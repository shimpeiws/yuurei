import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The published yuurei package version (`package.json` `version`). This is the
 * single source of the version for both the CLI (`cli.version()`) and cell
 * identity (`RunPipelineInput.yuureiVersion`, which the digest hashes) — a
 * package bump must update both, or cells silently carry a stale version in
 * their identity (#113).
 *
 * `createRequire(import.meta.url)` resolves `../package.json` relative to the
 * compiled module (`dist/version.js`), so it reaches the manifest both from a
 * source checkout and from the packed tarball (`dist/` sits at the package
 * root, exactly one level below `package.json`).
 *
 * Distinct concepts, intentionally separate sources:
 * - **package version** (`packageVersion`, here): the npm release number;
 *   part of the cell digest, so identical work against a different release is
 *   a different cell.
 * - **design version** (docs/design, v0.3): which design revision the current
 *   implementation tracks; independent of package releases.
 * - **trace schema version** (`TRACE_SCHEMA_VERSION` in `src/trace/schema.ts`):
 *   the on-disk `trace.json` shape, which only changes when that shape
 *   changes — never on package bumps (#113, schema comment).
 */
export const packageVersion: string = require('../package.json').version;
