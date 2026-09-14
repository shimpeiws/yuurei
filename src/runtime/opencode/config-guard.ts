import { dirname, isAbsolute, join, resolve } from 'node:path';
import { EXIT_CODES, YuureiError } from '../../cli/exit-codes.js';
import { parseJsonc } from './jsonc.js';
import { isRealPathWithin } from './path-safety.js';

/**
 * Rejects profile config entries that would let a profile reach a credential
 * outside the cell (design doc §20.5, §9.2), before anything is written:
 *
 * 1. A `{file:...}` variable reference that resolves outside the cell. OpenCode
 *    resolves such a reference relative to the declaring config file, or as an
 *    absolute / `~`-rooted path, and injects the file's contents into the
 *    config at that position. A spike confirmed a profile-supplied
 *    `provider.*.options.apiKey: "{file:~/.local/share/opencode/auth.json}"`
 *    reads the operator's real credential store under level0 (where HOME is the
 *    real home).
 * 2. A literal `apiKey` value. A profile that hardcodes a provider key would
 *    have it materialized into the cell's config and, unlike the opt-in
 *    auth.json bridge, left on disk under `--keep`. Only substitution forms
 *    (`{env:...}`, `{file:...}`) are allowed; a `{file:...}` one is still
 *    containment-checked above.
 *
 * JSON/JSONC config files are parsed and inspected on *decoded* values, so a
 * JSON string escape (`\u007e`, `\/`, `\u004b`) cannot hide either shape from a
 * raw-text scan. A JSON config that fails to parse is rejected (fail closed).
 * Non-JSON files are scanned as raw text as defense-in-depth.
 *
 * `destDir` is the directory the config files will be written to; `homeDir` is
 * the HOME the runtime will actually see (`isolation.env.HOME`), so `~` expands
 * to the isolated home under level1 and the real home under level0. When
 * `homeDir` is `null` (the parent process has no HOME, so the runtime would
 * resolve `~` through the passwd entry — a home the guard cannot see), any `~`
 * reference is refused rather than expanded to a misleading in-cell path.
 */
const FILE_REFERENCE_PATTERN = /\{file:([^}]*)\}/g;
const LITERAL_CREDENTIAL_KEY_PATTERN = /^api_?key$/i;
// The whole value must be exactly one substitution — no surrounding whitespace,
// no literal prefix/suffix — so `{env:SAFE}literal-secret` or ` {env:X} `
// cannot smuggle a credential past the check. Env names are identifiers; a file
// path may contain spaces but must start and end with a non-space character.
const ENV_SUBSTITUTION_PATTERN = /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;
const FILE_SUBSTITUTION_PATTERN = /^\{file:\S(?:[^{}]*\S)?\}$/;

export async function assertNoOpenCodeFileReferencesEscape(
  destDir: string,
  configFiles: Record<string, { content: Buffer; mode: number }>,
  homeDir: string | null,
  cellRoot: string,
): Promise<void> {
  for (const [relPath, file] of Object.entries(configFiles)) {
    const text = file.content.toString('utf8');
    // Declaring config file's directory: OpenCode resolves a relative `file`
    // reference against this, not the process cwd.
    const declaringDir = join(destDir, dirname(relPath));

    if (/\.jsonc?$/i.test(relPath)) {
      let parsed: unknown;
      try {
        parsed = parseJsonc(text);
      } catch (err) {
        throw new YuureiError(
          `profile config ${relPath} is not valid JSON/JSONC: ${err instanceof Error ? err.message : String(err)}`,
          EXIT_CODES.CONFIG_ERROR,
        );
      }
      await inspectJsonValue(parsed, relPath, declaringDir, homeDir, cellRoot);
      continue;
    }

    // Non-JSON config (markdown, YAML frontmatter): raw-text scan.
    for (const match of text.matchAll(FILE_REFERENCE_PATTERN)) {
      await checkFileReference(match[1] ?? '', relPath, declaringDir, homeDir, cellRoot);
    }
  }
}

async function inspectJsonValue(
  value: unknown,
  relPath: string,
  declaringDir: string,
  homeDir: string | null,
  cellRoot: string,
): Promise<void> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(FILE_REFERENCE_PATTERN)) {
      await checkFileReference(match[1] ?? '', relPath, declaringDir, homeDir, cellRoot);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      await inspectJsonValue(item, relPath, declaringDir, homeDir, cellRoot);
    }
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  for (const [key, child] of Object.entries(value)) {
    if (LITERAL_CREDENTIAL_KEY_PATTERN.test(key)) {
      // Only a single substitution is accepted as the whole value (no trim: a
      // surrounding space is part of the value). A literal string — including
      // an empty one or a substitution with a literal suffix/prefix — is
      // refused, and so is any non-string value (object, array, number, null),
      // so no credential value is ever written into the run directory.
      const isSubstitution =
        typeof child === 'string' &&
        (ENV_SUBSTITUTION_PATTERN.test(child) || FILE_SUBSTITUTION_PATTERN.test(child));
      if (!isSubstitution) {
        throw new YuureiError(
          `profile config ${relPath} hardcodes a provider apiKey; use a single {env:...} or {file:...} reference instead, so the credential is never written into the run directory`,
          EXIT_CODES.CONFIG_ERROR,
        );
      }
    }
    await inspectJsonValue(child, relPath, declaringDir, homeDir, cellRoot);
  }
}

async function checkFileReference(
  rawReference: string,
  relPath: string,
  declaringDir: string,
  homeDir: string | null,
  cellRoot: string,
): Promise<void> {
  const raw = rawReference.trim();
  if (raw === '') {
    throw new YuureiError(
      `profile config ${relPath} has an empty {file:} reference`,
      EXIT_CODES.CONFIG_ERROR,
    );
  }
  const expanded = expandHome(raw, homeDir, relPath);
  const resolved = isAbsolute(expanded) ? resolve(expanded) : resolve(declaringDir, expanded);
  if (!(await isRealPathWithin(cellRoot, resolved))) {
    throw new YuureiError(
      `profile config ${relPath} references a file outside the isolated cell: {file:${raw}} resolves to ${resolved}`,
      EXIT_CODES.CONFIG_ERROR,
    );
  }
}

function expandHome(raw: string, homeDir: string | null, relPath: string): string {
  if (raw === '~' || raw.startsWith('~/')) {
    // Without a HOME in the child environment the runtime would resolve `~`
    // through the passwd entry — a home the guard cannot see — so refuse
    // rather than expand to an in-cell path that diverges from the runtime.
    if (homeDir === null) {
      throw new YuureiError(
        `profile config ${relPath} uses a home reference ({file:${raw}}) but HOME is not set in the isolated environment, so it cannot be resolved safely`,
        EXIT_CODES.CONFIG_ERROR,
      );
    }
    return raw === '~' ? homeDir : join(homeDir, raw.slice(2));
  }
  // `~user` and other tilde forms are not resolved the same way everywhere;
  // refuse rather than risk mis-resolving one into the cell.
  if (raw.startsWith('~')) {
    throw new YuureiError(
      `profile config ${relPath} uses an unsupported home reference: {file:${raw}}`,
      EXIT_CODES.CONFIG_ERROR,
    );
  }
  return raw;
}
