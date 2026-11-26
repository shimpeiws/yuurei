import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRunStatusMonitor, lastActivityMs, type RunStatusSnapshot } from './status.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readStatus(path: string): Promise<RunStatusSnapshot> {
  return JSON.parse(await readFile(path, 'utf8')) as RunStatusSnapshot;
}

async function waitForStatus(path: string): Promise<RunStatusSnapshot> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      return await readStatus(path);
    } catch {
      if (Date.now() > deadline) throw new Error('status.json never appeared');
      await sleep(10);
    }
  }
}

describe('lastActivityMs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yuurei-activity-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the newest mtime under the root, including nested files', async () => {
    const oldFile = join(dir, 'old.txt');
    await writeFile(oldFile, 'x', 'utf8');
    const nested = join(dir, 'a', 'b');
    await mkdir(nested, { recursive: true });
    const newFile = join(nested, 'new.txt');
    await writeFile(newFile, 'y', 'utf8');
    // Pin the old file far into the past so only the nested file can win.
    const past = new Date('2000-01-01T00:00:00Z');
    await utimes(oldFile, past, past);
    const newFileMtime = (await lstat(newFile)).mtimeMs;

    const result = await lastActivityMs([dir]);
    expect(result).toBeGreaterThanOrEqual(newFileMtime);
  });

  it('does not follow a symlink out of the scanned root', async () => {
    // A symlinked directory inside the cell pointing at an outside tree
    // must never be descended into — files in the cell are untrusted and
    // the scan is not a path out of it.
    const outside = await mkdtemp(join(tmpdir(), 'yuurei-activity-outside-'));
    try {
      const outsideFile = join(outside, 'future.txt');
      await writeFile(outsideFile, 'x', 'utf8');
      // A far-future mtime: if the scan followed the link, this value would
      // become the reported last-activity.
      const future = new Date('2030-01-01T00:00:00Z');
      await utimes(outsideFile, future, future);

      const scanned = join(dir, 'scanned');
      await mkdir(scanned);
      await symlink(outside, join(scanned, 'link-out'), 'dir');

      const result = await lastActivityMs([scanned]);
      expect(result === null || result < future.getTime()).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('skips entries that vanish mid-scan and unreadable roots', async () => {
    const result = await lastActivityMs([join(dir, 'does-not-exist')]);
    expect(result).toBeNull();
  });
});

describe('run status monitor', () => {
  let dir: string;
  let cellRoot: string;
  let statusPath: string;
  const warnings: string[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yuurei-status-test-'));
    cellRoot = join(dir, 'cell');
    await mkdir(cellRoot, { recursive: true });
    statusPath = join(dir, 'status.json');
    warnings.length = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeMonitor(overrides: Partial<Parameters<typeof createRunStatusMonitor>[0]> = {}) {
    return createRunStatusMonitor({
      runId: 'run-test',
      statusPath,
      intervalMs: 30,
      activityRoots: () => [cellRoot],
      onWarning: (m) => warnings.push(m),
      ...overrides,
    });
  }

  it('writes a running status immediately and keeps it valid JSON on every read', async () => {
    const monitor = makeMonitor({ intervalMs: 5 });
    monitor.start();
    try {
      await waitForStatus(statusPath);
      // Read across several ticks; an atomic rename means every read either
      // sees the previous whole file or the next — never a torn write.
      for (let i = 0; i < 20; i += 1) {
        const status = await readStatus(statusPath);
        expect(status.run_id).toBe('run-test');
        expect(status.state).toBe('running');
        expect(typeof status.elapsed_s).toBe('number');
        expect(Number.isInteger(status.elapsed_s)).toBe(true);
        expect(typeof status.pid).toBe('number');
        await sleep(3);
      }
    } finally {
      await monitor.stop();
    }
  });

  it('reports a non-decreasing elapsed_s across ticks', async () => {
    const monitor = makeMonitor({ intervalMs: 20 });
    monitor.start();
    try {
      await waitForStatus(statusPath);
      const seen: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        await sleep(40);
        seen.push((await readStatus(statusPath)).elapsed_s);
      }
      for (let i = 1; i < seen.length; i += 1) {
        expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] ?? 0);
      }
    } finally {
      await monitor.stop();
    }
  });

  it('picks up a freshly touched cell file as last_activity_at', async () => {
    const monitor = makeMonitor({ intervalMs: 20 });
    monitor.start();
    try {
      // Wait for the first write, then create activity inside the cell.
      await waitForStatus(statusPath);
      const marker = join(cellRoot, 'session.jsonl');
      await writeFile(marker, '{}', 'utf8');
      const markerMtime = (await lstat(marker)).mtimeMs;
      await sleep(60);
      const status = await readStatus(statusPath);
      expect(status.last_activity_at).not.toBeNull();
      expect(Date.parse(status.last_activity_at ?? '')).toBeGreaterThanOrEqual(markerMtime - 1);
    } finally {
      await monitor.stop();
    }
  });

  it('does not regress last_activity_at when the newest file is deleted between ticks', async () => {
    const monitor = makeMonitor({ intervalMs: 20 });
    monitor.start();
    try {
      // A file with a far-future mtime wins the first scan outright.
      const marker = join(cellRoot, 'newest.txt');
      await writeFile(marker, 'x', 'utf8');
      const future = new Date('2030-06-01T00:00:00Z');
      await utimes(marker, future, future);
      await waitForStatus(statusPath);
      const deadline = Date.now() + 5000;
      for (;;) {
        const status = await readStatus(statusPath);
        if (status.last_activity_at !== null) break;
        if (Date.now() > deadline) throw new Error('last_activity_at never observed');
        await sleep(20);
      }
      const observed = (await readStatus(statusPath)).last_activity_at;

      // The file that held the max vanishes; the hint must not move backwards.
      await rm(marker);
      await sleep(80);
      expect((await readStatus(statusPath)).last_activity_at).toBe(observed);
    } finally {
      await monitor.stop();
    }
  });

  it('stop() resolves only after an in-flight write has settled', async () => {
    // Hold the first tick's activity probe in flight, then call stop() while
    // the write is still blocked: a caller removing the run directory right
    // after stop() must not race a late status write.
    let releaseProbe: () => void = () => {};
    const probeGate = new Promise<string[]>((resolve) => {
      releaseProbe = () => resolve([cellRoot]);
    });
    const monitor = makeMonitor({ activityRoots: () => probeGate });
    monitor.start();
    let stopped = false;
    const stopping = monitor.stop().then(() => {
      stopped = true;
    });
    await sleep(50);
    expect(stopped).toBe(false);

    releaseProbe();
    await stopping;
    // The held write landed before stop() resolved: the directory can be
    // removed now with no status write still in flight.
    expect((await readStatus(statusPath)).state).toBe('running');
    await rm(statusPath, { force: true });
    await sleep(50);
    await expect(readStatus(statusPath)).rejects.toThrow();
  });

  it('does not accumulate a write backlog when the probe outlasts the interval', async () => {
    // With a probe slower than the interval, ticks must coalesce rather
    // than queue: finish() should only ever wait for the one write in
    // flight, not a backlog built up while the caller waited.
    let releaseProbe: () => void = () => {};
    const gate = new Promise<string[]>((resolve) => {
      releaseProbe = () => resolve([cellRoot]);
    });
    const seen: RunStatusSnapshot[] = [];
    const monitor = makeMonitor({
      intervalMs: 5,
      activityRoots: () => gate,
      onProgress: (s) => seen.push(s),
    });
    monitor.start();
    await sleep(80);
    const finishing = monitor.finish('finished');
    await sleep(80);
    // Still blocked only on the single in-flight write — not on dozens of
    // queued ticks an interval timer would have enqueued.
    releaseProbe();
    await finishing;
    expect(seen.length).toBeLessThanOrEqual(3);
    expect(seen[seen.length - 1]?.state).toBe('finished');
  });

  it('does not reject stop() when the activity probe throws', async () => {
    const monitor = makeMonitor({
      activityRoots: () => {
        throw new Error('probe exploded');
      },
    });
    monitor.start();
    try {
      const status = await waitForStatus(statusPath);
      expect(status.state).toBe('running');
      expect(status.last_activity_at).toBeNull();
    } finally {
      await expect(monitor.stop()).resolves.toBeUndefined();
      await expect(monitor.finish('finished')).resolves.toBeUndefined();
    }
  });

  it('writes the terminal state exactly once — first finish wins', async () => {
    const monitor = makeMonitor();
    monitor.start();
    await sleep(40);
    await monitor.finish('finished', '2026-01-01T00:01:00.000Z');
    await monitor.finish('interrupted');
    const status = await readStatus(statusPath);
    expect(status.state).toBe('finished');
    expect(status.finished_at).toBe('2026-01-01T00:01:00.000Z');
  });

  it('stops rewriting after stop()', async () => {
    const monitor = makeMonitor({ intervalMs: 15 });
    monitor.start();
    await waitForStatus(statusPath);
    await monitor.stop();
    const before = (await readStatus(statusPath)).elapsed_s;
    const beforeRaw = await readFile(statusPath, 'utf8');
    await sleep(60);
    const afterRaw = await readFile(statusPath, 'utf8');
    // No rewrite after stop: the file content is frozen.
    expect(afterRaw).toBe(beforeRaw);
    expect((JSON.parse(afterRaw) as RunStatusSnapshot).elapsed_s).toBe(before);
  });

  it('warns once and keeps ticking when the status write fails', async () => {
    // A statusPath inside a directory that does not exist makes every
    // write fail; the monitor must warn once and stay alive.
    const badPath = join(dir, 'missing-dir', 'status.json');
    const monitor = makeMonitor({ statusPath: badPath, intervalMs: 15 });
    monitor.start();
    try {
      await sleep(80);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(badPath);
    } finally {
      await monitor.stop();
    }
  });

  it('calls onProgress with each snapshot', async () => {
    const seen: RunStatusSnapshot[] = [];
    const monitor = makeMonitor({
      intervalMs: 20,
      onProgress: (s) => seen.push(s),
    });
    monitor.start();
    await sleep(60);
    await monitor.finish('finished');
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]?.state).toBe('running');
    expect(seen[seen.length - 1]?.state).toBe('finished');
  });
});
