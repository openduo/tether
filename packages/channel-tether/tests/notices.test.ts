// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  assertNoticesCover,
  bundledPackages,
  renderNotices
} from "../scripts/third-party-notices.mjs";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

async function metafile(entry: string) {
  const result = await build({
    absWorkingDir: PACKAGE_DIR,
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    write: false,
    metafile: true,
    outfile: "out.js",
    logLevel: "silent"
  });
  return result.metafile;
}

describe("third-party notices", () => {
  it("lists every package that reaches the bundle", async () => {
    const metas = [await metafile("src/main.ts"), await metafile("src/cli/bin.ts")];
    const packages = bundledPackages(metas, PACKAGE_DIR);
    expect(packages.map((p) => p.name)).toEqual(
      expect.arrayContaining(["@openduo/protocol", "fastify", "jose"])
    );
    const notices = renderNotices(packages);
    expect(() => assertNoticesCover(notices, packages)).not.toThrow();
    for (const p of packages) expect(notices).toContain(`## ${p.id}\n`);
  });

  it("refuses a bundled package with neither license field nor license file", () => {
    const stray = {
      id: "stray@1.0.0",
      name: "stray",
      version: "1.0.0",
      license: undefined,
      texts: []
    };
    expect(() => renderNotices([stray])).toThrow(/stray@1.0.0/);
  });

  it("states the same-owner protocol package instead of failing", () => {
    const protocol = {
      id: "@openduo/protocol@0.8.4",
      name: "@openduo/protocol",
      version: "0.8.4",
      license: undefined,
      texts: []
    };
    expect(renderNotices([protocol])).toContain(
      "License: license not declared by the package; published by openduo"
    );
  });

  it("names the missing package when a section is absent", () => {
    const pkg = { id: "a@1.0.0", name: "a", version: "1.0.0", license: "MIT", texts: [] };
    expect(() => assertNoticesCover("# Third-party notices\n", [pkg])).toThrow(/a@1.0.0/);
  });
});
