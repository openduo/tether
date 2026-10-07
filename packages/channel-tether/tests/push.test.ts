// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import type { ServerEventBus } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpEndpoint, handleMcpPost } from "../src/mcp";
import { mailboxUri } from "../src/mail";
import { runRevoke } from "../src/admin";
import { LISTEN_KEEP_ALIVE_MS } from "../src/client-contract";
import type { MailRecord } from "../src/mail";
import {
  cleanupDirs,
  connect,
  fakeDaemon,
  fakeOutbox,
  FORM,
  form,
  grantNamed,
  pluginHarness,
  PUBLIC
} from "./helpers";
import { listenLoopback } from "./loopback";

// Push on the assistant's own MCP connection, over the channel's loopback port.

const MODERN = "2026-07-28";
const ACCEPT = "application/json, text/event-stream";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await cleanupDirs();
});

type Json = Record<string, unknown>;

/** How many listen streams are reading the bus right now. */
function openListens(bus: ServerEventBus): () => number {
  let open = 0;
  const subscribe = bus.subscribe.bind(bus);
  vi.spyOn(bus, "subscribe").mockImplementation((listener) => {
    open += 1;
    const off = subscribe(listener);
    return () => {
      open -= 1;
      off();
    };
  });
  return () => open;
}

function modernRequest(
  token: string,
  id: number | string,
  method: string,
  params: Json = {},
  name?: string
) {
  return {
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: ACCEPT,
      "mcp-protocol-version": MODERN,
      "mcp-method": method,
      ...(name !== undefined ? { "mcp-name": name } : {})
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientCapabilities": {}
        }
      }
    })
  };
}

const listenParams = (uri: string) => ({ notifications: { resourceSubscriptions: [uri] } });

/** SSE `data:` payloads, parsed. */
function messages(sse: string): Json[] {
  return sse
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Json);
}

async function setup(scope?: string, options: Parameters<typeof pluginHarness>[0] = {}) {
  const h = await pluginHarness(options);
  await h.app.ready();
  const { accessToken } = await connect(h.app, h.authenticator, {
    name: "dots",
    ...(scope !== undefined ? { scope } : {})
  });
  const grantId = grantNamed(await h.store.readGrants(), "dots").grant_id;
  const open = openListens(h.bus);
  const request = await listenLoopback(h.app);
  closers.push(() => {
    // An open listen holds its connection; close() alone would wait for it.
    h.app.server.closeAllConnections();
    return h.app.close();
  });
  let id = 0;
  const call = (method: string, params: Json = {}, name?: string) =>
    request({
      method: "POST",
      path: "/mcp",
      ...modernRequest(accessToken, ++id, method, params, name)
    });
  return { h, grantId, open, call, accessToken, uri: mailboxUri(grantId) };
}

describe("the mailbox resource", () => {
  it("resources/list shows the caller its own mailbox; resources/read acknowledges nothing", async () => {
    const { h, call, uri } = await setup();
    const listed = JSON.parse((await call("resources/list")).body) as {
      result: { resources: Json[] };
    };
    expect(listed.result.resources).toEqual([expect.objectContaining({ uri, name: "mailbox" })]);
    const before = h.daemon.mock.calls.length;
    const read = JSON.parse((await call("resources/read", { uri }, uri)).body) as {
      result: { contents: Json[] };
    };
    expect(read.result.contents).toEqual([
      { uri, mimeType: "application/json", text: expect.any(String) }
    ]);
    // Nothing acknowledged: no cursor moves, no read time is recorded.
    expect(
      h.daemon.mock.calls.slice(before).filter(([method]) => method === "channel.ack")
    ).toEqual([]);
  });

  it("resources/read of another grant's mailbox is refused", async () => {
    const { call } = await setup();
    const refused = JSON.parse(
      (
        await call(
          "resources/read",
          { uri: mailboxUri("someone-else") },
          mailboxUri("someone-else")
        )
      ).body
    ) as { error?: { code: number } };
    expect(refused.error?.code).toBe(-32602);
  });

  it("a legacy client is offered no resources and no push", async () => {
    const h = await pluginHarness();
    const { accessToken } = await connect(h.app, h.authenticator, { name: "dots" });
    const response = await h.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: ACCEPT
      },
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "legacy", version: "1" }
        }
      })
    });
    expect(response.headers["content-type"]).toContain("application/json");
    const { result } = JSON.parse(response.payload) as { result: { capabilities: Json } };
    expect(result.capabilities.resources).toBeUndefined();
  });
});

