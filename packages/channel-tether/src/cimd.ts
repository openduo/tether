// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Client ID Metadata Documents. Any https client_id may ask; its document is
 * fetched only after the owner's passkey verified, HTTPS only, redirects never
 * followed, with a time and a size bound from config. No address filtering:
 * the owner saw the URL. No cache: the code carries the validated client, redirect and
 * authentication method to /token.
 */

/** The token-endpoint authentication the client's document binds it to. */
export type ClientAuth =
  { method: "none" } | { method: "private_key_jwt"; jwksUri: string; alg: "RS256" };

/** What /token accepts, as the AS metadata advertises it. */
export const TOKEN_AUTH_METHODS = ["none", "private_key_jwt"] as const;
export const TOKEN_AUTH_SIGNING_ALGS = ["RS256"] as const;

export type ClientMetadata = {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  auth: ClientAuth;
};

export type CimdOutcome = { ok: true; client: ClientMetadata } | { ok: false; problem: string };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function readBounded(response: Response, maxBytes: number): Promise<string | null> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type Limits = { timeoutMs: number; maxBytes: number };

/** One JSON document over https, no redirects, within the CIMD time and size bounds. */
async function fetchJson(
  url: string,
  what: string,
  limits: Limits,
  fetchImpl: FetchLike
): Promise<{ ok: true; record: Record<string, unknown> } | { ok: false; problem: string }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(limits.timeoutMs),
      headers: { accept: "application/json" }
    });
  } catch (error) {
    return { ok: false, problem: `its ${what} could not be fetched (${String(error)})` };
  }
  if (response.status !== 200) {
    return { ok: false, problem: `its ${what} answered HTTP ${response.status}` };
  }
  let raw: string | null;
  try {
    raw = await readBounded(response, limits.maxBytes);
  } catch (error) {
    return { ok: false, problem: `its ${what} could not be read (${String(error)})` };
  }
  if (raw === null) return { ok: false, problem: `its ${what} is larger than allowed` };
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return { ok: false, problem: `its ${what} is not JSON` };
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { ok: false, problem: `its ${what} is not a JSON object` };
  }
  return { ok: true, record: document as Record<string, unknown> };
}

/**
 * The method /token will demand. The declared method wins when duoduo supports
 * it, so a private_key_jwt client is never downgraded to none; otherwise the
 * strongest method both sides list.
 */
function clientAuthOf(
  clientId: string,
  record: Record<string, unknown>
): { ok: true; auth: ClientAuth } | { ok: false; problem: string } {
  const declared =
    typeof record.token_endpoint_auth_method === "string"
      ? record.token_endpoint_auth_method
      : "none";
  const listed = Array.isArray(record.token_endpoint_auth_methods_supported)
    ? record.token_endpoint_auth_methods_supported.filter(
        (method): method is string => typeof method === "string"
      )
    : [];
  const offered = new Set([declared, ...listed]);
  const supported = (TOKEN_AUTH_METHODS as readonly string[]).includes(declared)
    ? declared
    : offered.has("private_key_jwt")
      ? "private_key_jwt"
      : offered.has("none")
        ? "none"
        : null;
  if (supported === null) {
    return {
      ok: false,
      problem: `its client document asks for ${declared} authentication, which duoduo does not support (it supports ${TOKEN_AUTH_METHODS.join(" and ")})`
    };
  }
  if (supported === "none") return { ok: true, auth: { method: "none" } };
  const alg = record.token_endpoint_auth_signing_alg ?? "RS256";
  if (!(TOKEN_AUTH_SIGNING_ALGS as readonly unknown[]).includes(alg)) {
    return {
      ok: false,
      problem: `its client document signs with ${String(alg)}, and duoduo accepts only ${TOKEN_AUTH_SIGNING_ALGS.join(", ")}`
    };
  }
  // The keys must come from the client's own host: a client document cannot
  // point duoduo at a key set anywhere else.
  let jwks: URL | null = null;
  try {
    jwks = typeof record.jwks_uri === "string" ? new URL(record.jwks_uri) : null;
  } catch {
    jwks = null;
  }
  if (jwks === null || jwks.protocol !== "https:" || jwks.host !== new URL(clientId).host) {
    return {
      ok: false,
      problem: "its client document names no https jwks_uri on the client's own host"
    };
  }
  return { ok: true, auth: { method: "private_key_jwt", jwksUri: jwks.href, alg: "RS256" } };
}

/** The client's key set, fetched per token exchange with the CIMD bounds; no cache. */
export async function fetchJwks(
  jwksUri: string,
  limits: Limits,
  fetchImpl: FetchLike = fetch
): Promise<{ ok: true; jwks: { keys: unknown[] } } | { ok: false; problem: string }> {
  const fetched = await fetchJson(jwksUri, "key set", limits, fetchImpl);
  if (!fetched.ok) return fetched;
  if (!Array.isArray(fetched.record.keys)) {
    return { ok: false, problem: "its key set has no keys array" };
  }
  return { ok: true, jwks: { keys: fetched.record.keys } };
}

/** A client_id duoduo may fetch: an https URL. Anything else is refused before anything. */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export async function fetchClientMetadata(
  clientId: string,
  limits: Limits,
  fetchImpl: FetchLike = fetch
): Promise<CimdOutcome> {
  if (!isHttpsUrl(clientId)) {
    return { ok: false, problem: "the client id is not an https URL" };
  }
  const fetched = await fetchJson(clientId, "client document", limits, fetchImpl);
  if (!fetched.ok) return fetched;
  const { record } = fetched;
  if (record.client_id !== clientId) {
    return { ok: false, problem: "its client document names another client_id" };
  }
  const redirectUris = record.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    !redirectUris.every((uri) => typeof uri === "string")
  ) {
    return { ok: false, problem: "its client document lists no redirect_uris" };
  }
  const auth = clientAuthOf(clientId, record);
  if (!auth.ok) return auth;
  return {
    ok: true,
    client: {
      clientId,
      clientName: typeof record.client_name === "string" ? record.client_name : null,
      redirectUris: redirectUris as string[],
      auth: auth.auth
    }
  };
}
