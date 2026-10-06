// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * OAuth 2.1 authorization code + PKCE with passkey approval, and passkey
 * enrollment. The owner's passkey assertion on /authorize is the approval: no
 * channel, no LLM and no terminal command approves. Every check-then-consume
 * runs inside the store's mutex.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON
} from "@simplewebauthn/server";
import { INTERNAL_SOURCE_KINDS, isRecord, SOURCE_NAME_PATTERN } from "@openduo/protocol";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import {
  fetchClientMetadata,
  fetchJwks,
  isHttpsUrl,
  TOKEN_AUTH_METHODS,
  TOKEN_AUTH_SIGNING_ALGS,
  type ClientAuth,
  type FetchLike
} from "./cimd";
import { hostedClientOf, hostedNameOf } from "./clients";
import { RESERVED_TETHER_NAMES, SCOPES, type TetherConfig, type Scope } from "./config";
import { DaemonUnreachableError, type DaemonCall } from "./forward";
import { authorizePage, errorPage, nameSlug, replacedPage } from "./pages";
import { sha256Hex, type AuthorizeRequest, type Grant, type Grants, type Store } from "./store";
import type { Mailroom } from "./mail";
import { renderNameRefusal } from "./texts";

export type OAuthDeps = {
  config: TetherConfig & { publicUrl: string };
  store: Store;
  daemon: DaemonCall;
  /** Told of every grant a token exchange or revoke ends or adds. */
  mail: Pick<Mailroom, "approved" | "revoked">;
  fetchImpl?: FetchLike;
};

export type Reply = { status: number; headers: Record<string, string>; body: string };

const NO_STORE = { "cache-control": "no-store" };

function json(status: number, value: unknown, extra: Record<string, string> = {}): Reply {
  return {
    status,
    headers: { "content-type": "application/json", ...NO_STORE, ...extra },
    body: JSON.stringify(value)
  };
}

function rpIdOf(publicUrl: string): string {
  return new URL(publicUrl).hostname;
}

/** `https://host` and `https://host/` are the one canonical resource; nothing else is. */
export function isCanonicalResource(value: unknown, publicUrl: string): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.origin === publicUrl &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

// --- discovery ---------------------------------------------------------------------------

export function protectedResourceMetadata(publicUrl: string): Reply {
  return json(200, {
    resource: publicUrl,
    authorization_servers: [publicUrl],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"]
  });
}

