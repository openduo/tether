// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleAdmin, type AdminDeps } from "../src/admin";
import type { HostedClients } from "../src/store";
import { renderClientHandoff } from "../src/texts";
import {
  approvalLocation,
  authorizeUrl,
  challengeOf,
  cleanupDirs,
  FORM,
  form,
  pkce,
  pluginHarness,
  PUBLIC,
  readJsonFile,
  RP_ID
} from "./helpers";

afterEach(cleanupDirs);

type Harness = Awaited<ReturnType<typeof pluginHarness>>;

const MUSE_REDIRECT = "http://127.0.0.1:8976/callback";
const MUSE = `${PUBLIC}/clients/muse`;

const verb = (h: Harness, args: string[], inSession = false, overrides: Partial<AdminDeps> = {}) =>
  handleAdmin(
    {
      store: h.store,
      config: h.config,
      daemon: h.daemon,
      mail: h.mail,
      ...overrides
    },
    { verb: "client", args, in_session: inSession }
  );

const clientsOf = (h: Harness) =>
  readJsonFile<HostedClients>(path.join(h.stateDir, "clients.json"));

async function openPage(h: Harness, clientId: string, redirectUri: string) {
  const { verifier, challenge } = pkce();
  const page = await h.app.inject({
    method: "GET",
    url: authorizeUrl({ challenge, clientId, redirectUri })
  });
  return { page, verifier };
}

function approve(h: Harness, challenge: string, name: string) {
  return h.app.inject({
    method: "POST",
    url: "/authorize",
    headers: FORM,
    payload: form({
      challenge,
      name,
      assertion: JSON.stringify(h.authenticator.get({ rpId: RP_ID, origin: PUBLIC, challenge }))
    })
  });
}

function mcpCall(h: Harness, token: string) {
  return h.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    payload: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "GetContext", arguments: {} }
    })
  });
}

/** Muse's flow: authorize, passkey, code on loopback, PKCE-only exchange. */
async function connectMuse(h: Harness, name = "muse") {
  const { page, verifier } = await openPage(h, MUSE, MUSE_REDIRECT);
  expect(page.statusCode).toBe(200);
  const approved = await approve(h, challengeOf(page.payload), name);
  const location = approvalLocation(approved);
  if (location === null) throw new Error(`approval ${approved.statusCode}: ${approved.payload}`);
  const token = await h.app.inject({
    method: "POST",
    url: "/token",
    headers: FORM,
    payload: form({
      grant_type: "authorization_code",
      code: location.searchParams.get("code") ?? "",
      redirect_uri: MUSE_REDIRECT,
      client_id: MUSE,
      code_verifier: verifier,
      resource: PUBLIC
    })
  });
  return {
    page,
    location,
    token,
    accessToken: (JSON.parse(token.payload) as { access_token?: string }).access_token ?? ""
  };
}

