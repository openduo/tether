// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT, UnsecuredJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRevoke } from "../src/admin";
import type { FetchLike } from "../src/cimd";
import { SCOPES } from "../src/config";
import type { Grants } from "../src/store";
import {
  approvalLocation,
  authorizeUrl,
  challengeOf,
  CHATGPT,
  CHATGPT_REDIRECT,
  CLAUDE,
  CLAUDE_REDIRECT,
  cleanupDirs,
  clientsOf,
  connect,
  CURSOR,
  CURSOR_CIMD,
  CURSOR_REDIRECT,
  fakeCimd,
  fakeDaemon,
  grantNamed,
  FORM,
  form,
  GROK_REDIRECT,
  manualClock,
  pkce,
  pluginHarness,
  PUBLIC,
  readJsonFile,
  RP_ID,
  SoftAuthenticator
} from "./helpers";

afterEach(cleanupDirs);

type Harness = Awaited<ReturnType<typeof pluginHarness>>;

const grantsOf = (h: Harness) => readJsonFile<Grants>(path.join(h.stateDir, "grants.json"));

async function openPage(h: Harness, overrides: Record<string, string> = {}) {
  const { verifier, challenge } = pkce();
  const page = await h.app.inject({
    method: "GET",
    url: authorizeUrl({ challenge, ...overrides })
  });
  return { page, verifier, codeChallenge: challenge };
}

async function submit(h: Harness, challenge: string, fields: Record<string, string>) {
  return h.app.inject({
    method: "POST",
    url: "/authorize",
    headers: FORM,
    payload: form({ challenge, ...fields })
  });
}

function assertionFor(h: Harness, challenge: string, userVerified = true): string {
  return JSON.stringify(
    h.authenticator.get({ rpId: RP_ID, origin: PUBLIC, challenge, userVerified })
  );
}