export function authorizationServerMetadata(publicUrl: string): Reply {
  return json(200, {
    issuer: publicUrl,
    authorization_endpoint: `${publicUrl}/authorize`,
    token_endpoint: `${publicUrl}/token`,
    revocation_endpoint: `${publicUrl}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: TOKEN_AUTH_METHODS,
    token_endpoint_auth_signing_alg_values_supported: TOKEN_AUTH_SIGNING_ALGS,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    scopes_supported: SCOPES
  });
}

// --- names -------------------------------------------------------------------------------

class UnreadableChannels extends Error {}

/** A missing directory holds no names; any other read error is not "no names". */
async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new UnreadableChannels(
      `${dir}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`
    );
  }
}

/**
 * The channel kinds and installed channel plugin types, read at submit.
 * Fails closed: an unreachable daemon or an unreadable directory is a reason
 * to refuse, never an empty set.
 */
async function channelNames(
  daemon: DaemonCall
): Promise<{ ok: true; names: Set<string> } | { ok: false; why: string }> {
  let reply;
  try {
    reply = await daemon("system.runtime.info", {});
  } catch (error) {
    if (error instanceof DaemonUnreachableError)
      return { ok: false, why: "duoduo is not answering" };
    throw error;
  }
  const info = reply.result;
  if (
    !isRecord(info) ||
    typeof info.kernel_dir !== "string" ||
    typeof info.runtime_dir !== "string"
  ) {
    return { ok: false, why: "duoduo did not say where its channels live" };
  }
  const names = new Set<string>();
  try {
    for (const entry of await listDir(path.join(info.kernel_dir, "config"))) {
      if (entry.endsWith(".md")) names.add(entry.slice(0, -".md".length));
    }
    const plugins = path.join(info.runtime_dir, "plugins", "channels");
    for (const entry of await listDir(plugins)) {
      // An installed plugin type is a directory (or a link to one); a stray file is not.
      const stat = await fs.stat(path.join(plugins, entry)).catch(() => null);
      if (stat?.isDirectory()) names.add(entry);
    }
  } catch (error) {
    if (error instanceof UnreadableChannels) {
      return { ok: false, why: `duoduo could not read its channel list (${error.message})` };
    }
    throw error;
  }
  return { ok: true, names };
}

function describeHolder(grant: Grant): string {
  try {
    return grant.client_name ?? new URL(grant.client_id).host;
  } catch {
    return grant.client_name ?? grant.client_id;
  }
}

/** The grant of `clientId` holding `name`: an approval under that name replaces it. */
function sameClientHolder(grants: Grants, name: string, clientId: string): Grant | null {
  return (
    Object.values(grants).find((grant) => grant.name === name && grant.client_id === clientId) ??
    null
  );
}

/**
 * The refusal text for a name, or null when `clientId` may take it: free, or
 * held by a grant of the same client. Call inside the mutex.
 */
async function nameRefusal(
  deps: OAuthDeps,
  name: string,
  clientId: string
): Promise<string | null> {
  if (!SOURCE_NAME_PATTERN.test(name)) return renderNameRefusal(name, "pattern");
  if (INTERNAL_SOURCE_KINDS.includes(name)) return renderNameRefusal(name, "internal");
  if (RESERVED_TETHER_NAMES.includes(name)) return renderNameRefusal(name, "reserved");
  for (const grant of Object.values(await deps.store.readGrants())) {
    if (grant.client_id !== clientId && grant.name === name) {
      return renderNameRefusal(name, "taken", describeHolder(grant));
    }
  }
  const channels = await channelNames(deps.daemon);
  if (!channels.ok) {
    return (
      `${channels.why}, so "${name}" could not be checked against duoduo's channel names.` +
      ` Nothing was approved. Try again; if this repeats, the owner checks the duoduo host.`
    );
  }
  if (channels.names.has(name)) return renderNameRefusal(name, "channel");
  return null;
}

// --- authorize ---------------------------------------------------------------------------

function withParams(redirectUri: string, params: Record<string, string | null>): string {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) target.searchParams.set(key, value);
  }
  return target.toString();
}

const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

const EXPIRED_TEXT =
  "This approval page was used already, expired, or duoduo restarted since it opened. Nothing" +
  " was approved. Start connecting again from the app.";

function parseScopes(raw: unknown): Scope[] | null {
  if (raw === undefined || raw === "") return [...SCOPES];
  if (typeof raw !== "string") return null;
  const asked = raw.split(" ").filter((scope) => scope !== "");
  if (asked.length === 0) return [...SCOPES];
  if (!asked.every((scope) => (SCOPES as readonly string[]).includes(scope))) return null;
  return SCOPES.filter((scope) => asked.includes(scope));
}

async function renderApproval(
  deps: OAuthDeps,
  request: AuthorizeRequest,
  name: string,
  refusal?: string
): Promise<Reply> {
  const challenge = deps.store.mintChallenge(
    { kind: "authorize", request },
    deps.config.challengeLifetimeMs,
    deps.config.challengeCap
  );
  const passkeys = await deps.store.readPasskeys();
  return authorizePage({
    challenge,
    clientId: request.clientId,
    hosted: hostedNameOf(request.clientId, deps.config.publicUrl) !== null,
    redirectUri: request.redirectUri,
    scopes: request.scopes as Scope[],
    name,
    ...(refusal !== undefined ? { refusal } : {}),
    rpId: rpIdOf(deps.config.publicUrl),
    timeoutMs: deps.config.challengeLifetimeMs,
    credentialIds: passkeys.map((passkey) => ({
      id: passkey.id,
      ...(passkey.transports ? { transports: passkey.transports } : {})
    }))
  });
}

