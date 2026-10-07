// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The plugin's state. The plugin process is the only writer of `state/`; host
 * verbs reach it over the admin socket.
 *
 *   state/grants.json    { <grant_id>: Grant }, one per assistant name 0600
 *   state/passkeys.json  [ Passkey ]                                    0600
 *   state/enroll.json    { digest, issued_at, issued_in_session }       0600
 *                        of the one live link
 *   state/clients.json   { <name>: HostedClient }, the client documents 0600
 *                        hosted by this duoduo
 *
 * In memory only: authorize and enroll challenges, authorization codes and
 * each grant's last-used time. A restart voids challenges and codes; the
 * client starts over.
 *
 * Every mutation of a file and every check-then-consume of a challenge, code
 * or link runs inside `serialize`, one plugin-wide promise chain: read,
 * decide, write by temp file and rename, update memory. Token checks read
 * committed state outside it. The last-used map is display only.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ClientAuth } from "./cimd";

export type Logger = { warn: (message: string, fields?: Record<string, unknown>) => void };

export type Grant = {
  grant_id: string;
  client_id: string;
  name: string;
  /** SHA-256 of the token, hex. The token itself is never stored. */
  token_digest: string;
  scopes: string[];
  resource: string;
  client_name: string | null;
  approved_at: string;
  /** Rung once per mail this grant owns; they go with the grant. */
  doorbells?: Doorbell[];
  /** MCP Events webhook subscriptions the assistant made itself; they go with the grant. */
  subscriptions?: Subscription[];
};
export type Grants = Record<string, Grant>;

/** A generic webhook. The secret never leaves this file. */
export type Doorbell = {
  url: string;
  auth: "hmac" | "bearer";
  secret: string;
  added_at: string;
};

/**
 * One `events/subscribe` of `mailbox.new`. The URL passed the verification
 * handshake before it was stored; `refresh_before` is null when the assistant
 * asked for no expiry. The secret never leaves this file.
 */
export type Subscription = {
  id: string;
  url: string;
  secret: string;
  refresh_before: string | null;
};

export type Passkey = {
  /** Credential id, base64url. */
  id: string;
  /** COSE public key, base64url. */
  public_key: string;
  /** The signature counter; it must increase while either side reports non-zero. */
  counter: number;
  label: string | null;
  transports?: string[];
  created_at: string;
};

/**
 * `issued_in_session`: the link was printed into a duoduo session, so it sits
 * in the spine; it is safe only while no grant can read the spine.
 */
type EnrollFile = { digest: string; issued_at: string; issued_in_session: boolean };

/**
 * What an authorize challenge binds: the request as GET /authorize read it.
 * Client and redirect are unverified until the document is fetched after the
 * passkey, so nothing is fetched for a client the owner has not approved.
 */
export type AuthorizeRequest = {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scopes: string[];
  resource: string;
};

export type Challenge =
  | { kind: "authorize"; expiresAt: number; request: AuthorizeRequest }
  | { kind: "enroll"; expiresAt: number }
  | { kind: "enroll-assert"; expiresAt: number };

/** A code carries what the client document established at approval. */
export type AuthorizationCode = AuthorizeRequest & {
  clientName: string | null;
  clientAuth: ClientAuth;
  name: string;
  expiresAt: number;
};

export type Authenticated = { clientId: string; grant: Grant };

/** The scopes of `scopes` the caller's grant lacks, in that order. */
export function missingScopes(auth: Authenticated, scopes: readonly string[]): string[] {
  return scopes.filter((scope) => !auth.grant.scopes.includes(scope));
}

/** A client document hosted by this duoduo; its client_id derives from the public URL. */
export type HostedClient = { name: string; redirect_uris: string[]; created_at: string };
export type HostedClients = Record<string, HostedClient>;

/** 32 random bytes: tokens, codes, challenges and enrollment secrets. */
const SECRET_BYTES = 32;
/** grant_id: 128 random bits, so two grants never share an id or a mailbox URI. */
const GRANT_ID_BYTES = 16;

export function randomSecret(): string {
  return crypto.randomBytes(SECRET_BYTES).toString("base64url");
}