describe("discovery", () => {
  it("serves both metadata documents from the public URL, advertising only what exists", async () => {
    const h = await pluginHarness();
    const resource = JSON.parse(
      (await h.app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource" })).payload
    );
    expect(resource).toEqual({
      resource: PUBLIC,
      authorization_servers: [PUBLIC],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ["header"]
    });
    const server = JSON.parse(
      (await h.app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" }))
        .payload
    );
    expect(server).toEqual({
      issuer: PUBLIC,
      authorization_endpoint: `${PUBLIC}/authorize`,
      token_endpoint: `${PUBLIC}/token`,
      revocation_endpoint: `${PUBLIC}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: ["RS256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: [...SCOPES]
    });
  });

  it("without a public URL serves no OAuth or MCP route", async () => {
    const h = await pluginHarness({ config: { publicUrl: null } });
    for (const [method, url] of [
      ["GET", "/.well-known/oauth-protected-resource"],
      ["GET", "/authorize"],
      ["POST", "/token"],
      ["POST", "/mcp"],
      ["GET", "/enroll"],
      ["POST", "/rpc"],
      ["POST", "/pair"]
    ] as const) {
      expect((await h.app.inject({ method, url })).statusCode, url).toBe(404);
    }
  });
});

describe("GET /authorize", () => {
  it.each([
    ["http", "http://chatgpt.com/oauth/client.json"],
    ["not a URL", "chatgpt"]
  ])("refuses a client_id that is %s with a page, before any fetch", async (_label, id) => {
    const h = await pluginHarness();
    const { page } = await openPage(h, { clientId: id });
    expect(page.statusCode).toBe(400);
    expect(page.headers.location).toBeUndefined();
    expect(page.payload).not.toContain("webauthn-options");
    expect(h.fetchImpl).toHaveBeenCalledTimes(0);
  });

  it("shows an unlisted client's full client_id and redirect_uri as unverified, fetching nothing", async () => {
    const h = await pluginHarness();
    const clientId = "https://unknown.example/oauth/client.json";
    const redirectUri = "https://unknown.example/cb?x=1";
    const { page } = await openPage(h, { clientId, redirectUri });
    expect(page.statusCode).toBe(200);
    const shown = page.payload.replace(/&amp;/g, "&");
    expect(shown).toContain(clientId);
    expect(shown).toContain(redirectUri);
    expect(/id="name" name="name" value="([^"]*)"/.exec(page.payload)?.[1]).toBe("unknown-example");
    expect(h.fetchImpl).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["response_type", { response_type: "token" }],
    ["code_challenge_method", { code_challenge_method: "plain" }],
    ["code_challenge", { code_challenge: "short" }],
    ["resource", { resource: `${PUBLIC}/mcp` }],
    ["scope", { scope: "context:read admin" }]
  ])("a bad %s is a page, never a redirect to the unverified address", async (_label, params) => {
    const h = await pluginHarness();
    const { challenge } = pkce();
    const url = new URL(`http://x${authorizeUrl({ challenge })}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await h.app.inject({ method: "GET", url: `${url.pathname}${url.search}` });
    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(response.payload).toContain(_label);
    expect(h.fetchImpl).toHaveBeenCalledTimes(0);
  });

  it("with no passkey enrolled answers a page and mints nothing", async () => {
    const h = await pluginHarness();
    await h.store.writePasskeys([]);
    const { page } = await openPage(h);
    expect(page.statusCode).toBe(503);
    expect(page.payload).not.toContain("webauthn-options");
  });

  it("renders the page with no-store, no-referrer and a hashed-script CSP", async () => {
    const h = await pluginHarness();
    const { page } = await openPage(h);
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    const policy = String(page.headers["content-security-policy"]);
    expect(policy).toContain("frame-ancestors 'none'");
    const script = /<script>([\s\S]*?)<\/script>/.exec(page.payload)?.[1] ?? "";
    const hash = crypto.createHash("sha256").update(script).digest("base64");
    expect(policy).toContain(`script-src 'sha256-${hash}'`);
    expect(page.headers["set-cookie"]).toBeUndefined();
  });

  it("prefills the slug of the client_id host, never a stored grant name", async () => {
    const h = await pluginHarness();
    expect((await connect(h.app, h.authenticator, { name: "dotstether" })).accessToken).not.toBe(
      ""
    );
    const { page } = await openPage(h);
    expect(/id="name" name="name" value="([^"]*)"/.exec(page.payload)?.[1]).toBe("chatgpt-com");
    expect(page.payload).not.toContain("dotstether");
  });

  it("at the cap evicts the oldest challenge, which then answers expired; no 503", async () => {
    const h = await pluginHarness({ config: { challengeCap: 2 } });
    const pages = [await openPage(h), await openPage(h), await openPage(h)];
    expect(pages.map(({ page }) => page.statusCode)).toEqual([200, 200, 200]);
    const [owner, , newest] = pages.map(({ page }) => challengeOf(page.payload));
    const evicted = await submit(h, owner, { name: "dots", assertion: assertionFor(h, owner) });
    expect(evicted.statusCode).toBe(400);
    expect(evicted.headers.location).toBeUndefined();
    expect(evicted.payload).toContain("This approval page has expired");
    const kept = await submit(h, newest, { name: "dots", assertion: assertionFor(h, newest) });
    expect(kept.statusCode).toBe(302);
  });
});

describe("POST /authorize", () => {
  it("a verified passkey and a free name answer 302 with code, state and iss", async () => {
    const h = await pluginHarness();
    const { page } = await openPage(h);
    const challenge = challengeOf(page.payload);
    const approved = await submit(h, challenge, {
      name: "dots",
      assertion: assertionFor(h, challenge)
    });
    expect(approved.statusCode).toBe(302);
    const location = new URL(String(approved.headers.location));
    expect(location.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("state")).toBe("s1");
    expect(location.searchParams.get("iss")).toBe(PUBLIC);
  });

  it("deny needs no passkey, fetches nothing and follows no address; the challenge is gone", async () => {
    const h = await pluginHarness();
    const { page } = await openPage(h);
    const challenge = challengeOf(page.payload);
    const denied = await submit(h, challenge, { deny: "1" });
    expect(denied.statusCode).toBe(200);
    expect(denied.headers.location).toBeUndefined();
    expect(h.fetchImpl).toHaveBeenCalledTimes(0);
    const replay = await submit(h, challenge, {
      name: "dots",
      assertion: assertionFor(h, challenge)
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.headers.location).toBeUndefined();
  });

  it("a replayed form post fails: the challenge was consumed", async () => {
    const h = await pluginHarness();
    const { page } = await openPage(h);
    const challenge = challengeOf(page.payload);
    const fields = { name: "dots", assertion: assertionFor(h, challenge) };
    expect((await submit(h, challenge, fields)).statusCode).toBe(302);
    const replay = await submit(h, challenge, fields);
    expect(replay.statusCode).toBe(400);
    expect(replay.headers.location).toBeUndefined();
  });

  it.each([
    ["without user verification", (h: Harness, c: string) => assertionFor(h, c, false)],
    ["signed over another challenge", (h: Harness) => assertionFor(h, "AAAA")],
    [
      "from an unknown credential",
      (_h: Harness, c: string) =>
        JSON.stringify(new SoftAuthenticator().get({ rpId: RP_ID, origin: PUBLIC, challenge: c }))
    ],
    ["missing", () => ""]
  ])("an assertion %s approves nothing and consumes the challenge", async (_label, make) => {
    const h = await pluginHarness();
    const { page } = await openPage(h);
    const challenge = challengeOf(page.payload);
    const failed = await submit(h, challenge, { name: "dots", assertion: make(h, challenge) });
    expect(failed.statusCode).toBe(400);
    expect(failed.headers.location).toBeUndefined();
    const retry = await submit(h, challenge, {
      name: "dots",
      assertion: assertionFor(h, challenge)
    });
    expect(retry.statusCode).toBe(400);
  });

  it("an expired challenge approves nothing", async () => {
    const clock = manualClock();
    const h = await pluginHarness({ now: clock.now, config: { challengeLifetimeMs: 1000 } });
    const { page } = await openPage(h);
    const challenge = challengeOf(page.payload);
    clock.advance(1000);
    const late = await submit(h, challenge, {
      name: "dots",
      assertion: assertionFor(h, challenge)
    });
    expect(late.statusCode).toBe(400);
    expect(late.headers.location).toBeUndefined();
  });

  it.each([
    ["the pattern", "Dots"],
    ["an internal kind", "runner"],
    ["a configured channel kind", "feishu"],
    ["an installed plugin type", "tether"]
  ])(
    "a name that is %s returns the page with a fresh challenge and no code",
    async (_label, name) => {
      const h = await pluginHarness();
      const { page } = await openPage(h);
      const challenge = challengeOf(page.payload);
      const refused = await submit(h, challenge, { name, assertion: assertionFor(h, challenge) });
      expect(refused.statusCode).toBe(200);
      expect(refused.headers.location).toBeUndefined();
      const fresh = challengeOf(refused.payload);
      expect(fresh).not.toBe(challenge);
      expect(refused.payload).toContain('class="reason"');
      expect(/id="name" name="name" value="([^"]*)"/.exec(refused.payload)?.[1]).toBe(name);
      const retried = await submit(h, fresh, { name: "dots", assertion: assertionFor(h, fresh) });
      expect(retried.statusCode).toBe(302);
    }
  );

  // An assistant's name is the first segment of its record keys and an address; these
  // would land in another namespace or be unrevokable (`revoke help`).
  it.each(["tether", "help", "job", "subconscious", "lark", "meta", "cadence", "system"])(
    "the reserved name %s is refused with no code",
    async (name) => {
      const h = await pluginHarness();
      const { page } = await openPage(h);
      const challenge = challengeOf(page.payload);
      const refused = await submit(h, challenge, { name, assertion: assertionFor(h, challenge) });
      expect(refused.statusCode).toBe(200);
      expect(refused.headers.location).toBeUndefined();
      expect(refused.payload).toContain('class="reason"');
      expect(Object.keys(await h.store.readGrants())).toHaveLength(0);
    }
  );

  // A channel directory duoduo cannot read is a refusal, not an empty list.
  async function dirsOf(daemon: Awaited<ReturnType<typeof fakeDaemon>>) {
    const info = (await daemon("system.runtime.info", {})).result as {
      kernel_dir: string;
      runtime_dir: string;
    };
    return {
      config: path.join(info.kernel_dir, "config"),
      plugins: path.join(info.runtime_dir, "plugins", "channels")
    };
  }

  it.each(["config", "plugins"] as const)(
    "an unreadable %s directory refuses the approval and mints no code",
    async (which) => {
      const daemon = await fakeDaemon();
      const dir = (await dirsOf(daemon))[which];
      await fs.chmod(dir, 0o000);
      try {
        const h = await pluginHarness({ daemon });
        const { page } = await openPage(h);
        const challenge = challengeOf(page.payload);
        const refused = await submit(h, challenge, {
          name: "dots",
          assertion: assertionFor(h, challenge)
        });
        expect(refused.statusCode).toBe(200);
        expect(refused.headers.location).toBeUndefined();
        expect(refused.payload).toContain('class="reason"');
      } finally {
        await fs.chmod(dir, 0o700);
      }
    }
  );

  it("an unreadable channel directory at token exchange refuses the grant", async () => {
    const daemon = await fakeDaemon();
    const h = await pluginHarness({ daemon });
    const { config } = await dirsOf(daemon);
    const { verifier, challenge: codeChallenge } = pkce();
    const page = await h.app.inject({
      method: "GET",
      url: authorizeUrl({ challenge: codeChallenge })
    });
    const challenge = challengeOf(page.payload);
    const approved = await submit(h, challenge, {
      name: "dots",
      assertion: assertionFor(h, challenge)
    });
    const code = new URL(String(approved.headers.location)).searchParams.get("code") ?? "";
    await fs.chmod(config, 0o000);
    try {
      const token = await h.app.inject({
        method: "POST",
        url: "/token",
        headers: FORM,
        payload: form({
          grant_type: "authorization_code",
          code,
          redirect_uri: CHATGPT_REDIRECT,
          client_id: CHATGPT,
          code_verifier: verifier,
          resource: PUBLIC
        })
      });
      expect(token.statusCode).toBe(400);
      expect(JSON.parse(token.payload).error).toBe("invalid_grant");
      expect(await h.store.readGrants()).toEqual({});
    } finally {
      await fs.chmod(config, 0o700);
    }
  });

  it("a plain file under plugins/channels is not an installed plugin type", async () => {
    const daemon = await fakeDaemon();
    await fs.writeFile(path.join((await dirsOf(daemon)).plugins, "notes"), "x");
    const h = await pluginHarness({ daemon });
    expect((await connect(h.app, h.authenticator, { name: "notes" })).token.statusCode).toBe(200);
  });

  it("another client's grant name is refused; the same client may keep its own", async () => {
    const h = await pluginHarness();
    await connect(h.app, h.authenticator, { name: "dots" });
    const page = await h.app.inject({
      method: "GET",
      url: authorizeUrl({
        challenge: pkce().challenge,
        clientId: CLAUDE,
        redirectUri: CLAUDE_REDIRECT
      })
    });
    const challenge = challengeOf(page.payload);
    const refused = await submit(h, challenge, {
      name: "dots",
      assertion: assertionFor(h, challenge)
    });
    expect(refused.statusCode).toBe(200);
    expect(refused.headers.location).toBeUndefined();
    const again = await connect(h.app, h.authenticator, { name: "dots" });
    expect(again.token.statusCode).toBe(200);
  });
});

describe("any https client, fetched only after the passkey", () => {
  const mcp = (h: Harness, token: string) =>
    h.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });

  it("GrokBot on Cursor's shared document connects end to end through the passkey", async () => {
    const h = await pluginHarness();
    const { verifier, challenge: codeChallenge } = pkce();
    const page = await h.app.inject({
      method: "GET",
      url: authorizeUrl({ challenge: codeChallenge, clientId: CURSOR, redirectUri: GROK_REDIRECT })
    });
    expect(page.statusCode).toBe(200);
    expect(page.payload).toContain(CURSOR);
    expect(page.payload).toContain(GROK_REDIRECT);
    expect(/id="name" name="name" value="([^"]*)"/.exec(page.payload)?.[1]).toBe("cursor-com");
    expect(h.fetchImpl).toHaveBeenCalledTimes(0);
    const challenge = challengeOf(page.payload);
    const approved = await submit(h, challenge, {
      name: "grok",
      assertion: assertionFor(h, challenge)
    });
    expect(approved.statusCode).toBe(302);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.fetchImpl.mock.calls[0]?.[0]).toBe(CURSOR);
    expect(h.fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    const location = new URL(String(approved.headers.location));
    expect(`${location.origin}${location.pathname}`).toBe(GROK_REDIRECT);
    expect(location.searchParams.get("state")).toBe("s1");
    const token = await h.app.inject({
      method: "POST",
      url: "/token",
      headers: FORM,
      payload: form({
        grant_type: "authorization_code",
        code: location.searchParams.get("code") ?? "",
        redirect_uri: GROK_REDIRECT,
        client_id: CURSOR,
        code_verifier: verifier,
        resource: PUBLIC
      })
    });
    expect(token.statusCode, token.payload).toBe(200);
    const grant = grantNamed(await grantsOf(h), "grok");
    expect(grant.client_id).toBe(CURSOR);
    expect(grant.client_name).toBe("Cursor");
    const accessToken = JSON.parse(token.payload).access_token as string;
    expect((await mcp(h, accessToken)).statusCode).toBe(200);
  });

  it("fetches nothing before a verified passkey: not on the page, not on a failed assertion", async () => {
    const h = await pluginHarness();
    const { page } = await openPage(h, { clientId: CURSOR, redirectUri: GROK_REDIRECT });
    const challenge = challengeOf(page.payload);
    const failed = await submit(h, challenge, {
      name: "grok",
      assertion: assertionFor(h, challenge, false)
    });
    expect(failed.statusCode).toBe(400);
    expect(h.fetchImpl).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["answers HTTP 404", () => new Response("gone", { status: 404 })],
    [
      "names another client_id",
      () => Response.json({ ...CURSOR_CIMD, client_id: "https://cursor.com/other.json" })
    ],
    ["is not JSON", () => new Response("<html>", { status: 200 })]
  ])(
    "a client document that %s after the passkey approves nothing and gives a fresh challenge",
    async (_label, answer) => {
      const fetchImpl = vi.fn<FetchLike>(async () => answer());
      const h = await pluginHarness({ fetchImpl });
      const { page } = await openPage(h, { clientId: CURSOR, redirectUri: GROK_REDIRECT });
      const challenge = challengeOf(page.payload);
      const refused = await submit(h, challenge, {
        name: "grok",
        assertion: assertionFor(h, challenge)
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(refused.statusCode).toBe(200);
      expect(refused.headers.location).toBeUndefined();
      expect(refused.payload).toContain('class="reason"');
      expect(refused.payload).toContain("Nothing was approved");
      const fresh = challengeOf(refused.payload);
      expect(fresh).not.toBe(challenge);
      expect(/id="name" name="name" value="([^"]*)"/.exec(refused.payload)?.[1]).toBe("grok");
      expect(await grantsOf(h)).toBeNull();
      // The old challenge is consumed; the fresh one is the only way on.
      const replay = await submit(h, challenge, {
        name: "grok",
        assertion: assertionFor(h, challenge)
      });
      expect(replay.statusCode).toBe(400);
    }
  );

  it("a redirect_uri the fetched document does not list is refused after the passkey, never followed", async () => {
    const h = await pluginHarness();
    const evil = "https://evil.example/cb";
    const { page } = await openPage(h, { clientId: CURSOR, redirectUri: evil });
    expect(page.statusCode).toBe(200);
    const challenge = challengeOf(page.payload);
    const refused = await submit(h, challenge, {
      name: "grok",
      assertion: assertionFor(h, challenge)
    });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(refused.statusCode).toBe(200);
    expect(refused.headers.location).toBeUndefined();
    expect(refused.payload).toContain('class="reason"');
    expect(refused.payload).not.toContain("code=");
    expect(await grantsOf(h)).toBeNull();
  });

  it("two assistants on one client_id coexist, each with its own token", async () => {
    const h = await pluginHarness();
    const grok = await connect(h.app, h.authenticator, {
      name: "grok",
      clientId: CURSOR,
      redirectUri: GROK_REDIRECT
    });
    const cursor = await connect(h.app, h.authenticator, {
      name: "cursor",
      clientId: CURSOR,
      redirectUri: CURSOR_REDIRECT
    });
    expect(cursor.approved.statusCode).toBe(302);
    expect((await mcp(h, grok.accessToken)).statusCode).toBe(200);
    expect((await mcp(h, cursor.accessToken)).statusCode).toBe(200);
    const grants = (await grantsOf(h)) ?? {};
    expect(clientsOf(grants)).toEqual([CURSOR, CURSOR]);
    expect(grantNamed(grants, "grok").grant_id).not.toBe(grantNamed(grants, "cursor").grant_id);
  });

  it("a name another client's assistant holds is refused after the passkey, before any fetch", async () => {
    const h = await pluginHarness();
    await connect(h.app, h.authenticator, { name: "dots" });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    const { page } = await openPage(h, { clientId: CURSOR, redirectUri: GROK_REDIRECT });
    const challenge = challengeOf(page.payload);
    const refused = await submit(h, challenge, {
      name: "dots",
      assertion: assertionFor(h, challenge)
    });
    expect(refused.statusCode).toBe(200);
    expect(refused.headers.location).toBeUndefined();
    expect(refused.payload).toContain("ChatGPT");
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(clientsOf(await grantsOf(h))).toEqual([CHATGPT]);
  });

  it("revoke <name> also voids a pending re-approval bound to that name", async () => {
    const h = await pluginHarness();
    await connect(h.app, h.authenticator, { name: "dots" });
    const { verifier, page } = await openPage(h);
    const challenge = challengeOf(page.payload);
    const approved = await submit(h, challenge, {
      name: "dots",
      assertion: assertionFor(h, challenge)
    });
    expect(approved.statusCode).toBe(200);
    const location = approvalLocation(approved);
    expect(location).not.toBeNull();
    // Revoke by name voids the approval bound to that name too.
    const revoked = await runRevoke(
      { store: h.store, config: h.config, daemon: h.daemon, mail: h.mail },
      "dots"
    );
    expect(revoked.exitCode).toBe(0);
    const token = await h.app.inject({
      method: "POST",
      url: "/token",
      headers: FORM,
      payload: form({
        grant_type: "authorization_code",
        code: location?.searchParams.get("code") ?? "",
        redirect_uri: CHATGPT_REDIRECT,
        client_id: CHATGPT,
        code_verifier: verifier,
        resource: PUBLIC
      })
    });
    expect(JSON.parse(token.payload).error).toBe("invalid_grant");
    expect(await h.store.readGrants()).toEqual({});
  });
});

describe("POST /token", () => {
  it("answers a Bearer token with no expires_in and no refresh_token, and stores only its digest", async () => {
    const h = await pluginHarness();
    const { token, accessToken } = await connect(h.app, h.authenticator, { name: "dots" });
    expect(token.statusCode).toBe(200);
    expect(token.headers["cache-control"]).toBe("no-store");
    const body = JSON.parse(token.payload);
    expect(Object.keys(body).sort()).toEqual(["access_token", "scope", "token_type"]);
    expect(body.token_type).toBe("Bearer");
    expect(body.scope).toBe(SCOPES.join(" "));
    expect(accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const grants = (await grantsOf(h)) ?? {};
    expect(clientsOf(grants)).toEqual([CHATGPT]);
    const grant = grantNamed(grants, "dots");
    expect(Object.keys(grants)).toEqual([grant.grant_id]);
    expect(grant.client_id).toBe(CHATGPT);
    expect(grant.client_name).toBe("ChatGPT");
    expect(grant.resource).toBe(PUBLIC);
    expect(grant.grant_id).toMatch(/^[0-9a-f]{32}$/);
    expect(grant.token_digest).toBe(crypto.createHash("sha256").update(accessToken).digest("hex"));
    expect(JSON.stringify(grants)).not.toContain(accessToken);
  });

  it("a code works once; a second exchange is invalid_grant", async () => {
    const h = await pluginHarness();
    const first = await connect(h.app, h.authenticator, { name: "dots" });
    const again = await h.app.inject({
      method: "POST",
      url: "/token",
      headers: FORM,
      payload: form({
        grant_type: "authorization_code",
        code: first.code,
        redirect_uri: CHATGPT_REDIRECT,
        client_id: CHATGPT,
        code_verifier: "x".repeat(43),
        resource: PUBLIC
      })
    });
    expect(JSON.parse(again.payload).error).toBe("invalid_grant");
  });

  it.each([
    ["verifier", { code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier" }],
    ["redirect_uri", { redirect_uri: "https://chatgpt.com/other" }],
    ["client_id", { client_id: CLAUDE }],
    ["resource", { resource: "https://other.example.com" }]
  ])("a wrong %s is invalid_grant and the code is gone", async (_label, wrong) => {
    const h = await pluginHarness();
    const { verifier, challenge: codeChallenge } = pkce();
    const page = await h.app.inject({
      method: "GET",
      url: authorizeUrl({ challenge: codeChallenge })
    });
    const challenge = challengeOf(page.payload);
    const approved = await submit(h, challenge, {
      name: "dots",
      assertion: assertionFor(h, challenge)
    });
    const code = new URL(String(approved.headers.location)).searchParams.get("code") ?? "";
    const right = {
      grant_type: "authorization_code",
      code,
      redirect_uri: CHATGPT_REDIRECT,
      client_id: CHATGPT,
      code_verifier: verifier,
      resource: PUBLIC
    };
    const bad = await h.app.inject({
      method: "POST",
      url: "/token",
      headers: FORM,
      payload: form({ ...right, ...wrong })
    });
    expect(JSON.parse(bad.payload).error).toBe("invalid_grant");
    const good = await h.app.inject({
      method: "POST",
      url: "/token",
      headers: FORM,
      payload: form(right)
    });
    expect(JSON.parse(good.payload).error).toBe("invalid_grant");
    expect(await grantsOf(h)).toBeNull();
  });

  it.each([
    ["client_id", "missing", undefined],
    ["client_id", "wrong", CLAUDE],
    ["redirect_uri", "missing", undefined],
    ["redirect_uri", "wrong", "https://chatgpt.com/other"],
    ["resource", "missing", undefined],
    ["resource", "wrong", "https://other.example.com"],
    ["code_verifier", "missing", undefined],
    ["code_verifier", "wrong", "wrong-verifier-wrong-verifier-wrong-verifier"]
  ] as const)(
    "a %s that is %s is invalid_grant naming that parameter, and the code is gone",
    async (param, _how, value) => {
      const h = await pluginHarness();
      const { verifier, challenge: codeChallenge } = pkce();
      const page = await h.app.inject({
        method: "GET",
        url: authorizeUrl({ challenge: codeChallenge })
      });
      const challenge = challengeOf(page.payload);
      const approved = await submit(h, challenge, {
        name: "dots",
        assertion: assertionFor(h, challenge)
      });
      const code = new URL(String(approved.headers.location)).searchParams.get("code") ?? "";
      const right: Record<string, string> = {
        grant_type: "authorization_code",
        code,
        redirect_uri: CHATGPT_REDIRECT,
        client_id: CHATGPT,
        code_verifier: verifier,
        resource: PUBLIC
      };
      const sent = { ...right };
      if (value === undefined) delete sent[param];
      else sent[param] = value;
      const bad = await h.app.inject({
        method: "POST",
        url: "/token",
        headers: FORM,
        payload: form(sent)
      });
      const body = JSON.parse(bad.payload);
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toContain(param);
      const good = await h.app.inject({
        method: "POST",
        url: "/token",
        headers: FORM,
        payload: form(right)
      });
      expect(JSON.parse(good.payload).error).toBe("invalid_grant");
    }
  );

  it("an expired code is invalid_grant", async () => {
    const clock = manualClock();
    const h = await pluginHarness({ now: clock.now, config: { codeLifetimeMs: 1000 } });
    const { verifier, challenge: codeChallenge } = pkce();
    const page = await h.app.inject({
      method: "GET",
      url: authorizeUrl({ challenge: codeChallenge })
    });
    const challenge = challengeOf(page.payload);
    const approved = await submit(h, challenge, {
      name: "dots",
      assertion: assertionFor(h, challenge)
    });
    clock.advance(1000);
    const late = await h.app.inject({
      method: "POST",
      url: "/token",
      headers: FORM,
      payload: form({
        grant_type: "authorization_code",
        code: new URL(String(approved.headers.location)).searchParams.get("code") ?? "",
        redirect_uri: CHATGPT_REDIRECT,
        client_id: CHATGPT,
        code_verifier: verifier,
        resource: PUBLIC
      })
    });
    expect(JSON.parse(late.payload).error).toBe("invalid_grant");
  });

  it("two approvals for different clients with one name: the first exchange commits, the second fails", async () => {
    const h = await pluginHarness();
    const approve = async (clientId: string, redirectUri: string) => {
      const { verifier, challenge: codeChallenge } = pkce();
      const page = await h.app.inject({
        method: "GET",
        url: authorizeUrl({ challenge: codeChallenge, clientId, redirectUri })
      });
      const challenge = challengeOf(page.payload);
      const approved = await submit(h, challenge, {
        name: "dots",
        assertion: assertionFor(h, challenge)
      });
      return {
        grant_type: "authorization_code",
        code: new URL(String(approved.headers.location)).searchParams.get("code") ?? "",
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: PUBLIC
      };
    };
    const chatgpt = await approve(CHATGPT, CHATGPT_REDIRECT);
    const claude = await approve(CLAUDE, CLAUDE_REDIRECT);
    const exchange = (fields: Record<string, string>) =>
      h.app.inject({ method: "POST", url: "/token", headers: FORM, payload: form(fields) });
    expect((await exchange(chatgpt)).statusCode).toBe(200);
    expect(JSON.parse((await exchange(claude)).payload).error).toBe("invalid_grant");
    expect(clientsOf(await grantsOf(h))).toEqual([CHATGPT]);
  });
});

describe("tokens and revocation", () => {
  const mcp = (h: Harness, token: string) =>
    h.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });

  it("a new approval for the same client under the same name replaces the old token", async () => {
    const h = await pluginHarness();
    const first = await connect(h.app, h.authenticator, { name: "dots" });
    const before = grantNamed(await grantsOf(h), "dots");
    expect((await mcp(h, first.accessToken)).statusCode).toBe(200);
    const second = await connect(h.app, h.authenticator, { name: "dots" });
    // The owner learns of the replacement on a result page, after the passkey.
    expect(second.approved.statusCode).toBe(200);
    expect(second.approved.payload).toContain("replaces it");
    expect(second.approved.headers.location).toBeUndefined();
    expect((await mcp(h, first.accessToken)).statusCode).toBe(401);
    expect((await mcp(h, second.accessToken)).statusCode).toBe(200);
    const grants = (await grantsOf(h)) ?? {};
    expect(Object.values(grants).map((grant) => grant.name)).toEqual(["dots"]);
    expect(grantNamed(grants, "dots").grant_id).not.toBe(before.grant_id);
  });

  it("a new approval for the same client under another name adds an assistant; both tokens work", async () => {
    const h = await pluginHarness();
    const first = await connect(h.app, h.authenticator, { name: "dots" });
    const second = await connect(h.app, h.authenticator, { name: "kai" });
    expect(second.approved.statusCode).toBe(302);
    expect((await mcp(h, first.accessToken)).statusCode).toBe(200);
    expect((await mcp(h, second.accessToken)).statusCode).toBe(200);
    expect(clientsOf(await grantsOf(h))).toEqual([CHATGPT, CHATGPT]);
  });

  it("client /revoke deletes only a grant whose token belongs to that client, and always answers 200", async () => {
    const h = await pluginHarness();
    const { accessToken } = await connect(h.app, h.authenticator, { name: "dots" });
    const revoke = (fields: Record<string, string>) =>
      h.app.inject({ method: "POST", url: "/revoke", headers: FORM, payload: form(fields) });
    expect((await revoke({ token: accessToken, client_id: CLAUDE })).statusCode).toBe(200);
    expect((await mcp(h, accessToken)).statusCode).toBe(200);
    expect((await revoke({ token: "nonsense", client_id: CHATGPT })).statusCode).toBe(200);
    expect((await mcp(h, accessToken)).statusCode).toBe(200);
    expect((await revoke({ token: accessToken, client_id: CHATGPT })).statusCode).toBe(200);
    expect((await mcp(h, accessToken)).statusCode).toBe(401);
  });

  it("a revoke before the exchange voids the code", async () => {
    const h = await pluginHarness();
    const daemon = await fakeDaemon();
    const { verifier, challenge: codeChallenge } = pkce();
    const page = await h.app.inject({
      method: "GET",
      url: authorizeUrl({ challenge: codeChallenge })
    });
    const challenge = challengeOf(page.payload);
    const approved = await submit(h, challenge, {
      name: "dots",
      assertion: assertionFor(h, challenge)
    });
    const revoked = await runRevoke(
      { store: h.store, config: h.config, daemon, mail: h.mail },
      "dots"
    );
    expect(revoked.exitCode).toBe(0);
    const exchanged = await h.app.inject({
      method: "POST",
      url: "/token",
      headers: FORM,
      payload: form({
        grant_type: "authorization_code",
        code: new URL(String(approved.headers.location)).searchParams.get("code") ?? "",
        redirect_uri: CHATGPT_REDIRECT,
        client_id: CHATGPT,
        code_verifier: verifier,
        resource: PUBLIC
      })
    });
    expect(JSON.parse(exchanged.payload).error).toBe("invalid_grant");
    expect(await grantsOf(h)).toBeNull();
  });

  it("a token whose grant names another resource is refused (a changed public URL)", async () => {
    const h = await pluginHarness();
    const { accessToken } = await connect(h.app, h.authenticator, { name: "dots" });
    const grants = (await grantsOf(h)) ?? {};
    grantNamed(grants, "dots").resource = "https://old.example.com";
    await h.store.writeGrants(grants);
    expect((await mcp(h, accessToken)).statusCode).toBe(401);
  });
});

describe("passkey signature counter (WebAuthn section 6.1.1)", () => {
  async function approveWith(h: Awaited<ReturnType<typeof pluginHarness>>, counter: number) {
    const { challenge: codeChallenge } = pkce();
    const page = await h.app.inject({
      method: "GET",
      url: authorizeUrl({ challenge: codeChallenge })
    });
    const challenge = challengeOf(page.payload);
    const approved = await h.app.inject({
      method: "POST",
      url: "/authorize",
      headers: FORM,
      payload: form({
        challenge,
        name: "dots",
        assertion: JSON.stringify(
          h.authenticator.get({ rpId: RP_ID, origin: PUBLIC, challenge, counter })
        )
      })
    });
    return approved.statusCode;
  }

  it("a counter that stays at zero is accepted every time", async () => {
    const h = await pluginHarness();
    expect(await approveWith(h, 0)).toBe(302);
    expect(await approveWith(h, 0)).toBe(302);
  });

  it("a non-zero counter must increase; a repeat is refused and stores nothing new", async () => {
    const h = await pluginHarness();
    expect(await approveWith(h, 5)).toBe(302);
    expect((await h.store.readPasskeys())[0].counter).toBe(5);
    expect(await approveWith(h, 5)).toBe(400);
    expect(await approveWith(h, 4)).toBe(400);
    expect(await approveWith(h, 6)).toBe(302);
  });
});

// ChatGPT's client document as fetched on 2026-10-03, field for field.
const CHATGPT_JWKS = "https://chatgpt.com/oauth/jwks.json";
const CHATGPT_CIMD = {
  client_id: CHATGPT,
  client_name: "ChatGPT",
  redirect_uris: [CHATGPT_REDIRECT],
  grant_types: ["authorization_code", "refresh_token"],
  token_endpoint_auth_method: "private_key_jwt",
  token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
  token_endpoint_auth_signing_alg: "RS256",
  jwks_uri: CHATGPT_JWKS
};

const JWT_BEARER = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

describe("private_key_jwt clients", () => {
  async function keyPair(kid: string) {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" } };
  }

  async function chatgpt(cimd: Record<string, unknown> = CHATGPT_CIMD) {
    const signing = await keyPair("k1");
    const h = await pluginHarness({
      fetchImpl: fakeCimd({ [CHATGPT]: cimd, [CHATGPT_JWKS]: { keys: [signing.jwk] } })
    });
    return { h, signing };
  }

  /** Approve with the passkey; the code and its verifier, not yet exchanged. */
  async function approvedCode(h: Harness) {
    const { verifier, challenge: codeChallenge } = pkce();
    const page = await h.app.inject({
      method: "GET",
      url: authorizeUrl({ challenge: codeChallenge })
    });
    expect(page.statusCode, page.payload).toBe(200);
    const challenge = challengeOf(page.payload);
    const approved = await h.app.inject({
      method: "POST",
      url: "/authorize",
      headers: FORM,
      payload: form({
        challenge,
        name: "dots",
        assertion: JSON.stringify(h.authenticator.get({ rpId: RP_ID, origin: PUBLIC, challenge }))
      })
    });
    // A second approval under "dots" replaces the first: a result page, not a 302.
    const code = approvalLocation(approved)?.searchParams.get("code") ?? "";
    return { code, verifier };
  }

  async function exchange(
    h: Harness,
    code: string,
    verifier: string,
    extra: Record<string, string>
  ) {
    const response = await h.app.inject({
      method: "POST",
      url: "/token",
      headers: FORM,
      payload: form({
        grant_type: "authorization_code",
        code,
        redirect_uri: CHATGPT_REDIRECT,
        client_id: CHATGPT,
        code_verifier: verifier,
        resource: PUBLIC,
        ...extra
      })
    });
    return {
      status: response.statusCode,
      body: JSON.parse(response.payload) as Record<string, string>
    };
  }

  type Claims = { iss?: string; sub?: string; aud?: string; exp?: number; jti?: string };

  async function assertion(
    key: SigningKey,
    claims: Claims = {},
    header: { alg?: string; kid?: string } = {}
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ jti: claims.jti ?? crypto.randomUUID() })
      .setProtectedHeader({ alg: header.alg ?? "RS256", kid: header.kid ?? "k1" })
      .setIssuer(claims.iss ?? CHATGPT)
      .setSubject(claims.sub ?? CHATGPT)
      .setAudience(claims.aud ?? `${PUBLIC}/token`)
      .setIssuedAt(now)
      .setExpirationTime(claims.exp ?? now + 60)
      .sign(key);
  }

  const bearer = (jwt: string) => ({ client_assertion_type: JWT_BEARER, client_assertion: jwt });

  it("ChatGPT's real client document is accepted after the passkey", async () => {
    const { h } = await chatgpt();
    const { code } = await approvedCode(h);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it.each([
    ["the token endpoint", `${PUBLIC}/token`],
    ["the issuer", PUBLIC]
  ])("a valid client_assertion whose aud is %s gets a token", async (_label, aud) => {
    const { h, signing } = await chatgpt();
    const { code, verifier } = await approvedCode(h);
    const answer = await exchange(
      h,
      code,
      verifier,
      bearer(await assertion(signing.privateKey, { aud }))
    );
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(typeof answer.body.access_token).toBe("string");
    expect(answer.body.refresh_token).toBeUndefined();
    expect(answer.body.expires_in).toBeUndefined();
    expect(clientsOf(await h.store.readGrants())).toEqual([CHATGPT]);
  });

  const refusals: Array<
    [string, (signing: { privateKey: SigningKey }) => Promise<Record<string, string>>]
  > = [
    ["no client_assertion (no downgrade to PKCE alone)", async () => ({})],
    [
      "an HS256 assertion",
      async () =>
        bearer(
          await new SignJWT({ jti: "j" })
            .setProtectedHeader({ alg: "HS256", kid: "k1" })
            .setIssuer(CHATGPT)
            .setSubject(CHATGPT)
            .setAudience(`${PUBLIC}/token`)
            .setExpirationTime("1m")
            .sign(new TextEncoder().encode("a-shared-secret-of-enough-length!"))
        )
    ],
    [
      "an unsigned (alg none) assertion",
      async () =>
        bearer(
          new UnsecuredJWT({ jti: "j" })
            .setIssuer(CHATGPT)
            .setSubject(CHATGPT)
            .setAudience(`${PUBLIC}/token`)
            .setExpirationTime("1m")
            .encode()
        )
    ],
    [
      "a signature by another key under the same kid",
      async () => bearer(await assertion((await keyPair("k1")).privateKey))
    ],
    [
      "another issuer",
      async (s) =>
        bearer(await assertion(s.privateKey, { iss: "https://evil.example/client.json" }))
    ],
    [
      "another subject",
      async (s) =>
        bearer(await assertion(s.privateKey, { sub: "https://evil.example/client.json" }))
    ],
    [
      "another audience",
      async (s) => bearer(await assertion(s.privateKey, { aud: "https://evil.example/token" }))
    ],
    [
      "an expired assertion",
      async (s) => bearer(await assertion(s.privateKey, { exp: Math.floor(Date.now() / 1000) - 1 }))
    ],
    ["an unknown kid", async (s) => bearer(await assertion(s.privateKey, {}, { kid: "k9" }))],
    [
      "the wrong client_assertion_type",
      async (s) => ({
        client_assertion_type: "urn:example:other",
        client_assertion: await assertion(s.privateKey)
      })
    ]
  ];

  it.each(refusals)("%s is invalid_client and grants nothing", async (_label, make) => {
    const { h, signing } = await chatgpt();
    const { code, verifier } = await approvedCode(h);
    const answer = await exchange(h, code, verifier, await make(signing));
    expect(answer.status).toBe(401);
    expect(answer.body.error).toBe("invalid_client");
    expect(await h.store.readGrants()).toEqual({});
  });

  it("a replayed jti is refused on the second exchange", async () => {
    const { h, signing } = await chatgpt();
    const jwt = await assertion(signing.privateKey, { jti: "once" });
    const first = await approvedCode(h);
    expect((await exchange(h, first.code, first.verifier, bearer(jwt))).status).toBe(200);
    const second = await approvedCode(h);
    const replay = await exchange(h, second.code, second.verifier, bearer(jwt));
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("invalid_client");
  });

  it.each([
    ["on another host", { jwks_uri: "https://keys.example.com/jwks.json" }],
    ["over http", { jwks_uri: "http://chatgpt.com/oauth/jwks.json" }],
    ["missing", { jwks_uri: undefined }],
    ["with an HS256 signing alg", { token_endpoint_auth_signing_alg: "HS256" }],
    [
      "with only client_secret_basic",
      {
        token_endpoint_auth_method: "client_secret_basic",
        token_endpoint_auth_methods_supported: ["client_secret_basic"]
      }
    ]
  ])(
    "a client document whose key set or method is %s is refused after the passkey",
    async (_label, change) => {
      const { h } = await chatgpt({ ...CHATGPT_CIMD, ...change });
      const page = await h.app.inject({
        method: "GET",
        url: authorizeUrl({ challenge: pkce().challenge })
      });
      const challenge = challengeOf(page.payload);
      const refused = await submit(h, challenge, {
        name: "dots",
        assertion: assertionFor(h, challenge)
      });
      expect(refused.statusCode).toBe(200);
      expect(refused.headers.location).toBeUndefined();
      expect(refused.payload).toContain('class="reason"');
    }
  );
});
