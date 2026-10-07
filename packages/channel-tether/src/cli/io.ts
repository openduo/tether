// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Everything duoduo-tether touches outside itself, passed in, so tests run
 * every command against a real channel without a terminal or a browser.
 */

import { spawn } from "node:child_process";
import readline from "node:readline";

/** The exit codes docs/cli.md lists. */
export const EXIT = {
  ok: 0,
  /** The tool refused, the server answered a JSON-RPC error, or a local step failed. */
  refused: 1,
  /** The command line is wrong, or no token file is chosen. */
  usage: 2,
  /** The host refused the token (HTTP 401). */
  token: 3,
  /** The host could not be reached or answered another HTTP error. */
  unreachable: 4
} as const;

/** Ends a command with `code`; `message` goes to standard error. */
export class CliExit extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

export type ListenTiming = { idleMs: number; retryMinMs: number; retryMaxMs: number };

export type CliIo = {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** All of standard input, for `send` without a message argument. */
  readStdin: () => Promise<string>;
  /** Standard input line by line, for a pasted address during `login`. */
  stdinLines: () => { lines: AsyncIterable<string>; close: () => void };
  openBrowser: (url: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** In [0, 1), for the reconnect jitter. */
  random: () => number;
  /** Tests only; the command uses the constants in listen.ts. */
  listenTiming?: ListenTiming;
};

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The browser command of each platform; anywhere else the URL is only printed. */
function browserCommand(url: string): [string, string[]] | null {
  if (process.platform === "darwin") return ["open", [url]];
  if (process.platform === "win32") return ["cmd", ["/c", "start", '""', url]];
  if (process.platform === "linux") return ["xdg-open", [url]];
  return null;
}

export function processIo(): CliIo {
  return {
    env: process.env,
    fetch: globalThis.fetch,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin: readAll,
    stdinLines: () => {
      const lines = readline.createInterface({ input: process.stdin, terminal: false });
      return { lines, close: () => lines.close() };
    },
    openBrowser: (url) => {
      const command = browserCommand(url);
      if (command === null) return;
      // A machine with no browser fails here; the printed URL is the way on.
      const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
      child.on("error", () => undefined);
      child.unref();
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: Math.random
  };
}
