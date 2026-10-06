// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The plugin's configuration, all from `~/.config/duoduo/.env` through the
 * manifest's envAllowlist. There is no switch: installing and starting the
 * plugin is the opt-in.
 *
 * Every operational number has a code default and stays overridable by its
 * config key.
 */

import { isIP } from "node:net";
import { DEFAULT_PULL_WAIT_MS, RESERVED_SOURCE_PREFIXES } from "@openduo/protocol";

/**
 * RFC 6749 section 4.1.2: "A maximum authorization code lifetime of 10 minutes
 * is RECOMMENDED." The passkey challenge is the same ceremony, so it takes the
 * same grounds. Both stay config values.
 */
const RFC6749_CODE_LIFETIME_MS = 10 * 60 * 1000;

const MIB = 1024 * 1024;

/** Code defaults; each is overridable by the config key beside it. */
export const DEFAULTS = {
  /** Fastify's own default body limit. */
  requestLimitBytes: MIB,
  /** Bounds challenge memory under /authorize spam; real connects hold a handful. */
  challengeCap: 1000,
  /** A client metadata document is a small JSON file on the client's own host. */
  cimdTimeoutMs: 10_000,
  cimdMaxBytes: 64 * 1024,
  /** The mail long poll takes the channel pull wait. */
  pullWaitMs: DEFAULT_PULL_WAIT_MS
} as const;

/**
 * Names an assistant may not take beyond duoduo's internal source kinds: the
 * record sources duoduo reserves (an assistant's name is its record source), and `help`,
 * which every host verb reads as a request for help, so `revoke help` could
 * never revoke.
 */
export const RESERVED_TETHER_NAMES: readonly string[] = [...RESERVED_SOURCE_PREFIXES, "help"];

export const SCOPES = [
  "context:read",
  "memory:read",
  "events:read",
  "sessions:read",
  "sessions:notify",
  "experience:write"
] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * The three mail tools take the send and list scopes; MCP Events, which only
 * says "you have mail", takes the same.
 */
export const MAIL_SCOPES: readonly Scope[] = ["sessions:notify", "sessions:read"];

export type TetherConfig = {
  /** The IP literal the channel binds; loopback unless the owner sets another. */
  host: string;
  /** The port the channel listens on; how it is exposed is the owner's choice. */
  port: number;
  /** The public origin: issuer, resource and passkey RP origin; null before setup. */
  publicUrl: string | null;
  requestLimitBytes: number;
  /** Outstanding authorize and enroll challenges together. */
  challengeCap: number;
  codeLifetimeMs: number;
  challengeLifetimeMs: number;
  /** Bounds of the client document and key set fetches. */
  cimd: { timeoutMs: number; maxBytes: number };
  /**
   * The pause before an assistant's dropped `channel.pull` stream is opened again.
   * Nothing is lost meanwhile: the stream replays every unacknowledged record.
   */
  pullWaitMs: number;
  /**
   * The MCP 2026-07-28 `tools/list` cache hint. Null when unset: no hint, so
   * the SDK emits `ttlMs: 0` and duoduo
   * picks no number. The tool list changes only when the plugin is upgraded,
   * which restarts it, so an operator may set a longer time.
   */
  toolsListTtlMs: number | null;
};

/**
 * An `https:` origin on port 443 with no path, query, fragment or userinfo,
 * as `URL.origin`; null when the value is not one.
 */
export function normalizePublicUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.port !== "" && parsed.port !== "443") return null;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  return parsed.origin;
}

class ConfigError extends Error {}

function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new ConfigError(`${key} must be a positive whole number (got ${JSON.stringify(raw)})`);
  }
  return Number(raw);
}

function optionalWholeNumber(env: NodeJS.ProcessEnv, key: string): number | null {
  const raw = env[key]?.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${key} must be a whole number (got ${JSON.stringify(raw)})`);
  }
  return Number(raw);
}

function parsePort(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  if (!/^\d+$/.test(raw.trim())) throw new ConfigError(`ALADUO_TETHER_PORT is not a port number`);
  const port = Number(raw.trim());
  if (port < 1 || port > 65535) throw new ConfigError(`ALADUO_TETHER_PORT is not a port number`);
  return port;
}

const LOOPBACK = "127.0.0.1";

/** Loopback: 127.0.0.0/8 and ::1. */
export function isLoopbackHost(host: string): boolean {
  return host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}

/** `host:port`, an IPv6 literal in brackets. */
export function listenAddress(host: string, port: number): string {
  return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

function parseHost(raw: string | undefined): string {
  const host = raw?.trim();
  if (host === undefined || host === "") return LOOPBACK;
  if (isIP(host) === 0) {
    throw new ConfigError(
      `ALADUO_TETHER_HOST is not an IP address (got ${JSON.stringify(host)}); give an IPv4 or IPv6` +
        ` literal such as 127.0.0.1 or 192.168.1.20, not a hostname`
    );
  }
  return host;
}

export function parseTetherConfig(
  env: NodeJS.ProcessEnv
): { ok: true; config: TetherConfig } | { ok: false; reason: string } {
  try {
    const host = parseHost(env.ALADUO_TETHER_HOST);
    const port = parsePort(env.ALADUO_TETHER_PORT);
    const rawUrl = env.ALADUO_TETHER_PUBLIC_URL?.trim();
    const publicUrl = rawUrl ? normalizePublicUrl(rawUrl) : null;
    if (rawUrl && publicUrl === null) {
      throw new ConfigError(
        `ALADUO_TETHER_PUBLIC_URL is not an https:// origin on port 443 without a path (got ${JSON.stringify(rawUrl)})`
      );
    }
    const requestLimitBytes = positiveInteger(
      env,
      "ALADUO_TETHER_REQUEST_LIMIT_BYTES",
      DEFAULTS.requestLimitBytes
    );
    const challengeCap = positiveInteger(env, "ALADUO_TETHER_CHALLENGE_CAP", DEFAULTS.challengeCap);
    const cimd = {
      timeoutMs: positiveInteger(env, "ALADUO_TETHER_CIMD_TIMEOUT_MS", DEFAULTS.cimdTimeoutMs),
      maxBytes: positiveInteger(env, "ALADUO_TETHER_CIMD_MAX_BYTES", DEFAULTS.cimdMaxBytes)
    };
    if (port === null) {
      throw new ConfigError(
        `ALADUO_TETHER_PORT is not set: the tether channel listens on ${host} at that port`
      );
    }
    return {
      ok: true,
      config: {
        host,
        port,
        publicUrl,
        requestLimitBytes,
        challengeCap,
        codeLifetimeMs: positiveInteger(
          env,
          "ALADUO_TETHER_CODE_LIFETIME_MS",
          RFC6749_CODE_LIFETIME_MS
        ),
        challengeLifetimeMs: positiveInteger(
          env,
          "ALADUO_TETHER_CHALLENGE_LIFETIME_MS",
          RFC6749_CODE_LIFETIME_MS
        ),
        cimd,
        pullWaitMs: positiveInteger(env, "ALADUO_PULL_WAIT_MS", DEFAULTS.pullWaitMs),
        toolsListTtlMs: optionalWholeNumber(env, "ALADUO_TETHER_TOOLS_LIST_TTL_MS")
      }
    };
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, reason: error.message };
    throw error;
  }
}
