// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCOPES } from "../src/config";
import { DaemonUnreachableError } from "../src/forward";
import { mintMailId } from "../src/mail";
import { TOOLS } from "../src/mcp";
import {
  TETHER_MCP_TURN_CONTRACT,
  MCP_INSTRUCTIONS,
  renderContext,
  renderDaemonError,
  renderMailToSession,
  renderNoBoard,
  TOOL_DESCRIPTIONS
} from "../src/texts";
import {
  CHATGPT,
  cleanupDirs,
  connect,
  fakeDaemon,
  grantNamed,
  pluginHarness,
  PUBLIC
} from "./helpers";

/** Parsed JSON-RPC answers, read field by field. */
type Json = ReturnType<typeof JSON.parse>;

// The instructions and descriptions are prompts: their structure is tested, not their wording.

afterEach(cleanupDirs);

const ACCEPT = "application/json, text/event-stream";
const CLIENT = (grantId: string) => ({ id: CHATGPT, grant: grantId });

type Harness = Awaited<ReturnType<typeof pluginHarness>>;

async function connected(options: Parameters<typeof pluginHarness>[0] & { scope?: string } = {}) {
  const h = await pluginHarness(options);
  const { accessToken } = await connect(h.app, h.authenticator, {
    name: "dots",
    ...(options.scope !== undefined ? { scope: options.scope } : {})
  });
  const grantId = grantNamed(await h.store.readGrants(), "dots").grant_id;
  const post = async (message: unknown, headers: Record<string, string> = {}) => {
    const response = await h.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: ACCEPT,
        ...headers
      },
      payload: JSON.stringify(message)
    });
    return {
      status: response.statusCode,
      headers: response.headers,
      body: response.payload === "" ? null : (JSON.parse(response.payload) as Record<string, Json>)
    };
  };
  let id = 0;
  const rpc = (method: string, params: unknown = {}) =>
    post({ jsonrpc: "2.0", id: ++id, method, params });
  const tool = async (name: string, args: unknown) => {
    const response = await rpc("tools/call", { name, arguments: args });
    return response.body as Record<string, Json>;
  };
  return { ...h, accessToken, grantId, post, rpc, tool };
}

const daemonCalls = (h: Harness, method: string) =>
  h.daemon.mock.calls.filter(([called]) => called === method);

describe("transport", () => {
  it("GET /mcp is 405 with no token needed", async () => {
    const h = await pluginHarness();
    const response = await h.app.inject({ method: "GET", url: "/mcp" });
    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe("POST");
  });

  it.each([
    ["no token", undefined],
    ["an unknown token", "Bearer nope"],
    ["a malformed header", "Basic abc"]
  ])(
    "%s is 401 with the resource metadata and all six scopes, and reaches no daemon",
    async (_label, auth) => {
      const h = await pluginHarness();
      const response = await h.app.inject({
        method: "POST",
        url: "/mcp",
        headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
        payload: "{}"
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toBe(
        `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource", scope="${SCOPES.join(" ")}"`
      );
      expect(h.daemon).toHaveBeenCalledTimes(0);
    }
  );

  it("an unreadable grants file is 503, not 401: the token was not found to be bad", async () => {
    const h = await connected();
    await fs.writeFile(path.join(h.stateDir, "grants.json"), "{ not json");
    const response = await h.rpc("tools/list");
    expect(response.status).toBe(503);
    expect(response.headers["www-authenticate"]).toBeUndefined();
    expect(response.body?.error).toBe("temporarily_unavailable");
  });

  it("refuses an Origin that is not the public origin; no Origin passes", async () => {
    const h = await connected();
    expect((await h.rpc("tools/list")).status).toBe(200);
    const foreign = await h.post(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { origin: "https://evil.example" }
    );
    expect(foreign.status).toBe(403);
    const same = await h.post(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { origin: PUBLIC }
    );
    expect(same.status).toBe(200);
  });

  it("initialize answers JSON with serverInfo, tools capability and instructions; no session id", async () => {
    const h = await connected();
    const response = await h.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" }
    });
    expect(response.status).toBe(200);
    expect(String(response.headers["content-type"])).toContain("application/json");
    expect(response.headers["mcp-session-id"]).toBeUndefined();
    const result = response.body?.result;
    expect(result.serverInfo).toEqual({ name: "duoduo", version: "9.9.9-test" });
    expect(result.capabilities.tools).toBeDefined();
    expect(result.instructions).toBe(MCP_INSTRUCTIONS);
  });

  it("a request over the configured body limit is 413 and reaches no daemon", async () => {
    const h = await pluginHarness({ config: { requestLimitBytes: 64 } });
    const response = await h.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json", authorization: "Bearer x" },
      payload: JSON.stringify({ padding: "x".repeat(65) })
    });
    expect(response.statusCode).toBe(413);
    expect(h.daemon).toHaveBeenCalledTimes(0);
  });

  it("a notification gets 202 with no body", async () => {
    const h = await connected();
    const response = await h.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.status).toBe(202);
    expect(response.body).toBeNull();
  });
});

