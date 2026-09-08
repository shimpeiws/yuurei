import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRuntime } from './index.js';
import type { PreparedRun, RuntimeResult } from '../types.js';

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

  function makeRun(version: string | null): PreparedRun {
    return {
      runtimeId: 'claude-code',
      command: 'claude',
      args: [],
      env: {},
      cwd: tmpDir,
      isolation: { strategy: 'level0', rootDir: tmpDir, env: {}, keep: false } as never,
      cell: {} as never,
      runtimeVersion: version,
      credentialFilePaths: [],
      credentialValuesToRedact: [],
    };
  }

  it('extracts usage from real --output-format json stdout', async () => {
    const { result, stdoutPath } = makeResult();
    await writeFile(stdoutPath, REAL_CLAUDE_STDOUT, 'utf8');

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeRun('2.1.265 (Claude Code)'));

    expect(fragment.usage).toEqual({
      input_tokens: 3,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 24335,
    });
  });

  it('threads runtimeVersion into the trace runtime field', async () => {
    const { result, stdoutPath } = makeResult();
    await writeFile(stdoutPath, REAL_CLAUDE_STDOUT, 'utf8');

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeRun('2.1.265 (Claude Code)'));

    expect(fragment.runtime).toEqual({ id: 'claude-code', version: '2.1.265 (Claude Code)' });
  });

  it('returns empty usage when stdout is absent', async () => {
    const { result } = makeResult();
    // stdoutPath not written — readFile will throw

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeRun(null));

    expect(fragment.usage).toEqual({});
  });

  it('returns empty usage when stdout is not valid JSON', async () => {
    const { result, stdoutPath } = makeResult();
    await writeFile(stdoutPath, 'not json\n', 'utf8');

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeRun(null));

    expect(fragment.usage).toEqual({});
  });

  it('returns empty usage when stdout JSON has no usage field', async () => {
    const { result, stdoutPath } = makeResult();
    await writeFile(stdoutPath, '{}', 'utf8');

    const runtime = new ClaudeCodeRuntime();
    const fragment = await runtime.normalize(result, makeRun(null));

    expect(fragment.usage).toEqual({});
  });
});
