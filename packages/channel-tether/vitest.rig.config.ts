// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The rig suite: integration tests against a long-lived local duoduo daemon. It needs
 * TETHER_RIG_RUNTIME_DIR and is not part of `pnpm test`.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["rig/**/*.rig.test.ts"],
    // One channel owns every assistant session on a daemon: when its mailroom starts, it
    // archives each one it holds no grant for. Two harnesses running at once would archive
    // each other's assistants, so the files run one at a time. For the same reason, two runs
    // of this suite must not share a rig at the same moment.
    fileParallelism: false
  }
});
