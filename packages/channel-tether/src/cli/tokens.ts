// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * One token file per host under `$XDG_CONFIG_HOME/duoduo-tether/` (default
 * `~/.config/duoduo-tether/`): the directory 0700, each file 0600, written by rename
 * so a reader never sees half a file.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isRecord } from "@openduo/protocol";
import { CliExit, EXIT } from "./io";

export type Connection = { publicUrl: string; grant: string; token: string };

type TokenFile = { public_url: string; grant: string; token: string };

/** XDG Base Directory: a relative XDG_CONFIG_HOME is invalid and ignored. */
export function tokenDir(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base =
    xdg !== undefined && path.isAbsolute(xdg) ? xdg : path.join(env.HOME ?? "", ".config");
  // The command's own name: "tether" alone could be another tool's directory.
  return path.join(base, "duoduo-tether");
}

export function hostOf(publicUrl: string): string {
  return new URL(publicUrl).host;
}

export function tokenPath(env: Record<string, string | undefined>, host: string): string {
  return path.join(tokenDir(env), `${host}.json`);
}

export async function saveConnection(
  env: Record<string, string | undefined>,
  connection: Connection
): Promise<string> {
  const dir = tokenDir(env);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const host = hostOf(connection.publicUrl);
  const file = tokenPath(env, host);
  const temp = path.join(dir, `.${host}.json.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const body: TokenFile = {
    public_url: connection.publicUrl,
    grant: connection.grant,
    token: connection.token
  };
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(body, null, 2)}\n`);
    } finally {
      await handle.close();
    }
    await fs.chmod(temp, 0o600);
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
  return file;
}

/** The hosts with a token file, sorted; temp files start with a dot. */
export async function savedHosts(env: Record<string, string | undefined>): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(tokenDir(env));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

/** The connection `--host` names, or the only one there is. */
export async function loadConnection(
  env: Record<string, string | undefined>,
  host: string | undefined
): Promise<{ connection: Connection; file: string }> {
  const hosts = await savedHosts(env);
  if (host === undefined) {
    if (hosts.length === 0) {
      throw new CliExit(
        EXIT.usage,
        `Not logged in: ${tokenDir(env)} holds no token file. Run duoduo-tether login <public url>.`
      );
    }
    if (hosts.length > 1) {
      throw new CliExit(
        EXIT.usage,
        `Logged in to several hosts (${hosts.join(", ")}). Name one with --host <host>.`
      );
    }
    host = hosts[0] as string;
  } else if (!hosts.includes(host)) {
    throw new CliExit(
      EXIT.usage,
      `Not logged in to ${host}.${hosts.length > 0 ? ` Logged in to: ${hosts.join(", ")}.` : ""}` +
        ` Run duoduo-tether login <public url>.`
    );
  }
  const file = tokenPath(env, host);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    throw new CliExit(
      EXIT.usage,
      `${file} could not be read (${error instanceof Error ? error.message : String(error)}).` +
        ` Delete it and log in again.`
    );
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.public_url !== "string" ||
    typeof parsed.grant !== "string" ||
    typeof parsed.token !== "string"
  ) {
    throw new CliExit(
      EXIT.usage,
      `${file} is not a token file duoduo-tether wrote. Delete it and log in again.`
    );
  }
  return {
    connection: { publicUrl: parsed.public_url, grant: parsed.grant, token: parsed.token },
    file
  };
}
