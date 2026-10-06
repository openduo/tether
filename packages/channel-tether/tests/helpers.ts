// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryServerEventBus } from "@modelcontextprotocol/server";
import { vi } from "vitest";
import type { CallbackPost } from "../src/callback";
import type { FetchLike } from "../src/cimd";
import type { TetherConfig } from "../src/config";
import type { DaemonCall, DaemonReply } from "../src/forward";
import { createTetherApp } from "../src/listener";
import { Mailroom, type MailRecord, type OpenPull } from "../src/mail";
import { Store, type Grant, type Grants, type Passkey } from "../src/store";

// Integration tests take the bus from here instead of depending on the MCP SDK themselves.
export { InMemoryServerEventBus };

export const PUBLIC = "https://tether.example.com";
export const RP_ID = "tether.example.com";
export const CHATGPT = "https://chatgpt.com/oauth/client.json";
export const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
export const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";
export const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
/** Cursor's shared client document, as GrokBot presented it. */
export const CURSOR = "https://cursor.com/oauth/mcp-client.json";
export const CURSOR_REDIRECT = "https://www.cursor.com/agents/mcp/oauth/callback";
export const GROK_REDIRECT = "https://grok.com/connectors-oauth-exchange-code/";
export const CURSOR_CIMD = {
  client_id: CURSOR,
  client_name: "Cursor",
  token_endpoint_auth_method: "none",
  redirect_uris: [
    CURSOR_REDIRECT,
    "https://www.cursor.com/bot/mcp/oauth/callback",
    GROK_REDIRECT,
    "http://localhost:8787/callback",
    "http://127.0.0.1:8787/callback"
  ]
};

/** Fixture numbers (tests only); production values are measured config. */
export function makeConfig(overrides: Partial<TetherConfig> = {}): TetherConfig {
  return {
    host: "127.0.0.1",
    port: 20240,
    publicUrl: PUBLIC,
    requestLimitBytes: 1024 * 1024,
    challengeCap: 16,
    codeLifetimeMs: 600_000,
    challengeLifetimeMs: 600_000,
    cimd: { timeoutMs: 1000, maxBytes: 4096 },
    pullWaitMs: 0,
    toolsListTtlMs: null,
    ...overrides
  };
}

const dirs: string[] = [];

export async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export async function cleanupDirs(): Promise<void> {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
}

/** A clock the test moves by hand. */
export function manualClock(start = "2026-10-03T08:00:00.000Z") {
  let now = new Date(start).getTime();
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    }
  };
}

export async function makeStore(now?: () => Date): Promise<{ store: Store; stateDir: string }> {
  const dir = await tempDir("tether-plugin-");
  const stateDir = path.join(dir, "state");
  const store = new Store(stateDir, { warn: vi.fn() }, now);
  await store.init();
  return { store, stateDir };
}

/**
 * A daemon spy: `session.list` answers `sessions`, `system.runtime.info`
 * points at a temp kernel and runtime holding `channels` (config/<kind>.md)
 * and `plugins` (plugins/channels/<type>/), every assistant session's outbox is
 * empty, everything else `{ ok: true }`.
 */
export async function fakeDaemon(
  options: {
    sessions?: Array<{ session_key: string; display_name?: string | null; kind: string }>;
    channels?: string[];
    plugins?: string[];
    override?: (method: string, params: Record<string, unknown>) => DaemonReply | undefined;
  } = {}
) {
  const root = await tempDir("tether-daemon-");
  const kernel = path.join(root, "kernel");
  const runtime = path.join(root, "runtime");
  await fs.mkdir(path.join(kernel, "config"), { recursive: true });
  await fs.mkdir(path.join(runtime, "plugins", "channels"), { recursive: true });
  for (const kind of options.channels ?? ["feishu", "stdio"]) {
    await fs.writeFile(path.join(kernel, "config", `${kind}.md`), "---\n---\n");
  }
  for (const type of options.plugins ?? ["tether"]) {
    await fs.mkdir(path.join(runtime, "plugins", "channels", type), { recursive: true });
  }
  return vi.fn<DaemonCall>(async (method, params) => {
    const custom = options.override?.(method, params);
    if (custom) return custom;
    if (method === "session.list") {
      // `kind` filters as the daemon's does; every listed session is deliverable.
      const rows = options.sessions ?? [];
      return {
        result: rows.filter((row) => params.kind === undefined || row.kind === params.kind)
      };
    }
    if (method === "system.runtime.info") {
      return { result: { kernel_dir: kernel, runtime_dir: runtime } };
    }
    if (method === "system.status") return { result: { sessions: [] } };
    if (method === "spine.record") {
      return {
        result: { ok: true, event_id: "evt_1", ts: "2026-10-03T08:00:00.000Z", duplicate: false }
      };
    }
    if (method === "channel.pull") return { result: { records: [] } };
    if (method === "channel.ack") return { result: { committed: true } };
    if (method === "session.archive") return { result: { archived: true } };
    if (method === "session.notify") {
      return {
        result: {
          ok: true,
          target: params.target,
          session_key: params.target,
          route_id: "route-1",
          event_id: "evt_2",
          ts: "2026-10-03T08:00:00.000Z",
          duplicate: false
        }
      };
    }
    if (method === "memory.read") return { result: { path: params.path, text: "FILE\n" } };
    if (method === "spine.cat") {
      return { result: { text: "EVENTS\n" } };
    }
    return { result: { ok: true, method } };
  });
}

