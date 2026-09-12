import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeTrace } from './writer.js';
import type { Trace } from './schema.js';
import { TRACE_SCHEMA_VERSION } from './schema.js';

function makeTrace(): Trace {
  return {
    schema_version: TRACE_SCHEMA_VERSION,
    run_id: '20260912T000000Z-0000',
    started_at: '2026-09-12T00:00:00.000Z',
    finished_at: '2026-09-12T00:00:01.000Z',
    runtime: { id: 'fake', version: null },
    model: { requested: '', resolved: null },
    profile: { name: 'p', digest: 'sha256:p' },
    task: { source: 'task.md', digest: 'sha256:t' },
    isolation: { strategy: 'level1', verified: true },
    execution: { exit_code: 0, signal: null, duration_ms: 1, timed_out: false },
    usage: {},
    cost: null,
    artifacts: [],
  };
}

describe('writeTrace', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'yuurei-trace-writer-'));
    dirs.push(dir);
    return dir;
  }

  it('publishes trace.json and leaves no temporary file behind', async () => {
    const dir = await tempDir();
    await writeTrace(dir, makeTrace());

    const entries = await readdir(dir);
    expect(entries).toEqual(['trace.json']);
    const published = JSON.parse(await readFile(join(dir, 'trace.json'), 'utf8'));
    expect(published.schema_version).toBe(TRACE_SCHEMA_VERSION);
    expect(published.run_id).toBe('20260912T000000Z-0000');
  });

  it('does not publish a trace and removes the temp file when the rename fails', async () => {
    // A pre-existing directory at the rename target makes rename() fail
    // (EISDIR): nothing must be published, and the temp sibling must go.
    const dir = await tempDir();
    await rm(join(dir, 'trace.json'), { recursive: true, force: true });
    await mkdir(join(dir, 'trace.json'), { recursive: true });

    await expect(writeTrace(dir, makeTrace())).rejects.toThrow();

    const entries = await readdir(dir);
    expect(entries).toEqual(['trace.json']);
    expect(entries.some((entry) => entry.startsWith('.trace.json.tmp-'))).toBe(false);
  });
});