function cannotConnect(description: string): Reply {
  return errorPage(400, "This app cannot connect", `${description} Nothing was approved.`);
}

/**
 * Whether a document hosted by this duoduo lists `redirectUri`: read
 * from `clients.json`, never fetched.
 */
async function hostedAccepts(store: Store, name: string, redirectUri: string): Promise<boolean> {
  const client = hostedClientOf(await store.readClients(), name);
  return client !== null && client.redirect_uris.includes(redirectUri);
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Nothing is fetched here, so an external client and its redirect stay
 * unverified, and every error is a page: duoduo never sends a browser to an
 * address it has not checked against the client's document. A document hosted
 * by this duoduo is read locally and checked here.
 */
export async function authorizeGet(
  deps: OAuthDeps,
  query: Record<string, unknown>
): Promise<Reply> {
  const { publicUrl } = deps.config;
  const clientId = query.client_id;
  const redirectUri = query.redirect_uri;
  if (typeof clientId !== "string" || typeof redirectUri !== "string") {
    return cannotConnect("The request names no client or no return address.");
  }
  if (!isHttpsUrl(clientId)) {
    return cannotConnect(`Its client id ${JSON.stringify(clientId)} is not an https URL.`);
  }
  if (!isUrl(redirectUri)) {
    return cannotConnect(`Its return address ${JSON.stringify(redirectUri)} is not a URL.`);
  }
  if (query.response_type !== "code") return cannotConnect("Its response_type is not code.");
  if (query.code_challenge_method !== "S256") {
    return cannotConnect("Its code_challenge_method is not S256.");
  }
  if (typeof query.code_challenge !== "string" || !S256_CHALLENGE.test(query.code_challenge)) {
    return cannotConnect("Its code_challenge is not a base64url SHA-256 value.");
  }
  if (!isCanonicalResource(query.resource, publicUrl)) {
    return cannotConnect(`Its resource is not ${publicUrl}.`);
  }
  const scopes = parseScopes(query.scope);
  if (scopes === null) {
    return cannotConnect(`Its scope is not a subset of ${SCOPES.join(" ")}.`);
  }
  // A local read, so it is checked before the passkey. One text for an
  // unknown name and an unlisted address: nothing stored is shown before the
  // passkey, so the page must not tell which documents exist.
  const hosted = hostedNameOf(clientId, publicUrl);
  if (hosted !== null && !(await hostedAccepts(deps.store, hosted, redirectUri))) {
    return cannotConnect(
      "No client document hosted by this duoduo accepts this client id with this return address." +
        " On the duoduo host, duoduo channel tether client list shows the documents, the client_id" +
        " of each, and the return addresses each accepts."
    );
  }
  if ((await deps.store.readPasskeys()).length === 0) {
    return errorPage(
      503,
      "No passkey is set up",
      "duoduo approves connections with the owner's passkey, and none is enrolled yet. Nothing was" +
        " approved. Enroll one with duoduo channel tether passkey add, then connect again from the app."
    );
  }
  const request: AuthorizeRequest = {
    clientId,
    redirectUri,
    state: typeof query.state === "string" ? query.state : null,
    codeChallenge: query.code_challenge,
    scopes,
    resource: publicUrl
  };
  return renderApproval(deps, request, hosted ?? nameSlug(new URL(clientId).host));
}

async function verifyAssertion(
  deps: OAuthDeps,
  rawAssertion: unknown,
  challenge: string
): Promise<boolean> {
  let response: AuthenticationResponseJSON;
  if (isRecord(rawAssertion)) {
    response = rawAssertion as unknown as AuthenticationResponseJSON;
  } else {
    if (typeof rawAssertion !== "string" || rawAssertion === "") return false;
    try {
      response = JSON.parse(rawAssertion) as AuthenticationResponseJSON;
    } catch {
      return false;
    }
  }
  // Against the passkeys enrolled now: a remove that committed first wins.
  const passkeys = await deps.store.readPasskeys();
  const passkey = passkeys.find((candidate) => candidate.id === response?.id);
  if (passkey === undefined) return false;
  try {
    const verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: deps.config.publicUrl,
      expectedRPID: rpIdOf(deps.config.publicUrl),
      requireUserVerification: true,
      credential: {
        id: passkey.id,
        publicKey: new Uint8Array(Buffer.from(passkey.public_key, "base64url")),
        // WebAuthn section 6.1.1: checked only when the stored or the presented
        // counter is non-zero; then it must increase. Synced passkeys report 0.
        counter: passkey.counter,
        ...(passkey.transports ? { transports: passkey.transports as never } : {})
      }
    });
    if (!verified.verified) return false;
    passkey.counter = verified.authenticationInfo.newCounter;
    await deps.store.writePasskeys(passkeys);
    return true;
  } catch {
    return false;
  }
}

