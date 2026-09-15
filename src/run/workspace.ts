import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Characters in a path component that cannot be represented in a diff header. */
const FORBIDDEN_NAME_CHARS = ['\u0000', '\n', '\r', '\t', '\\'];

function hasForbiddenNameChar(component: string): boolean {
  return FORBIDDEN_NAME_CHARS.some((char) => component.includes(char));
}

/**
 * Copies the cell workspace into the durable run workspace (ADR-0016). Only
 * regular files are copied; a symlink entry is skipped and never followed, and
 * directories are recreated. Every skip and a failed copy are reported as fixed
 * strings; the count is the only variable and no path is included.
 */
export async function copyWorkspace(sourceDir: string, destDir: string): Promise<string[]> {
  const diagnostics: string[] = [];
  let symlinks = 0;
  let special = 0;
  let failed = false;

  async function walk(relativeDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(join(sourceDir, relativeDir), { withFileTypes: true });
    } catch {
      failed = true;
      return;
    }
    for (const entry of entries) {
      const rel = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        try {
          await mkdir(join(destDir, rel), { recursive: true });
        } catch {
          failed = true;
          continue;
        }
        await walk(rel);
      } else if (entry.isFile()) {
        try {
          // `isFile()` is false for a symlink, so this reads only entries the
          // walk saw as regular files. A filesystem actor that swaps one for a
          // symlink between the check and the read is out of scope (§12.1), the
          // same check-then-read race profile materialization already accepts.
          await writeFile(join(destDir, rel), await readFile(join(sourceDir, rel)));
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

  if (symlinks > 0) diagnostics.push(`workspace: ${symlinks} symlink(s) skipped`);
  if (special > 0) diagnostics.push(`workspace: ${special} special file(s) skipped`);
  if (failed) diagnostics.push('workspace: copy failed; durable workspace may be incomplete');
  return diagnostics;
}

export interface PatchResult {
  diff: string;
  diagnostics: string[];
}

/**
 * Builds an all-additions unified diff of the workspace against the empty base
 * (ADR-0016). Files are added in UTF-8 byte order until the next would take the
 * patch past `maxBytes`; binary, oversized and unrepresentably named files are
 * omitted. Every omission is a fixed string with a count, never a path.
 */
export async function buildPatch(workspaceDir: string, maxBytes: number): Promise<PatchResult> {
  const diagnostics: string[] = [];
  const files: string[] = [];

  async function collect(relativeDir: string): Promise<void> {
    const entries = await readdir(join(workspaceDir, relativeDir), { withFileTypes: true });
    for (const entry of entries) {
      const rel = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) await collect(rel);
      else if (entry.isFile()) files.push(rel);
    }
  }
  await collect('');

  const representable: string[] = [];
  let unrepresentable = 0;
  for (const rel of files) {
    if (rel.split('/').some((part) => part.includes('\uFFFD') || hasForbiddenNameChar(part))) {
      unrepresentable += 1;
    } else {
      representable.push(rel);
    }
  }
  representable.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));

  let binary = 0;
  let oversized = 0;
  let overTotal = 0;
  let stopped = false;
  let diff = '';
  let diffBytes = 0;

  for (const rel of representable) {
    if (stopped) {
      overTotal += 1;
      continue;
    }
    // Size is checked before reading so a single huge file cannot be buffered.
    if ((await stat(join(workspaceDir, rel))).size > maxBytes) {
      oversized += 1;
      continue;
    }
    // The durable workspace is trusted here: `copyWorkspace` produced it from
    // the cell after the runtime exited, so it holds no symlinks and is not
    // being written to. A plain read is safe under that assumption.
    const content = await readFile(join(workspaceDir, rel));
    if (content.includes(0)) {
      binary += 1;
      continue;
    }
    const text = content.toString('utf8');
    // Invalid UTF-8 decodes to the replacement character.
    if (text.includes('\uFFFD')) {
      binary += 1;
      continue;
    }
    const fileDiff = renderNewFile(rel, text);
    if (diffBytes + Buffer.byteLength(fileDiff, 'utf8') > maxBytes) {
      stopped = true;
      overTotal += 1;
      continue;
    }
    diff += fileDiff;
    diffBytes += Buffer.byteLength(fileDiff, 'utf8');
  }

  if (binary > 0) diagnostics.push(`patch: ${binary} binary file(s) omitted`);
  if (oversized > 0) diagnostics.push(`patch: ${oversized} oversized file(s) omitted`);
  if (unrepresentable > 0) {
    diagnostics.push(`patch: ${unrepresentable} unrepresentable name(s) omitted`);
  }
  if (overTotal > 0) diagnostics.push(`patch: ${overTotal} file(s) omitted over the total cap`);
  return { diff, diagnostics };
}

/** One file as an all-additions hunk, or headers only when it is empty. */
function renderNewFile(path: string, text: string): string {
  const header = `--- /dev/null\n+++ ${path}\n`;
  if (text.length === 0) return header;
  const endsWithNewline = text.endsWith('\n');
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split('\n');
  const hunk = `@@ -0,0 +1,${lines.length} @@\n`;
  const added = lines.map((line) => `+${line}\n`).join('');
  const noNewline = endsWithNewline ? '' : '\\ No newline at end of file\n';
  return `${header}${hunk}${added}${noNewline}`;
}
