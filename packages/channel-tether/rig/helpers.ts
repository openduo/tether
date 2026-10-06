// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The rig suite drives the channel, in process, against a real long-lived duoduo daemon.
 * The rig is shared across runs, so every test names its own sessions and assistants with a
 * fresh suffix, filters every list it reads to those names, and archives what it made.
 * Every session a test makes runs no model: assistants' sessions are void, and the stand-in
 * owner chat is a void session too, so no test can start a paid turn.
 */

import crypto from "node:crypto";
import http from "node:http";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach } from "vitest";
import WebSocket from "ws";
import { handleAdmin } from "../src/admin";
import { socketDaemon, type DaemonCall } from "../src/forward";
import { createTetherApp } from "../src/listener";
import { Mailroom, socketPull, type MailRecord } from "../src/mail";
import { Store } from "../src/store";
import {
  connect,
  fakeCimd,
  grantNamed,
  InMemoryServerEventBus,
  makeConfig,
  SoftAuthenticator
} from "../tests/helpers";

/** Parsed JSON answers, read field by field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export const ACCEPT = "application/json, text/event-stream";
const WHERE = "the rig notes in .agents/environments/tether-rig.md";

export function rigRuntimeDir(): string {
  const dir = process.env.TETHER_RIG_RUNTIME_DIR?.trim();
  if (!dir) {
    throw new Error(
      `TETHER_RIG_RUNTIME_DIR is not set: point it at the rig daemon's runtime dir (see ${WHERE}).`
    );
  }
  return dir;
}

export function rigSocket(): string {
  return path.join(rigRuntimeDir(), "run", "daemon.sock");
}

/** Fails, never skips, when the rig daemon does not answer its health check. */
export async function requireRig(): Promise<void> {
  const socketPath = rigSocket();
  const answer = await new Promise<string>((resolve) => {
    const request = http.request({ socketPath, path: "/healthz", method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.on("error", (error) => resolve(String(error)));
    request.end();
  });
  if (!answer.includes('"ok"')) {
    throw new Error(
      `The rig daemon at ${socketPath} (TETHER_RIG_RUNTIME_DIR) did not answer /healthz ok (${answer}); start it per ${WHERE}.`
    );
  }
}

export function rigDaemon(): DaemonCall {
  return socketDaemon(rigSocket());
}

/** A per-run suffix: names stay unique on a rig that outlives every run. */
export function runId(): string {
  return crypto.randomBytes(4).toString("hex");
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const cleanups: Array<() => unknown> = [];

/** Runs every cleanup a test registered, newest first, even when one fails. */
export function useCleanups(): (cleanup: () => unknown) => void {
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw errors[0];
  });
  return (cleanup) => cleanups.push(cleanup);
}

/** A record the daemon pushed on a pull stream. */
export type PushedRecord = MailRecord & {
  payload: { text?: string; data?: Record<string, unknown> };
};

export type Owner = {
  key: string;
  /** Every record pushed to the owner's chat since it opened, in order. */
  records: () => PushedRecord[];
};

/**
 * A stand-in for the owner's chat: a void channel session with a consumer on its pull
 * stream, so duoduo's consumer gate delivers to it and what lands there can be read.
 */
export async function openOwner(
  daemon: DaemonCall,
  run: string,
  cleanup: (fn: () => unknown) => void
): Promise<Owner> {
  const key = `rigchat:${run}:owner`;
  const spawned = await daemon("channel.spawn", {
    channel_kind: "rigchat",
    channel_id: `rigchat-${run}`,
    cwd_abs: os.tmpdir(),
    runtime: "void",
    display_name: `owner-${run}`,
    session_key: key
  });
  if ((spawned.result as Json)?.ok !== true) {
    throw new Error(`channel.spawn refused the owner session: ${JSON.stringify(spawned)}`);
  }
  cleanup(() => daemon("session.archive", { session_key: key }));
  const pushed: PushedRecord[] = [];
  const ws = new WebSocket("ws://localhost/ws", {
    createConnection: () => net.connect({ path: rigSocket() })
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.on("message", (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Json;
      if (message.id === "owner" && message.result?.opened === true) resolve();
      if (message.id === "owner" && message.error) reject(new Error(JSON.stringify(message.error)));
      if (message.method === "session.output") pushed.push(message.params.record);
    });
    ws.on("error", reject);
  });
  ws.on("open", () =>
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "owner",
        method: "channel.pull",
        params: { session_key: key, consumer_id: "rig-owner" }
      })
    )
  );
  await opened;
  cleanup(() => ws.close());
  return { key, records: () => [...pushed] };
}