/**
 * Stand-in for the `channel.pull` WebSockets: records which sessions are
 * streamed and lets a test push a record into one, as the daemon would.
 */
export function fakePull() {
  const open = new Map<
    string,
    { onRecord: (record: MailRecord) => void; onClose: () => void; closed: boolean }
  >();
  const opened: string[] = [];
  const openPull: OpenPull = (sessionKey, handlers) => {
    const entry = { ...handlers, closed: false };
    open.set(sessionKey, entry);
    opened.push(sessionKey);
    return {
      close: () => {
        entry.closed = true;
        if (open.get(sessionKey) === entry) open.delete(sessionKey);
      }
    };
  };
  return {
    openPull,
    opened,
    streamed: () => [...open.keys()].sort(),
    push: (sessionKey: string, record: MailRecord) => {
      const entry = open.get(sessionKey);
      if (entry === undefined) throw new Error(`no stream on ${sessionKey}`);
      entry.onRecord(record);
    },
    /** The daemon dropped the stream. */
    drop: (sessionKey: string) => {
      const entry = open.get(sessionKey);
      if (entry === undefined) throw new Error(`no stream on ${sessionKey}`);
      open.delete(sessionKey);
      entry.onClose();
    }
  };
}

/**
 * An assistant session's outbox as the daemon keeps it: records in order and one
 * acknowledged cursor. `override` it into a fakeDaemon.
 */
export function fakeOutbox() {
  const records = new Map<string, MailRecord[]>();
  const acked = new Map<string, string>();
  const unread = (sessionKey: string, after?: string): MailRecord[] => {
    const all = records.get(sessionKey) ?? [];
    const from = after ?? acked.get(sessionKey);
    const index = from === undefined ? -1 : all.findIndex((record) => record.id === from);
    return all.slice(index + 1);
  };
  return {
    add: (sessionKey: string, ...added: MailRecord[]) => {
      records.set(sessionKey, [...(records.get(sessionKey) ?? []), ...added]);
    },
    unread: (sessionKey: string) => unread(sessionKey).map((record) => record.id),
    override: (method: string, params: Record<string, unknown>): DaemonReply | undefined => {
      const sessionKey = String(params.session_key);
      if (method === "channel.pull") {
        const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
        return { result: { records: unread(sessionKey, cursor) } };
      }
      if (method === "channel.ack") {
        acked.set(sessionKey, String(params.cursor));
        return { result: { committed: true } };
      }
      return undefined;
    }
  };
}

