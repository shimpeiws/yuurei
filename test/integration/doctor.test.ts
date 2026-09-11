import { mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { printDoctorReport, runDoctor } from '../../src/cli/doctor.js';
import { ORPHAN_TEMP_DIR_MIN_AGE_MS } from '../../src/isolation/tempdir.js';
import type { Logger } from '../../src/util/logger.js';

describe('yuurei doctor', () => {
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

  it('emits auth guidance when authUsable is false, not when true or null', () => {
    const messages: { level: string; message: string; data?: Record<string, unknown> }[] = [];
    const logger: Logger = {
      info: (message, data) => messages.push({ level: 'info', message, data }),
      warn: (message, data) => messages.push({ level: 'warn', message, data }),
      error: (message, data) => messages.push({ level: 'error', message, data }),
    };

    // authUsable: false + authGuidance → guidance emitted
    messages.length = 0;
    printDoctorReport(
      {
        runtimes: [
          {
            runtimeId: 'claude-code',
            installed: true,
            version: '2.1.0',
            versionSupported: true,
            authUsable: false,
            authGuidance: 'Run claude setup-token and export ANTHROPIC_AUTH_TOKEN.',
          },
        ],
        canWriteOutputDir: true,
        orphanTempDirs: [],
      },
      logger,
    );
    const warnMessages = messages.filter((m) => m.level === 'warn');
    expect(warnMessages.length).toBeGreaterThan(0);
    const guidanceMsg = warnMessages.find((m) => m.data?.['authGuidance'] !== undefined);
    expect(guidanceMsg).toBeDefined();
    expect(guidanceMsg?.data?.['authGuidance']).toContain('claude setup-token');
    expect(guidanceMsg?.data?.['authGuidance']).toContain('ANTHROPIC_AUTH_TOKEN');
    // No secrets appear in the output
    const allText = messages.map((m) => m.message + JSON.stringify(m.data ?? {})).join('\n');
    expect(allText).not.toContain('sk-ant-api03-');
    expect(allText).not.toContain('ANTHROPIC_AUTH_TOKEN=sk-ant-secret');

    // authUsable: true → no guidance
    messages.length = 0;
    printDoctorReport(
      {
        runtimes: [
          {
            runtimeId: 'claude-code',
            installed: true,
            version: '2.1.0',
            versionSupported: true,
            authUsable: true,
          },
        ],
        canWriteOutputDir: true,
        orphanTempDirs: [],
      },
      logger,
    );
    expect(messages.filter((m) => m.level === 'warn' && m.data?.['authGuidance'])).toHaveLength(0);

    // authUsable: null → no guidance
    messages.length = 0;
    printDoctorReport(
      {
        runtimes: [
          {
            runtimeId: 'claude-code',
            installed: true,
            version: null,
            versionSupported: null,
            authUsable: null,
          },
        ],
        canWriteOutputDir: true,
        orphanTempDirs: [],
      },
      logger,
    );
    expect(messages.filter((m) => m.level === 'warn' && m.data?.['authGuidance'])).toHaveLength(0);
  });

  it('suggests "yuurei clean" when orphans are found and stays silent otherwise', () => {
    const makeLogger = (messages: { level: string; message: string }[]): Logger => ({
      info: (message) => messages.push({ level: 'info', message }),
      warn: (message) => messages.push({ level: 'warn', message }),
      error: (message) => messages.push({ level: 'error', message }),
    });

    const cleanMessages: { level: string; message: string }[] = [];
    printDoctorReport(
      { runtimes: [], canWriteOutputDir: true, orphanTempDirs: [] },
      makeLogger(cleanMessages),
    );
    expect(cleanMessages.some((m) => m.message.includes('yuurei clean'))).toBe(false);

    const orphanMessages: { level: string; message: string }[] = [];
    printDoctorReport(
      {
        runtimes: [],
        canWriteOutputDir: true,
        orphanTempDirs: [{ path: '/tmp/yuurei-old', ageMs: 1 }],
      },
      makeLogger(orphanMessages),
    );
    expect(
      orphanMessages.some((m) => m.level === 'warn' && m.message.includes('yuurei clean')),
    ).toBe(true);
  });
});