export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export class Store {
  private readonly grantsFile: string;
  private readonly passkeysFile: string;
  private readonly enrollFile: string;
  private readonly clientsFile: string;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly challenges = new Map<string, Challenge>();
  private readonly codes = new Map<string, AuthorizationCode>();
  /** Client-assertion ids seen, keyed by client and jti, until their exp (ms). */
  private readonly assertionIds = new Map<string, number>();
  private readonly lastUsed = new Map<string, Date>();

  constructor(
    readonly stateDir: string,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date()
  ) {
    this.grantsFile = path.join(stateDir, "grants.json");
    this.passkeysFile = path.join(stateDir, "passkeys.json");
    this.enrollFile = path.join(stateDir, "enroll.json");
    this.clientsFile = path.join(stateDir, "clients.json");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.stateDir, 0o700);
  }

  /** The plugin-wide mutex: every state mutation runs inside it. */
  serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  clock(): Date {
    return this.now();
  }

  // --- grants ---------------------------------------------------------------------

  async readGrants(): Promise<Grants> {
    return (await readJson<Grants>(this.grantsFile)) ?? {};
  }

  /** Call inside `serialize`. */
  async writeGrants(grants: Grants): Promise<void> {
    await writeJsonAtomic(this.grantsFile, grants);
  }

  /**
   * The grant a presented bearer belongs to, or null. Read from the file on
   * every request, so a revoke is refused on the very next call. A token whose
   * grant names another resource is refused: a changed public URL reconnects
   * every client. "unavailable" when the grants could not be read: the token
   * was not found to be bad, so the caller must not tell the client it is.
   */
  async authenticate(
    header: string | undefined,
    resource: string
  ): Promise<Authenticated | null | "unavailable"> {
    const presented =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length).trim()
        : "";
    if (!presented) return null;
    const digest = sha256Hex(presented);
    let grants: Grants;
    try {
      grants = await this.readGrants();
    } catch (error) {
      this.log.warn("[tether] could not read grants; refusing the request", {
        error: String(error)
      });
      return "unavailable";
    }
    let found: Authenticated | null = null;
    for (const grant of Object.values(grants)) {
      if (typeof grant?.token_digest !== "string") continue;
      if (sameHex(digest, grant.token_digest)) found = { clientId: grant.client_id, grant };
    }
    if (found === null || found.grant.resource !== resource) return null;
    this.lastUsed.set(found.grant.grant_id, this.now());
    return found;
  }

  lastUsedOf(grantId: string): Date | null {
    return this.lastUsed.get(grantId) ?? null;
  }

  // --- challenges -----------------------------------------------------------------

  private pruneChallenges(): void {
    const now = this.now().getTime();
    for (const [key, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(key);
    }
  }

  /**
   * The cap counts authorize and enroll challenges together and bounds memory
   * only: at the cap the oldest is evicted, so spam cannot lock the owner out;
   * an evicted owner challenge fails as expired.
   */
  mintChallenge(
    value:
      | { kind: "authorize"; request: AuthorizeRequest }
      | { kind: "enroll" }
      | { kind: "enroll-assert" },
    lifetimeMs: number,
    cap: number
  ): string {
    this.pruneChallenges();
    for (const oldest of this.challenges.keys()) {
      if (this.challenges.size < cap) break;
      this.challenges.delete(oldest);
    }
    const challenge = randomSecret();
    const expiresAt = this.now().getTime() + lifetimeMs;
    this.challenges.set(
      challenge,
      value.kind === "authorize"
        ? { kind: "authorize", request: value.request, expiresAt }
        : { kind: value.kind, expiresAt }
    );
    return challenge;
  }

  /**
   * Look up and consume in one step: a challenge is gone
   * after its first use, whatever happens next. Call inside `serialize`.
   */
  consumeChallenge(challenge: unknown, kind: Challenge["kind"]): Challenge | null {
    if (typeof challenge !== "string") return null;
    const found = this.challenges.get(challenge);
    if (found === undefined || found.kind !== kind) return null;
    this.challenges.delete(challenge);
    return found.expiresAt > this.now().getTime() ? found : null;
  }

  // --- codes ----------------------------------------------------------------------

  mintCode(bound: Omit<AuthorizationCode, "expiresAt">, lifetimeMs: number): string {
    const code = randomSecret();
    this.codes.set(code, { ...bound, expiresAt: this.now().getTime() + lifetimeMs });
    return code;
  }

  /** The code's bindings without consuming it; the take inside the mutex decides. */
  peekCode(code: unknown): AuthorizationCode | null {
    if (typeof code !== "string") return null;
    const found = this.codes.get(code);
    return found !== undefined && found.expiresAt > this.now().getTime() ? found : null;
  }

  /**
   * Record a client assertion's jti until its exp, so it is used once.
   * Bounded by the challenge cap, the existing memory bound for spam, rather
   * than a number of its own. Call inside `serialize`.
   */
  useAssertionId(
    clientId: string,
    jti: string,
    expiresAtMs: number,
    cap: number
  ): "ok" | "replayed" | "full" {
    const now = this.now().getTime();
    for (const [key, until] of this.assertionIds) {
      if (until <= now) this.assertionIds.delete(key);
    }
    const key = JSON.stringify([clientId, jti]);
    if (this.assertionIds.has(key)) return "replayed";
    if (this.assertionIds.size >= cap) return "full";
    this.assertionIds.set(key, expiresAtMs);
    return "ok";
  }

  /** Delete-on-lookup: a second exchange of one code finds nothing. Call inside `serialize`. */
  takeCode(code: unknown): AuthorizationCode | null {
    if (typeof code !== "string") return null;
    const found = this.codes.get(code);
    if (found === undefined) return null;
    this.codes.delete(code);
    return found.expiresAt > this.now().getTime() ? found : null;
  }

  /** A revoke of an assistant voids every approval bound to its name. Call inside `serialize`. */
  dropCodesNamed(name: string): number {
    let dropped = 0;
    for (const [code, bound] of this.codes) {
      if (bound.name === name) {
        this.codes.delete(code);
        dropped += 1;
      }
    }
    return dropped;
  }

  /**
   * Commit a new grant. A grant of the same client holding the name is
   * deleted in the same write, so its token stops working and the name
   * continues. The caller has refused a name held by another client. Call
   * inside `serialize`.
   */
  async commitGrant(bound: AuthorizationCode): Promise<{ token: string; grant: Grant }> {
    const token = randomSecret();
    const grant: Grant = {
      grant_id: crypto.randomBytes(GRANT_ID_BYTES).toString("hex"),
      client_id: bound.clientId,
      name: bound.name,
      token_digest: sha256Hex(token),
      scopes: [...bound.scopes],
      resource: bound.resource,
      client_name: bound.clientName,
      approved_at: this.now().toISOString()
    };
    const grants = await this.readGrants();
    for (const [grantId, held] of Object.entries(grants)) {
      if (held.name === bound.name && held.client_id === bound.clientId) delete grants[grantId];
    }
    grants[grant.grant_id] = grant;
    await this.writeGrants(grants);
    // From here an assistant holds a token that reads the spine, where a link
    // issued inside a session was printed.
    const link = await readJson<EnrollFile>(this.enrollFile);
    if (link?.issued_in_session === true) await this.deleteEnrollLink();
    return { token, grant };
  }

  // --- passkeys -------------------------------------------------------------------

  async readPasskeys(): Promise<Passkey[]> {
    return (await readJson<Passkey[]>(this.passkeysFile)) ?? [];
  }

  /** Call inside `serialize`. */
  async writePasskeys(passkeys: Passkey[]): Promise<void> {
    await writeJsonAtomic(this.passkeysFile, passkeys);
  }

  // --- hosted client documents ---------------------------------------------------

  async readClients(): Promise<HostedClients> {
    return (await readJson<HostedClients>(this.clientsFile)) ?? {};
  }

  /** Call inside `serialize`. */
  async writeClients(clients: HostedClients): Promise<void> {
    await writeJsonAtomic(this.clientsFile, clients);
  }

  // --- enrollment link ------------------------------------------------------------

  /** A new link replaces the previous one. Call inside `serialize`. */
  async issueEnrollLink(issuedInSession: boolean): Promise<string> {
    const secret = randomSecret();
    await writeJsonAtomic(this.enrollFile, {
      digest: sha256Hex(secret),
      issued_at: this.now().toISOString(),
      issued_in_session: issuedInSession
    } satisfies EnrollFile);
    return secret;
  }

  async isCurrentEnrollSecret(secret: unknown): Promise<boolean> {
    if (typeof secret !== "string" || secret === "") return false;
    const file = await readJson<EnrollFile>(this.enrollFile);
    return file !== null && sameHex(sha256Hex(secret), file.digest);
  }

  /** Call inside `serialize`. */
  async deleteEnrollLink(): Promise<void> {
    await fs.rm(this.enrollFile, { force: true });
  }
}