export async function authorizePost(
  deps: OAuthDeps,
  form: Record<string, unknown>
): Promise<Reply> {
  return deps.store.serialize(async () => {
    // Step 7.1-7.2: every submit consumes its challenge, whatever happens next.
    const found = deps.store.consumeChallenge(form.challenge, "authorize");
    if (found === null || found.kind !== "authorize") {
      return errorPage(400, "This approval page has expired", EXPIRED_TEXT);
    }
    const { request } = found;
    // Step 8: the redirect is unverified without the passkey and the document,
    // so a deny is a page, never a redirect.
    if (form.deny !== undefined) {
      return errorPage(
        200,
        "Connection denied",
        "Nothing was approved. The app was not told; close this page."
      );
    }
    // The passkey before the name, so nothing stored is shown before it.
    if (!(await verifyAssertion(deps, form.assertion, form.challenge as string))) {
      return errorPage(
        400,
        "The passkey check failed",
        "Nothing was approved. Start connecting again from the app."
      );
    }
    // A hosted document is read again inside the mutex; it may have been
    // removed since GET. Before the name: a gone document ends this request.
    const hosted = hostedNameOf(request.clientId, deps.config.publicUrl);
    if (hosted !== null && !(await hostedAccepts(deps.store, hosted, request.redirectUri))) {
      return errorPage(
        400,
        "This app's client document changed",
        `The client document ${hosted} hosted by this duoduo was removed, or no longer lists the` +
          ` return address ${request.redirectUri}, since this page opened. Nothing was approved.` +
          ` On the duoduo host, duoduo channel tether client list shows the documents; add it again` +
          ` with duoduo channel tether client add, then connect again from the app.`
      );
    }
    const name = typeof form.name === "string" ? form.name.trim() : "";
    const refusal = await nameRefusal(deps, name, request.clientId);
    if (refusal !== null) return renderApproval(deps, request, name, refusal);
    let client: { clientName: string | null; clientAuth: ClientAuth };
    if (hosted !== null) {
      client = { clientName: hosted, clientAuth: { method: "none" } };
    } else {
      // The first fetch for this client, after the owner's passkey.
      const metadata = await fetchClientMetadata(
        request.clientId,
        deps.config.cimd,
        deps.fetchImpl
      );
      if (!metadata.ok) {
        return renderApproval(
          deps,
          request,
          name,
          `The app's client document was refused: ${metadata.problem}. Nothing was approved.`
        );
      }
      if (!metadata.client.redirectUris.includes(request.redirectUri)) {
        return renderApproval(
          deps,
          request,
          name,
          `The return address ${request.redirectUri} is not one the app's client document lists.` +
            ` Nothing was approved.`
        );
      }
      client = { clientName: metadata.client.clientName, clientAuth: metadata.client.auth };
    }
    const code = deps.store.mintCode({ ...request, ...client, name }, deps.config.codeLifetimeMs);
    const location = withParams(request.redirectUri, {
      code,
      state: request.state,
      iss: deps.config.publicUrl
    });
    // The owner learns of a replacement only after the passkey.
    if (sameClientHolder(await deps.store.readGrants(), name, request.clientId) !== null) {
      return replacedPage({ name, location });
    }
    return { status: 302, headers: { location, ...NO_STORE }, body: "" };
  });
}