describe("subscriptions/listen", () => {
  it("a listen on the caller's mailbox gets notifications/resources/updated for its grant only", async () => {
    const { h, call, uri, open } = await setup();
    const listen = await call("subscriptions/listen", listenParams(uri));
    expect(listen.status).toBe(200);
    expect(listen.headers["content-type"]).toContain("text/event-stream");
    expect(listen.headers["x-accel-buffering"]).toBe("no");
    const stream = listen.stream!;
    await vi.waitFor(() =>
      expect(messages(stream.data).map((message) => message.method)).toEqual([
        "notifications/subscriptions/acknowledged"
      ])
    );
    expect(open()).toBe(1);
    h.bus.publish({ kind: "resource_updated", uri: mailboxUri("someone-else") });
    h.bus.publish({ kind: "resource_updated", uri });
    await vi.waitFor(() => expect(messages(stream.data)).toHaveLength(2));
    expect(messages(stream.data)[1]).toMatchObject({
      method: "notifications/resources/updated",
      params: { uri }
    });
  });

  it("a listen naming another grant's mailbox is refused and subscribes nothing", async () => {
    const { call, uri, open } = await setup();
    const refused = await call("subscriptions/listen", {
      notifications: { resourceSubscriptions: [uri, mailboxUri("someone-else")] }
    });
    expect(refused.stream).toBeUndefined();
    expect((JSON.parse(refused.body) as { error: { code: number } }).error.code).toBe(-32602);
    expect(open()).toBe(0);
  });

  it("the client going away ends the listen stream", async () => {
    const { call, uri, open } = await setup();
    const listen = await call("subscriptions/listen", listenParams(uri));
    await vi.waitFor(() => expect(open()).toBe(1));
    listen.stream!.cancel();
    await vi.waitFor(() => expect(open()).toBe(0));
  });
});

describe("who may use push", () => {
  it("a grant without the mail scopes is refused listen, list and read, and subscribes nothing", async () => {
    const { call, uri, open } = await setup("context:read sessions:notify");
    for (const [method, params, name] of [
      ["subscriptions/listen", listenParams(uri), undefined],
      ["resources/list", {}, undefined],
      ["resources/read", { uri }, uri]
    ] as const) {
      const refused = await call(method, params, name);
      expect(refused.stream, method).toBeUndefined();
      expect((JSON.parse(refused.body) as { error: { code: number } }).error.code, method).toBe(
        -32600
      );
    }
    expect(open()).toBe(0);
  });
});

