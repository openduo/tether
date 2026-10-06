// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import { handleAdmin } from "../src/admin";
import {
  CHATGPT,
  cleanupDirs,
  clientsOf,
  connect,
  pluginHarness,
  PUBLIC,
  RP_ID,
  SoftAuthenticator
} from "./helpers";

/** Parsed JSON-RPC answers, read field by field. */
type Json = ReturnType<typeof JSON.parse>;

afterEach(cleanupDirs);

type Harness = Awaited<ReturnType<typeof pluginHarness>>;

async function issueLink(h: Harness): Promise<string> {
  const output = await handleAdmin(
    { store: h.store, config: h.config, daemon: h.daemon, mail: h.mail },
    { verb: "passkey", args: ["add"] }
  );
  return /\/enroll#(\S+)/.exec(output.stdout)?.[1] ?? "";
}

async function postJson(h: Harness, url: string, body: unknown) {
  const response = await h.app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(body)
  });
  return {
    status: response.statusCode,
    body: JSON.parse(response.payload) as Record<string, Json>
  };
}

async function options(h: Harness, secret: string) {
  return postJson(h, "/enroll/options", { secret });
}

type Offer = { options: { challenge: string }; assertion?: { challenge: string } };

/** `approver` signs the offered assertion challenge, when the offer carries one. */
async function finish(
  h: Harness,
  secret: string,
  offer: Offer,
  authenticator: SoftAuthenticator,
  { userVerified = true, approver = h.authenticator as SoftAuthenticator | null } = {}
) {
  const challenge = offer.options.challenge;
  const approval =
    offer.assertion && approver
      ? {
          assertion_challenge: offer.assertion.challenge,
          assertion: approver.get({
            rpId: RP_ID,
            origin: PUBLIC,
            challenge: offer.assertion.challenge
          })
        }
      : {};
  return postJson(h, "/enroll/finish", {
    ...approval,
    secret,
    challenge,
    label: "phone",
    response: authenticator.create({ rpId: RP_ID, origin: PUBLIC, challenge, userVerified })
  });
}

