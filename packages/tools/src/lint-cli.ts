#!/usr/bin/env node
/**
 * `pnpm lint:tools`.
 *
 * A separate file because the guard that used to live at the bottom of
 * `lint.ts` — `import.meta.url === file://${process.argv[1]}` — stops being a
 * guard once the code is bundled. In a bundle both sides of that comparison
 * point at the bundle, so importing the library ran the linter, and every
 * `motif` command printed "tool schemas: clean" before doing anything.
 *
 * A library module should not have a main.
 */

import { CORE_TOOLS } from "./schemas.js";
import { formatFindings, lintTools } from "./lint.js";

const findings = lintTools(CORE_TOOLS);
process.stdout.write(formatFindings(findings) + "\n");
process.exit(findings.length > 0 ? 1 : 0);