describe("client add, list and remove", () => {
  it("add stores a 0600 document and prints its client_id; list shows it; remove deletes it", async () => {
    const h = await pluginHarness();
    const added = await verb(h, [
      "add",
      "muse",
      "--redirect",
      MUSE_REDIRECT,
      "--redirect=http://localhost:8976/callback",
      "--redirect",
      MUSE_REDIRECT
    ]);
    expect(added.exitCode).toBe(0);
    expect(added.stdout.split("\n")).toContain(`  ${MUSE}`);
    const stored = await clientsOf(h);
    expect(stored?.muse?.redirect_uris).toEqual([MUSE_REDIRECT, "http://localhost:8976/callback"]);
    expect((await fs.stat(path.join(h.stateDir, "clients.json"))).mode & 0o777).toBe(0o600);

    const listed = await verb(h, ["list"]);
    expect(listed.exitCode).toBe(0);
    for (const fact of ["muse", MUSE, JSON.stringify(MUSE_REDIRECT), "0 connected"]) {
      expect(listed.stdout).toContain(fact);
    }

    const removed = await verb(h, ["remove", "muse"]);
    expect(removed.exitCode).toBe(0);
    expect(await clientsOf(h)).toEqual({});
    expect((await verb(h, ["remove", "muse"])).exitCode).toBe(2);
  });

  it("add prints a handoff paragraph naming the client_id and the MCP endpoint", async () => {
    const h = await pluginHarness();
    const added = await verb(h, ["add", "muse", "--redirect", MUSE_REDIRECT]);
    expect(added.exitCode).toBe(0);
    const handoff = renderClientHandoff(MUSE, PUBLIC);
    expect(added.stdout).toContain(handoff);
    expect(handoff).toContain(MUSE);
    expect(handoff).toContain(`${PUBLIC}/mcp`);
  });

  it("add inside a session is allowed", async () => {
    const h = await pluginHarness();
    const added = await verb(h, ["add", "muse", "--redirect", MUSE_REDIRECT], true);
    expect(added.exitCode).toBe(0);
    expect(Object.keys((await clientsOf(h)) ?? {})).toEqual(["muse"]);
  });

  it.each([
    "https://evil.example/cb",
    "http://192.168.1.2/cb",
    "http://localhost.evil.com/cb",
    "http://127.0.0.1.evil.com/cb",
    "http://127.0.0.1:8976/call\nback"
  ])("refuses the non-loopback return address %j and stores nothing", async (uri) => {
    const h = await pluginHarness();
    const refused = await verb(h, ["add", "muse", "--redirect", MUSE_REDIRECT, "--redirect", uri]);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain(JSON.stringify(uri));
    expect(await clientsOf(h)).toBeNull();
  });

  it.each(["http://localhost/cb", "http://[::1]:9/x/y", "http://127.0.0.1:8976/callback"])(
    "accepts the loopback return address %s",
    async (uri) => {
      const h = await pluginHarness();
      expect((await verb(h, ["add", "muse", "--redirect", uri])).exitCode).toBe(0);
    }
  );

  it("refuses an invalid name, an existing name and a missing --redirect, changing nothing", async () => {
    const h = await pluginHarness();
    expect((await verb(h, ["add", "Muse", "--redirect", MUSE_REDIRECT])).exitCode).toBe(2);
    expect((await verb(h, ["add", "muse"])).exitCode).toBe(2);
    expect(await clientsOf(h)).toBeNull();
    expect((await verb(h, ["add", "muse", "--redirect", MUSE_REDIRECT])).exitCode).toBe(0);
    const again = await verb(h, ["add", "muse", "--redirect", "http://localhost/other"]);
    expect(again.exitCode).toBe(2);
    expect((await clientsOf(h))?.muse?.redirect_uris).toEqual([MUSE_REDIRECT]);
  });

  it("every client verb refuses without a public URL", async () => {
    const h = await pluginHarness();
    const config = { ...h.config, publicUrl: null };
    for (const args of [
      ["add", "muse", "--redirect", MUSE_REDIRECT],
      ["list"],
      ["remove", "muse"]
    ]) {
      const refused = await verb(h, args, false, { config });
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("ALADUO_TETHER_PUBLIC_URL");
    }
    expect(await clientsOf(h)).toBeNull();
  });
});

