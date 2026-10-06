// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import crypto from "node:crypto";
import { InMemoryServerEventBus } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAdmin, runVerbProcess, type AdminDeps } from "../src/admin";
import type { CallbackPost } from "../src/callback";
import type { FetchLike } from "../src/cimd";
import type { DaemonCall, DaemonReply } from "../src/forward";
import {
  Mailroom,
  mailboxUri,
  mailIdOf,
  mailOf,
  ownedBy,
  ringRequest,
  webhookKey,
  type MailRecord
} from "../src/mail";
import type { Grant, Store } from "../src/store";
import {
  renderBounce,
  renderJobBounce,
  renderMailSent,
  renderMailToSession,
  renderNotYourMail
} from "../src/texts";
import {
  cleanupDirs,
  connect,
  fakeDaemon,
  fakeOutbox,
  fakePull,
  grantNamed,
  makeStore,
  pluginHarness,
  PUBLIC
} from "./helpers";

// The plugin's half of mail between assistants and duoduo's sessions.

afterEach(cleanupDirs);

const SESSION = "lark:oc_x:1";
const DOTS = "tether:dots";
const LIMITS = { timeoutMs: 1000, maxBytes: 4096 };
const APPROVED = "2026-10-04T08:00:00.000Z";
const SECRET = `whsec_${Buffer.from("a-test-signing-secret").toString("base64")}`;

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    grant_id: "g-dots",
    client_id: "https://chatgpt.com/oauth/client.json",
    name: "dots",
    token_digest: "00",
    scopes: [],
    resource: PUBLIC,
    client_name: null,
    approved_at: APPROVED,
    ...overrides
  };
}

/** An outbox record of an assistant session, as the kernel's void delivery writes it. */
function record(id: string, overrides: { ts?: string; data?: Record<string, unknown> } = {}) {
  const ts = overrides.ts ?? "2026-10-04T09:00:00.000Z";
  return {
    id: `out_${id}`,
    created_at: ts,
    payload: {
      text: `text of ${id}`,
      data: {
        event_id: id,
        event_ts: ts,
        source_session_key: SESSION,
        ...overrides.data
      }
    }
  } satisfies MailRecord;
}

/** A daemon that answers each method from a table; anything else is a plain success. */
function tableDaemon(table: Record<string, (params: Record<string, unknown>) => DaemonReply>) {
  return vi.fn<DaemonCall>(async (method, params) =>
    table[method] ? table[method](params) : { result: { ok: true } }
  );
}

async function storeWith(grants: Grant[]): Promise<Store> {
  const { store } = await makeStore();
  await store.writeGrants(Object.fromEntries(grants.map((entry) => [entry.grant_id, entry])));
  return store;
}

const calls = (daemon: ReturnType<typeof vi.fn<DaemonCall>>, method: string) =>
  daemon.mock.calls.filter(([called]) => called === method).map(([, params]) => params);

/** A started Mailroom over `store`, its streams faked. */
async function started(
  store: Store,
  options: {
    daemon?: ReturnType<typeof vi.fn<DaemonCall>>;
    fetchImpl?: FetchLike;
    postCallback?: CallbackPost;
    warn?: (message: string, fields?: Record<string, unknown>) => void;
    bus?: InMemoryServerEventBus;
  } = {}
) {
  const daemon = options.daemon ?? tableDaemon({});
  const pull = fakePull();
  const mail = new Mailroom({
    store,
    daemon,
    openPull: pull.openPull,
    reconnectMs: 0,
    workspace: "/tmp/tether-state",
    callbackLimits: LIMITS,
    bus: options.bus ?? new InMemoryServerEventBus(),
    log: { warn: options.warn ?? vi.fn() },
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.postCallback ? { postCallback: options.postCallback } : {})
  });
  await mail.start();
  return { mail, pull, daemon };
}

describe("the pull streams", () => {
  it("start spawns each assistant's void session and opens one stream per assistant", async () => {
    const store = await storeWith([grant(), grant({ grant_id: "g-muse", name: "muse" })]);
    const { pull, daemon, mail } = await started(store);
    expect(calls(daemon, "channel.spawn")).toEqual([
      {
        channel_kind: "tether",
        channel_id: "tether-dots",
        cwd_abs: "/tmp/tether-state",
        runtime: "void",
        display_name: "dots",
        session_key: DOTS
      },
      expect.objectContaining({ channel_id: "tether-muse", session_key: "tether:muse" })
    ]);
    expect(pull.streamed()).toEqual([DOTS, "tether:muse"]);
    await mail.stop();
    expect(pull.streamed()).toEqual([]);
  });

  it("a dropped stream is opened again", async () => {
    const store = await storeWith([grant()]);
    const { pull } = await started(store);
    pull.drop(DOTS);
    await vi.waitFor(() => expect(pull.opened).toEqual([DOTS, DOTS]));
    expect(pull.streamed()).toEqual([DOTS]);
  });

  it("a stopped mailroom opens nothing again", async () => {
    const store = await storeWith([grant()]);
    const { pull, mail } = await started(store);
    await mail.stop();
    expect(() => pull.drop(DOTS)).toThrow();
    expect(pull.opened).toEqual([DOTS]);
  });
});