/** Client documents, served without the network; a fetch of anything else fails. */
export function fakeCimd(
  documents: Record<string, Record<string, unknown>> = {
    [CHATGPT]: { client_id: CHATGPT, client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT] },
    [CLAUDE]: { client_id: CLAUDE, client_name: "Claude", redirect_uris: [CLAUDE_REDIRECT] },
    [CURSOR]: CURSOR_CIMD
  }
) {
  return vi.fn<FetchLike>(async (url) => {
    const document = documents[url];
    if (document === undefined) throw new Error(`unexpected fetch of ${url}`);
    return new Response(JSON.stringify(document), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
}

// --- a software WebAuthn authenticator, for tests only ----------------------------------

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
}
const cborBytes = (bytes: Buffer): Buffer => Buffer.concat([cborHead(2, bytes.length), bytes]);
const cborText = (text: string): Buffer =>
  Buffer.concat([cborHead(3, Buffer.byteLength(text)), Buffer.from(text)]);

const sha256 = (data: Buffer | string): Buffer => crypto.createHash("sha256").update(data).digest();
const b64u = (data: Buffer): string => data.toString("base64url");

export class SoftAuthenticator {
  readonly credentialId = crypto.randomBytes(16);
  private readonly keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  private counter = 0;

  /** COSE_Key for the public key: kty EC2, alg ES256, crv P-256, x, y. */
  coseKey(): Buffer {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    const x = Buffer.from(jwk.x as string, "base64url");
    const y = Buffer.from(jwk.y as string, "base64url");
    return Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]),
      cborBytes(x),
      Buffer.from([0x22]),
      cborBytes(y)
    ]);
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  /** The stored form, as enrollment would leave it. */
  passkey(label: string | null = "test"): Passkey {
    return {
      id: this.id,
      public_key: b64u(this.coseKey()),
      counter: 0,
      label,
      created_at: "2026-10-03T08:00:00.000Z"
    };
  }

  create(input: { rpId: string; origin: string; challenge: string; userVerified?: boolean }) {
    const flags = 0x01 | 0x40 | (input.userVerified === false ? 0 : 0x04);
    const counter = Buffer.alloc(4);
    const idLength = Buffer.from([this.credentialId.length >> 8, this.credentialId.length & 0xff]);
    const authData = Buffer.concat([
      sha256(input.rpId),
      Buffer.from([flags]),
      counter,
      Buffer.alloc(16),
      idLength,
      this.credentialId,
      this.coseKey()
    ]);
    const attestationObject = Buffer.concat([
      Buffer.from([0xa3]),
      cborText("fmt"),
      cborText("none"),
      cborText("attStmt"),
      Buffer.from([0xa0]),
      cborText("authData"),
      cborBytes(authData)
    ]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: "webauthn.create",
        challenge: input.challenge,
        origin: input.origin,
        crossOrigin: false
      })
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ["internal"]
      }
    };
  }

  /** `counter` pins the signature counter; otherwise it increases per call. */
  get(input: {
    rpId: string;
    origin: string;
    challenge: string;
    userVerified?: boolean;
    counter?: number;
  }) {
    this.counter = input.counter ?? this.counter + 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const flags = 0x01 | (input.userVerified === false ? 0 : 0x04);
    const authenticatorData = Buffer.concat([sha256(input.rpId), Buffer.from([flags]), counter]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: input.challenge,
        origin: input.origin,
        crossOrigin: false
      })
    );
    const signature = crypto.sign(
      "sha256",
      Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
      this.keys.privateKey
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        authenticatorData: b64u(authenticatorData),
        clientDataJSON: b64u(clientDataJSON),
        signature: b64u(signature)
      }
    };
  }
}

// --- the OAuth flow, driven through the routes -------------------------------------------

export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64u(crypto.randomBytes(32));
  return { verifier, challenge: b64u(sha256(verifier)) };
}

type Injectable = {
  inject: (options: {
    method: "GET" | "POST";
    url: string;
    headers?: Record<string, string>;
    payload?: string;
  }) => Promise<{ statusCode: number; headers: Record<string, unknown>; payload: string }>;
};

export function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

export const FORM = { "content-type": "application/x-www-form-urlencoded" };

/** The challenge the authorize page carries, read from its WebAuthn options block. */
export function challengeOf(html: string): string {
  const match = /<script type="application\/json" id="webauthn-options">(.*?)<\/script>/s.exec(
    html
  );
  if (!match) throw new Error("no webauthn options on the page");
  return (JSON.parse(match[1]) as { challenge: string }).challenge;
}

export function authorizeUrl(
  options: {
    clientId?: string;
    redirectUri?: string;
    challenge: string;
    state?: string;
    scope?: string;
    resource?: string;
  } & Record<string, string | undefined>
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId ?? CHATGPT,
    redirect_uri: options.redirectUri ?? CHATGPT_REDIRECT,
    state: options.state ?? "s1",
    code_challenge: options.challenge,
    code_challenge_method: "S256",
    resource: options.resource ?? PUBLIC
  });
  if (options.scope !== undefined) params.set("scope", options.scope);
  return `/authorize?${params.toString()}`;
}

