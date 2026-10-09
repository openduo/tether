// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Third-party notices for the bundled channel. esbuild inlines the runtime
 * dependencies into dist/ and drops their legal comments, so the license text
 * of every package that reaches the bundle ships beside it in
 * THIRD_PARTY_NOTICES.md. The package list comes from esbuild's metafile: the
 * inputs that actually landed in an output, not package.json.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Packages the owner of this repository publishes without a license field.
 * They are listed with a statement instead of failing the build.
 */
const SAME_OWNER = new Map([
  ["@openduo/protocol", "license not declared by the package; published by openduo"]
]);

const LEGAL_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;

/** The package root an input path belongs to, or undefined for first-party source. */
function packageRoot(input) {
  const posix = input.split("\\").join("/");
  const at = posix.lastIndexOf("node_modules/");
  if (at === -1) return undefined;
  const rest = posix.slice(at + "node_modules/".length).split("/");
  const depth = rest[0].startsWith("@") ? 2 : 1;
  return posix.slice(0, at) + "node_modules/" + rest.slice(0, depth).join("/");
}

function licenseField(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((l) => (typeof l === "string" ? l : l?.type)).filter(Boolean);
    if (types.length > 0) return types.join(" OR ");
  }
  return undefined;
}

/**
 * Every package with at least one input in the given metafiles.
 * @param {Array<{inputs: Record<string, unknown>, outputs: Record<string, {inputs: Record<string, unknown>}>}>} metafiles
 * @param {string} workingDir the directory metafile paths are relative to
 */
export function bundledPackages(metafiles, workingDir) {
  const roots = new Set();
  for (const meta of metafiles) {
    for (const output of Object.values(meta.outputs)) {
      for (const input of Object.keys(output.inputs)) {
        const root = packageRoot(input);
        if (root) roots.add(resolve(workingDir, root));
      }
    }
  }
  const byId = new Map();
  for (const dir of roots) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const id = `${pkg.name}@${pkg.version}`;
    if (byId.has(id)) continue;
    const files = readdirSync(dir)
      .filter((f) => LEGAL_FILE.test(f))
      .sort();
    byId.set(id, {
      id,
      name: pkg.name,
      version: pkg.version,
      license: licenseField(pkg),
      texts: files.map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8").trimEnd() }))
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The notices document; throws on a package with neither license field nor license file. */
export function renderNotices(packages) {
  const unlicensed = [];
  const parts = [
    "# Third-party notices",
    "",
    "The files in `dist/` bundle the packages below. Each is listed with its declared license",
    "and the license and notice files it ships.",
    ""
  ];
  for (const p of packages) {
    let license = p.license;
    if (!license && p.texts.length === 0) {
      license = SAME_OWNER.get(p.name);
      if (!license) {
        unlicensed.push(p.id);
        continue;
      }
    }
    parts.push(`## ${p.id}`, "", `License: ${license ?? "see the license file below"}`, "");
    for (const t of p.texts) {
      parts.push(`### ${t.file}`, "", "```text", t.text, "```", "");
    }
  }
  if (unlicensed.length > 0) {
    throw new Error(
      `bundled packages with neither a license field nor a license file: ${unlicensed.join(", ")}`
    );
  }
  return parts.join("\n");
}

/** Throws unless the notices document has a section for every package. */
export function assertNoticesCover(notices, packages) {
  const headings = new Set(
    notices
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3))
  );
  const missing = packages.map((p) => p.id).filter((id) => !headings.has(id));
  if (missing.length > 0) {
    throw new Error(`THIRD_PARTY_NOTICES.md does not list: ${missing.join(", ")}`);
  }
}
