// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Every hop a hosted assistant uses, against a real daemon: discovery, passkey approval,
 * token exchange, every tool, the mail round trip with its push on a listen stream, and
 * revoke. Once on the channel's loopback port, once behind a reverse proxy.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { handleAdmin } from "../src/admin";
import { mailboxUri } from "../src/mail";
import {
  authorizeUrl,
  challengeOf,
  CHATGPT,
  CHATGPT_REDIRECT,
  clientsOf,
  form,
  FORM,
  grantNamed,
  pkce,
  PUBLIC,
  RP_ID,
  SoftAuthenticator
} from "../tests/helpers";
import { listenLoopback } from "../tests/loopback";
import {
  ACCEPT,
  deliveries,
  harness,
  openOwner,
  runId,
  today,
  useCleanups,
  type Json
} from "./helpers";

const cleanup = useCleanups();

/** Forwards every request byte for byte to `upstreamPort`, as nginx or Caddy would. */
async function startReverseProxy(upstreamPort: number): Promise<string> {
  const proxy = http.createServer((incoming, outgoing) => {
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: upstreamPort,
        method: incoming.method,
        path: incoming.url,
        headers: { ...incoming.headers, "x-forwarded-proto": "https" }
      },
      (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(outgoing);
      }
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502).end();
    });
    // A client that leaves closes the upstream request too, as a gateway does.
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
  cleanup(() => new Promise((resolve) => proxy.close(resolve)));
  return `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
}

describe("an assistant over MCP, end to end", () => {
  it("connects on the loopback port, runs every tool, retries a mail, and is cut off by revoke", async () => {
    const run = runId();
    const name = `dots-${run}`;
    const h = await harness(cleanup);
    const owner = await openOwner(h.daemon, run, cleanup);
    // The harness's passkey store holds one authenticator; this test approves with its own.
    const authenticator = new SoftAuthenticator();
    await h.store.writePasskeys([authenticator.passkey()]);
    const request = await listenLoopback(h.app);

    // Discovery.
    const unauthorized = await request({
      method: "POST",
      path: "/mcp",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: "{}"
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers["www-authenticate"]).toContain(
      `resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`
    );
    const resourceMeta = await request({
      method: "GET",
      path: "/.well-known/oauth-protected-resource"
    });
    expect(JSON.parse(resourceMeta.body).authorization_servers).toEqual([PUBLIC]);
    const serverMeta = await request({
      method: "GET",
      path: "/.well-known/oauth-authorization-server"
    });
    expect(JSON.parse(serverMeta.body).token_endpoint).toBe(`${PUBLIC}/token`);

    // Authorize with the passkey, exchange the code.
    const { verifier, challenge: codeChallenge } = pkce();
    const page = await request({ method: "GET", path: authorizeUrl({ challenge: codeChallenge }) });
    expect(page.status).toBe(200);
    const challenge = challengeOf(page.body);
    const approved = await request({
      method: "POST",
      path: "/authorize",
      headers: FORM,
      body: form({
        challenge,
        name,
        assertion: JSON.stringify(authenticator.get({ rpId: RP_ID, origin: PUBLIC, challenge }))
      })
    });
    expect(approved.status).toBe(302);
    const code = new URL(approved.headers.location).searchParams.get("code") ?? "";
    const exchanged = await request({
      method: "POST",
      path: "/token",
      headers: FORM,
      body: form({
        grant_type: "authorization_code",
        code,
        redirect_uri: CHATGPT_REDIRECT,
        client_id: CHATGPT,
        code_verifier: verifier,
        resource: PUBLIC
      })
    });
    expect(exchanged.status).toBe(200);
    const token = (JSON.parse(exchanged.body) as { access_token: string }).access_token;
    const grantId = grantNamed(await h.store.readGrants(), name).grant_id;

    let id = 0;
    const mcp = async (method: string, params: unknown, bearer = token) => {
      const response = await request({
        method: "POST",
        path: "/mcp",
        headers: {
          "content-type": "application/json",
          accept: ACCEPT,
          authorization: `Bearer ${bearer}`
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })
      });
      return { status: response.status, headers: response.headers, body: response.body };
    };
    const tool = async (tool: string, args: Record<string, unknown>) => {
      const response = await mcp("tools/call", { name: tool, arguments: args });
      expect(response.status).toBe(200);
      const result = (JSON.parse(response.body) as { result: Record<string, Json> }).result;
      expect(result.isError, `${tool}: ${JSON.stringify(result)}`).toBeUndefined();
      return result;
    };

    const init = await mcp("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "rig", version: "1" }
    });
    expect(JSON.parse(init.body).result.serverInfo.version).toBe("rig");
    const listed = JSON.parse((await mcp("tools/list", {})).body).result.tools as Array<{
      name: string;
    }>;
    expect(listed).toHaveLength(7);

    // A 2026-07-28 client: its per-request MCP headers reach the SDK.
    const modernRaw = (method: string, params: Record<string, unknown>, tool?: string) =>
      request({
        method: "POST",
        path: "/mcp",
        headers: {
          "content-type": "application/json",
          accept: ACCEPT,
          authorization: `Bearer ${token}`,
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...(tool !== undefined ? { "mcp-name": tool } : {})
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {}
            }
          }
        })
      });
    const modern = async (method: string, params: Record<string, unknown>, tool?: string) => {
      const response = await modernRaw(method, params, tool);
      return JSON.parse(response.body) as { result?: Record<string, Json>; error?: unknown };
    };
    const discovered = await modern("server/discover", {});
    expect(discovered.error).toBeUndefined();
    expect(discovered.result?.supportedVersions).toContain("2026-07-28");
    const called = await modern("tools/call", { name: "GetContext", arguments: {} }, "GetContext");
    expect(called.error).toBeUndefined();
    expect(called.result?.isError).toBeUndefined();

    // Every tool once. The rig's board is empty, and the test does not write the daemon's
    // memory, so that the context carries the board whole stays a unit-suite check.
    const context = await tool("GetContext", {});
    const { conversation, board_rev: boardRev } = context.structuredContent as {
      conversation: string;
      board_rev: string;
    };
    expect(context.content[0].text).toContain(name);
    expect(typeof (await tool("ReadMemory", { path: "CLAUDE.md" })).content[0].text).toBe("string");
    const addresses = (await tool("ListAddresses", {})).structuredContent.addresses as Array<{
      address: string;
    }>;
    expect(addresses.map((entry) => entry.address)).toContain(owner.key);
    const recorded = await tool("RecordExperience", {
      conversation,
      board_rev: boardRev,
      said: "export vertical by default",
      did: "re-exported",
      outcome: "done"
    });
    expect(recorded.structuredContent.duplicate).toBe(false);
    expect(
      (await tool("ReadEvents", { date: today(), count_only: true })).content[0].text
    ).toContain("END spine");

    // A mail retry with the same key gets the first receipt.
    const first = await tool("SendMail", {
      to: owner.key,
      message: "please confirm the export",
      idempotency_key: "k1"
    });
    const retry = await tool("SendMail", {
      to: owner.key,
      message: "please confirm the export",
      idempotency_key: "k1"
    });
    expect(first.structuredContent.duplicate).toBe(false);
    expect(retry.structuredContent).toMatchObject({
      duplicate: true,
      event_id: first.structuredContent.event_id
    });

    // The spine carries the grant's name and client beside each other.
    const experience = JSON.parse(
      (
        (
          await h.daemon("spine.cat", {
            date: today(),
            show: recorded.structuredContent.event_id
          })
        ).result as { text: string }
      ).text
    );
    expect(experience).toMatchObject({
      type: "external.record",
      source: { kind: name },
      session_key: `${name}:${conversation}`,
      payload: { client: { id: CHATGPT, grant: grantId } }
    });
    const rendered = (
      await h.daemon("spine.cat", {
        date: today(),
        session: `${name}:${conversation}`,
        types: ["external.record"],
        unfiltered: true
      })
    ).result as { text: string };
    expect(rendered.text).toContain(`◀ reported via ${name} · client chatgpt.com`);
    const notifies = await deliveries(h.daemon, owner.key);
    expect(notifies).toHaveLength(1);
    expect(notifies[0].payload.payload).toMatchObject({
      notify_source: `tether:${name}`,
      notify_client: { id: CHATGPT, grant: grantId }
    });

    // Mail: the assistant listens on its mailbox, the session mails it, the pull stream
    // rings the listen stream, the assistant reads and answers, and the session answers that.
    const listen = await modernRaw("subscriptions/listen", {
      notifications: { resourceSubscriptions: [mailboxUri(grantId)] }
    });
    expect(listen.headers["content-type"]).toContain("text/event-stream");
    const pushed = () =>
      listen
        .stream!.data.split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)) as { method: string; params: Json });
    await vi.waitFor(() =>
      expect(pushed().map((note) => note.method)).toEqual([
        "notifications/subscriptions/acknowledged"
      ])
    );
    const sent = await h.daemon("session.notify", {
      target: `tether:${name}`,
      message: "what did the export decide?",
      caller_session: owner.key
    });
    expect(sent.result).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(pushed()).toHaveLength(2));
    expect(pushed()[1]).toMatchObject({
      method: "notifications/resources/updated",
      params: { uri: mailboxUri(grantId) }
    });
    listen.stream!.cancel();
    const inbox = (await tool("ReadMail", {})).structuredContent.mails as Array<{
      id: string;
      from: string;
      text: string;
    }>;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ from: owner.key, text: "what did the export decide?" });
    expect((await tool("ReadMail", {})).structuredContent.mails).toEqual([]);
    const answered = await tool("SendMail", {
      in_reply_to: inbox[0].id,
      message: "vertical, by default"
    });
    const replies = (await deliveries(h.daemon, owner.key)).filter(
      (event) => event.payload.payload.notify_in_reply_to === inbox[0].id
    );
    expect(replies).toHaveLength(1);
    const answerId = /as mail (mail_[0-9a-f]{16})/.exec(answered.content[0].text)?.[1];
    expect(answerId).toBeDefined();
    await h.daemon("session.notify", {
      target: `tether:${name}`,
      message: "thanks",
      in_reply_to: answerId,
      caller_session: owner.key
    });
    expect((await tool("ReadMail", {})).structuredContent.mails).toEqual([
      expect.objectContaining({ from: owner.key, text: "thanks", in_reply_to: answerId })
    ]);
    expect((await tool("ReadMail", { id: inbox[0].id })).structuredContent.mails).toEqual(inbox);

    // Revoke: the next call is 401 with the challenge.
    const revoked = await handleAdmin(
      { store: h.store, config: h.config, daemon: h.daemon, mail: h.mail },
      { verb: "revoke", args: [name] }
    );
    expect(revoked.exitCode).toBe(0);
    const refused = await mcp("tools/list", {});
    expect(refused.status).toBe(401);
    expect(refused.headers["www-authenticate"]).toContain("Bearer resource_metadata=");
  });

  it("discovers, approves with a passkey, exchanges the code and calls a tool through a reverse proxy", async () => {
    const run = runId();
    const name = `dots-${run}`;
    const h = await harness(cleanup);
    const authenticator = new SoftAuthenticator();
    await h.store.writePasskeys([authenticator.passkey()]);
    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const base = await startReverseProxy((h.app.server.address() as AddressInfo).port);

    // Discovery: every URL names the public origin, not the proxy's Host.
    const unauthorized = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: "{}"
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain(
      `resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`
    );
    const resourceMeta = (await (
      await fetch(`${base}/.well-known/oauth-protected-resource`)
    ).json()) as { resource: string; authorization_servers: string[] };
    expect(resourceMeta.authorization_servers).toEqual([PUBLIC]);
    const serverMeta = (await (
      await fetch(`${base}/.well-known/oauth-authorization-server`)
    ).json()) as { issuer: string; token_endpoint: string };
    expect(serverMeta.issuer).toBe(PUBLIC);
    expect(serverMeta.token_endpoint).toBe(`${PUBLIC}/token`);

    // Authorize with the passkey; the RP ID is the public host.
    const { verifier, challenge: codeChallenge } = pkce();
    const page = await fetch(`${base}${authorizeUrl({ challenge: codeChallenge })}`);
    expect(page.status).toBe(200);
    const challenge = challengeOf(await page.text());
    const approved = await fetch(`${base}/authorize`, {
      method: "POST",
      headers: FORM,
      redirect: "manual",
      body: form({
        challenge,
        name,
        assertion: JSON.stringify(authenticator.get({ rpId: RP_ID, origin: PUBLIC, challenge }))
      })
    });
    expect(approved.status).toBe(302);
    const location = new URL(approved.headers.get("location") ?? "");
    expect(location.searchParams.get("iss")).toBe(PUBLIC);
    const exchanged = await fetch(`${base}/token`, {
      method: "POST",
      headers: FORM,
      body: form({
        grant_type: "authorization_code",
        code: location.searchParams.get("code") ?? "",
        redirect_uri: CHATGPT_REDIRECT,
        client_id: CHATGPT,
        code_verifier: verifier,
        resource: PUBLIC
      })
    });
    expect(exchanged.status).toBe(200);
    const { access_token: token } = (await exchanged.json()) as { access_token: string };
    expect(clientsOf(await h.store.readGrants())).toEqual([CHATGPT]);

    // One tool call.
    const called = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: ACCEPT,
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "GetContext", arguments: {} }
      })
    });
    expect(called.status).toBe(200);
    const result = ((await called.json()) as { result: Record<string, unknown> }).result;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ board_rev: expect.any(String) });

    // A 2026-07-28 listen on the grant's mailbox: each notification arrives while the
    // response is still open, and the client leaving ends it.
    const uri = mailboxUri(grantNamed(await h.store.readGrants(), name).grant_id);
    let open = 0;
    const subscribe = h.bus.subscribe.bind(h.bus);
    vi.spyOn(h.bus, "subscribe").mockImplementation((listener) => {
      open += 1;
      const off = subscribe(listener);
      return () => {
        open -= 1;
        off();
      };
    });
    const leave = new AbortController();
    const listen = await fetch(`${base}/mcp`, {
      method: "POST",
      signal: leave.signal,
      headers: {
        "content-type": "application/json",
        accept: ACCEPT,
        authorization: `Bearer ${token}`,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "subscriptions/listen"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "subscriptions/listen",
        params: {
          notifications: { resourceSubscriptions: [uri] },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {}
          }
        }
      })
    });
    expect(listen.headers.get("content-type")).toContain("text/event-stream");
    const reader = listen.body!.pipeThrough(new TextDecoderStream()).getReader();
    let seen = "";
    const next = async (method: string) => {
      while (!seen.includes(`"method":"${method}"`)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${method}`);
        seen += value;
      }
    };
    await next("notifications/subscriptions/acknowledged");
    // The mail itself rings the listen stream, through the daemon's pull stream.
    const sent = await h.daemon("session.notify", { target: `tether:${name}`, message: "ring" });
    expect(sent.result).toMatchObject({ ok: true });
    await next("notifications/resources/updated");
    expect(seen).toContain(uri);
    expect(open).toBe(1);
    leave.abort();
    await vi.waitFor(() => expect(open).toBe(0));
  });
});
