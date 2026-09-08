/**
 * Environment variables that are safe to forward into an isolated run
 * unchanged (e.g. terminal/locale basics). Everything else is dropped
 * unless a runtime adapter explicitly re-adds something it needs.
 */
const ALLOWED_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ'];

export function buildRestrictedEnv(
  source: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
): Record<string, string> {
  const restricted: Record<string, string> = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      restricted[key] = value;
    }
  }
  return { ...restricted, ...overrides };
}