describe("a hosted document at /authorize", () => {
  it("Muse connects end to end through the passkey, with no network fetch at any step", async () => {
    const h = await pluginHarness();
    expect((await verb(h, ["add", "muse", "--redirect", MUSE_REDIRECT])).exitCode).toBe(0);
    const { page, location, token, accessToken } = await connectMuse(h);
    // Client and return address both carry the verified mark, never the unverified one.
    expect(page.payload.match(/<span class="verified">/g)).toHaveLength(2);
    expect(page.payload).not.toMatch(/<span class="claim">/);
    expect(/id="name" name="name" value="([^"]*)"/.exec(page.payload)?.[1]).toBe("muse");
    expect(`${location.origin}${location.pathname}`).toBe(MUSE_REDIRECT);
    expect(location.searchParams.get("state")).toBe("s1");
    expect(token.statusCode).toBe(200);
    const called = await mcpCall(h, accessToken);
    expect(called.statusCode).toBe(200);
    expect(called.payload).toContain("FILE");
    const grant = Object.values(await h.store.readGrants())[0];
    expect(grant).toMatchObject({ client_id: MUSE, name: "muse", client_name: "muse" });
    expect(h.fetchImpl).toHaveBeenCalledTimes(0);
    expect((await verb(h, ["list"])).stdout).toContain("1 connected");
  });

  it.each([
    ["an unknown name", `${PUBLIC}/clients/nobody`, MUSE_REDIRECT],
    ["a further path segment", `${PUBLIC}/clients/muse/x`, MUSE_REDIRECT],
    ["a query", `${PUBLIC}/clients/muse?x=1`, MUSE_REDIRECT],
    ["a case variant of the origin", "https://TETHER.example.com/clients/muse", MUSE_REDIRECT],
    ["a prototype key", `${PUBLIC}/clients/constructor`, MUSE_REDIRECT],
    ["a redirect it does not list", MUSE, "http://127.0.0.1:8976/other"]
  ])(
    "refuses %s before the passkey with a page, minting and fetching nothing",
    async (_label, clientId, redirectUri) => {
      const h = await pluginHarness();
      await verb(h, ["add", "muse", "--redirect", MUSE_REDIRECT]);
      const { page } = await openPage(h, clientId, redirectUri);
      expect(page.statusCode).toBe(400);
      expect(page.headers.location).toBeUndefined();
      expect(page.payload).not.toContain("webauthn-options");
      expect(h.fetchImpl).toHaveBeenCalledTimes(0);
    }
  );

  it.each([
    ["a port", MUSE_REDIRECT, "http://127.0.0.1:9999/callback"],
    ["no port", "http://127.0.0.1/callback", "http://127.0.0.1:60793/callback"]
  ])(
    "a loopback redirect listed with %s accepts any port (RFC 8252 section 7.3)",
    async (_label, listed, requested) => {
      const h = await pluginHarness();
      await verb(h, ["add", "muse", "--redirect", listed]);
      const { page } = await openPage(h, MUSE, requested);
      expect(page.statusCode).toBe(200);
      const approved = await approve(h, challengeOf(page.payload), "muse");
      const location = approvalLocation(approved);
      expect(location).not.toBeNull();
      expect(`${location?.origin}${location?.pathname}`).toBe(requested);
    }
  );

  it("an unknown name and an unlisted return address get the identical page, so names cannot be enumerated", async () => {
    const h = await pluginHarness();
    await verb(h, ["add", "muse", "--redirect", MUSE_REDIRECT]);
    const unknown = await openPage(h, `${PUBLIC}/clients/nobody`, MUSE_REDIRECT);
    const unlisted = await openPage(h, MUSE, "http://127.0.0.1:8976/other");
    expect(unknown.page.statusCode).toBe(400);
    expect(unlisted.page.statusCode).toBe(400);
    expect(unlisted.page.payload).toBe(unknown.page.payload);
  });

  it("a document removed between GET and POST is refused after the passkey; nothing is approved", async () => {
    const h = await pluginHarness();
    await verb(h, ["add", "muse", "--redirect", MUSE_REDIRECT]);
    const { page } = await openPage(h, MUSE, MUSE_REDIRECT);
    expect(page.statusCode).toBe(200);
    expect((await verb(h, ["remove", "muse"])).exitCode).toBe(0);
    const refused = await approve(h, challengeOf(page.payload), "muse");
    expect(refused.statusCode).toBe(400);
    expect(refused.headers.location).toBeUndefined();
    expect(approvalLocation(refused)).toBeNull();
    expect(refused.payload).not.toContain("webauthn-options");
    expect(await h.store.readGrants()).toEqual({});
    expect(h.fetchImpl).toHaveBeenCalledTimes(0);
  });

  it("a redirect dropped from the document between GET and POST is refused after the passkey", async () => {
    const h = await pluginHarness();
    await verb(h, ["add", "muse", "--redirect", MUSE_REDIRECT]);
    const { page } = await openPage(h, MUSE, MUSE_REDIRECT);
    await verb(h, ["remove", "muse"]);
    await verb(h, ["add", "muse", "--redirect", "http://localhost:8976/callback"]);
    const refused = await approve(h, challengeOf(page.payload), "muse");
    expect(refused.statusCode).toBe(400);
    expect(approvalLocation(refused)).toBeNull();
    expect(await h.store.readGrants()).toEqual({});
  });

  it("tether list labels a hosted client's name as set by this duoduo, not as its own claim", async () => {
    const h = await pluginHarness();
    await verb(h, ["add", "muse", "--redirect", MUSE_REDIRECT]);
    await connectMuse(h);
    const listed = await handleAdmin(
      { store: h.store, config: h.config, daemon: h.daemon, mail: h.mail },
      { verb: "list", args: [] }
    );
    expect(listed.stdout.split("\n")).toContain(
      `  client      "muse" (hosted by this duoduo) · "${MUSE}"`
    );
    expect(listed.stdout).not.toContain("(its own claim)");
  });

  it("remove leaves a connected assistant connected; a new authorization is refused", async () => {
    const h = await pluginHarness();
    await verb(h, ["add", "muse", "--redirect", MUSE_REDIRECT]);
    const { accessToken } = await connectMuse(h);
    const removed = await verb(h, ["remove", "muse"]);
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toContain("1 connected assistant");
    expect((await mcpCall(h, accessToken)).statusCode).toBe(200);
    expect(Object.values(await h.store.readGrants()).map((grant) => grant.name)).toEqual(["muse"]);
    expect((await openPage(h, MUSE, MUSE_REDIRECT)).page.statusCode).toBe(400);
  });

  it("nothing is served under /clients/: the document is not a public route", async () => {
    const h = await pluginHarness();
    await verb(h, ["add", "muse", "--redirect", MUSE_REDIRECT]);
    for (const url of ["/clients/muse", "/clients/", "/clients"]) {
      expect((await h.app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
  });

  it("a code approved before remove is still exchanged", async () => {
    const h = await pluginHarness();
    await verb(h, ["add", "muse", "--redirect", MUSE_REDIRECT]);
    const { page, verifier } = await openPage(h, MUSE, MUSE_REDIRECT);
    const location = approvalLocation(await approve(h, challengeOf(page.payload), "muse"));
    expect(location).not.toBeNull();
    await verb(h, ["remove", "muse"]);
    const token = await h.app.inject({
      method: "POST",
      url: "/token",
      headers: FORM,
      payload: form({
        grant_type: "authorization_code",
        code: location?.searchParams.get("code") ?? "",
        redirect_uri: MUSE_REDIRECT,
        client_id: MUSE,
        code_verifier: verifier,
        resource: PUBLIC
      })
    });
    expect(token.statusCode).toBe(200);
  });

  it("the exchange is PKCE only: a wrong verifier is refused", async () => {
    const h = await pluginHarness();
    await verb(h, ["add", "muse", "--redirect", MUSE_REDIRECT]);
    const { page } = await openPage(h, MUSE, MUSE_REDIRECT);
    const location = approvalLocation(await approve(h, challengeOf(page.payload), "muse"));
    const token = await h.app.inject({
      method: "POST",
      url: "/token",
      headers: FORM,
      payload: form({
        grant_type: "authorization_code",
        code: location?.searchParams.get("code") ?? "",
        redirect_uri: MUSE_REDIRECT,
        client_id: MUSE,
        code_verifier: crypto.randomBytes(32).toString("base64url"),
        resource: PUBLIC
      })
    });
    expect(token.statusCode).toBe(400);
    expect(await h.store.readGrants()).toEqual({});
  });
});
