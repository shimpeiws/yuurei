import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import type { ZodType } from 'zod';
import { EXIT_CODES, YuureiError } from '../cli/exit-codes.js';

/**
 * Reads and validates a YAML config file, mapping every failure — an
 * unreadable file, malformed YAML, or a schema violation — to a configuration
 * error (exit 2). A bad config file is configuration, not a runtime failure.
 */
export async function loadYamlConfig<T>(path: string, schema: ZodType<T>): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new YuureiError(
      `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODES.CONFIG_ERROR,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new YuureiError(
      `invalid YAML in ${path}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODES.CONFIG_ERROR,
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new YuureiError(`invalid ${path}: ${issues}`, EXIT_CODES.CONFIG_ERROR);
  }
  return result.data;
}
