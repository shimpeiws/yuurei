import { mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { printDoctorReport, runDoctor } from '../../src/cli/doctor.js';
import { ORPHAN_TEMP_DIR_MIN_AGE_MS } from '../../src/isolation/tempdir.js';
import { createLogger, type Logger } from '../../src/util/logger.js';

function makeLogger(): {
  logger: Logger;
  messages: { level: string; message: string; data?: Record<string, unknown> }[];
} {
  const messages: { level: string; message: string; data?: Record<string, unknown> }[] = [];
  const logger: Logger = {
    info: (message, data) => messages.push({ level: 'info', message, data }),
    warn: (message, data) => messages.push({ level: 'warn', message, data }),
    error: (message, data) => messages.push({ level: 'error', message, data }),
  };
  return { logger, messages };
}

function claudeCodeRuntime(
  overrides: Partial<{
    version: string | null;
    versionSupported: boolean | null;
    authUsable: boolean | null;
    authGuidance?: string;
  }> = {},
) {
  return {
    runtimeId: 'claude-code',
    installed: true,
    version: '2.1.269 (Claude Code)',
    versionSupported: true,
    authUsable: true,
    ...overrides,
  };
}

describe('yuurei doctor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a detection entry for every registered runtime', async () => {
    const report = await runDoctor();

    const runtimeIds = report.runtimes.map((runtime) => runtime.runtimeId);
    expect(runtimeIds).toEqual(expect.arrayContaining(['claude-code', 'codex']));
    for (const runtime of report.runtimes) {
      expect(typeof runtime.installed).toBe('boolean');
      expect(
        runtime.versionSupported === null || typeof runtime.versionSupported === 'boolean',
      ).toBe(true);
      expect(runtime.authUsable === null || typeof runtime.authUsable === 'boolean').toBe(true);
    }
    expect(Array.isArray(report.orphanTempDirs)).toBe(true);
  });

  it('checks whether the output directory is writable', async () => {
    const report = await runDoctor();
    expect(typeof report.canWriteOutputDir).toBe('boolean');
  });

  it('detects orphaned isolation temp dirs without removing them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yuurei-doctor-test-'));
    try {
      const stale = join(root, 'yuurei-stale');
      await mkdir(stale);
      await utimes(
        stale,
        new Date(Date.now() - 2 * ORPHAN_TEMP_DIR_MIN_AGE_MS),
        new Date(Date.now() - 2 * ORPHAN_TEMP_DIR_MIN_AGE_MS),
      );
      const fresh = join(root, 'yuurei-fresh');
      await mkdir(fresh);

      const report = await runDoctor({ tempDir: root });

      expect(report.orphanTempDirs.map((orphan) => orphan.path)).toEqual([stale]);
      await expect(stat(stale)).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renders each runtime as a readable block with no inline JSON', () => {
    const { logger, messages } = makeLogger();
    printDoctorReport(
      {
        runtimes: [claudeCodeRuntime()],
        canWriteOutputDir: true,
        orphanTempDirs: [],
      },
      logger,
      'human',
    );

    const text = messages.map((m) => m.message);
    expect(text).toContain('claude-code');
    expect(text).toContain('  status: installed');
    expect(text).toContain('  version: 2.1.269 (Claude Code)');
    expect(text).toContain('  supported: yes');
    expect(text).toContain('  authentication: ready');
    // Human output must not append structured data to the line.
    for (const m of messages) {
      expect(m.data).toBeUndefined();
      expect(m.message).not.toContain('"version"');
      expect(m.message).not.toMatch(/\{[^}]*\}/);
    }
  });

  it('distinguishes not found, unsupported, and unauthenticated states', () => {
    const { logger, messages } = makeLogger();
    printDoctorReport(
      {
        runtimes: [
          {
            ...claudeCodeRuntime(),
            runtimeId: 'codex',
            installed: false,
            version: null,
            versionSupported: null,
            authUsable: null,
          },
          { ...claudeCodeRuntime(), version: '1.5.0', versionSupported: false },
          { ...claudeCodeRuntime(), authUsable: null },
        ],
        canWriteOutputDir: true,
        orphanTempDirs: [],
      },
      logger,
      'human',
    );

    const text = messages.map((m) => m.message);
    const warn = messages.filter((m) => m.level === 'warn').map((m) => m.message);
    expect(text).toContain('  status: not found');
    expect(warn.some((m) => m.includes('WARNING: supported: no'))).toBe(true);
    expect(warn.some((m) => m.includes('upgrade this runtime to a supported version'))).toBe(true);
    expect(text).toContain('  authentication: not checked');
  });

  it('renders auth guidance as an indented paragraph and never prints secrets', () => {
    const { logger, messages } = makeLogger();
    const guidance =
      'For subscription login, run `claude setup-token` once, then in this shell export the result as ANTHROPIC_AUTH_TOKEN. ' +
      'Re-run `yuurei doctor` and look for authentication: ready.';
    printDoctorReport(
      {
        runtimes: [claudeCodeRuntime({ authUsable: false, authGuidance: guidance })],
        canWriteOutputDir: true,
        orphanTempDirs: [],
      },
      logger,
      'human',
    );

    const text = messages.map((m) => m.message);
    const warn = messages.filter((m) => m.level === 'warn').map((m) => m.message);
    expect(warn.some((m) => m.includes('WARNING: authentication: required'))).toBe(true);
    const guidanceLines = warn.filter((m) => m.startsWith('    '));
    expect(guidanceLines.join(' ')).toContain('claude setup-token');
    expect(guidanceLines.join(' ')).toContain('ANTHROPIC_AUTH_TOKEN');
    // No secrets appear in the output.
    const allText = text.join('\n');
    expect(allText).not.toContain('sk-ant-api03-');
    expect(allText).not.toContain('ANTHROPIC_AUTH_TOKEN=sk-ant-secret');
    expect(allText).not.toContain('sk-proj-');
  });

  it('keeps the machine-readable JSON schema stable', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger('json');
    printDoctorReport(
      {
        runtimes: [
          claudeCodeRuntime({
            authUsable: false,
            authGuidance: 'Run `claude setup-token` and export ANTHROPIC_AUTH_TOKEN.',
          }),
        ],
        canWriteOutputDir: true,
        orphanTempDirs: [{ path: '/tmp/yuurei-old', ageMs: 1 }],
      },
      logger,
      'json',
    );

    const lines = logSpy.mock.calls.map((call) => call[0]) as string[];
    expect(lines.length).toBe(4);
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(parsed[0]).toEqual({
      level: 'info',
      message: 'claude-code: installed',
      version: '2.1.269 (Claude Code)',
      versionSupported: true,
      authUsable: false,
    });
    expect(parsed[1]).toEqual({
      level: 'warn',
      message: 'claude-code: authentication required — next steps',
      authGuidance: 'Run `claude setup-token` and export ANTHROPIC_AUTH_TOKEN.',
    });
    expect(parsed[2]).toEqual({ level: 'info', message: 'output directory writable: true' });
    expect(parsed[3]).toEqual({
      level: 'warn',
      message: 'found 1 orphaned isolation temp directory; run "yuurei clean" to remove them',
      paths: ['/tmp/yuurei-old'],
    });
  });

  it('suggests "yuurei clean" when orphans are found and stays silent otherwise', () => {
    const clean = makeLogger();
    printDoctorReport(
      { runtimes: [], canWriteOutputDir: true, orphanTempDirs: [] },
      clean.logger,
      'human',
    );
    expect(clean.messages.some((m) => m.message.includes('yuurei clean'))).toBe(false);

    const orphans = makeLogger();
    printDoctorReport(
      {
        runtimes: [],
        canWriteOutputDir: true,
        orphanTempDirs: [{ path: '/tmp/yuurei-old', ageMs: 1 }],
      },
      orphans.logger,
      'human',
    );
    const warn = orphans.messages.filter((m) => m.level === 'warn');
    expect(warn.some((m) => m.message.includes('WARNING: found 1 orphaned'))).toBe(true);
    expect(warn.some((m) => m.message.includes('yuurei clean'))).toBe(true);
  });

  it('lists orphaned temp dir paths one per line without truncation', () => {
    const count = 25;
    const orphanTempDirs = Array.from({ length: count }, (_, i) => ({
      path: `/tmp/yuurei-${i}`,
      ageMs: 1,
    }));

    const { logger, messages } = makeLogger();
    printDoctorReport({ runtimes: [], canWriteOutputDir: true, orphanTempDirs }, logger, 'human');

    const warn = messages.filter((m) => m.level === 'warn').map((m) => m.message);
    // The count and cleanup command appear first, before the path list.
    const countLineIndex = warn.findIndex((m) => m.includes('WARNING: found 25 orphaned'));
    expect(countLineIndex).toBeGreaterThanOrEqual(0);
    const cleanLineIndex = warn.findIndex((m) => m.includes('Run "yuurei clean" to remove them'));
    expect(cleanLineIndex).toBeGreaterThan(countLineIndex);
    const pathLines = warn.filter((m) => /^  \/tmp\/yuurei-\d+$/.test(m));
    expect(pathLines).toHaveLength(count);
    for (let i = 0; i < count; i++) {
      expect(pathLines).toContain(`  /tmp/yuurei-${i}`);
    }
  });
});
