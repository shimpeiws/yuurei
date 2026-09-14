import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The published yuurei package version (`package.json` `version`). This is the
 * single source of the version for the CLI (`cli.version()`) and for the
 * `yuurei_version` the trace records as an observed property of the run. It is
 * **not** part of `requested_cell.digest` (ADR-0011): hashing it made every
 * release, documentation-only patches included, produce a different digest for
 * the same definition.
 *
 * `createRequire(import.meta.url)` resolves `../package.json` relative to the
 * compiled module (`dist/version.js`), so it reaches the manifest both from a
 * source checkout and from the packed tarball (`dist/` sits at the package
 * root, exactly one level below `package.json`).
 *
 * Distinct concepts, intentionally separate sources:
 * - **package version** (`packageVersion`, here): the npm release number;
 *   recorded as `yuurei_version`, not hashed into cell identity.
 * - **design version** (docs/design, v0.3): which design revision the current
 *   implementation tracks; independent of package releases.
 * - **trace schema version** (`TRACE_SCHEMA_VERSION` in `src/trace/schema.ts`):
 *   the on-disk `trace.json` shape, which only changes when that shape
 *   changes — never on package bumps (#113, schema comment).
 */
export const packageVersion: string = require('../package.json').version;