/** One spine event in full, as `spine show` prints it. */
export async function spineEvent(daemon: DaemonCall, id: string): Promise<Json> {
  const reply = await daemon("spine.cat", { date: today(), show: id });
  if (reply.error) throw new Error(JSON.stringify(reply.error));
  return JSON.parse((reply.result as { text: string }).text);
}

/** Today's route deliveries into one session, in full. */
export async function deliveries(daemon: DaemonCall, sessionKey: string): Promise<Json[]> {
  const reply = await daemon("spine.cat", {
    date: today(),
    session: sessionKey,
    types: ["route.deliver"],
    unfiltered: true,
    json: true
  });
  if (reply.error) throw new Error(JSON.stringify(reply.error));
  const ids = (reply.result as { text: string }).text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as { id: string }).id);
  return Promise.all(ids.map((id) => spineEvent(daemon, id)));
}

/** The channel, in process, against the rig daemon, with a fresh state dir. */
export async function harness(cleanup: (fn: () => unknown) => void) {
  await requireRig();
  const daemon = rigDaemon();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "tether-rig-state-"));
  cleanup(() => fs.rm(stateDir, { recursive: true, force: true }));
  const store = new Store(stateDir, { warn: () => undefined });
  await store.init();
  const authenticator = new SoftAuthenticator();
  await store.writePasskeys([authenticator.passkey()]);
  const config = makeConfig();
  const bus = new InMemoryServerEventBus();
  const mail = new Mailroom({
    store,
    daemon,
    openPull: socketPull(rigSocket()),
    reconnectMs: config.pullWaitMs,
    workspace: store.stateDir,
    callbackLimits: config.cimd,
    log: { warn: () => undefined },
    bus
  });
  const app = createTetherApp({
    config,
    store,
    daemon,
    version: "rig",
    fetchImpl: fakeCimd(),
    mail,
    bus
  });
  await app.ready();
  cleanup(() => app.close());
  await mail.start();
  cleanup(() => mail.stop());

  const tokens = new Map<string, string>();
  /** Revokes every grant this harness made: their sessions are archived, unread mail bounced. */
  cleanup(async () => {
    const grants = Object.values((await store.readGrants()) ?? {});
    for (const name of new Set(grants.map((grant) => grant.name))) {
      await handleAdmin({ store, config, daemon, mail }, { verb: "revoke", args: [name] });
    }
  });
  const connectAs = async (name: string, client?: { id: string; redirect: string }) => {
    const { accessToken } = await connect(app, authenticator, {
      name,
      ...(client ? { clientId: client.id, redirectUri: client.redirect } : {})
    });
    tokens.set(name, accessToken);
    return grantNamed(await store.readGrants(), name);
  };
  const call = async (as: string, name: string, args: Record<string, unknown>) => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${tokens.get(as)}`,
        "content-type": "application/json",
        accept: ACCEPT
      },
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args }
      })
    });
    return (JSON.parse(response.payload) as { result: Record<string, Json> }).result;
  };
  const tool = async (as: string, name: string, args: Record<string, unknown>) => {
    const result = await call(as, name, args);
    if (result.isError !== undefined) {
      throw new Error(`${name} refused: ${JSON.stringify(result)}`);
    }
    return result;
  };
  const unread = async (as: string) =>
    (await tool(as, "ReadMail", {})).structuredContent.mails as Array<Record<string, Json>>;
  /** The official TypeScript MCP client, connected as `as`, its HTTP served by the channel app. */
  const sdkClient = async (as: string) => {
    const fetchThroughApp = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const response = await app.inject({
        method: (init?.method ?? "GET") as "GET" | "POST",
        url: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(typeof init?.body === "string" ? { payload: init.body } : {})
      });
      return new Response(response.statusCode === 202 ? null : response.payload, {
        status: response.statusCode,
        headers: response.headers as Record<string, string>
      });
    };
    const client = new Client({ name: "rig", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${config.publicUrl}/mcp`), {
        fetch: fetchThroughApp as typeof fetch,
        requestInit: { headers: { authorization: `Bearer ${tokens.get(as)}` } }
      })
    );
    cleanup(() => client.close());
    await client.listTools();
    return client;
  };
  return { daemon, store, config, mail, bus, app, connectAs, call, tool, unread, sdkClient };
}