// --- token -------------------------------------------------------------------------------

function tokenError(error: string, description: string): Reply {
  // RFC 6749 section 5.2: a failed client authentication is 401.
  return json(error === "invalid_client" ? 401 : 400, { error, error_description: description });
}

const JWT_BEARER = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

type ClientProof =
  { ok: true; jti: string; expiresAtMs: number } | { ok: false; description: string };

/**
 * RFC 7523 section 3 client authentication, checked against the client's key set on
 * its own host. aud may name the token endpoint or the issuer (both are in
 * use). exp, jti and kid are required; nbf is checked when present; jose's
 * default leaves no clock skew; iat is only type-checked.
 */
async function verifyClientAssertion(
  deps: OAuthDeps,
  clientId: string,
  auth: Extract<ClientAuth, { method: "private_key_jwt" }>,
  form: Record<string, unknown>
): Promise<ClientProof> {
  if (form.client_assertion_type !== JWT_BEARER || typeof form.client_assertion !== "string") {
    return {
      ok: false,
      description: `this client authenticates with private_key_jwt: send client_assertion_type ${JWT_BEARER} and a client_assertion`
    };
  }
  const keys = await fetchJwks(auth.jwksUri, deps.config.cimd, deps.fetchImpl);
  if (!keys.ok)
    return { ok: false, description: `the client's ${keys.problem.replace(/^its /, "")}` };
  try {
    const { payload, protectedHeader } = await jwtVerify(
      form.client_assertion,
      createLocalJWKSet(keys.jwks as JSONWebKeySet),
      {
        algorithms: [auth.alg],
        issuer: clientId,
        subject: clientId,
        audience: [`${deps.config.publicUrl}/token`, deps.config.publicUrl],
        requiredClaims: ["exp", "jti"],
        currentDate: deps.store.clock()
      }
    );
    if (typeof protectedHeader.kid !== "string") {
      return { ok: false, description: "the client_assertion names no kid" };
    }
    if (typeof payload.jti !== "string" || payload.jti === "" || typeof payload.exp !== "number") {
      return { ok: false, description: "the client_assertion needs a string jti and an exp" };
    }
    return { ok: true, jti: payload.jti, expiresAtMs: payload.exp * 1000 };
  } catch (error) {
    return {
      ok: false,
      description: `the client_assertion was refused (${error instanceof Error ? error.message : String(error)})`
    };
  }
}

const absent = (value: unknown): boolean => typeof value !== "string" || value === "";

/**
 * Names every token-request parameter that is missing or differs from what the code was
 * issued for. The reader is usually an agent that cannot see the code's bindings, and the
 * code is already consumed, so the text says which parameter to fix before starting over.
 */
function bindingMismatch(
  form: Record<string, unknown>,
  bound: { clientId: string; redirectUri: string; resource: string; codeChallenge: string }
): string | null {
  const problems: string[] = [];
  const names: string[] = [];
  if (form.client_id !== bound.clientId) {
    names.push("client_id");
    problems.push(
      absent(form.client_id)
        ? "client_id is missing"
        : "client_id is not the client the code was issued to"
    );
  }
  if (form.redirect_uri !== bound.redirectUri) {
    names.push("redirect_uri");
    problems.push(
      absent(form.redirect_uri)
        ? "redirect_uri is missing; send the one the authorization request used"
        : "redirect_uri is not the one the authorization request used"
    );
  }
  if (!isCanonicalResource(form.resource, bound.resource)) {
    names.push("resource");
    problems.push(
      absent(form.resource)
        ? `resource is missing; send resource=${bound.resource} (RFC 8707)`
        : `resource is not ${bound.resource}`
    );
  }
  const verifier = form.code_verifier;
  const challenge =
    typeof verifier === "string"
      ? crypto.createHash("sha256").update(verifier).digest("base64url")
      : null;
  if (challenge !== bound.codeChallenge) {
    names.push("code_verifier");
    problems.push(
      absent(verifier)
        ? "code_verifier is missing (PKCE S256)"
        : "code_verifier does not hash to the code_challenge of the authorization request (PKCE S256)"
    );
  }
  if (problems.length === 0) return null;
  return (
    `The token request does not match the code: ${problems.join("; ")}. ` +
    `The code is used up and cannot be exchanged again. Start a new authorization and send ` +
    `${names.join(", ")} correctly in its token request.`
  );
}

