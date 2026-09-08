import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexRuntime } from './index.js';
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

  it('returns empty usage with no warning when stdout is absent', async () => {
    const result = makeResult();
    // stdoutPath not written — readFile will throw

    const runtime = new CodexRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.usage).toEqual({});
    expect(fragment.warnings).toBeUndefined();
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

  it('skips unparseable lines and still finds turn.completed', async () => {
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
  });
});