describe("the per-turn contract, structure only", () => {
  const texts = [
    MCP_INSTRUCTIONS,
    TOOL_DESCRIPTIONS.GetContext,
    TOOL_DESCRIPTIONS.RecordExperience
  ];

  it("is assembled whole into the instructions and both descriptions", () => {
    for (const text of texts) expect(text.split(TETHER_MCP_TURN_CONTRACT)).toHaveLength(2);
  });

  it("carries no hostname, username, token, curl or CLI install text", () => {
    for (const text of [MCP_INSTRUCTIONS, ...Object.values(TOOL_DESCRIPTIONS)]) {
      expect(text).not.toContain(os.hostname());
      expect(text).not.toContain(os.userInfo().username);
      expect(text).not.toMatch(
        /\bcurl\b|npm install|Bearer|\.auth\b|ALADUO_|\bduoduo (attach|tether|spine|session|channel)\b/
      );
    }
  });
});

describe("tools/list", () => {
  // Each tool has its own oauth2 scope, except the three mail tools: they need
  // sessions:notify and sessions:read, the scopes NotifySession needed.
  it("lists seven PascalCase tools with strict schemas, output schemas, annotations and their oauth2 scopes", async () => {
    const h = await connected();
    const tools = (await h.rpc("tools/list")).body?.result.tools as Array<Record<string, Json>>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "GetContext",
      "ReadMemory",
      "ReadEvents",
      "ListAddresses",
      "SendMail",
      "ReadMail",
      "RecordExperience"
    ]);
    const scopes = new Set<string>();
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[A-Z][A-Za-z]+$/);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema.type).toBe("object");
      expect(typeof tool.description).toBe("string");
      expect(tool.annotations).toBeDefined();
      expect(tool.securitySchemes).toHaveLength(1);
      expect(tool.securitySchemes[0].type).toBe("oauth2");
      expect(tool.securitySchemes[0].scopes).toEqual(
        ["ListAddresses", "SendMail", "ReadMail"].includes(tool.name)
          ? ["sessions:notify", "sessions:read"]
          : [expect.any(String)]
      );
      for (const scope of tool.securitySchemes[0].scopes) scopes.add(scope);
      for (const forbidden of ["assistant", "client", "source", "force", "worker_token", "store"]) {
        expect(Object.keys(tool.inputSchema.properties), tool.name).not.toContain(forbidden);
      }
    }
    expect([...scopes].sort()).toEqual([...SCOPES].sort());
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    expect(byName.SendMail).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true
    });
    expect(byName.RecordExperience).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false
    });
    expect(byName.ReadMail).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false
    });
    for (const name of ["GetContext", "ReadMemory", "ReadEvents", "ListAddresses"]) {
      expect(byName[name].readOnlyHint, name).toBe(true);
    }
  });
});

