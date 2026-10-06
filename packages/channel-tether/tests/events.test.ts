// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAdmin } from "../src/admin";
import { BlockedAddressError, BodyTooLargeError, type CallbackPost } from "../src/callback";
import {
  cleanupDirs,
  connect,
  fakeDaemon,
  grantNamed,
  manualClock,
  pluginHarness
} from "./helpers";

// The 2026-07-28 modern endpoint and
// OpenAI MCP Events (https://developers.openai.com/plugins/build/mcp-events).

afterEach(cleanupDirs);

const MODERN = "2026-07-28";
const CALLBACK = "https://receiver.example.com/callback";
const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;

type Json = Record<string, unknown>;
type Harness = Awaited<ReturnType<typeof pluginHarness>>;

/** A callback that answers each verification POST with its own challenge. */
function echoingCallback(): ReturnType<typeof vi.fn<CallbackPost>> {
  return vi.fn<CallbackPost>(async (_url, _headers, body) => {
    const sent = JSON.parse(body) as { type?: string; challenge?: string };
    return {
      status: 200,
      body: sent.type === "verification" ? JSON.stringify({ challenge: sent.challenge }) : ""
    };
  });
}

async function modern(
  options: Parameters<typeof pluginHarness>[0] & { scope?: string } = {}
): Promise<
  Harness & {
    call: (method: string, params?: Json, name?: string) => Promise<Json>;
    grantId: string;
  }
> {
  const h = await pluginHarness(options);
  const { accessToken } = await connect(h.app, h.authenticator, {
    name: "dots",
    ...(options.scope !== undefined ? { scope: options.scope } : {})
  });
  let id = 0;
  const call = async (method: string, params: Json = {}, name?: string) => {
    const response = await h.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MODERN,
        "mcp-method": method,
        ...(name !== undefined ? { "mcp-name": name } : {})
      },
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: ++id,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN,
            "io.modelcontextprotocol/clientCapabilities": {}
          }
        }
      })
    });
    return JSON.parse(response.payload) as Json;
  };
  const grantId = grantNamed(await h.store.readGrants(), "dots").grant_id;
  return { ...h, call, grantId };
}

const subscribeParams = (overrides: Json = {}) => ({
  name: "mailbox.new",
  arguments: {},
  delivery: { mode: "webhook", url: CALLBACK, secret: SECRET },
  cursor: null,
  ...overrides
});

describe("the 2026-07-28 endpoint", () => {
  it("server/discover advertises the modern revision, tools and events", async () => {
    const h = await modern();
    const { result } = (await h.call("server/discover")) as { result: Json };
    expect(result.supportedVersions).toContain(MODERN);
    expect(result.capabilities).toMatchObject({ tools: {}, events: {} });
  });

  it("tools/list carries the configured cache time", async () => {
    const h = await modern({ config: { toolsListTtlMs: 1234 } });
    const { result } = (await h.call("tools/list")) as { result: Json };
    expect((result.tools as unknown[]).length).toBe(7);
    expect(result.ttlMs).toBe(1234);
  });

  it("tools/call runs as the caller's grant", async () => {
    const h = await modern();
    const { result } = (await h.call(
      "tools/call",
      { name: "GetContext", arguments: {} },
      "GetContext"
    )) as { result: Json };
    expect(result.isError).toBeUndefined();
    expect(h.daemon.mock.calls.filter(([method]) => method === "memory.read")).toEqual([
      ["memory.read", { path: "CLAUDE.md" }]
    ]);
  });
});

describe("events/list", () => {
  it("names mailbox.new: webhook only, no arguments, empty payload", async () => {
    const h = await modern();
    const { result } = (await h.call("events/list")) as { result: { events: Json[] } };
    expect(result.events).toEqual([
      {
        name: "mailbox.new",
        description: expect.any(String),
        delivery: ["webhook"],
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        payloadSchema: { type: "object", properties: {}, additionalProperties: false }
      }
    ]);
  });
});

