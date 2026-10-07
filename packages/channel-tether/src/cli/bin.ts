// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** The `duoduo-tether` executable; the plugin's entry is src/main.ts. */

import { processIo } from "./io";
import { runCli } from "./main";

void runCli(process.argv.slice(2), processIo()).then((code) => {
  // Exit once both streams are flushed: a pipe on macOS is written asynchronously, and a
  // finished login can leave standard input open, which would keep the process alive.
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
});
