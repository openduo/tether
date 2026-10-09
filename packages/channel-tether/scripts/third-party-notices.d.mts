// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import type { Metafile } from "esbuild";

export interface BundledPackage {
  id: string;
  name: string;
  version: string;
  license: string | undefined;
  texts: Array<{ file: string; text: string }>;
}

export function bundledPackages(metafiles: Metafile[], workingDir: string): BundledPackage[];
export function renderNotices(packages: BundledPackage[]): string;
export function assertNoticesCover(notices: string, packages: BundledPackage[]): void;
