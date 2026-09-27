import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRuntime } from './index.js';
import type { NormalizationContext, RuntimeResult } from '../types.js';

// Real stdout captured from `claude --print --output-format json "hello"`.
// input_tokens:3, output_tokens:4, cache_creation_input_tokens:0, cache_read_input_tokens:24335
const REAL_CLAUDE_STDOUT =
  '{"duration_api_ms":9527,"stop_reason":"end_turn","session_id":"319956cc-f994-47a0-8ce0-91bb0c064fc8","total_cost_usd":0.007369499999999999,"usage":{"input_tokens":3,"cache_creation_input_tokens":0,"cache_read_input_tokens":24335,"output_tokens":4,"output_tokens_details":{"thinking_tokens":0},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available"},"is_error":false,"result":"hello","type":"result"}\n';

describe('ClaudeCodeRuntime.normalize()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'yuurei-claude-normalize-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeResult(): { result: RuntimeResult; stdoutPath: string } {
    const stdoutPath = join(tmpDir, 'stdout.log');
    const stderrPath = join(tmpDir, 'stderr.log');
    const now = new Date().toISOString();
    const result: RuntimeResult = {
      exitCode: 0,
      signal: null,
      startedAt: now,
      finishedAt: now,
      stdoutPath,
      stderrPath,
      timedOut: false,
    };
    return { result, stdoutPath };
  }

  function makeContext(version: string | null): NormalizationContext {
    return { runtimeVersion: version };
  }

  it('extracts usage from real --output-format json stdout', async () => {
    const { result, stdoutPath } = makeResult();
    await writeFile(stdoutPath, REAL_CLAUDE_STDOUT, 'utf8');

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeContext('2.1.265 (Claude Code)'));

    expect(fragment.usage).toEqual({
      input_tokens: 3,
      output_tokens: 4,
      cache_write_input_tokens: 0,
      cache_read_input_tokens: 24335,
      reasoning_output_tokens: 0,
    });
  });

  it('resolves the model from the modelUsage keys', async () => {
    const { result, stdoutPath } = makeResult();
    const stdout =
      '{"modelUsage":{"claude-sonnet-4-5-20250929":{"inputTokens":3,"outputTokens":4,"costUSD":0.01}},"usage":{"input_tokens":3,"output_tokens":4},"type":"result"}\n';
    await writeFile(stdoutPath, stdout, 'utf8');

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.model).toEqual({ requested: '', resolved: 'claude-sonnet-4-5-20250929' });
  });

  it('joins every modelUsage key when several models served the run', async () => {
    const { result, stdoutPath } = makeResult();
    const stdout =
      '{"modelUsage":{"claude-sonnet-4-5":{},"claude-haiku-4-5":{}},"usage":{},"type":"result"}\n';
    await writeFile(stdoutPath, stdout, 'utf8');

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.model).toEqual({
      requested: '',
      resolved: 'claude-haiku-4-5,claude-sonnet-4-5',
    });
  });

  it('reports the model as unobserved when modelUsage is absent or empty', async () => {
    const { result, stdoutPath } = makeResult();
    // REAL_CLAUDE_STDOUT predates modelUsage; {} exercises the empty-object path.
    for (const stdout of [REAL_CLAUDE_STDOUT, '{"modelUsage":{},"type":"result"}\n']) {
      await writeFile(stdoutPath, stdout, 'utf8');

      const runtime = new ClaudeCodeRuntime();
      const fragment = await runtime.normalize(result, makeContext(null));

      expect(fragment.model).toEqual({
        requested: '',
        resolved: null,
        resolvedReason: 'unobserved',
      });
    }
  });

  it('reports parse_failed when the modelUsage field is malformed', async () => {
    const { result, stdoutPath } = makeResult();
    // A non-map value, an array (whose keys are indices, not model ids), and a
    // map carrying an empty key are all malformed rather than observed models.
    for (const stdout of [
      '{"modelUsage":"oops","type":"result"}\n',
      '{"modelUsage":[{}],"type":"result"}\n',
      '{"modelUsage":{"":{}},"type":"result"}\n',
      '{"modelUsage":{"":{},"claude-sonnet-4-5":{}},"type":"result"}\n',
    ]) {
      await writeFile(stdoutPath, stdout, 'utf8');

      const runtime = new ClaudeCodeRuntime();
      const fragment = await runtime.normalize(result, makeContext(null));

      expect(fragment.model).toEqual({
        requested: '',
        resolved: null,
        resolvedReason: 'parse_failed',
      });
    }
  });

  it('reports parse_failed when stdout cannot be read as a result object', async () => {
    const { result, stdoutPath } = makeResult();
    for (const stdout of ['not json\n', 'null']) {
      await writeFile(stdoutPath, stdout, 'utf8');

      const runtime = new ClaudeCodeRuntime();
      const fragment = await runtime.normalize(result, makeContext(null));

      expect(fragment.model.resolvedReason).toBe('parse_failed');
    }
  });

  it('reports the model as unobserved when stdout is absent', async () => {
    const { result } = makeResult();
    result.exitCode = null;
    result.signal = 'SIGTERM';

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.model).toEqual({
      requested: '',
      resolved: null,
      resolvedReason: 'unobserved',
    });
  });

  it('extracts the final result text from the result object', async () => {
    const { result, stdoutPath } = makeResult();
    await writeFile(stdoutPath, REAL_CLAUDE_STDOUT, 'utf8');

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.result).toEqual({ text: 'hello' });
  });

  it('reports the result as unobserved when the result field is absent', async () => {
    const { result, stdoutPath } = makeResult();
    await writeFile(stdoutPath, '{"usage":{},"type":"result"}\n', 'utf8');

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.result).toEqual({ text: null, reason: 'unobserved' });
  });

  it('reports the result as parse_failed when the result field is malformed', async () => {
    const { result, stdoutPath } = makeResult();
    await writeFile(stdoutPath, '{"result":42,"type":"result"}\n', 'utf8');

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.result).toEqual({ text: null, reason: 'parse_failed' });
  });

  it('reports the result as parse_failed when stdout cannot be read as a result object', async () => {
    const { result, stdoutPath } = makeResult();
    await writeFile(stdoutPath, 'not json\n', 'utf8');

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.result).toEqual({ text: null, reason: 'parse_failed' });
  });

  it('reports the result as unobserved when stdout is absent after a killed run', async () => {
    const { result } = makeResult();
    result.exitCode = null;
    result.signal = 'SIGTERM';

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.result).toEqual({ text: null, reason: 'unobserved' });
  });

  it('records the runtime-reported total_cost_usd as an observed cost', async () => {
    const { result, stdoutPath } = makeResult();
    await writeFile(stdoutPath, REAL_CLAUDE_STDOUT, 'utf8');

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.cost).toEqual({ amount: 0.007369499999999999, currency: 'USD' });
  });

  it('threads runtimeVersion into the trace runtime field', async () => {
    const { result, stdoutPath } = makeResult();
    await writeFile(stdoutPath, REAL_CLAUDE_STDOUT, 'utf8');

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeContext('2.1.265 (Claude Code)'));

    expect(fragment.runtime).toEqual({ id: 'claude-code', version: '2.1.265 (Claude Code)' });
  });

  it('returns empty usage with no warning when stdout is absent after killed run', async () => {
    const { result } = makeResult();
    // Override to simulate a killed run (signal set, exitCode null)
    result.exitCode = null;
    result.signal = 'SIGTERM';
    // stdoutPath not written — readFile throws ENOENT

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.usage).toEqual({});
    expect(fragment.warnings).toBeUndefined();
  });

  it('warns when stdout is absent after normal exit', async () => {
    const { result } = makeResult();
    // result already has exitCode:0, signal:null, timedOut:false from makeResult()
    // stdoutPath not written — readFile throws ENOENT

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.usage).toEqual({});
    expect(fragment.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('absent after normal exit')]),
    );
  });

  it('returns empty usage and a warning when stdout is not valid JSON', async () => {
    const { result, stdoutPath } = makeResult();
    await writeFile(stdoutPath, 'not json\n', 'utf8');

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.usage).toEqual({});
    expect(fragment.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('not valid JSON')]),
    );
  });

  it('returns empty usage and a warning when stdout JSON has no usage field', async () => {
    const { result, stdoutPath } = makeResult();
    await writeFile(stdoutPath, '{}', 'utf8');

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.usage).toEqual({});
    expect(fragment.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('no usage field')]),
    );
  });

  it('warns when stdout JSON is a non-object (null, string, number)', async () => {
    const { result, stdoutPath } = makeResult();
    await writeFile(stdoutPath, 'null', 'utf8');

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeContext(null));

    expect(fragment.usage).toEqual({});
    expect(fragment.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('not an object')]),
    );
  });
});