describe("tools/call", () => {
  it.each(TOOLS.map((tool) => [tool.name]))(
    "%s with a body, client, source or force argument is -32602 and reaches no daemon",
    async (name) => {
      const h = await connected();
      const before = h.daemon.mock.calls.length;
      for (const extra of [
        { body: "muse" },
        { client: "x" },
        { source: "tether:muse" },
        { force: true }
      ]) {
        const response = await h.rpc("tools/call", { name, arguments: extra });
        expect(response.body?.error?.code, JSON.stringify(extra)).toBe(-32602);
      }
      expect(h.daemon.mock.calls.length).toBe(before);
    }
  );

  it("GetContext reads the board and composes the text, minting a conversation or passing one on", async () => {
    const now = new Date("2026-10-03T08:00:00.000Z");
    const h = await connected({ now: () => now });
    const boardRev = crypto.createHash("sha256").update("FILE\n").digest("hex").slice(0, 16);
    const first = await h.tool("GetContext", {});
    const conversation = first.result.structuredContent.conversation as string;
    expect(first.result.structuredContent).toEqual({ conversation, board_rev: boardRev });
    expect(first.result.content).toEqual([
      {
        type: "text",
        text: renderContext({ name: "dots", now, conversation, boardRev, board: "FILE\n" })
      }
    ]);
    const second = await h.tool("GetContext", { conversation: "c-new" });
    expect(second.result.structuredContent).toEqual({ conversation: "c-new", board_rev: boardRev });
    expect(daemonCalls(h, "memory.read").map(([, params]) => params)).toEqual([
      { path: "CLAUDE.md" },
      { path: "CLAUDE.md" }
    ]);
  });

  it("RecordExperience fills the source name and client from the grant", async () => {
    const h = await connected();
    const record = {
      conversation: "c-new",
      board_rev: "rev1",
      said: "s",
      did: "d",
      outcome: "o",
      from: "Lao Ding"
    };
    const result = (await h.tool("RecordExperience", record)).result;
    expect(result.structuredContent).toEqual({
      ok: true,
      event_id: "evt_1",
      ts: "2026-10-03T08:00:00.000Z",
      duplicate: false
    });
    expect(daemonCalls(h, "spine.record").map(([, params]) => params)).toEqual([
      {
        source: "dots",
        conversation: "c-new",
        payload: {
          text: "s",
          from: "Lao Ding",
          did: "d",
          outcome: "o",
          board_rev: "rev1",
          client: CLIENT(h.grantId)
        },
        dedup_key: expect.stringMatching(/^[0-9a-f]{16}$/)
      }
    ]);
  });

  it("ReadMemory, ReadEvents and ListAddresses call their one daemon method", async () => {
    const h = await connected();
    expect((await h.tool("ReadMemory", { path: "entities/x.md" })).result.content[0].text).toBe(
      "FILE\n"
    );
    expect(
      (await h.tool("ReadEvents", { date: "2026-10-03", count_only: true })).result.content[0].text
    ).toBe("EVENTS\n");
    // Assistants come from the plugin's own grants.
    expect((await h.tool("ListAddresses", {})).result.structuredContent).toEqual({
      addresses: [{ address: "tether:dots", kind: "assistant", alias: null, last_read_at: null }]
    });
    expect(daemonCalls(h, "memory.read").map(([, p]) => p)).toEqual([{ path: "entities/x.md" }]);
    // ReadEvents is spine.cat's external view.
    expect(daemonCalls(h, "spine.cat").map(([, p]) => p)).toEqual([
      { date: "2026-10-03", count_only: true, redact: "external" }
    ]);
    expect(daemonCalls(h, "session.list").map(([, p]) => p)).toEqual([
      { kind: "channel", deliverable: true }
    ]);
  });

  it("a missing scope is a tool error carrying the insufficient_scope challenge, and reaches no daemon", async () => {
    const h = await connected({ scope: "context:read" });
    const before = h.daemon.mock.calls.length;
    const result = (
      await h.tool("RecordExperience", {
        conversation: "c",
        board_rev: "r",
        said: "s",
        did: "d",
        outcome: "o"
      })
    ).result;
    expect(result.isError).toBe(true);
    expect(result._meta["duoduo/reason"]).toBe("insufficient_scope");
    const challenge = result._meta["mcp/www_authenticate"] as string[];
    expect(challenge).toHaveLength(1);
    expect(challenge[0]).toContain('error="insufficient_scope"');
    expect(challenge[0]).toContain('scope="experience:write"');
    expect(h.daemon.mock.calls.length).toBe(before);
  });

  it("a daemon error reaches the assistant without its data", async () => {
    const daemon = await fakeDaemon({
      override: (method) =>
        method === "memory.read"
          ? { error: { code: -32603, message: "Internal error", data: "Error: /secret/path" } }
          : undefined
    });
    const h = await connected({ daemon });
    const result = (await h.tool("ReadMemory", { path: "x" })).result;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("/secret/path");
  });

  it.each([
    ["ReadMemory", { path: "x" }, "memory.read", false],
    [
      "RecordExperience",
      { conversation: "c", board_rev: "r", said: "s", did: "d", outcome: "o" },
      "spine.record",
      true
    ]
  ])(
    "a daemon error on %s carries the read or write outcome",
    async (name, args, method, writes) => {
      const daemon = await fakeDaemon({
        override: (called) =>
          called === method ? { error: { code: -32603, message: "Internal error" } } : undefined
      });
      const h = await connected({ daemon });
      const result = (await h.tool(name, args)).result;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(renderDaemonError(name, "Internal error", writes));
    }
  );

  it("an unreachable daemon is a tool error, not an HTTP failure", async () => {
    const daemon = await fakeDaemon({
      override: (method) => {
        if (method === "memory.read") throw new DaemonUnreachableError("ECONNREFUSED");
        return undefined;
      }
    });
    const h = await connected({ daemon });
    const result = (await h.tool("GetContext", {})).result;
    expect(result.isError).toBe(true);
    expect(result._meta["duoduo/reason"]).toBe("unreachable");
  });

  it("a daemon refusal of a record keeps its reason and message", async () => {
    const daemon = await fakeDaemon({
      override: (method) =>
        method === "memory.read"
          ? { result: { ok: false, reason: "reserved_source", message: "RESERVED" } }
          : undefined
    });
    const h = await connected({ daemon });
    const result = (await h.tool("GetContext", {})).result;
    expect(result._meta["duoduo/reason"]).toBe("reserved_source");
    expect(result.content[0].text).toBe("RESERVED");
  });

  // memory.read's text for a missing board names a kernel path.
  it("a missing board reaches the assistant as the plugin's own text, never the daemon's", async () => {
    const daemon = await fakeDaemon({
      override: (method) =>
        method === "memory.read"
          ? { error: { code: -32602, message: "No file memory/CLAUDE.md" } }
          : undefined
    });
    const h = await connected({ daemon });
    const result = (await h.tool("GetContext", {})).result;
    expect(result.isError).toBe(true);
    expect(result._meta["duoduo/reason"]).toBe("no_board");
    expect(result.content[0].text).toBe(renderNoBoard());
  });
});

