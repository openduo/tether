// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The daemon side of the tether channel: one JSON-RPC call over the unix socket
 * the plugin manager handed us, with the daemon's internal error detail
 * stripped before anything reaches an assistant.
 */

import http from "node:http";

export type RpcError = { code: number; message: string; data?: unknown };
export type DaemonReply = { result?: unknown; error?: RpcError };
export type DaemonCall = (
  method: string,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
) => Promise<DaemonReply>;

/** The daemon could not be reached over its socket. */
export class DaemonUnreachableError extends Error {}

export function socketDaemon(socketPath: string): DaemonCall {
  return (method, params, options) =>
    new Promise<DaemonReply>((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: "tether", method, params });
      const request = http.request(
        {
          socketPath,
          path: "/rpc",
          method: "POST",
          ...(options?.signal ? { signal: options.signal } : {}),
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as DaemonReply;
              resolve({ result: parsed.result, error: parsed.error });
            } catch (error) {
              reject(new DaemonUnreachableError(`unreadable daemon answer: ${String(error)}`));
            }
          });
          response.on("error", (error) => reject(new DaemonUnreachableError(String(error))));
        }
      );
      request.on("error", (error) => reject(new DaemonUnreachableError(String(error))));
      request.end(body);
    });
}

/** The daemon's catch-all fills `data` with the internal error; an assistant never sees it. */
export function stripped(error: RpcError): { message: string } {
  return { message: error.message };
}

export type SessionEntry = { session_key: string; display_name?: string | null; kind: string };

export type Resolution =
  | { ok: true; entry: SessionEntry }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "ambiguous"; candidates: SessionEntry[] };

/**
 * The daemon's resolution, done once: an exact key, else a unique
 * display name. The caller then sends the resolved key, never the alias, so a
 * rename between this read and the delivery cannot pick a new owner.
 */
export function resolveTarget(entries: readonly SessionEntry[], target: string): Resolution {
  const exact = entries.find((entry) => entry.session_key === target);
  if (exact) return { ok: true, entry: exact };
  const named = entries.filter((entry) => entry.display_name === target);
  if (named.length === 1) return { ok: true, entry: named[0] };
  if (named.length > 1) return { ok: false, reason: "ambiguous", candidates: named };
  return { ok: false, reason: "not_found" };
}
