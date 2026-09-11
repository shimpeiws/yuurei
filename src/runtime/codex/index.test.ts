import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexRuntime, stripCodexStdinNotice } from './index.js';
import type { NormalizationContext, RuntimeResult } from '../types.js';

// Real JSONL captured from `codex exec --json "say hello"`.
// turn.completed: input_tokens:21616, cached_input_tokens:9984, cache_write_input_tokens:0,
//                 output_tokens:8, reasoning_output_tokens:0
const REAL_CODEX_STDOUT = [
  '{"type":"thread.started","thread_id":"01a08310-c553-7813-aadb-05df8e89abea"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Hello!"}}',
  '{"type":"turn.completed","usage":{"input_tokens":21616,"cached_input_tokens":9984,"cache_write_input_tokens":0,"output_tokens":8,"reasoning_output_tokens":0}}',
  '',
].join('\n');

describe('CodexRuntime.normalize()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'yuurei-codex-normalize-test-'));
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

  function makeContext(version: string | null): NormalizationContext {
    return { runtimeVersion: version };
  }

  it('extracts usage from real --json JSONL stdout', async () => {
    const result = makeResult();
    await writeFile(result.stdoutPath, REAL_CODEX_STDOUT, 'utf8');

    const runtime = new CodexRuntime();
    const fragment = await runtime.normalize(result, makeContext('0.100.0'));

    expect(fragment.usage).toEqual({
      input_tokens: 21616,
      cached_input_tokens: 9984,
      cache_write_input_tokens: 0,
      output_tokens: 8,
      reasoning_output_tokens: 0,
    });
  });

  it('threads runtimeVersion into the trace runtime field', async () => {
    const result = makeResult();
    await writeFile(result.stdoutPath, REAL_CODEX_STDOUT, 'utf8');

    const runtime = new CodexRuntime();
    const fragment = await runtime.normalize(result, makeContext('0.100.0'));

    expect(fragment.runtime).toEqual({ id: 'codex', version: '0.100.0' });
  });

  it('returns empty usage with no warning when stdout is absent after killed run', async () => {
    const result = makeResult();
    result.exitCode = null;
    result.signal = 'SIGTERM';
    // stdoutPath not written — readFile throws ENOENT

    const runtime = new CodexRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.usage).toEqual({});
    expect(fragment.warnings).toBeUndefined();
  });

  it('warns when stdout is absent after normal exit', async () => {
    const result = makeResult();
    // exitCode:0, signal:null, timedOut:false from makeResult()
    // stdoutPath not written — readFile throws ENOENT

    const runtime = new CodexRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.usage).toEqual({});
    expect(fragment.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('absent after normal exit')]),
    );
  });

  it('returns empty usage and a warning when no turn.completed event is present', async () => {
    const result = makeResult();
    const noCompletedEvent = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"turn.started"}',
      '',
    ].join('\n');
    await writeFile(result.stdoutPath, noCompletedEvent, 'utf8');

    const runtime = new CodexRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.usage).toEqual({});
    expect(fragment.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('no turn.completed')]),
    );
  });

  it('skips unparseable lines, warns about them, and still finds turn.completed', async () => {
    const result = makeResult();
    const withGarbage = [
      '{"type":"thread.started","thread_id":"abc"}',
      'not valid json',
      '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
      '',
    ].join('\n');
    await writeFile(result.stdoutPath, withGarbage, 'utf8');

    const runtime = new CodexRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.usage).toMatchObject({ input_tokens: 100, output_tokens: 5 });
    expect(fragment.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('1 unparseable JSONL line(s)')]),
    );
  });

  it('counts valid-JSON non-objects (null, numbers) as malformed', async () => {
    const result = makeResult();
    const withNonObjects = [
      '{"type":"thread.started","thread_id":"abc"}',
      'null',
      '42',
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":2,"reasoning_output_tokens":0}}',
      '',
    ].join('\n');
    await writeFile(result.stdoutPath, withNonObjects, 'utf8');

    const runtime = new CodexRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.usage).toMatchObject({ input_tokens: 10, output_tokens: 2 });
    expect(fragment.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('2 unparseable JSONL line(s)')]),
    );
  });

  it('counts malformed lines that appear after turn.completed', async () => {
    const result = makeResult();
    const withGarbageAfterCompleted = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":3,"reasoning_output_tokens":0}}',
      'trailing garbage line',
      '',
    ].join('\n');
    await writeFile(result.stdoutPath, withGarbageAfterCompleted, 'utf8');

    const runtime = new CodexRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.usage).toMatchObject({ input_tokens: 50, output_tokens: 3 });
    expect(fragment.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('1 unparseable JSONL line(s)')]),
    );
  });
});

describe('stripCodexStdinNotice', () => {
  it('removes only Codex’s benign stdin notice and preserves other stderr', () => {
    expect(
      stripCodexStdinNotice(
        'Reading additional input from stdin...\nreal runtime failure\nReading additional input from stdin...',
      ),
    ).toBe('real runtime failure');
  });

  it('preserves stderr that does not contain the exact notice', () => {
    expect(stripCodexStdinNotice('Reading additional input from stdin')).toBe(
      'Reading additional input from stdin',
    );
  });
});
