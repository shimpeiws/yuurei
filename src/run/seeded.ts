import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PatchResult } from './workspace.js';
import { hasForbiddenNameChar, renderNewFile, toPatchText } from './workspace.js';
import type { SeedManifest, WorkspaceChanges } from '../seed/types.js';
import { decodeUtf8Strict, isPathWithin } from '../util/fs.js';
import { sha256Digest } from '../util/hash.js';

/** Ascending order of a path's UTF-8 byte sequence, as `buildPatch` uses. */
function byUtf8Path(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export interface SeededCollectResult {
  diagnostics: string[];
  /** False when an I/O error leaves the copy possibly incomplete. */
  complete: boolean;
  /**
   * The observed change set against the baseline — trustworthy only when
   * `complete` is true; the pipeline records it only on that path.
   */
  changes: WorkspaceChanges;
}

/**
 * The seeded-mode counterpart of `copyWorkspace` (#202): copies the cell
 * workspace into the durable run workspace, retaining **only** the files
 * whose content differs from the materialized baseline — added and modified
 * files. An unchanged file is not retained, and a baseline path the run left
 * absent is reported as deleted rather than copied.
 *
 * Classification is by content digest alone: mode, mtime and other metadata
 * differences are not part of the recorded change set. Symlinks and special
 * files are skipped with the same fixed-string diagnostics as the unseeded
 * copy, and a failed copy leaves `complete` false so nothing derived from it
 * (changes.json, patch.diff) is recorded as if it were complete.
 */
export async function collectSeededWorkspace(
  sourceDir: string,
  destDir: string,
  baseline: SeedManifest,
): Promise<SeededCollectResult> {
  const diagnostics: string[] = [];
  const added: string[] = [];
  const modified: string[] = [];
  const present = new Set<string>();
  let symlinks = 0;
  let special = 0;
  let failed = false;

  async function walk(relativeDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(join(sourceDir, relativeDir), {
        withFileTypes: true,
        encoding: 'buffer',
      });
    } catch {
      failed = true;
      return;
    }
    for (const entry of entries) {
      // Names are decoded from their raw bytes: a name that is not valid
      // UTF-8 cannot be recorded in the change set, so collection reports
      // incomplete rather than silently renaming the file. A literal
      // U+FFFD in a name decodes successfully and keeps its real name.
      const name = decodeUtf8Strict(entry.name);
      if (name === null) {
        failed = true;
        continue;
      }
      const rel = relativeDir === '' ? name : `${relativeDir}/${name}`;
      if (entry.isDirectory()) {
        await walk(rel);
      } else if (entry.isFile()) {
        present.add(rel);
        let content: Buffer;
        try {
          content = await readFile(join(sourceDir, rel));
        } catch {
          failed = true;
          continue;
        }
        const baselineEntry = baseline[rel];
        if (baselineEntry === undefined) {
          added.push(rel);
        } else if (baselineEntry.digest === sha256Digest(content)) {
          continue;
        } else {
          modified.push(rel);
        }
        try {
          await mkdir(dirname(join(destDir, rel)), { recursive: true });
          await writeFile(join(destDir, rel), content);
        } catch {
          failed = true;
        }
      } else if (entry.isSymbolicLink()) {
        symlinks += 1;
      } else {
        special += 1;
      }
    }
  }

  await walk('');

  const deleted = Object.keys(baseline).filter((path) => !present.has(path));

  if (symlinks > 0) diagnostics.push(`workspace: ${symlinks} symlink(s) skipped`);
  if (special > 0) diagnostics.push(`workspace: ${special} special file(s) skipped`);
  if (failed) diagnostics.push('workspace: copy failed; durable workspace may be incomplete');
  return {
    diagnostics,
    complete: !failed,
    changes: {
      added: added.sort(byUtf8Path),
      modified: modified.sort(byUtf8Path),
      deleted: deleted.sort(byUtf8Path),
    },
  };
}

/** The durable record written to `changes.json` on a seeded run. */
export function toChangesManifest(
  baselineDigest: string,
  changes: WorkspaceChanges,
): Record<string, unknown> {
  return {
    version: 1,
    baseline_digest: baselineDigest,
    added: changes.added,
    modified: changes.modified,
    deleted: changes.deleted,
  };
}

export interface SeededPatchContext {
  /** The durable run workspace — holds the run's added and modified files. */
  workspaceDir: string;
  /** The untouched source repository root — supplies baseline file bytes. */
  sourceDir: string;
  /** The materialized baseline manifest used to verify baseline bytes. */
  baseline: SeedManifest;
}

type ReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'binary' | 'oversized' | 'unavailable' };

/** The run's side of a changed file, read from the durable workspace. */
async function readResultText(
  workspaceDir: string,
  path: string,
  maxBytes: number,
): Promise<ReadResult> {
  const full = join(workspaceDir, path);
  // Stat and read through one handle so the size check and the read cannot
  // observe different files (TOCTOU). O_NONBLOCK keeps a FIFO planted in
  // the durable workspace from blocking the open; the stat below rejects
  // it as unavailable.
  const handle = await open(full, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) return { ok: false, reason: 'unavailable' };
    if (fileStat.size > maxBytes) return { ok: false, reason: 'oversized' };
    const text = toPatchText(await handle.readFile());
    return text === null ? { ok: false, reason: 'binary' } : { ok: true, text };
  } finally {
    await handle.close();
  }
}

/**
 * The baseline's side of a changed file, re-read from the untouched source
 * repository — the baseline tree is deliberately not retained, so the old
 * bytes come from the original worktree. They are used only when the file is
 * still a regular file whose content digest matches the baseline manifest;
 * otherwise the change is omitted and counted as baseline-unavailable rather
 * than silently rendered against drifted content.
 */
async function readBaselineText(
  context: SeededPatchContext,
  path: string,
  maxBytes: number,
): Promise<ReadResult> {
  const full = join(context.sourceDir, path);
  // Paths come from the baseline manifest, validated at resolve time; this
  // is defense in depth — a path that resolves outside the source root is
  // never read.
  if (!(await isPathWithin(context.sourceDir, full))) {
    return { ok: false, reason: 'unavailable' };
  }
  // A blocking open would hang on a FIFO until a writer appears — and a
  // baseline path can legitimately become one between seed resolution and
  // patch generation — so the open is non-blocking and the descriptor
  // itself is validated with fstat below: the fd pins the inode, so the
  // size check and the read cannot observe different files (TOCTOU).
  const handle = await open(full, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
  if (handle === null) return { ok: false, reason: 'unavailable' };
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) return { ok: false, reason: 'unavailable' };
    if (fileStat.size > maxBytes) return { ok: false, reason: 'oversized' };
    const content = await handle.readFile();
    if (sha256Digest(content) !== context.baseline[path]?.digest) {
      return { ok: false, reason: 'unavailable' };
    }
    const text = toPatchText(content);
    return text === null ? { ok: false, reason: 'binary' } : { ok: true, text };
  } finally {
    await handle.close();
  }
}

/**
 * Builds a unified diff of the run's changes against the materialized
 * baseline (#202). Added files use the same all-additions hunk as the
 * empty-workspace format; a deleted file emits `--- <path>` / `+++ /dev/null`
 * with a hunk removing every old line; a modified file emits a single hunk
 * replacing all old lines with all new ones. Entries are ordered by the
 * UTF-8 byte sequence of their path, independently of the change kind.
 *
 * The same omission rules apply on both sides of a change — a file that is
 * binary, oversized, or unrepresentably named is omitted, and baseline
 * content that no longer verifies against the manifest is omitted as
 * `baseline content unavailable`. Every omission is a fixed string with a
 * count, never a path.
 */