describe("enrollment", () => {
  it("serves the page with a hashed script, connect-src 'self' and no cookie", async () => {
    const h = await pluginHarness();
    const page = await h.app.inject({ method: "GET", url: "/enroll" });
    expect(page.statusCode).toBe(200);
    expect(String(page.headers["content-security-policy"])).toContain("connect-src 'self'");
    expect(page.headers["set-cookie"]).toBeUndefined();
  });

  it("offers creation options with the public host as RP, UV required, attestation none, enrolled ids excluded", async () => {
    const h = await pluginHarness();
    const offered = await options(h, await issueLink(h));
    expect(offered.status).toBe(200);
    const o = offered.body.options;
    expect(o.rp.id).toBe(RP_ID);
    expect(o.attestation).toBe("none");
    expect(o.authenticatorSelection.userVerification).toBe("required");
    expect(o.excludeCredentials.map((c: { id: string }) => c.id)).toEqual([h.authenticator.id]);
    expect(o.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("stores the passkey and kills the link; the new passkey approves a connection", async () => {
    const h = await pluginHarness();
    await h.store.writePasskeys([]);
    const secret = await issueLink(h);
    const offered = await options(h, secret);
    const phone = new SoftAuthenticator();
    const done = await finish(h, secret, offered.body as Offer, phone);
    expect(done.status).toBe(200);
    const passkeys = await h.store.readPasskeys();
    expect(passkeys.map((passkey) => [passkey.id, passkey.label])).toEqual([[phone.id, "phone"]]);
    expect((await options(h, secret)).status).toBe(403);
    expect((await connect(h.app, phone, { name: "dots" })).token.statusCode).toBe(200);
    expect(clientsOf(await h.store.readGrants())).toEqual([CHATGPT]);
  });

  it("a second passkey add voids an unused link", async () => {
    const h = await pluginHarness();
    const first = await issueLink(h);
    const second = await issueLink(h);
    expect((await options(h, first)).status).toBe(403);
    expect((await options(h, second)).status).toBe(200);
  });

  it("a link replaced between options and finish stores nothing", async () => {
    const h = await pluginHarness();
    const secret = await issueLink(h);
    const offered = await options(h, secret);
    await issueLink(h);
    const done = await finish(h, secret, offered.body as Offer, new SoftAuthenticator());
    expect(done.status).toBe(403);
    expect(await h.store.readPasskeys()).toHaveLength(1);
  });

  it("a credential without user verification is refused, and the link still works", async () => {
    const h = await pluginHarness();
    const secret = await issueLink(h);
    const offered = await options(h, secret);
    const refused = await finish(h, secret, offered.body as Offer, new SoftAuthenticator(), {
      userVerified: false
    });
    expect(refused.status).toBe(400);
    expect(await h.store.readPasskeys()).toHaveLength(1);
    expect((await options(h, secret)).status).toBe(200);
  });

  it("an unknown secret gets nothing", async () => {
    const h = await pluginHarness();
    await issueLink(h);
    expect((await options(h, "not-the-secret")).status).toBe(403);
    expect((await options(h, "")).status).toBe(403);
  });

  it("with no passkey enrolled, options carry no assertion request", async () => {
    const h = await pluginHarness();
    await h.store.writePasskeys([]);
    const offered = await options(h, await issueLink(h));
    expect(offered.body.assertion).toBeUndefined();
  });

  it("with a passkey enrolled, options ask that passkey for an assertion", async () => {
    const h = await pluginHarness();
    const offered = await options(h, await issueLink(h));
    const a = offered.body.assertion;
    expect(a.rpId).toBe(RP_ID);
    expect(a.allowCredentials.map((c: { id: string }) => c.id)).toEqual([h.authenticator.id]);
    expect(a.challenge).not.toBe(offered.body.options.challenge);
  });

  it.each([
    ["no assertion", null],
    ["an assertion from a passkey that is not enrolled", new SoftAuthenticator()]
  ])("with a passkey enrolled, the link plus %s creates nothing", async (_label, approver) => {
    const h = await pluginHarness();
    const secret = await issueLink(h);
    const offered = await options(h, secret);
    const done = await finish(h, secret, offered.body as Offer, new SoftAuthenticator(), {
      approver
    });
    expect(done.status).toBe(403);
    expect((await h.store.readPasskeys()).map((p) => p.id)).toEqual([h.authenticator.id]);
    expect(await h.store.isCurrentEnrollSecret(secret)).toBe(true);
  });

  it("with a passkey enrolled, an assertion from it lets the new passkey in", async () => {
    const h = await pluginHarness();
    const secret = await issueLink(h);
    const offered = await options(h, secret);
    const phone = new SoftAuthenticator();
    expect((await finish(h, secret, offered.body as Offer, phone)).status).toBe(200);
    expect((await h.store.readPasskeys()).map((p) => p.id)).toEqual([h.authenticator.id, phone.id]);
  });

  it("an assertion challenge is used once", async () => {
    const h = await pluginHarness();
    const secret = await issueLink(h);
    const offered = (await options(h, secret)).body as Offer;
    const replayed = {
      assertion_challenge: offered.assertion?.challenge,
      assertion: h.authenticator.get({
        rpId: RP_ID,
        origin: PUBLIC,
        challenge: offered.assertion?.challenge ?? ""
      })
    };
    // First submit fails on the registration, but consumes both challenges.
    await postJson(h, "/enroll/finish", { ...replayed, secret, challenge: "x", response: {} });
    const second = await options(h, secret);
    const phone = new SoftAuthenticator();
    const challenge = (second.body as Offer).options.challenge;
    const done = await postJson(h, "/enroll/finish", {
      ...replayed,
      secret,
      challenge,
      response: phone.create({ rpId: RP_ID, origin: PUBLIC, challenge })
    });
    expect(done.status).toBe(403);
    expect(await h.store.readPasskeys()).toHaveLength(1);
  });
});
