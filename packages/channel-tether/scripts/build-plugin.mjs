// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { assertNoticesCover, bundledPackages, renderNotices } from "./third-party-notices.mjs";

const NOTICES = "THIRD_PARTY_NOTICES.md";

// The bundle carries this package's SPDX header after the shebang. It is ESM,
// but bundled CommonJS dependencies (Fastify's) assume `require`, `__dirname`
// and `__filename`; the banner defines them.
const banner = [
  "#!/usr/bin/env node",
  "// Copyright 2026 openduo",
  "// SPDX-License-Identifier: FSL-1.1-Apache-2.0",
  'import { createRequire as __createRequire } from "node:module";',
  'import { fileURLToPath as __fileURLToPath } from "node:url";',
  'import { dirname as __dirnameOf } from "node:path";',
  "const require = __createRequire(import.meta.url);",
  "const __filename = __fileURLToPath(import.meta.url);",
  "const __dirname = __dirnameOf(__filename);"
].join("\n");

await rm("dist", { recursive: true, force: true });
await rm(NOTICES, { force: true });

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  logLevel: "info",
  metafile: true,
  banner: { js: banner }
};

// Two entry points of one package: the channel duoduo starts, and the
// duoduo-tether command line a person or an agent runs.
const plugin = await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/plugin.js" });
const cli = await build({ ...common, entryPoints: ["src/cli/bin.ts"], outfile: "dist/cli.js" });

// The bundled dependencies' license texts, which legalComments: "none" keeps
// out of dist/, ship beside the bundle instead.
const packages = bundledPackages([plugin.metafile, cli.metafile], process.cwd());
await writeFile(NOTICES, renderNotices(packages));
assertNoticesCover(await readFile(NOTICES, "utf8"), packages);
console.log(`${NOTICES}: ${packages.length} bundled package(s)`);