describe("a pushed record", () => {
  it("rings the grant's doorbells and its mailbox resource, and acknowledges nothing", async () => {
    const store = await storeWith([
      grant({
        doorbells: [
          { url: "https://hook.example/a", auth: "bearer", secret: "tok", added_at: APPROVED }
        ]
      })
    ]);
    const fetchImpl = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const bus = new InMemoryServerEventBus();
    const published: unknown[] = [];
    bus.subscribe((event) => published.push(event));
    const { pull, daemon } = await started(store, { fetchImpl, bus });
    pull.push(DOTS, record("evt_owned"));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(fetchImpl.mock.calls[0][0]).toBe("https://hook.example/a");
    expect(published).toEqual([{ kind: "resource_updated", uri: mailboxUri("g-dots") }]);
    expect(calls(daemon, "channel.ack")).toEqual([]);
    expect(calls(daemon, "session.notify")).toEqual([]);
  });

  it("mail from before the grant's approval does not ring it; the approval instant is the old grant's", async () => {
    const store = await storeWith([
      grant({
        doorbells: [
          { url: "https://hook.example/a", auth: "hmac", secret: SECRET, added_at: APPROVED }
        ]
      })
    ]);
    const fetchImpl = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const { pull } = await started(store, { fetchImpl });
    pull.push(DOTS, record("evt_early", { ts: "2026-10-04T07:00:00.000Z" }));
    pull.push(DOTS, record("evt_tie", { ts: APPROVED }));
    pull.push(DOTS, record("evt_owned"));
    const rung = () =>
      fetchImpl.mock.calls.map(
        ([, init]) => (init as { headers: Record<string, string> }).headers["webhook-id"]
      );
    // Pushes are handled in order under the store's mutex: once the last rang, the others settled.
    await vi.waitFor(() => expect(rung()).toContain("evt_owned@2026-10-04"));
    expect(rung()).toEqual(["evt_owned@2026-10-04"]);
  });

  it("mail from a job is bounced to the job, once per record, and not rung", async () => {
    const store = await storeWith([grant()]);
    const fetchImpl = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const { pull, daemon } = await started(store, { fetchImpl });
    const fromJob = record("evt_job", { data: { source_session_key: "job:nightly" } });
    pull.push(DOTS, fromJob);
    await vi.waitFor(() => expect(calls(daemon, "session.notify")).toHaveLength(1));
    expect(calls(daemon, "session.notify")[0]).toEqual({
      target: "job:nightly",
      exact_key: true,
      message: renderJobBounce("dots", mailIdOf(fromJob)),
      source: "duoduo",
      force: true,
      idempotency_key: `bounce:${fromJob.id}`
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("ownership", () => {
  it("is the grant approved strictly before the mail", () => {
    const owner = grant();
    expect(ownedBy(owner, record("evt_1", { ts: "2026-10-04T08:00:00.001Z" }))).toBe(true);
    expect(ownedBy(owner, record("evt_1", { ts: APPROVED }))).toBe(false);
  });

  it("reads the event's time, not the record's, so both ways of reading agree", () => {
    const arrived = record("evt_1", { ts: APPROVED });
    const written = { ...arrived, created_at: "2026-10-04T08:00:00.001Z" };
    expect(ownedBy(grant(), written)).toBe(false);
    expect(mailOf(written).ts).toBe(APPROVED);
  });
});

describe("the mail id", () => {
  it("is the event the mail arrived as, and that event's day", () => {
    expect(mailIdOf(record("evt_1", { ts: "2026-10-04T23:59:59.999Z" }))).toBe("evt_1@2026-10-04");
  });
});

describe("a ring", () => {
  const now = new Date("2026-10-04T09:00:00.000Z");

  it("signs per Standard Webhooks in hmac mode and carries no mail content", () => {
    const { url, init } = ringRequest(
      { url: "https://hook.example/a", auth: "hmac", secret: SECRET, added_at: APPROVED },
      "evt_1",
      now
    );
    expect(url).toBe("https://hook.example/a");
    const timestamp = String(now.getTime() / 1000);
    const expected = crypto
      .createHmac("sha256", Buffer.from("a-test-signing-secret"))
      .update(`evt_1.${timestamp}.${init.body}`)
      .digest("base64");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      "webhook-id": "evt_1",
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${expected}`
    });
    expect(JSON.parse(init.body)).toEqual({
      type: "mailbox.new",
      timestamp: now.toISOString(),
      data: {}
    });
  });

  it("sends the secret as the bearer token in bearer mode", () => {
    const { init } = ringRequest(
      { url: "https://hook.example/a", auth: "bearer", secret: "tok", added_at: APPROVED },
      "evt_1",
      now
    );
    expect(init.headers.authorization).toBe("Bearer tok");
    expect(init.headers["webhook-signature"]).toBeUndefined();
  });

  it("never follows a redirect, in either mode", () => {
    for (const auth of ["hmac", "bearer"] as const) {
      const { init } = ringRequest(
        { url: "https://hook.example/a", auth, secret: SECRET, added_at: APPROVED },
        "evt_1",
        now
      );
      expect(init.redirect).toBe("error");
    }
  });

  it("a failed ring logs no secret and no URL path", async () => {
    const store = await storeWith([
      grant({
        doorbells: [
          {
            url: "https://hook.example/private/path?k=v",
            auth: "bearer",
            secret: "tok-secret",
            added_at: APPROVED
          }
        ]
      })
    ]);
    const warn = vi.fn();
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new TypeError("Headers.append: Bearer tok-secret is an invalid header value.");
    });
    const { pull } = await started(store, { warn, fetchImpl });
    pull.push(DOTS, record("evt_owned"));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("tok-secret");
    expect(logged).not.toContain("/private/path");
    expect(warn.mock.calls[0][1]).toEqual({
      tether: "dots",
      host: "hook.example",
      error: "TypeError"
    });
  });

  it("delivers one signed MCP Events POST per live subscription, and skips a lapsed one", async () => {
    const live = {
      id: "sub_live",
      url: "https://receiver.example.com/cb?token=t",
      secret: SECRET,
      refresh_before: null
    };
    const lapsed = {
      ...live,
      id: "sub_lapsed",
      url: "https://old.example.com/cb",
      refresh_before: APPROVED
    };
    const store = await storeWith([grant({ subscriptions: [live, lapsed] })]);
    const postCallback = vi.fn<CallbackPost>(async () => ({ status: 200, body: "" }));
    const { pull } = await started(store, { postCallback });
    pull.push(DOTS, record("evt_owned"));
    await vi.waitFor(() => expect(postCallback).toHaveBeenCalledTimes(1));
    const [url, headers, body, limits] = postCallback.mock.calls[0];
    expect(url).toBe(live.url);
    expect(limits).toBe(LIMITS);
    expect(JSON.parse(body)).toEqual({
      eventId: "evt_owned@2026-10-04",
      name: "mailbox.new",
      timestamp: expect.any(String),
      data: {},
      cursor: null
    });
    expect(headers["webhook-id"]).toBe("evt_owned@2026-10-04");
    expect(headers["x-mcp-subscription-id"]).toBe("sub_live");
    const signed = crypto
      .createHmac("sha256", Buffer.from("a-test-signing-secret"))
      .update(`evt_owned@2026-10-04.${headers["webhook-timestamp"]}.${body}`)
      .digest("base64");
    expect(headers["webhook-signature"]).toBe(`v1,${signed}`);
  });

  it("a non-2xx delivery is logged with its status and no URL path, and not retried", async () => {
    const store = await storeWith([
      grant({
        subscriptions: [
          {
            id: "sub_live",
            url: "https://receiver.example.com/private/path",
            secret: SECRET,
            refresh_before: null
          }
        ]
      })
    ]);
    const warn = vi.fn();
    const postCallback = vi.fn<CallbackPost>(async () => ({ status: 410, body: "gone" }));
    const { pull } = await started(store, { warn, postCallback });
    pull.push(DOTS, record("evt_owned"));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn.mock.calls[0][1]).toEqual({
      tether: "dots",
      host: "receiver.example.com",
      status: 410
    });
    expect(postCallback).toHaveBeenCalledTimes(1);
  });

  it("a failed delivery logs no URL path", async () => {
    const store = await storeWith([
      grant({
        subscriptions: [
          {
            id: "sub_live",
            url: "https://receiver.example.com/private/path",
            secret: SECRET,
            refresh_before: null
          }
        ]
      })
    ]);
    const warn = vi.fn();
    const postCallback = vi.fn<CallbackPost>(async () => {
      throw new Error("connect ECONNREFUSED /private/path");
    });
    const { pull } = await started(store, { warn, postCallback });
    pull.push(DOTS, record("evt_owned"));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("/private/path");
    expect(warn.mock.calls[0][1]).toEqual({
      tether: "dots",
      host: "receiver.example.com",
      error: "Error"
    });
  });

  it("takes a whsec_ secret or bare base64, and nothing else", () => {
    expect(webhookKey(SECRET)?.toString()).toBe("a-test-signing-secret");
    expect(webhookKey("not base64!")).toBeNull();
  });
});

/**
 * A plugin whose duoduo keeps assistant outboxes (fakeOutbox) and a spine holding
 * one `route.deliver` per mail (`spine.cat show` and the session's day rows).
 */
async function mailHarness() {
  const outbox = fakeOutbox();
  const spine = new Map<string, Record<string, unknown>>();
  const daemon = await fakeDaemon({
    sessions: [
      { session_key: SESSION, display_name: "owner chat", kind: "channel" },
      { session_key: "tether:muse", display_name: "muse", kind: "channel" }
    ],
    override: (method, params) => {
      if (method === "spine.cat" && typeof params.show === "string") {
        const event = spine.get(params.show);
        return event !== undefined && String(event.ts).startsWith(String(params.date))
          ? { result: { text: `${JSON.stringify(event, null, 2)}\n` } }
          : { error: { code: -32000, message: `Event ${params.show} not found` } };
      }
      if (method === "spine.cat" && params.redact === "external") {
        // ReadEvents: the external view of one day, as rows (text) or NDJSON (json).
        const rows = [...spine.values()].filter((event) =>
          String(event.ts).startsWith(String(params.date))
        );
        return {
          result: {
            text: rows
              .map((event) => {
                if (params.json === true) {
                  const { ts, type, session_key: sessionKey, id } = event;
                  return `${JSON.stringify({ ts, type, session_key: sessionKey, id })}\n`;
                }
                const payload = event.payload as Record<string, Record<string, unknown>>;
                const refused = payload.payload.notify_refused_reason !== undefined;
                const route = `${String(payload.source_session_key)} → ${String(event.session_key)}`;
                const short = String(event.id).slice(0, 12);
                const note = refused ? `REFUSED ${route}: nobody reads` : route;
                return `${String(event.ts)} · route.deliver ${note}  ${short}\n`;
              })
              .join("")
          }
        };
      }
      if (method === "spine.cat" && typeof params.session === "string") {
        const rows = [...spine.values()].filter(
          (event) =>
            event.session_key === params.session && String(event.ts).startsWith(String(params.date))
        );
        return {
          result: {
            text: rows
              .map(
                (event) => `${JSON.stringify({ ts: event.ts, type: event.type, id: event.id })}\n`
              )
              .join("")
          }
        };
      }
      return outbox.override(method, params);
    }
  });
  const clock = { at: new Date("2026-10-04T07:30:00.000Z").getTime() };
  const h = await pluginHarness({ daemon, now: () => new Date(clock.at) });
  /** Mail into an assistant's session: its outbox record and its spine event. */
  const deliver = (to: string, mail: MailRecord) => {
    outbox.add(to, mail);
    const { source_session_key: sourceSessionKey, ...data } = mail.payload.data ?? {};
    spine.set(String(data.event_id), {
      id: data.event_id,
      ts: data.event_ts,
      type: "route.deliver",
      session_key: to,
      payload: {
        source_session_key: sourceSessionKey,
        payload: { text: mail.payload.text, ...data }
      }
    });
  };
  const tokens = new Map<string, string>();
  const connectAs = async (name: string, clientId?: string, redirectUri?: string) => {
    const { accessToken } = await connect(h.app, h.authenticator, {
      name,
      ...(clientId ? { clientId } : {}),
      ...(redirectUri ? { redirectUri } : {})
    });
    tokens.set(name, accessToken);
  };
  const tool = async (as: string, name: string, args: unknown) => {
    const response = await h.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${tokens.get(as)}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args }
      })
    });
    return (JSON.parse(response.payload) as { result: Record<string, unknown> }).result;
  };
  const sent = (method: string) =>
    h.daemon.mock.calls.filter(([called]) => called === method).map(([, p]) => p);
  return { ...h, outbox, deliver, connectAs, tool, sent, clock };
}

type MailRow = { id: string; from: string; text: string; in_reply_to?: string };
const mailsOf = (result: Record<string, unknown>) =>
  (result.structuredContent as { mails: MailRow[] }).mails;

describe("ReadMail", () => {
  it("returns the unread mail, acknowledges the last record, and the next call is empty", async () => {
    const h = await mailHarness();
    await h.connectAs("dots");
    h.deliver(DOTS, record("evt_1"));
    h.deliver(DOTS, record("evt_2", { ts: "2026-10-04T09:30:00.000Z" }));
    const first = await h.tool("dots", "ReadMail", {});
    expect(mailsOf(first).map((mail) => [mail.id, mail.from, mail.text])).toEqual([
      ["evt_1@2026-10-04", SESSION, "text of evt_1"],
      ["evt_2@2026-10-04", SESSION, "text of evt_2"]
    ]);
    expect(h.sent("channel.ack")).toEqual([
      { session_key: DOTS, consumer_id: "tether-plugin", cursor: "out_evt_2" }
    ]);
    expect(h.outbox.unread(DOTS)).toEqual([]);
    expect(mailsOf(await h.tool("dots", "ReadMail", {}))).toEqual([]);
  });

  it("bounces and acknowledges mail from a job and mail the grant before it left, never shows them", async () => {
    const h = await mailHarness();
    await h.connectAs("dots");
    const early = record("evt_early", { ts: "2026-10-04T07:00:00.000Z" });
    const fromJob = record("evt_job", { data: { source_session_key: "job:nightly" } });
    h.deliver(DOTS, early);
    h.deliver(DOTS, fromJob);
    h.deliver(DOTS, record("evt_ok"));
    const read = await h.tool("dots", "ReadMail", {});
    expect(mailsOf(read).map((mail) => mail.id)).toEqual(["evt_ok@2026-10-04"]);
    expect(h.sent("session.notify")).toEqual([
      expect.objectContaining({
        target: SESSION,
        message: renderBounce("dots", mailIdOf(early)),
        idempotency_key: `bounce:${early.id}`
      }),
      expect.objectContaining({
        target: "job:nightly",
        message: renderJobBounce("dots", mailIdOf(fromJob)),
        idempotency_key: `bounce:${fromJob.id}`
      })
    ]);
    expect(h.outbox.unread(DOTS)).toEqual([]);
  });

  it("acknowledges nothing when duoduo does not answer the pull", async () => {
    const h = await mailHarness();
    await h.connectAs("dots");
    h.deliver(DOTS, record("evt_1"));
    h.daemon.mockImplementationOnce(async () => ({ error: { code: -32000, message: "down" } }));
    const read = await h.tool("dots", "ReadMail", {});
    expect(read.isError).toBe(true);
    expect((read._meta as Record<string, unknown>)["duoduo/reason"]).toBe("unreachable");
    expect(h.sent("channel.ack")).toEqual([]);
    expect(h.outbox.unread(DOTS)).toEqual(["out_evt_1"]);
  });

  it("id and after read back by id and acknowledge nothing", async () => {
    const h = await mailHarness();
    await h.connectAs("dots");
    h.deliver(DOTS, record("evt_1"));
    h.deliver(DOTS, record("evt_2", { ts: "2026-10-04T09:30:00.000Z" }));
    h.clock.at = new Date("2026-10-04T10:00:00.000Z").getTime();
    const one = await h.tool("dots", "ReadMail", { id: "evt_1@2026-10-04" });
    expect(mailsOf(one).map((mail) => mail.id)).toEqual(["evt_1@2026-10-04"]);
    const after = await h.tool("dots", "ReadMail", { after: "evt_1@2026-10-04" });
    expect(mailsOf(after).map((mail) => mail.id)).toEqual(["evt_2@2026-10-04"]);
    expect(h.sent("channel.ack")).toEqual([]);
    expect(h.outbox.unread(DOTS)).toEqual(["out_evt_1", "out_evt_2"]);
  });

  it("after skips a refused delivery and mail from a job", async () => {
    const h = await mailHarness();
    await h.connectAs("dots");
    h.deliver(DOTS, record("evt_1"));
    h.deliver(
      DOTS,
      record("evt_refused", {
        ts: "2026-10-04T09:10:00.000Z",
        data: { notify_refused_reason: "nobody reads" }
      })
    );
    h.deliver(
      DOTS,
      record("evt_job", {
        ts: "2026-10-04T09:20:00.000Z",
        data: { source_session_key: "job:nightly" }
      })
    );
    h.deliver(DOTS, record("evt_2", { ts: "2026-10-04T09:30:00.000Z" }));
    h.clock.at = new Date("2026-10-04T10:00:00.000Z").getTime();
    const after = await h.tool("dots", "ReadMail", { after: "evt_1@2026-10-04" });
    expect(mailsOf(after).map((mail) => mail.id)).toEqual(["evt_2@2026-10-04"]);
  });

  it.each([
    ["an id it never showed", "evt_none@2026-10-04"],
    ["text that is no mail id", "mail 1"],
    ["mail to another assistant", "evt_muse@2026-10-04"],
    ["mail from before this grant", "evt_early@2026-10-04"],
    ["a delivery the consumer gate refused", "evt_refused@2026-10-04"],
    ["mail from a job", "evt_job@2026-10-04"]
  ])("an id that is %s is not_found", async (_label, id) => {
    const h = await mailHarness();
    await h.connectAs("dots");
    h.deliver(DOTS, record("evt_1"));
    h.deliver("tether:muse", record("evt_muse"));
    h.deliver(DOTS, record("evt_early", { ts: "2026-10-04T07:00:00.000Z" }));
    h.deliver(DOTS, record("evt_refused", { data: { notify_refused_reason: "nobody reads" } }));
    h.deliver(DOTS, record("evt_job", { data: { source_session_key: "job:nightly" } }));
    const read = await h.tool("dots", "ReadMail", { id });
    expect(read.isError).toBe(true);
    expect((read._meta as Record<string, unknown>)["duoduo/reason"]).toBe("not_found");
  });

  it("a bare event id reads the unread mail it arrived as, and acknowledges nothing", async () => {
    const h = await mailHarness();
    await h.connectAs("dots");
    h.deliver(DOTS, record("evt_1"));
    const one = await h.tool("dots", "ReadMail", { id: "evt_1" });
    expect(mailsOf(one).map((mail) => mail.id)).toEqual(["evt_1@2026-10-04"]);
    expect(h.sent("channel.ack")).toEqual([]);
    expect(h.outbox.unread(DOTS)).toEqual(["out_evt_1"]);
  });

  it.each(BARE_UNRESOLVED)(
    "a bare event id of %s is not_found, with the refusal for an id without its day",
    async (_label, id) => {
      const h = await bareMailHarness();
      const read = await h.tool("dots", "ReadMail", { id });
      expect(read.isError).toBe(true);
      expect((read._meta as Record<string, unknown>)["duoduo/reason"]).toBe("not_found");
      expect((read.content as Array<{ text: string }>)[0].text).toBe(renderNotYourMail(id, true));
    }
  );
});

/** Bare event ids that name no unread mail of `dots`. */
const BARE_UNRESOLVED = [
  ["mail to another assistant", "evt_muse"],
  ["mail from before this grant", "evt_early"],
  ["a delivery the consumer gate refused", "evt_refused"],
  ["mail from a job", "evt_job"],
  ["mail already read", "evt_read"],
  ["no event at all", "evt_none"]
] as const;

/** `dots` connected, `evt_read` read, and each other unresolvable mail of BARE_UNRESOLVED delivered. */
async function bareMailHarness() {
  const h = await mailHarness();
  await h.connectAs("dots");
  h.deliver(DOTS, record("evt_read"));
  await h.tool("dots", "ReadMail", {});
  h.deliver("tether:muse", record("evt_muse"));
  h.deliver(DOTS, record("evt_early", { ts: "2026-10-04T07:00:00.000Z" }));
  h.deliver(DOTS, record("evt_refused", { data: { notify_refused_reason: "nobody reads" } }));
  h.deliver(DOTS, record("evt_job", { data: { source_session_key: "job:nightly" } }));
  return h;
}

describe("ReadEvents", () => {
  /** `dots` connected; one mail of each kind delivered on 2026-10-04, under ids longer than a row's. */
  async function eventsHarness() {
    const h = await mailHarness();
    await h.connectAs("dots");
    h.deliver(DOTS, record("evt_0a1b2c3d-mine"));
    h.deliver("tether:muse", record("evt_1a1b2c3d-muse"));
    h.deliver(DOTS, record("evt_2a1b2c3d-early", { ts: "2026-10-04T07:00:00.000Z" }));
    h.deliver(
      DOTS,
      record("evt_3a1b2c3d-refused", { data: { notify_refused_reason: "nobody reads" } })
    );
    h.deliver(DOTS, record("evt_4a1b2c3d-job", { data: { source_session_key: "job:nightly" } }));
    return h;
  }

  it("prints the full mail id on this grant's mail rows, and only there", async () => {
    const h = await eventsHarness();
    const result = await h.tool("dots", "ReadEvents", { date: "2026-10-04" });
    const lines = (result.content as Array<{ text: string }>)[0].text.trimEnd().split("\n");
    expect(lines).toEqual([
      `2026-10-04T09:00:00.000Z · route.deliver ${SESSION} → ${DOTS}  evt_0a1b2c3d  mail=evt_0a1b2c3d-mine@2026-10-04`,
      `2026-10-04T09:00:00.000Z · route.deliver ${SESSION} → tether:muse  evt_1a1b2c3d`,
      `2026-10-04T07:00:00.000Z · route.deliver ${SESSION} → ${DOTS}  evt_2a1b2c3d`,
      `2026-10-04T09:00:00.000Z · route.deliver REFUSED ${SESSION} → ${DOTS}: nobody reads  evt_3a1b2c3d`,
      `2026-10-04T09:00:00.000Z · route.deliver job:nightly → ${DOTS}  evt_4a1b2c3d`
    ]);
  });

  it("adds mail_id to this grant's mail rows when json is asked, and only there", async () => {
    const h = await eventsHarness();
    const result = await h.tool("dots", "ReadEvents", { date: "2026-10-04", json: true });
    const rows = (result.content as Array<{ text: string }>)[0].text
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.map((row) => row.mail_id)).toEqual([
      "evt_0a1b2c3d-mine@2026-10-04",
      undefined,
      undefined,
      undefined,
      undefined
    ]);
  });

  it("the id ReadEvents prints answers that mail after ReadMail has read it", async () => {
    const h = await eventsHarness();
    await h.tool("dots", "ReadMail", {});
    const result = await h.tool("dots", "SendMail", {
      in_reply_to: "evt_0a1b2c3d-mine@2026-10-04",
      message: "done"
    });
    expect(result.isError).toBeUndefined();
    // ReadMail bounced the early and the job mail first; the answer is the one call naming it.
    const answers = h
      .sent("session.notify")
      .filter((params) => params.in_reply_to === "evt_0a1b2c3d-mine@2026-10-04");
    expect(answers).toEqual([expect.objectContaining({ target: SESSION })]);
  });
});

describe("SendMail", () => {
  async function sending() {
    const h = await mailHarness();
    await h.connectAs("dots");
    await h.connectAs(
      "muse",
      "https://claude.ai/oauth/mcp-oauth-client-metadata",
      "https://claude.ai/api/mcp/auth_callback"
    );
    return h;
  }

  it("in_reply_to alone answers a session's mail with the plugin's text and a minted mail id", async () => {
    const h = await sending();
    h.deliver(DOTS, record("evt_q"));
    const result = await h.tool("dots", "SendMail", {
      in_reply_to: "evt_q@2026-10-04",
      message: "done"
    });
    expect(result.isError).toBeUndefined();
    const [notified] = h.sent("session.notify");
    const [grantId, mailId] = JSON.parse(String(notified.idempotency_key)) as [string, string];
    expect(grantId).toBe(grantNamed(await h.store.readGrants(), "dots").grant_id);
    expect(mailId).toMatch(/^mail_[0-9a-f]{16}$/);
    expect(notified).toEqual({
      target: SESSION,
      exact_key: true,
      message: renderMailToSession({
        name: "dots",
        mailId,
        inReplyTo: "evt_q@2026-10-04",
        message: "done"
      }),
      source: DOTS,
      in_reply_to: "evt_q@2026-10-04",
      idempotency_key: JSON.stringify([grantId, mailId])
    });
  });

  it("in_reply_to alone answers an assistant's mail into that assistant's session, as sent", async () => {
    const h = await sending();
    h.deliver(
      DOTS,
      record("evt_q", {
        data: { source_session_key: undefined, notify_source_label: "tether:muse" }
      })
    );
    const result = await h.tool("dots", "SendMail", {
      in_reply_to: "evt_q@2026-10-04",
      message: "done"
    });
    expect(result.isError).toBeUndefined();
    expect(h.sent("session.notify")).toEqual([
      expect.objectContaining({
        target: "tether:muse",
        message: "done",
        source: DOTS,
        in_reply_to: "evt_q@2026-10-04"
      })
    ]);
  });

  // A `duoduo session notify` from the command line: a source label, no session.
  it("refuses an in_reply_to to mail from outside duoduo's sessions, naming no pseudo-address", async () => {
    const h = await sending();
    h.deliver(
      DOTS,
      record("evt_q", {
        data: {
          source_session_key: "external:session.notify",
          notify_source_label: "session.notify"
        }
      })
    );
    const result = await h.tool("dots", "SendMail", {
      in_reply_to: "evt_q@2026-10-04",
      message: "seen"
    });
    expect((result._meta as Record<string, unknown>)["duoduo/reason"]).toBe("no_reply_address");
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).not.toContain("session.notify");
    expect(h.sent("session.notify")).toEqual([]);
  });

  it.each([
    ["another assistant's mail", "tether:muse", {}],
    ["mail from a job", DOTS, { source_session_key: "job:nightly" }],
    ["a delivery the consumer gate refused", DOTS, { notify_refused_reason: "nobody reads" }]
  ])("refuses an in_reply_to naming %s, and sends nothing", async (_label, to, data) => {
    const h = await sending();
    h.deliver(to, record("evt_q", { data }));
    const result = await h.tool("dots", "SendMail", {
      in_reply_to: "evt_q@2026-10-04",
      message: "x"
    });
    expect((result._meta as Record<string, unknown>)["duoduo/reason"]).toBe("not_your_mail");
    expect(h.sent("session.notify")).toEqual([]);
  });

  it("in_reply_to as a bare event id answers the unread mail it names, under the id ReadMail shows", async () => {
    const h = await sending();
    h.deliver(DOTS, record("evt_q"));
    const result = await h.tool("dots", "SendMail", { in_reply_to: "evt_q", message: "done" });
    expect(result.isError).toBeUndefined();
    expect(h.sent("session.notify")).toEqual([
      expect.objectContaining({ target: SESSION, in_reply_to: "evt_q@2026-10-04" })
    ]);
    expect(h.sent("channel.ack")).toEqual([]);
  });

  it.each(BARE_UNRESOLVED)(
    "refuses an in_reply_to that is a bare event id of %s as not_your_mail, and sends nothing",
    async (_label, id) => {
      const h = await bareMailHarness();
      const result = await h.tool("dots", "SendMail", { in_reply_to: id, message: "x" });
      expect((result._meta as Record<string, unknown>)["duoduo/reason"]).toBe("not_your_mail");
      expect((result.content as Array<{ text: string }>)[0].text).toBe(renderNotYourMail(id, true));
      expect(h.sent("session.notify")).toEqual([]);
    }
  );

  it.each([
    ["itself", DOTS, "self"],
    ["an assistant with no grant", "tether:nobody", "not_found"],
    ["the bounce sender", "duoduo", "not_found"],
    ["a job", "job:nightly", "job_address"],
    ["no recipient at all", undefined, "no_recipient"]
  ])("refuses %s and sends nothing", async (_label, to, reason) => {
    const h = await sending();
    const result = await h.tool("dots", "SendMail", {
      ...(to !== undefined ? { to } : {}),
      message: "x"
    });
    expect((result._meta as Record<string, unknown>)["duoduo/reason"]).toBe(reason);
    expect(h.sent("session.notify")).toEqual([]);
  });

  it("the receipt for mail to an assistant names when that assistant last acknowledged its mail", async () => {
    const h = await sending();
    h.daemon.mockImplementation(async (method, params) =>
      method === "system.status"
        ? {
            result: {
              sessions: [
                { session_key: "tether:muse", last_cursor_advance_at: "2026-10-04T06:00:00.000Z" }
              ]
            }
          }
        : method === "session.notify"
          ? {
              result: {
                ok: true,
                session_key: params.target,
                route_id: "r",
                event_id: "evt_m",
                ts: "2026-10-04T09:00:00.000Z",
                duplicate: false
              }
            }
          : { result: { ok: true } }
    );
    const result = await h.tool("dots", "SendMail", { to: "tether:muse", message: "hi" });
    expect(result.content).toEqual([
      {
        type: "text",
        text: renderMailSent("tether:muse", "evt_m@2026-10-04", "2026-10-04T06:00:00.000Z", false)
      }
    ]);
  });

  it("to another assistant notifies its session with the grant as idempotency scope", async () => {
    const h = await sending();
    const result = await h.tool("dots", "SendMail", {
      to: "tether:muse",
      message: "hi",
      idempotency_key: "k"
    });
    expect(result.isError).toBeUndefined();
    const dots = grantNamed(await h.store.readGrants(), "dots");
    expect(h.sent("session.notify")).toEqual([
      {
        target: "tether:muse",
        exact_key: true,
        message: "hi",
        source: DOTS,
        idempotency_key: JSON.stringify([dots.grant_id, "k"])
      }
    ]);
  });

  // Moved from the daemon, which now has one key space for every caller.
  it("two grants of one client never share a key; a retry under one grant repeats its key", async () => {
    const h = await mailHarness();
    await h.connectAs("dots");
    await h.connectAs("dots2");
    await h.connectAs(
      "muse",
      "https://claude.ai/oauth/mcp-oauth-client-metadata",
      "https://claude.ai/api/mcp/auth_callback"
    );
    const grants = await h.store.readGrants();
    const first = grantNamed(grants, "dots");
    const second = grantNamed(grants, "dots2");
    expect(first.client_id).toBe(second.client_id);
    const send = (as: string) =>
      h.tool(as, "SendMail", { to: "tether:muse", message: "m", idempotency_key: "k" });
    await send("dots");
    await send("dots2");
    await send("dots");
    expect(h.sent("session.notify").map((params) => params.idempotency_key)).toEqual([
      JSON.stringify([first.grant_id, "k"]),
      JSON.stringify([second.grant_id, "k"]),
      JSON.stringify([first.grant_id, "k"])
    ]);
  });
});

describe("revoke and replace", () => {
  it("revoke bounces the unread mail, acknowledges it and archives the session", async () => {
    const h = await mailHarness();
    await h.connectAs("dots");
    const unread = record("evt_unread");
    h.deliver(DOTS, unread);
    const deps: AdminDeps = {
      store: h.store,
      config: h.config,
      daemon: h.daemon,
      mail: h.mail
    };
    const output = await handleAdmin(deps, { verb: "revoke", args: ["dots"] });
    expect(output.exitCode).toBe(0);
    expect(h.sent("session.notify")).toEqual([
      expect.objectContaining({
        target: SESSION,
        message: renderBounce("dots", mailIdOf(unread)),
        source: "duoduo",
        force: true
      })
    ]);
    expect(h.outbox.unread(DOTS)).toEqual([]);
    expect(h.sent("session.archive")).toEqual([{ session_key: DOTS }]);
  });

  it("a reconnect under the same name keeps the session and bounces only the old grant's mail", async () => {
    const h = await mailHarness();
    await h.connectAs("dots");
    const old = grantNamed(await h.store.readGrants(), "dots");
    const before = record("evt_old", { ts: "2026-10-04T07:45:00.000Z" });
    h.deliver(DOTS, before);
    h.clock.at = new Date("2026-10-04T08:30:00.000Z").getTime();
    await h.connectAs("dots");
    const current = grantNamed(await h.store.readGrants(), "dots");
    expect(current.grant_id).not.toBe(old.grant_id);
    h.deliver(DOTS, record("evt_new"));
    expect(h.sent("session.notify")).toEqual([
      expect.objectContaining({
        target: SESSION,
        message: renderBounce("dots", mailIdOf(before))
      })
    ]);
    expect(h.outbox.unread(DOTS)).toEqual(["out_evt_new"]);
    expect(h.sent("session.archive")).toEqual([]);
    expect(h.sent("channel.spawn").map((params) => params.session_key)).toEqual([DOTS, DOTS]);
  });
});

/**
 * duoduo as the settling sees it: assistant outboxes, the listed sessions, and a
 * session.notify that refuses `down.count` calls as if duoduo did not answer.
 * A repeated idempotency key replays as the daemon's does: the same target
 * and text is a duplicate, anything else an idempotency_conflict.
 */
function factsDaemon(outbox: ReturnType<typeof fakeOutbox>, sessions: string[]) {
  const down = { count: 0 };
  const gone = new Set<string>();
  const sent = new Map<string, { target: unknown; message: unknown }>();
  const daemon = vi.fn<DaemonCall>(async (method, params) => {
    const fromOutbox = outbox.override(method, params);
    if (fromOutbox) return fromOutbox;
    if (method === "session.list") {
      return { result: sessions.map((key) => ({ session_key: key, kind: "channel" })) };
    }
    if (method === "session.notify") {
      if (down.count > 0) {
        down.count -= 1;
        return { error: { code: -32000, message: "down" } };
      }
      if (gone.has(String(params.target))) {
        return { result: { ok: false, reason: "not_found", target: params.target } };
      }
      const key = String(params.idempotency_key);
      const first = sent.get(key);
      if (first === undefined) {
        sent.set(key, { target: params.target, message: params.message });
      } else if (first.target !== params.target || first.message !== params.message) {
        return { result: { ok: false, reason: "idempotency_conflict", target: params.target } };
      }
      return { result: { ok: true, target: params.target, duplicate: first !== undefined } };
    }
    if (method === "session.archive") return { result: { archived: true } };
    return { result: { ok: true } };
  });
  return { daemon, down, gone };
}

describe("settling an assistant's session from the facts", () => {
  it("start bounces a grantless assistant session's unread mail, then archives the session", async () => {
    const outbox = fakeOutbox();
    const left = record("evt_left");
    outbox.add("tether:old", left);
    const { daemon } = factsDaemon(outbox, [SESSION, DOTS, "tether:old"]);
    await started(await storeWith([grant()]), { daemon });
    expect(calls(daemon, "session.notify")).toEqual([
      expect.objectContaining({
        target: SESSION,
        message: renderBounce("old", mailIdOf(left)),
        idempotency_key: `bounce:${left.id}`
      })
    ]);
    expect(outbox.unread("tether:old")).toEqual([]);
    expect(calls(daemon, "session.archive")).toEqual([{ session_key: "tether:old" }]);
  });

  it("start bounces and acknowledges a grant's unread mail from before its approval", async () => {
    const outbox = fakeOutbox();
    const early = record("evt_early", { ts: "2026-10-04T07:00:00.000Z" });
    outbox.add(DOTS, early, record("evt_ok"));
    const { daemon } = factsDaemon(outbox, [DOTS]);
    await started(await storeWith([grant()]), { daemon });
    expect(calls(daemon, "session.notify")).toEqual([
      expect.objectContaining({ target: SESSION, idempotency_key: `bounce:${early.id}` })
    ]);
    expect(outbox.unread(DOTS)).toEqual(["out_evt_ok"]);
    expect(calls(daemon, "session.archive")).toEqual([]);
  });

  it("a bounce duoduo did not take is not acknowledged and the session stays; the next start finishes", async () => {
    const outbox = fakeOutbox();
    const left = record("evt_left");
    outbox.add("tether:old", left);
    const { daemon, down } = factsDaemon(outbox, ["tether:old"]);
    down.count = 1;
    const store = await storeWith([]);
    const first = await started(store, { daemon });
    expect(outbox.unread("tether:old")).toEqual(["out_evt_left"]);
    expect(calls(daemon, "session.archive")).toEqual([]);
    await first.mail.stop();
    await started(store, { daemon });
    expect(calls(daemon, "session.notify").map((params) => params.idempotency_key)).toEqual([
      `bounce:${left.id}`,
      `bounce:${left.id}`
    ]);
    expect(outbox.unread("tether:old")).toEqual([]);
    expect(calls(daemon, "session.archive")).toEqual([{ session_key: "tether:old" }]);
  });

  it("a bounce whose sender's session is gone counts as done", async () => {
    const outbox = fakeOutbox();
    outbox.add("tether:old", record("evt_left"));
    const { daemon, gone } = factsDaemon(outbox, ["tether:old"]);
    gone.add(SESSION);
    await started(await storeWith([]), { daemon });
    expect(outbox.unread("tether:old")).toEqual([]);
    expect(calls(daemon, "session.archive")).toEqual([{ session_key: "tether:old" }]);
  });

  it("a job's mail bounced at push is bounced the same way when its grant ends", async () => {
    const outbox = fakeOutbox();
    const { daemon } = factsDaemon(outbox, [DOTS]);
    const { mail, pull } = await started(await storeWith([grant()]), { daemon });
    const fromJob = record("evt_job", { data: { source_session_key: "job:nightly" } });
    outbox.add(DOTS, fromJob);
    pull.push(DOTS, fromJob);
    await vi.waitFor(() => expect(calls(daemon, "session.notify")).toHaveLength(1));
    expect(await mail.revoked(grant())).toBe(0);
    const [pushed, settled] = calls(daemon, "session.notify");
    expect(settled.message).toBe(pushed.message);
    expect(outbox.unread(DOTS)).toEqual([]);
    expect(calls(daemon, "session.archive")).toEqual([{ session_key: DOTS }]);
  });

  it("ReadMail acknowledges nothing past a bounce duoduo did not take, and bounces it next time", async () => {
    const outbox = fakeOutbox();
    const fromJob = record("evt_job", { data: { source_session_key: "job:nightly" } });
    outbox.add(DOTS, fromJob, record("evt_ok"));
    const { daemon, down } = factsDaemon(outbox, [DOTS]);
    const { mail } = await started(await storeWith([grant()]), { daemon });
    down.count = 1;
    expect(await mail.readUnread(grant())).toEqual([]);
    expect(outbox.unread(DOTS)).toEqual(["out_evt_job", "out_evt_ok"]);
    const read = await mail.readUnread(grant());
    expect(read?.map((mail) => mail.id)).toEqual(["evt_ok@2026-10-04"]);
    expect(outbox.unread(DOTS)).toEqual([]);
  });
});

describe("doorbell list shows event subscriptions", () => {
  it("names each subscription's id, callback host and expiry, never its path or secret", async () => {
    const h = await pluginHarness();
    await connect(h.app, h.authenticator, { name: "dots" });
    await h.store.serialize(async () => {
      const grants = await h.store.readGrants();
      const dots = grantNamed(grants, "dots");
      dots.subscriptions = [
        {
          id: "sub_a",
          url: "https://receiver.example.com/private/path",
          secret: SECRET,
          refresh_before: null
        },
        {
          id: "sub_b",
          url: "https://other.example.com/cb",
          secret: SECRET,
          refresh_before: "2026-10-06T00:00:00.000Z"
        }
      ];
      await h.store.writeGrants(grants);
    });
    const listed = await handleAdmin(
      { store: h.store, config: h.config, daemon: h.daemon, mail: h.mail },
      { verb: "doorbell", args: ["list"] }
    );
    const lines = listed.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^dots .*sub_a.*receiver\.example\.com.*no expiry/);
    expect(lines[1]).toMatch(/^dots .*sub_b.*other\.example\.com/);
    expect(listed.stdout).not.toContain("/private/path");
    expect(listed.stdout).not.toContain(SECRET);
  });
});

describe("doorbell host verbs", () => {
  async function harness() {
    const h = await pluginHarness();
    await connect(h.app, h.authenticator, { name: "dots" });
    const deps: AdminDeps = {
      store: h.store,
      config: h.config,
      daemon: h.daemon,
      mail: h.mail
    };
    const run = (args: string[], secret?: string) =>
      handleAdmin(deps, { verb: "doorbell", args, ...(secret !== undefined ? { secret } : {}) });
    return { ...h, run };
  }

  it("add stores the doorbell on the grant; list never prints the secret; remove drops it", async () => {
    const h = await harness();
    const added = await h.run(
      ["add", "dots", "--url", "https://hook.example/a", "--auth", "hmac"],
      SECRET
    );
    expect(added.exitCode).toBe(0);
    expect(grantNamed(await h.store.readGrants(), "dots").doorbells).toEqual([
      { url: "https://hook.example/a", auth: "hmac", secret: SECRET, added_at: expect.any(String) }
    ]);
    const listed = await h.run(["list"]);
    expect(listed.stdout).toContain("https://hook.example/a");
    expect(listed.stdout).not.toContain(SECRET);
    expect((await h.run(["remove", "dots", "https://hook.example/a"])).exitCode).toBe(0);
    expect(grantNamed(await h.store.readGrants(), "dots").doorbells).toEqual([]);
  });

  it.each([
    [
      "an unknown assistant",
      ["add", "muse", "--url", "https://hook.example/a", "--auth", "bearer"],
      "tok"
    ],
    [
      "a plain http URL off this machine",
      ["add", "dots", "--url", "http://hook.example/a", "--auth", "bearer"],
      "tok"
    ],
    [
      "an hmac secret that is not base64",
      ["add", "dots", "--url", "https://hook.example/a", "--auth", "hmac"],
      "not base64!"
    ],
    [
      "no secret",
      ["add", "dots", "--url", "https://hook.example/a", "--auth", "bearer"],
      undefined
    ],
    [
      "a bearer token with a newline in it",
      ["add", "dots", "--url", "https://hook.example/a", "--auth", "bearer"],
      "tok\nX-Injected: 1"
    ],
    [
      "a bearer token with a control character in it",
      ["add", "dots", "--url", "https://hook.example/a", "--auth", "bearer"],
      "tok\u0007"
    ]
  ])("refuses %s and stores nothing", async (_label, args, secret) => {
    const h = await harness();
    const output = await h.run(args, secret);
    expect(output.exitCode).toBe(2);
    expect(grantNamed(await h.store.readGrants(), "dots").doorbells).toBeUndefined();
  });

  it("the verb process refuses a secret on the command line before reaching the plugin", async () => {
    const output = await runVerbProcess(
      "doorbell",
      ["add", "dots", "--url", "https://hook.example/a", "--auth", "bearer", "--secret", "tok"],
      {},
      "/nonexistent/admin.sock"
    );
    expect(output.exitCode).toBe(2);
  });

  it("the verb process reads the secret from a file and sends it beside the args", async () => {
    const files: string[] = [];
    const output = await runVerbProcess(
      "doorbell",
      ["add", "dots", "--url", "https://hook.example/a", "--auth", "bearer", "--secret-file", "/s"],
      {},
      "/nonexistent/admin.sock",
      {
        stdin: async () => null,
        file: async (file) => {
          files.push(file);
          return "tok\n";
        }
      }
    );
    expect(files).toEqual(["/s"]);
    // No plugin answers on that socket: the read happened, the call found nothing.
    expect(output.exitCode).toBe(1);
  });
});