export async function exchangeToken(
  deps: OAuthDeps,
  form: Record<string, unknown>
): Promise<Reply> {
  // The key fetch is network I/O, so the assertion is verified before the
  // mutex, against the code's bindings read without consuming it. The take
  // inside the mutex is what decides; the jti is consumed there.
  const peeked = deps.store.peekCode(form.code);
  const proof =
    peeked !== null && peeked.clientAuth.method === "private_key_jwt"
      ? await verifyClientAssertion(deps, peeked.clientId, peeked.clientAuth, form)
      : null;
  return deps.store.serialize(async () => {
    if (form.grant_type !== "authorization_code") {
      return tokenError("unsupported_grant_type", "grant_type must be authorization_code");
    }
    const bound = deps.store.takeCode(form.code);
    if (bound === null) {
      return tokenError("invalid_grant", "the code is unknown, used or expired; connect again");
    }
    if (bound.clientAuth.method === "private_key_jwt") {
      // No downgrade: a client bound to private_key_jwt never gets a token on PKCE alone.
      if (proof === null || bound !== peeked) {
        return tokenError("invalid_client", "the client was not authenticated; connect again");
      }
      if (!proof.ok) return tokenError("invalid_client", `${proof.description}; connect again`);
      const used = deps.store.useAssertionId(
        bound.clientId,
        proof.jti,
        proof.expiresAtMs,
        deps.config.challengeCap
      );
      if (used !== "ok") {
        return tokenError(
          "invalid_client",
          used === "replayed"
            ? "this client_assertion was used before; connect again"
            : "duoduo is holding as many client assertions as it allows; try again after they expire"
        );
      }
    }
    const mismatch = bindingMismatch(form, bound);
    if (mismatch !== null) return tokenError("invalid_grant", mismatch);
    // An approval for another client may have taken the name since this one was approved.
    const refusal = await nameRefusal(deps, bound.name, bound.clientId);
    if (refusal !== null) return tokenError("invalid_grant", `${refusal} Connect again.`);
    const { token, grant } = await deps.store.commitGrant(bound);
    // The session exists before the token is out, and a replaced grant's
    // unread mail is bounced under this same turn of the mutex.
    await deps.mail.approved(grant);
    return json(200, { access_token: token, token_type: "Bearer", scope: bound.scopes.join(" ") });
  });
}

// --- revoke (RFC 7009) ---------------------------------------------------------------------

export async function revokeToken(deps: OAuthDeps, form: Record<string, unknown>): Promise<Reply> {
  await deps.store.serialize(async () => {
    if (typeof form.token !== "string" || typeof form.client_id !== "string") return;
    const grants = await deps.store.readGrants();
    const digest = sha256Hex(form.token);
    const entry = Object.entries(grants).find(
      ([, grant]) => grant.client_id === form.client_id && grant.token_digest === digest
    );
    if (entry === undefined) return;
    const [grantId, grant] = entry;
    delete grants[grantId];
    await deps.store.writeGrants(grants);
    deps.store.dropCodesNamed(grant.name);
    await deps.mail.revoked(grant);
  });
  return { status: 200, headers: { ...NO_STORE }, body: "" };
}

// --- enrollment ------------------------------------------------------------------------------

const LINK_GONE =
  "This enrollment link was used or replaced. Nothing was created. duoduo channel tether passkey" +
  " add issues a new link.";

