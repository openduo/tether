// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Callback URLs an assistant hands duoduo in `events/subscribe` (OpenAI MCP
 * Events, https://developers.openai.com/plugins/build/mcp-events): https only, no
 * private, loopback or link-local address, checked against every address the
 * name resolves to at connection time, the connection pinned to the checked
 * address with the hostname kept for TLS, and no redirect followed.
 */

import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import type { Readable } from "node:stream";

/**
 * Every block of the IANA special-purpose registries, globally reachable or
 * not: https://www.iana.org/assignments/iana-ipv4-special-registry and
 * https://www.iana.org/assignments/iana-ipv6-special-registry (read
 * 2026-10-05). Sub-blocks of a listed block are covered by it. Beyond them:
 * multicast (224.0.0.0/4, ff00::/8) and the deprecated IPv6 site-local
 * fec0::/10 (RFC 3879), from the address space registries. NAT64 and 6to4
 * ranges are refused whole, because each can carry a private IPv4 address.
 * An IPv4-mapped IPv6 address (::ffff:0:0/96) has no entry: BlockList checks
 * it against the IPv4 rules, and an entry would match every IPv4 address.
 */
const BLOCKED = new net.BlockList();
for (const [prefix, length] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  BLOCKED.addSubnet(prefix, length, "ipv4");
}
for (const [prefix, length] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8]
] as const) {
  BLOCKED.addSubnet(prefix, length, "ipv6");
}

export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return true;
  return BLOCKED.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Refused before any connection: not https, credentials, or a blocked literal address. */
export function isRefusedCallbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return true;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return true;
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return net.isIP(host) !== 0 && isBlockedAddress(host);
}

/** The connection reached, or would have reached, a refused address. */
export class BlockedAddressError extends Error {
  constructor(hostname: string) {
    super(`${hostname} resolves to a private, loopback or link-local address`);
    this.name = "BlockedAddressError";
  }
}

type LookupAll = (
  hostname: string,
  options: { all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void
) => void;

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number
) => void;

/**
 * A `lookup` for `https.request`: resolves every address, refuses the name
 * when any one is blocked, and hands the socket only checked addresses. Node
 * skips `lookup` for an IP literal, which `isRefusedCallbackUrl` checks.
 */
export function guardedLookup(resolve: LookupAll = dns.lookup as unknown as LookupAll) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    resolve(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error, []);
      if (addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
        return callback(new BlockedAddressError(hostname), []);
      }
      if (options.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

export type CallbackResponse = { status: number; body: string };
export type CallbackLimits = { timeoutMs: number; maxBytes: number };
export type CallbackPost = (
  url: string,
  headers: Record<string, string>,
  body: string,
  limits: CallbackLimits
) => Promise<CallbackResponse>;

/** The answer crossed the byte bound. */
export class BodyTooLargeError extends Error {
  constructor() {
    super("the answer is larger than the callback byte bound");
    this.name = "BodyTooLargeError";
  }
}

/**
 * The whole body, or a rejection once it crosses `maxBytes`: the stream is
 * destroyed then, so a truncated prefix is never read as an answer.
 */
export function readBoundedBody(stream: Readable, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        stream.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

/**
 * One POST to a validated callback URL. `https.request` never follows a
 * redirect, so a 3xx is just a status.
 */
export const postCallback: CallbackPost = (url, headers, body, limits) =>
  new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "POST",
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
        lookup: guardedLookup() as never,
        signal: AbortSignal.timeout(limits.timeoutMs)
      },
      (response) => {
        readBoundedBody(response, limits.maxBytes).then(
          (text) => resolve({ status: response.statusCode ?? 0, body: text }),
          (error: unknown) => {
            request.destroy();
            reject(error);
          }
        );
      }
    );
    request.on("error", reject);
    request.end(body);
  });

/** A timeout from `postCallback`'s abort signal. */
export function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}