describe("events/subscribe", () => {
  it("verifies the callback with a signed challenge, then stores the subscription on the grant", async () => {
    const postCallback = echoingCallback();
    const h = await modern({ postCallback });
    const { result } = (await h.call("events/subscribe", subscribeParams())) as {
      result: Json;
    };
    expect(result).toMatchObject({ refreshBefore: null, cursor: null, truncated: false });
    expect(String(result.id)).toMatch(/^sub_/);

    expect(postCallback).toHaveBeenCalledTimes(1);
    const [url, headers, body] = postCallback.mock.calls[0];
    expect(url).toBe(CALLBACK);
    expect(JSON.parse(body)).toEqual({ type: "verification", challenge: expect.any(String) });
    expect(headers["x-mcp-subscription-id"]).toBe(result.id);
    const signed = crypto
      .createHmac("sha256", Buffer.alloc(32, 7))
      .update(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`)
      .digest("base64");
    expect(headers["webhook-signature"]).toBe(`v1,${signed}`);

    expect(grantNamed(await h.store.readGrants(), "dots").subscriptions).toEqual([
      {
        id: result.id,
        url: CALLBACK,
        secret: SECRET,
        refresh_before: null
      }
    ]);
  });

  it("grants exactly the lifetime asked for", async () => {
    const clock = manualClock();
    const h = await modern({ postCallback: echoingCallback(), now: clock.now });
    const { result } = (await h.call("events/subscribe", subscribeParams({ ttlMs: 60_000 }))) as {
      result: Json;
    };
    expect(result.refreshBefore).toBe(new Date(clock.now().getTime() + 60_000).toISOString());
  });

  it("a refresh with the same callback keeps the id and is not verified again", async () => {
    const postCallback = echoingCallback();
    const h = await modern({ postCallback });
    const first = (await h.call("events/subscribe", subscribeParams())) as { result: Json };
    const again = (await h.call("events/subscribe", subscribeParams({ ttlMs: 5000 }))) as {
      result: Json;
    };
    expect(again.result.id).toBe(first.result.id);
    expect(again.result.refreshBefore).not.toBeNull();
    expect(postCallback).toHaveBeenCalledTimes(1);
    expect(grantNamed(await h.store.readGrants(), "dots").subscriptions).toHaveLength(1);
  });

  it("an unsubscribe that lands while a refresh waits for the store is not undone", async () => {
    const postCallback = echoingCallback();
    const h = await modern({ postCallback });
    await h.call("events/subscribe", subscribeParams());
    let release: () => void = () => undefined;
    const serialize = vi.spyOn(h.store, "serialize");
    // Hold the store; the refresh queues behind it, and the subscription is removed meanwhile.
    const held = h.store.serialize(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const refresh = h.call("events/subscribe", subscribeParams({ ttlMs: 5000 }));
    await vi.waitFor(() => expect(serialize).toHaveBeenCalledTimes(2));
    const grants = await h.store.readGrants();
    grants[h.grantId].subscriptions = [];
    await h.store.writeGrants(grants);
    release();
    await held;
    await refresh;
    // Gone when the refresh got the store, so it was a new subscription: verified again.
    expect(postCallback).toHaveBeenCalledTimes(2);
  });

  it("refuses a ttlMs past the last representable date as invalid params", async () => {
    const postCallback = echoingCallback();
    const h = await modern({ postCallback });
    const { error } = (await h.call(
      "events/subscribe",
      subscribeParams({ ttlMs: Number.MAX_SAFE_INTEGER })
    )) as { error: { code: number } };
    expect(error.code).toBe(-32602);
    expect(postCallback).not.toHaveBeenCalled();
  });

  it.each([
    ["http", "http://receiver.example.com/callback"],
    ["a private address", "https://10.0.0.8/callback"],
    ["loopback IPv6", "https://[::1]/callback"],
    ["link-local", "https://169.254.169.254/latest"],
    ["credentials", "https://user:pw@receiver.example.com/callback"]
  ])("refuses a callback with %s as invalid_url and posts nothing", async (_label, url) => {
    const postCallback = echoingCallback();
    const h = await modern({ postCallback });
    const { error } = (await h.call(
      "events/subscribe",
      subscribeParams({ delivery: { mode: "webhook", url, secret: SECRET } })
    )) as { error: { code: number; data: Json } };
    expect(error.code).toBe(-32015);
    expect(error.data).toEqual({ reason: "invalid_url" });
    expect(postCallback).not.toHaveBeenCalled();
    expect(grantNamed(await h.store.readGrants(), "dots").subscriptions).toBeUndefined();
  });

  it.each([
    [
      "a wrong challenge",
      async () => ({ status: 200, body: '{"challenge":"nope"}' }),
      "challenge_failed"
    ],
    ["a non-2xx answer", async () => ({ status: 500, body: "" }), "challenge_failed"],
    [
      "an answer over the byte bound",
      async () => {
        throw new BodyTooLargeError();
      },
      "challenge_failed"
    ],
    ["a redirect", async () => ({ status: 302, body: "" }), "challenge_failed"],
    [
      "a name resolving to a private address",
      async () => {
        throw new BlockedAddressError("receiver.example.com");
      },
      "invalid_url"
    ],
    [
      "a timeout",
      async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      },
      "timeout"
    ]
  ] as const)(
    "a failed verification (%s) is -32015 and stores nothing",
    async (_label, answer, reason) => {
      const h = await modern({ postCallback: vi.fn<CallbackPost>(answer) });
      const { error } = (await h.call("events/subscribe", subscribeParams())) as {
        error: { code: number; data: Json };
      };
      expect(error.code).toBe(-32015);
      expect(error.data).toEqual({ reason });
      expect(grantNamed(await h.store.readGrants(), "dots").subscriptions).toBeUndefined();
    }
  );

  it.each([
    ["an unknown event", { name: "comment.created" }],
    ["arguments", { arguments: { body: "muse" } }],
    ["a non-webhook delivery", { delivery: { mode: "poll" } }],
    [
      "a secret without whsec_",
      { delivery: { mode: "webhook", url: CALLBACK, secret: Buffer.alloc(32).toString("base64") } }
    ],
    [
      "a secret under 24 bytes",
      {
        delivery: {
          mode: "webhook",
          url: CALLBACK,
          secret: `whsec_${Buffer.alloc(23).toString("base64")}`
        }
      }
    ],
    [
      "a secret over 64 bytes",
      {
        delivery: {
          mode: "webhook",
          url: CALLBACK,
          secret: `whsec_${Buffer.alloc(65).toString("base64")}`
        }
      }
    ],
    ["a negative ttlMs", { ttlMs: -1 }]
  ])("refuses %s as invalid params and posts nothing", async (_label, overrides) => {
    const postCallback = echoingCallback();
    const h = await modern({ postCallback });
    const { error } = (await h.call("events/subscribe", subscribeParams(overrides))) as {
      error: { code: number };
    };
    expect(error.code).toBe(-32602);
    expect(postCallback).not.toHaveBeenCalled();
  });

  it("needs the mail scopes", async () => {
    const postCallback = echoingCallback();
    const h = await modern({ postCallback, scope: "context:read" });
    const { error } = (await h.call("events/subscribe", subscribeParams())) as {
      error: { code: number };
    };
    expect(error.code).toBe(-32600);
    expect(postCallback).not.toHaveBeenCalled();
  });
});

describe("events/unsubscribe", () => {
  it("drops the subscription by its callback, and again is a no-op", async () => {
    const h = await modern({ postCallback: echoingCallback() });
    await h.call("events/subscribe", subscribeParams());
    const params = {
      name: "mailbox.new",
      arguments: {},
      delivery: { mode: "webhook", url: CALLBACK }
    };
    expect(((await h.call("events/unsubscribe", params)) as { result: Json }).result).toMatchObject(
      {}
    );
    expect(grantNamed(await h.store.readGrants(), "dots").subscriptions).toEqual([]);
    expect((await h.call("events/unsubscribe", params)) as Json).toHaveProperty("result");
  });
});

describe("a subscription belongs to its grant", () => {
  it("goes with the grant on revoke", async () => {
    const daemon = await fakeDaemon();
    const h = await modern({ postCallback: echoingCallback(), daemon });
    await h.call("events/subscribe", subscribeParams());
    await handleAdmin(
      { store: h.store, config: h.config, daemon, mail: h.mail },
      { verb: "revoke", args: ["dots"] }
    );
    expect(await h.store.readGrants()).toEqual({});
  });
});