describe("SendMail to a session", () => {
  const SESSIONS = [
    { session_key: "lark:oc_x:1", display_name: "owner chat", kind: "channel" },
    { session_key: "lark:oc_y:2", display_name: "twin", kind: "channel" },
    { session_key: "lark:oc_z:3", display_name: "twin", kind: "channel" },
    { session_key: "job:report.1", display_name: "weekly", kind: "job" }
  ];

  async function withSessions() {
    return connected({ daemon: await fakeDaemon({ sessions: SESSIONS }) });
  }

  it("resolves an alias once and sends the key for exact delivery, the grant's source and a grant-scoped key, never force", async () => {
    const h = await withSessions();
    const result = (
      await h.tool("SendMail", {
        to: "owner chat",
        message: "停",
        idempotency_key: "k1"
      })
    ).result;
    expect(result.isError).toBeUndefined();
    expect(daemonCalls(h, "session.notify").map(([, params]) => params)).toEqual([
      {
        target: "lark:oc_x:1",
        exact_key: true,
        message: renderMailToSession({
          name: "dots",
          mailId: mintMailId(h.grantId, "k1"),
          inReplyTo: undefined,
          message: "停"
        }),
        source: "tether:dots",
        idempotency_key: JSON.stringify([h.grantId, "k1"])
      }
    ]);
  });

  it.each([
    ["an unknown target", "nobody", "not_found"],
    ["an ambiguous alias", "twin", "ambiguous"],
    // Jobs of every kind are not addresses.
    ["a job session", "weekly", "not_found"]
  ])("%s is refused and nothing is sent", async (_label, target, reason) => {
    const h = await withSessions();
    const result = (await h.tool("SendMail", { to: target, message: "m" })).result;
    expect(result.isError).toBe(true);
    expect(result._meta["duoduo/reason"]).toBe(reason);
    expect(daemonCalls(h, "session.notify")).toHaveLength(0);
  });

  it("with sessions:notify alone is refused before any daemon call", async () => {
    const h = await connected({
      daemon: await fakeDaemon({ sessions: SESSIONS }),
      scope: "sessions:notify"
    });
    const before = h.daemon.mock.calls.length;
    const result = (await h.tool("SendMail", { to: "twin", message: "m" })).result;
    expect(result.isError).toBe(true);
    expect(result._meta["duoduo/reason"]).toBe("insufficient_scope");
    const challenge = result._meta["mcp/www_authenticate"] as string[];
    expect(challenge[0]).toContain('scope="sessions:notify sessions:read"');
    expect(JSON.stringify(result)).not.toContain("lark:oc_y:2");
    expect(h.daemon.mock.calls.length).toBe(before);
  });

  it("with sessions:notify and sessions:read delivers", async () => {
    const h = await connected({
      daemon: await fakeDaemon({ sessions: SESSIONS }),
      scope: "sessions:notify sessions:read"
    });
    const result = (await h.tool("SendMail", { to: "owner chat", message: "m" })).result;
    expect(result.isError).toBeUndefined();
    expect(daemonCalls(h, "session.notify").map(([, params]) => params.target)).toEqual([
      "lark:oc_x:1"
    ]);
  });

  it("passes the daemon's duplicate receipt through", async () => {
    const daemon = await fakeDaemon({
      sessions: SESSIONS,
      override: (method, params) =>
        method === "session.notify"
          ? {
              result: {
                ok: true,
                target: params.target,
                session_key: params.target,
                route_id: "route-1",
                event_id: "evt_2",
                ts: "t",
                duplicate: true
              }
            }
          : undefined
    });
    const h = await connected({ daemon });
    const result = (
      await h.tool("SendMail", {
        to: "lark:oc_x:1",
        message: "m",
        idempotency_key: "k1"
      })
    ).result;
    expect(result.structuredContent).toEqual({
      ok: true,
      session_key: "lark:oc_x:1",
      route_id: "route-1",
      event_id: "evt_2",
      ts: "t",
      duplicate: true
    });
  });

  it.each([
    ["idempotency_conflict", { reason: "idempotency_conflict" }],
    ["no_consumer", { reason: "no_consumer", error: "nobody reads it" }],
    ["delivery_failed", { reason: "delivery_failed", error: "session_archived" }]
  ])("a daemon %s refusal is a tool error with that reason", async (reason, refusal) => {
    const daemon = await fakeDaemon({
      sessions: SESSIONS,
      override: (method, params) =>
        method === "session.notify"
          ? { result: { ok: false, target: params.target, session_key: params.target, ...refusal } }
          : undefined
    });
    const h = await connected({ daemon });
    const result = (
      await h.tool("SendMail", {
        to: "lark:oc_x:1",
        message: "m",
        idempotency_key: "k1"
      })
    ).result;
    expect(result.isError).toBe(true);
    expect(result._meta["duoduo/reason"]).toBe(reason);
  });
});