describe("request headers into the SDK", () => {
  it("passes the standard MCP headers and no Mcp-Param-* header", async () => {
    const h = await pluginHarness();
    await connect(h.app, h.authenticator, { name: "dots" });
    const grant = grantNamed(await h.store.readGrants(), "dots");
    const endpoint = createMcpEndpoint({
      daemon: h.daemon,
      store: h.store,
      publicUrl: PUBLIC,
      version: "t",
      toolsListTtlMs: null,
      callbackLimits: h.config.cimd,
      bus: h.bus,
      mail: h.mail
    });
    const fetch = vi.spyOn(endpoint.modern, "fetch");
    const { headers, body } = modernRequest("unused", 1, "tools/list");
    await handleMcpPost(
      endpoint,
      { clientId: grant.client_id, grant },
      { headers: { ...headers, "mcp-param-x": "1" }, body: JSON.parse(body) as unknown }
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const seen = [...(fetch.mock.calls[0][0] as Request).headers.keys()].sort();
    expect(seen).toEqual(["accept", "content-type", "mcp-method", "mcp-protocol-version"]);
  });
});

const OWNER = "lark:oc_owner:abc";
const INBOX = "tether:dots";

function mailRecord(id: string, ts: string, from = OWNER): MailRecord {
  return {
    id: `out_${id}`,
    created_at: ts,
    payload: {
      text: `text of ${id}`,
      data: { event_id: id, event_ts: ts, source_session_key: from }
    }
  };
}

/** A plugin whose duoduo keeps assistant outboxes, approving at 07:30 on 2026-10-04. */
async function mailSetup() {
  const outbox = fakeOutbox();
  const daemon = await fakeDaemon({ override: outbox.override });
  const clock = { at: Date.parse("2026-10-04T07:30:00.000Z") };
  const setUp = await setup(undefined, { daemon, now: () => new Date(clock.at) });
  return { ...setUp, outbox, clock };
}

describe("the mailbox resource lists unread mail (id and sender)", () => {
  it("lists exactly what ReadMail would return, and acknowledges nothing", async () => {
    const { h, call, uri, outbox } = await mailSetup();
    outbox.add(
      INBOX,
      mailRecord("evt_early", "2026-10-04T07:00:00.000Z"),
      mailRecord("evt_job", "2026-10-04T08:00:00.000Z", "job:nightly"),
      mailRecord("evt_ok", "2026-10-04T09:00:00.000Z"),
      mailRecord("evt_peer", "2026-10-04T09:30:00.000Z", "tether:muse")
    );
    const read = JSON.parse((await call("resources/read", { uri }, uri)).body) as {
      result: { contents: Array<{ uri: string; mimeType: string; text: string }> };
    };
    expect(read.result.contents).toHaveLength(1);
    expect(read.result.contents[0]).toMatchObject({ uri, mimeType: "application/json" });
    const listed = (JSON.parse(read.result.contents[0].text) as { unread: unknown[] }).unread;
    expect(listed).toEqual([
      { id: "evt_ok@2026-10-04", from: OWNER },
      { id: "evt_peer@2026-10-04", from: "tether:muse" }
    ]);
    expect(h.daemon.mock.calls.filter(([method]) => method === "channel.ack")).toEqual([]);
    expect(outbox.unread(INBOX)).toHaveLength(4);
    const mail = JSON.parse(
      (await call("tools/call", { name: "ReadMail", arguments: {} }, "ReadMail")).body
    ) as {
      result: { structuredContent: { mails: Array<{ id: string; from: string }> } };
    };
    expect(mail.result.structuredContent.mails.map(({ id, from }) => ({ id, from }))).toEqual(
      listed
    );
  });
});

describe("a listen stream ends when its grant ends", () => {
  async function listening() {
    const setUp = await setup();
    const listen = await setUp.call("subscriptions/listen", listenParams(setUp.uri));
    await vi.waitFor(() => expect(setUp.open()).toBe(1));
    return { ...setUp, stream: listen.stream! };
  }

  it("the assistant revoking its token at /revoke ends its open listen", async () => {
    const { h, accessToken, stream, open } = await listening();
    const grant = grantNamed(await h.store.readGrants(), "dots");
    const revoked = await h.app.inject({
      method: "POST",
      url: "/revoke",
      headers: FORM,
      payload: form({ token: accessToken, client_id: grant.client_id })
    });
    expect(revoked.statusCode).toBe(200);
    await vi.waitFor(() => expect(stream.ended).not.toBeNull());
    await vi.waitFor(() => expect(open()).toBe(0));
  });

  it("the owner revoking the connection ends its open listen", async () => {
    const { h, stream, open } = await listening();
    const out = await runRevoke(
      { store: h.store, config: h.config, daemon: h.daemon, mail: h.mail },
      "dots"
    );
    expect(out.exitCode).toBe(0);
    await vi.waitFor(() => expect(stream.ended).not.toBeNull());
    await vi.waitFor(() => expect(open()).toBe(0));
  });

  it("a new approval that replaces the grant ends the old grant's listen", async () => {
    const { h, stream, open } = await listening();
    await connect(h.app, h.authenticator, { name: "dots" });
    await vi.waitFor(() => expect(stream.ended).not.toBeNull());
    await vi.waitFor(() => expect(open()).toBe(0));
  });

  it("another grant's listen stays open", async () => {
    const { h, stream } = await listening();
    await connect(h.app, h.authenticator, { name: "muse" });
    await runRevoke({ store: h.store, config: h.config, daemon: h.daemon, mail: h.mail }, "muse");
    // Fence on a later frame of this same stream: a keep-alive-free check that it is still read.
    h.bus.publish({
      kind: "resource_updated",
      uri: mailboxUri(grantNamed(await h.store.readGrants(), "dots").grant_id)
    });
    await vi.waitFor(() => expect(messages(stream.data)).toHaveLength(2));
    expect(stream.ended).toBeNull();
  });
});

describe("the listen keep-alive", () => {
  it("is pinned at 15 s: duoduo-tether's idle timeout is derived from it", async () => {
    expect(LISTEN_KEEP_ALIVE_MS).toBe(15_000);
    const { call, uri } = await setup();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const listen = await call("subscriptions/listen", listenParams(uri));
      const stream = listen.stream!;
      await vi.waitFor(() => expect(messages(stream.data)).toHaveLength(1));
      vi.advanceTimersByTime(LISTEN_KEEP_ALIVE_MS - 1);
      expect(stream.data).not.toContain(": keepalive");
      vi.advanceTimersByTime(1);
      await vi.waitFor(() => expect(stream.data).toContain(": keepalive"));
    } finally {
      vi.useRealTimers();
    }
  });
});