/**
 * Where an approval sends the browser: the 302's Location, or the one link of
 * the replacement result page.
 */
export function approvalLocation(approved: {
  statusCode: number;
  headers: Record<string, unknown>;
  payload: string;
}): URL | null {
  if (approved.statusCode === 302) return new URL(String(approved.headers.location));
  const link = /<a href="([^"]*)">Continue to the app<\/a>/.exec(approved.payload)?.[1];
  return link === undefined ? null : new URL(link.replace(/&amp;/g, "&"));
}

/**
 * GET /authorize, approve with the authenticator under `name`, and exchange
 * the code. Returns the token and every intermediate answer.
 */
export async function connect(
  app: Injectable,
  authenticator: SoftAuthenticator,
  options: { name: string; clientId?: string; redirectUri?: string; scope?: string }
) {
  const { verifier, challenge: codeChallenge } = pkce();
  const page = await app.inject({
    method: "GET",
    url: authorizeUrl({
      challenge: codeChallenge,
      ...(options.clientId ? { clientId: options.clientId } : {}),
      ...(options.redirectUri ? { redirectUri: options.redirectUri } : {}),
      ...(options.scope !== undefined ? { scope: options.scope } : {})
    })
  });
  if (page.statusCode !== 200)
    throw new Error(`authorize page ${page.statusCode}: ${page.payload}`);
  const challenge = challengeOf(page.payload);
  const approved = await app.inject({
    method: "POST",
    url: "/authorize",
    headers: FORM,
    payload: form({
      challenge,
      name: options.name,
      assertion: JSON.stringify(authenticator.get({ rpId: RP_ID, origin: PUBLIC, challenge }))
    })
  });
  const location = approvalLocation(approved);
  if (location === null) throw new Error(`approval ${approved.statusCode}: ${approved.payload}`);
  const code = location.searchParams.get("code") ?? "";
  const token = await app.inject({
    method: "POST",
    url: "/token",
    headers: FORM,
    payload: form({
      grant_type: "authorization_code",
      code,
      redirect_uri: options.redirectUri ?? CHATGPT_REDIRECT,
      client_id: options.clientId ?? CHATGPT,
      code_verifier: verifier,
      resource: PUBLIC
    })
  });
  const body = JSON.parse(token.payload) as { access_token?: string };
  return { page, approved, location, code, token, accessToken: body.access_token ?? "" };
}

/** A plugin app with one enrolled software passkey. */
export async function pluginHarness(
  options: {
    config?: Partial<TetherConfig>;
    daemon?: Awaited<ReturnType<typeof fakeDaemon>>;
    now?: () => Date;
    fetchImpl?: ReturnType<typeof fakeCimd>;
    postCallback?: CallbackPost;
  } = {}
) {
  const { store, stateDir } = await makeStore(options.now);
  const authenticator = new SoftAuthenticator();
  await store.writePasskeys([authenticator.passkey()]);
  const daemon = options.daemon ?? (await fakeDaemon());
  const config = makeConfig(options.config);
  const fetchImpl = options.fetchImpl ?? fakeCimd();
  const bus = new InMemoryServerEventBus();
  const pull = fakePull();
  // Never started: a test that needs the streams calls start().
  const mail = new Mailroom({
    store,
    daemon,
    openPull: pull.openPull,
    reconnectMs: 0,
    workspace: stateDir,
    log: { warn: vi.fn() },
    fetchImpl,
    callbackLimits: config.cimd,
    ...(options.postCallback ? { postCallback: options.postCallback } : {}),
    bus
  });
  const app = createTetherApp({
    config,
    store,
    daemon,
    version: "9.9.9-test",
    fetchImpl,
    mail,
    bus,
    ...(options.postCallback ? { postCallback: options.postCallback } : {})
  });
  return { app, store, stateDir, authenticator, daemon, config, fetchImpl, mail, bus, pull };
}

/** The client of each stored grant, in file order (grants are keyed by grant_id). */
export function clientsOf(grants: Grants | null): string[] {
  return Object.values(grants ?? {}).map((grant) => grant.client_id);
}

export function grantNamed(grants: Grants | null, name: string): Grant {
  const grant = Object.values(grants ?? {}).find((candidate) => candidate.name === name);
  if (grant === undefined) throw new Error(`no grant named ${name}`);
  return grant;
}

export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}
