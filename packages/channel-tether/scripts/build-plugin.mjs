// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { rm } from "node:fs/promises";
import { build } from "esbuild";

// The bundle is ESM, but bundled CommonJS dependencies (Fastify's) assume
// `require`, `__dirname` and `__filename`; the banner defines them.
const banner = [
  "#!/usr/bin/env node",
  'import { createRequire as __createRequire } from "node:module";',
  'import { fileURLToPath as __fileURLToPath } from "node:url";',
  'import { dirname as __dirnameOf } from "node:path";',
  "const require = __createRequire(import.meta.url);",
  "const __filename = __fileURLToPath(import.meta.url);",
  "const __dirname = __dirnameOf(__filename);"
].join("\n");

await rm("dist", { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  logLevel: "info",
  banner: { js: banner }
};

// Two entry points of one package: the channel duoduo starts, and the
// duoduo-tether command line a person or an agent runs.
await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/plugin.js" });
await build({ ...common, entryPoints: ["src/cli/bin.ts"], outfile: "dist/cli.js" });