export async function buildSeededPatch(
  changes: WorkspaceChanges,
  context: SeededPatchContext,
  maxBytes: number,
): Promise<PatchResult> {
  const diagnostics: string[] = [];
  const entries = [
    ...changes.added.map((path) => ({ path, kind: 'added' as const })),
    ...changes.modified.map((path) => ({ path, kind: 'modified' as const })),
    ...changes.deleted.map((path) => ({ path, kind: 'deleted' as const })),
  ];

  const representable: typeof entries = [];
  let unrepresentable = 0;
  for (const entry of entries) {
    if (entry.path.split('/').some(hasForbiddenNameChar)) {
      unrepresentable += 1;
    } else {
      representable.push(entry);
    }
  }
  representable.sort((a, b) => byUtf8Path(a.path, b.path));

  let binary = 0;
  let oversized = 0;
  let overTotal = 0;
  let baselineUnavailable = 0;
  let stopped = false;
  let diff = '';
  let diffBytes = 0;

  for (const entry of representable) {
    if (stopped) {
      overTotal += 1;
      continue;
    }
    let fileDiff: string;
    if (entry.kind === 'added') {
      const next = await readResultText(context.workspaceDir, entry.path, maxBytes);
      if (!next.ok) {
        bump(next.reason);
        continue;
      }
      fileDiff = renderNewFile(entry.path, next.text);
    } else if (entry.kind === 'deleted') {
      const previous = await readBaselineText(context, entry.path, maxBytes);
      if (!previous.ok) {
        bump(previous.reason);
        continue;
      }
      fileDiff = renderDeletedFile(entry.path, previous.text);
    } else {
      const next = await readResultText(context.workspaceDir, entry.path, maxBytes);
      if (!next.ok) {
        bump(next.reason);
        continue;
      }
      const previous = await readBaselineText(context, entry.path, maxBytes);
      if (!previous.ok) {
        bump(previous.reason);
        continue;
      }
      fileDiff = renderModifiedFile(entry.path, previous.text, next.text);
    }
    if (diffBytes + Buffer.byteLength(fileDiff, 'utf8') > maxBytes) {
      stopped = true;
      overTotal += 1;
      continue;
    }
    diff += fileDiff;
    diffBytes += Buffer.byteLength(fileDiff, 'utf8');
  }

  function bump(reason: 'binary' | 'oversized' | 'unavailable'): void {
    if (reason === 'binary') binary += 1;
    else if (reason === 'oversized') oversized += 1;
    else baselineUnavailable += 1;
  }

  if (binary > 0) diagnostics.push(`patch: ${binary} binary file(s) omitted`);
  if (oversized > 0) diagnostics.push(`patch: ${oversized} oversized file(s) omitted`);
  if (unrepresentable > 0) {
    diagnostics.push(`patch: ${unrepresentable} unrepresentable name(s) omitted`);
  }
  if (baselineUnavailable > 0) {
    diagnostics.push(`patch: ${baselineUnavailable} file(s) omitted; baseline content unavailable`);
  }
  if (overTotal > 0) diagnostics.push(`patch: ${overTotal} file(s) omitted over the total cap`);
  return { diff, diagnostics };
}

/** Split text into LF-separated lines, keeping whether it ends in a newline. */
function splitLines(text: string): { lines: string[]; endsWithNewline: boolean } {
  // An empty file has zero lines, not one empty line: `''.split('\n')` yields
  // `['']`, which would render a fabricated blank line (and a no-newline
  // marker) into the patch, making it unable to reproduce the change.
  if (text.length === 0) return { lines: [], endsWithNewline: false };
  const endsWithNewline = text.endsWith('\n');
  return { lines: (endsWithNewline ? text.slice(0, -1) : text).split('\n'), endsWithNewline };
}

/**
 * One deleted file: `--- <path>` / `+++ /dev/null` headers, plus a hunk
 * removing every old line — or the headers alone when the file was empty.
 */
function renderDeletedFile(path: string, text: string): string {
  const header = `--- ${path}\n+++ /dev/null\n`;
  if (text.length === 0) return header;
  const { lines, endsWithNewline } = splitLines(text);
  const hunk = `@@ -1,${lines.length} +0,0 @@\n`;
  const removed = lines.map((line) => `-${line}\n`).join('');
  const noNewline = endsWithNewline ? '' : '\\ No newline at end of file\n';
  return `${header}${hunk}${removed}${noNewline}`;
}

/**
 * One modified file: `--- <path>` / `+++ <path>` headers plus a single hunk
 * that removes every old line and adds every new one — a correct, if
 * non-minimal, unified diff of the change. An empty side uses the `0,0`
 * start convention, matching the all-additions format.
 */
function renderModifiedFile(path: string, oldText: string, newText: string): string {
  const header = `--- ${path}\n+++ ${path}\n`;
  const oldSide = splitLines(oldText);
  const newSide = splitLines(newText);
  const oldStart = oldSide.lines.length === 0 ? 0 : 1;
  const newStart = newSide.lines.length === 0 ? 0 : 1;
  const hunk = `@@ -${oldStart},${oldSide.lines.length} +${newStart},${newSide.lines.length} @@\n`;
  const removed = oldSide.lines.map((line) => `-${line}\n`).join('');
  const added = newSide.lines.map((line) => `+${line}\n`).join('');
  // A zero-line side cannot end without a newline: the marker describes a
  // trailing line that does not exist.
  const oldNoNewline =
    oldSide.lines.length > 0 && !oldSide.endsWithNewline ? '\\ No newline at end of file\n' : '';
  const newNoNewline =
    newSide.lines.length > 0 && !newSide.endsWithNewline ? '\\ No newline at end of file\n' : '';
  return `${header}${hunk}${removed}${oldNoNewline}${added}${newNoNewline}`;
}
