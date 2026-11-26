import { describe, expect, it, vi } from 'vitest';
import type { RunStatusSnapshot } from '../run/status.js';
import { createProgressSink, formatElapsed, resolveProgress } from './progress.js';
import { EXIT_CODES, YuureiError } from './exit-codes.js';

function snapshot(overrides: Partial<RunStatusSnapshot> = {}): RunStatusSnapshot {
  return {
    run_id: 'run-abc',
    state: 'running',
    started_at: '2026-01-01T00:00:00.000Z',
    elapsed_s: 724,
    last_activity_at: new Date(Date.now() - 8000).toISOString(),
    pid: 1234,
    ...overrides,
  };
}

describe('resolveProgress', () => {
  it('defaults on for a TTY without --json, off otherwise', () => {
    expect(resolveProgress(undefined, { json: false, stderrIsTTY: true })).toEqual({
      enabled: true,
      intervalMs: 30_000,
    });
    expect(resolveProgress(undefined, { json: false, stderrIsTTY: false }).enabled).toBe(false);
    expect(resolveProgress(undefined, { json: true, stderrIsTTY: true }).enabled).toBe(false);
  });

  it('honours explicit on/off regardless of the environment', () => {
    expect(resolveProgress(false, { json: false, stderrIsTTY: true }).enabled).toBe(false);
    expect(resolveProgress(true, { json: true, stderrIsTTY: false }).enabled).toBe(true);
  });

  it('accepts a positive interval in seconds, number or string', () => {
    expect(resolveProgress(5, { json: false, stderrIsTTY: false })).toEqual({
      enabled: true,
      intervalMs: 5000,
    });
    expect(resolveProgress('2', { json: false, stderrIsTTY: false }).intervalMs).toBe(2000);
  });

  it.each([0, -3, 'abc', 'NaN', Number.NaN, Infinity])(
    'rejects invalid interval %s as a configuration error',
    (value) => {
      try {
        resolveProgress(value as number, { json: false, stderrIsTTY: true });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(YuureiError);
        expect((error as YuureiError).exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
        expect((error as YuureiError).code).toBe('invalid_input');
      }
    },
  );
});

describe('formatElapsed', () => {
  it('formats seconds like the issue examples', () => {
    expect(formatElapsed(8)).toBe('8s');
    expect(formatElapsed(724)).toBe('12m04s');
    expect(formatElapsed(3723)).toBe('1h02m03s');
  });
});

describe('createProgressSink', () => {
  function collect(): { stream: { write(c: string): boolean }; chunks: string[] } {
    const chunks: string[] = [];
    return { stream: { write: (c: string) => (chunks.push(c), true) }, chunks };
  }

  it('skips blocked frames, falls back on resize, and stops on interruption', () => {
    vi.useFakeTimers();
    const { stream, chunks } = collect();
    const terminal = { ...stream, columns: 40, rows: 24, writableNeedDrain: false };
    const sink = createProgressSink({ json: false, tty: true, animate: true, stream: terminal });
    try {
      sink(snapshot());
      expect(chunks[0]).toMatch(/[\u2801-\u28ff]/u);
      terminal.writableNeedDrain = true;
      vi.advanceTimersByTime(1000);
      expect(chunks).toHaveLength(1);
      terminal.writableNeedDrain = false;
      terminal.columns = 20;
      vi.advanceTimersByTime(100);
      expect(chunks[1]).toContain('\x1b[2A');
      terminal.columns = 80;
      vi.advanceTimersByTime(100);
      expect(chunks.at(-1)).toMatch(/[\u2801-\u28ff]/u);
      sink(snapshot({ state: 'interrupted' }));
      const count = chunks.length;
      expect(chunks.at(-1)).toContain('interrupted');
      vi.advanceTimersByTime(1000);
      expect(chunks).toHaveLength(count);
    } finally {
      sink.stop();
      vi.useRealTimers();
    }
  });

  it('stops the autonomous timer if interactive stderr closes mid-frame', () => {
    vi.useFakeTimers();
    const { stream, chunks } = collect();
    let onError: ((error: Error) => void) | undefined;
    const sink = createProgressSink({
      json: false,
      tty: true,
      animate: true,
      stream: {
        ...stream,
        columns: 80,
        rows: 24,
        on: (_event, listener) => {
          onError = listener;
        },
      },
    });
    try {
      sink(snapshot());
      vi.advanceTimersByTime(200);
      expect(chunks).toHaveLength(3);
      onError?.(new Error('write EPIPE'));
      vi.advanceTimersByTime(60_000);
      sink(snapshot({ state: 'interrupted' }));
      expect(chunks).toHaveLength(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      sink.stop();
      vi.useRealTimers();
    }
  });

  it('rewrites one line in place on a terminal', () => {
    const { stream, chunks } = collect();
    const sink = createProgressSink({ json: false, tty: true, stream });
    sink(snapshot());
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('\r\x1b[K[yuurei] run-abc running 12m04s, last activity ');
    expect(chunks[0]).toMatch(/last activity \d+s ago$/);
  });

  it('emits a final-state line terminated by a newline on a terminal', () => {
    const { stream, chunks } = collect();
    const sink = createProgressSink({ json: false, tty: true, stream });
    sink(snapshot({ state: 'timed_out', finished_at: '2026-01-01T00:12:04.000Z' }));
    expect(chunks[0]).toBe('\r\x1b[K[yuurei] run-abc timed out after 12m04s\n');
  });

  it('appends plain lines on a non-terminal stream', () => {
    const { stream, chunks } = collect();
    const sink = createProgressSink({ json: false, tty: false, stream });
    sink(snapshot({ last_activity_at: null }));
    sink(snapshot({ state: 'interrupted' }));
    expect(chunks).toEqual([
      '[yuurei] run-abc running 12m04s, last activity unknown\n',
      '[yuurei] run-abc interrupted after 12m04s\n',
    ]);
  });

  it('emits JSON lines carrying the status fields under --json', () => {
    const { stream, chunks } = collect();
    const sink = createProgressSink({ json: true, tty: true, stream });
    sink(snapshot());
    const parsed = JSON.parse(chunks[0] ?? '') as RunStatusSnapshot;
    expect(parsed.run_id).toBe('run-abc');
    expect(parsed.state).toBe('running');
    expect(parsed.elapsed_s).toBe(724);
    expect(parsed.pid).toBe(1234);
  });

  it('stops writing after an async stream error (closed pipe) instead of crashing', () => {
    const chunks: string[] = [];
    const listeners: Record<string, (error: Error) => void> = {};
    const stream = {
      write: (c: string) => (chunks.push(c), true),
      on: (event: string, listener: (error: Error) => void) => {
        listeners[event] = listener;
      },
    };
    const sink = createProgressSink({ json: false, tty: false, stream });
    sink(snapshot());
    // A closed reader surfaces as an 'error' event (EPIPE) — the sink
    // must absorb it and go quiet rather than let Node exit mid-run.
    listeners['error']?.(new Error('write EPIPE'));
    sink(snapshot());
    expect(chunks).toHaveLength(1);
  });

  it('disables itself after a synchronous write throw', () => {
    let calls = 0;
    const stream = {
      write: () => {
        calls += 1;
        throw new Error('write failed');
      },
    };
    const sink = createProgressSink({ json: false, tty: false, stream });
    sink(snapshot());
    sink(snapshot());
    expect(calls).toBe(1);
  });
});
