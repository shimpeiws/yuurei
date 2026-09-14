import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenCodeRuntime } from './index.js';
import type { NormalizationContext, RuntimeResult } from '../types.js';

// Real NDJSON captured from `opencode run --format json --auto "reply ok"`.
const REAL_STDOUT = [
  '{"type":"step_start","timestamp":1789346860980,"sessionID":"ses_x","part":{"type":"step-start"}}',
  '{"type":"text","timestamp":1789346861175,"sessionID":"ses_x","part":{"type":"text","text":"ok","time":{"start":1,"end":2}}}',
  '{"type":"step_finish","timestamp":1789346861235,"sessionID":"ses_x","part":{"type":"step-finish","reason":"stop","tokens":{"total":7982,"input":6174,"output":16,"reasoning":0,"cache":{"write":0,"read":1792}},"cost":0}}',
  '',
].join('\n');

describe('OpenCodeRuntime.normalize()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'yuurei-opencode-normalize-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeResult(): RuntimeResult {
    const now = new Date().toISOString();
    return {
      exitCode: 0,
      signal: null,
      startedAt: now,
      finishedAt: now,
      stdoutPath: join(tmpDir, 'stdout.log'),
      stderrPath: join(tmpDir, 'stderr.log'),
      timedOut: false,
    };
  }

  const context: NormalizationContext = { runtimeVersion: '1.18.30' };

  it('sums usage and cost from step_finish events', async () => {
    const result = makeResult();
    await writeFile(result.stdoutPath, REAL_STDOUT, 'utf8');

    const fragment = await new OpenCodeRuntime().normalize(result, context);

    expect(fragment.usage).toEqual({
      input_tokens: 6174,
      output_tokens: 16,
      reasoning_output_tokens: 0,
      cache_read_input_tokens: 1792,
      cache_write_input_tokens: 0,
      cost_usd: 0,
    });
  });

  it('reports the model as unobserved with an explicit reason', async () => {
    const result = makeResult();
    await writeFile(result.stdoutPath, REAL_STDOUT, 'utf8');

    const fragment = await new OpenCodeRuntime().normalize(result, context);

    expect(fragment.model).toEqual({ requested: '', resolved: null, resolvedReason: 'unobserved' });
    expect(fragment.runtime).toEqual({ id: 'opencode', version: '1.18.30' });
    expect(fragment.warnings).toBeUndefined();
  });

  it('sums across multiple step_finish events', async () => {
    const result = makeResult();
    const step = (input: number, output: number): string =>
      `{"type":"step_finish","part":{"type":"step-finish","tokens":{"input":${input},"output":${output},"reasoning":0,"cache":{"read":0,"write":0}},"cost":1}}`;
    await writeFile(result.stdoutPath, `${step(10, 2)}\n${step(5, 3)}\n`, 'utf8');

    const fragment = await new OpenCodeRuntime().normalize(result, context);

    expect(fragment.usage['input_tokens']).toBe(15);
    expect(fragment.usage['output_tokens']).toBe(5);
    expect(fragment.usage['cost_usd']).toBe(2);
  });

  it('records a missing metric as null rather than zero when a step omits it', async () => {
    const result = makeResult();
    const lines = [
      '{"type":"step_finish","part":{"type":"step-finish","tokens":{"input":10,"output":2,"reasoning":0,"cache":{"read":0,"write":0}},"cost":1}}',
      '{"type":"step_finish","part":{"type":"step-finish","tokens":{"output":3,"reasoning":0,"cache":{"read":0,"write":0}},"cost":1}}',
      '',
    ].join('\n');
    await writeFile(result.stdoutPath, lines, 'utf8');

    const fragment = await new OpenCodeRuntime().normalize(result, context);

    expect(fragment.usage['input_tokens']).toBeNull();
    expect(fragment.usage['output_tokens']).toBe(5);
    expect(fragment.diagnostics).toEqual(
      expect.arrayContaining([expect.stringContaining('input_tokens')]),
    );
  });

  it('reports malformed lines with count and line numbers', async () => {
    const result = makeResult();
    await writeFile(result.stdoutPath, `not json\n${REAL_STDOUT}`, 'utf8');

    const fragment = await new OpenCodeRuntime().normalize(result, context);

    expect(fragment.diagnostics).toEqual(
      expect.arrayContaining([expect.stringContaining('1 unparseable JSONL line(s)')]),
    );
    expect(fragment.diagnostics?.[0]).toContain('lines 1');
    expect(fragment.usage['input_tokens']).toBe(6174);
  });

  it('returns empty usage and a diagnostic when no step_finish event is present', async () => {
    const result = makeResult();
    await writeFile(
      result.stdoutPath,
      '{"type":"step_start","part":{"type":"step-start"}}\n',
      'utf8',
    );

    const fragment = await new OpenCodeRuntime().normalize(result, context);

    expect(fragment.usage).toEqual({});
    expect(fragment.diagnostics).toEqual(
      expect.arrayContaining([expect.stringContaining('no step_finish')]),
    );
  });

  it('records an error event as a fixed diagnostic, never persisting runtime text', async () => {
    const result = makeResult();
    result.exitCode = 1;
    const errorEvent =
      '{"type":"error","error":{"name":"token=arbitrary-secret","data":{"message":"secret-ish detail"}}}';
    await writeFile(result.stdoutPath, `${errorEvent}\n`, 'utf8');

    const fragment = await new OpenCodeRuntime().normalize(result, context);

    expect(fragment.diagnostics).toEqual(
      expect.arrayContaining([expect.stringContaining('session error reported')]),
    );
    // Neither the untrusted error name nor its message body reaches the trace.
    expect(JSON.stringify(fragment.diagnostics)).not.toContain('arbitrary-secret');
    expect(JSON.stringify(fragment.diagnostics)).not.toContain('secret-ish detail');
  });

  it('treats a step_finish event with a malformed payload as malformed', async () => {
    const result = makeResult();
    const lines = [
      '{"type":"step_finish"}',
      '{"type":"step_finish","part":{"type":"wrong-type"}}',
      '{"type":"step_finish","part":{"type":"step-finish","tokens":{"input":7,"output":1,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0}}',
      '',
    ].join('\n');
    await writeFile(result.stdoutPath, lines, 'utf8');

    const fragment = await new OpenCodeRuntime().normalize(result, context);

    expect(fragment.diagnostics).toEqual(
      expect.arrayContaining([expect.stringContaining('2 unparseable JSONL line(s)')]),
    );
    expect(fragment.usage['input_tokens']).toBe(7);
  });

  it('records why a metric is unobserved (absent vs invalid)', async () => {
    const result = makeResult();
    const lines = [
      '{"type":"step_finish","part":{"type":"step-finish","tokens":{"input":-5,"output":2,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0}}',
      '',
    ].join('\n');
    await writeFile(result.stdoutPath, lines, 'utf8');

    const fragment = await new OpenCodeRuntime().normalize(result, context);

    expect(fragment.usage['input_tokens']).toBeNull();
    expect(fragment.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining('input_tokens unobserved (line 1: negative)'),
      ]),
    );
  });

  it('persists a fixed diagnostic for an unreadable stdout, never the error text', async () => {
    const result = makeResult();
    // A directory at the log path makes readFile fail with EISDIR, whose
    // message contains the path.
    await mkdir(result.stdoutPath);

    const fragment = await new OpenCodeRuntime().normalize(result, context);

    expect(fragment.diagnostics).toEqual(
      expect.arrayContaining([expect.stringContaining('stdout unreadable')]),
    );
    expect(JSON.stringify(fragment.diagnostics)).not.toContain(tmpDir);
  });

  it('warns when stdout is absent after a normal exit but not after a signal', async () => {
    const normal = makeResult();
    const fragment = await new OpenCodeRuntime().normalize(normal, context);
    expect(fragment.diagnostics).toEqual(
      expect.arrayContaining([expect.stringContaining('absent after normal exit')]),
    );

    const killed = makeResult();
    killed.exitCode = null;
    killed.signal = 'SIGTERM';
    const killedFragment = await new OpenCodeRuntime().normalize(killed, context);
    expect(killedFragment.diagnostics).toBeUndefined();
  });
});