export async function enrollOptions(deps: OAuthDeps, body: unknown): Promise<Reply> {
  const secret = isRecord(body) ? body.secret : undefined;
  if (!(await deps.store.isCurrentEnrollSecret(secret))) return json(403, { message: LINK_GONE });
  const challenge = deps.store.mintChallenge(
    { kind: "enroll" },
    deps.config.challengeLifetimeMs,
    deps.config.challengeCap
  );
  const passkeys = await deps.store.readPasskeys();
  const options = await generateRegistrationOptions({
    rpName: "duoduo",
    rpID: rpIdOf(deps.config.publicUrl),
    userName: "duoduo owner",
    challenge: new Uint8Array(Buffer.from(challenge, "base64url")),
    timeout: deps.config.challengeLifetimeMs,
    attestationType: "none",
    excludeCredentials: passkeys.map((passkey) => ({
      id: passkey.id,
      ...(passkey.transports ? { transports: passkey.transports } : {})
    })),
    authenticatorSelection: { userVerification: "required", residentKey: "preferred" }
  });
  if (passkeys.length === 0) return json(200, { options });
  // Once a passkey exists, a new one needs an assertion from an enrolled
  // one, so a leaked link alone enrolls nothing.
  const assertChallenge = deps.store.mintChallenge(
    { kind: "enroll-assert" },
    deps.config.challengeLifetimeMs,
    deps.config.challengeCap
  );
  return json(200, {
    options,
    assertion: {
      challenge: assertChallenge,
      rpId: rpIdOf(deps.config.publicUrl),
      timeout: deps.config.challengeLifetimeMs,
      allowCredentials: passkeys.map((passkey) => ({
        id: passkey.id,
        ...(passkey.transports ? { transports: passkey.transports } : {})
      }))
    }
  });
}

export async function enrollFinish(deps: OAuthDeps, body: unknown): Promise<Reply> {
  const input = isRecord(body) ? body : {};
  return deps.store.serialize(async () => {
    // Re-checked inside the mutex: a passkey add that replaced the link wins.
    if (!(await deps.store.isCurrentEnrollSecret(input.secret))) {
      return json(403, { message: LINK_GONE });
    }
    const challenge = deps.store.consumeChallenge(input.challenge, "enroll");
    const assertChallenge = deps.store.consumeChallenge(input.assertion_challenge, "enroll-assert");
    // Decided on the passkeys enrolled now, inside the mutex.
    if ((await deps.store.readPasskeys()).length > 0) {
      const approved =
        assertChallenge !== null &&
        (await verifyAssertion(deps, input.assertion, input.assertion_challenge as string));
      if (!approved) {
        return json(403, {
          message:
            "A passkey already enrolled for duoduo must approve a new one, and that check failed." +
            " Nothing was created. Reload the page and approve with an enrolled passkey. If every" +
            " enrolled passkey is lost, on the duoduo host terminal revoke every connected assistant" +
            " (duoduo channel tether revoke <name>), remove the passkeys" +
            " (duoduo channel tether passkey remove <id>), and enroll again."
        });
      }
    }
    if (challenge === null) {
      return json(400, {
        message:
          "This passkey request expired or was used. Nothing was created. Reload the page and try again."
      });
    }
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response: input.response as RegistrationResponseJSON,
        expectedChallenge: input.challenge as string,
        expectedOrigin: deps.config.publicUrl,
        expectedRPID: rpIdOf(deps.config.publicUrl),
        requireUserVerification: true
      });
    } catch (error) {
      return json(400, {
        message: `The passkey could not be verified (${error instanceof Error ? error.message : String(error)}). Nothing was created. Reload the page and try again.`
      });
    }
    if (!verified.verified) {
      return json(400, {
        message:
          "The passkey could not be verified. Nothing was created. Reload the page and try again."
      });
    }
    const { credential } = verified.registrationInfo;
    const passkeys = await deps.store.readPasskeys();
    passkeys.push({
      id: credential.id,
      public_key: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      label:
        typeof input.label === "string" && input.label.trim() !== "" ? input.label.trim() : null,
      ...(credential.transports ? { transports: [...credential.transports] } : {}),
      created_at: deps.store.clock().toISOString()
    });
    await deps.store.writePasskeys(passkeys);
    await deps.store.deleteEnrollLink();
    return json(200, { message: "Passkey saved. This link no longer works." });
  });
}
