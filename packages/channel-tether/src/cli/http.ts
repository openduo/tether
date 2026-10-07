// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * MCP over plain fetch. A 2026-07-28 request is stateless: one POST carrying
 * the protocol version in `_meta`, no initialize and no session.
 */

import { isRecord } from "@openduo/protocol";
import { MODERN_PROTOCOL } from "../client-contract";
import { CliExit, EXIT, type CliIo } from "./io";
import type { Connection } from "./tokens";

export type Json = Record<string, unknown>;

/** The text an error answer carries, for the message the command prints. */
async function describe(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as unknown;
    if (isRecord(body)) {
      const said = body.error_description ?? body.message ?? body.error;
      if (typeof said === "string") return said;
    }
  } catch {
    // Not JSON: the status alone says it.
  }
  return "";
}

/** One POST /mcp; the caller reads the answer and handles a failure to send. */
export async function postMcp(
  io: CliIo,
  connection: Connection,
  method: string,
  params: Json,
  name?: string,
  signal?: AbortSignal
): Promise<Response> {
  return io.fetch(`${connection.publicUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN_PROTOCOL,
      "mcp-method": method,
      ...(name !== undefined ? { "mcp-name": name } : {})
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL,
          "io.modelcontextprotocol/clientCapabilities": {}
        }
      }
    }),
    ...(signal ? { signal } : {})
  });
}

/** CliExit for an answer that is not 2xx: 401 is the token, anything else the host. */
export async function httpFailure(connection: Connection, response: Response): Promise<CliExit> {
  const said = await describe(response);
  if (response.status === 401) {
    return new CliExit(
      EXIT.token,
      `${connection.publicUrl} refused the token${said ? `: ${said}` : "."} Log in again with` +
        ` duoduo-tether login ${connection.publicUrl}.`
    );
  }
  return new CliExit(
    EXIT.unreachable,
    `${connection.publicUrl} answered HTTP ${response.status}${said ? `: ${said}` : "."}`
  );
}

export function unreachable(connection: Connection, error: unknown): CliExit {
  const why = error instanceof Error ? (error.cause ?? error).toString() : String(error);
  return new CliExit(EXIT.unreachable, `Could not reach ${connection.publicUrl} (${why}).`);
}

/** The JSON-RPC messages of an SSE body. */
export function sseMessages(text: string): Json[] {
  const messages: Json[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (data === "") continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (isRecord(parsed)) messages.push(parsed);
    } catch {
      // A frame that is not JSON carries nothing for us.
    }
  }
  return messages;
}

/** One request and its result. A JSON-RPC error is CliExit 1. */
export async function rpc(
  io: CliIo,
  connection: Connection,
  method: string,
  params: Json,
  name?: string
): Promise<Json> {
  let response: Response;
  try {
    response = await postMcp(io, connection, method, params, name);
  } catch (error) {
    throw unreachable(connection, error);
  }
  if (!response.ok) throw await httpFailure(connection, response);
  const text = await response.text();
  let message: Json | undefined;
  if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
    message = sseMessages(text).find((candidate) => candidate.id === 1);
  } else {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed)) message = parsed;
    } catch {
      // Handled below as an answer that is not JSON-RPC.
    }
  }
  if (message === undefined) {
    throw new CliExit(
      EXIT.unreachable,
      `${connection.publicUrl} answered something that is not MCP.`
    );
  }
  if (isRecord(message.error)) {
    throw new CliExit(
      EXIT.refused,
      String(message.error.message ?? "The server refused the request.")
    );
  }
  return isRecord(message.result) ? message.result : {};
}
