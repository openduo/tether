// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * OpenAI MCP Events on the MCP endpoint
 * (https://developers.openai.com/plugins/build/mcp-events). One event,
 * `mailbox.new`, with no arguments and an empty payload; webhook delivery
 * only. The methods are not in the MCP spec, so they are custom request
 * handlers on the SDK server. A subscription belongs to the caller's grant
 * and goes with it on revoke or replace, as doorbells do.
 *
 * The verification POST runs outside the store mutex, so a slow callback
 * holds no mail walk; the subscription is written under the mutex afterwards
 * against the grant as it is then.
 */

import crypto from "node:crypto";
import {
  ProtocolError,
  ProtocolErrorCode,
  type Server,
  type StandardSchemaV1
} from "@modelcontextprotocol/server";
import { isRecord } from "@openduo/protocol";
import {
  BlockedAddressError,
  isRefusedCallbackUrl,
  isTimeout,
  postCallback,
  type CallbackLimits,
  type CallbackPost
} from "./callback";
import { MAIL_SCOPES } from "./config";
import { MAILBOX_EVENT, signedHeaders, webhookKey } from "./mail";
import {
  missingScopes,
  randomSecret,
  type Authenticated,
  type Store,
  type Subscription
} from "./store";
import {
  EVENT_DESCRIPTION,
  renderCallbackRefused,
  renderEventArguments,
  renderEventDelivery,
  renderEventSecret,
  renderEventTtl,
  renderInsufficientScope,
  renderNoSuchEvent,
  renderRevokedMidCall
} from "./texts";

/** OpenAI MCP Events: `CallbackEndpointError`. */
export const CALLBACK_ENDPOINT_ERROR = -32015;

/** OpenAI MCP Events: a subscription secret decodes to 24 to 64 bytes. */
const SECRET_MIN_BYTES = 24;
const SECRET_MAX_BYTES = 64;

const EMPTY_OBJECT_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

export type EventDeps = {
  store: Store;
  callbackLimits: CallbackLimits;
  postCallback?: CallbackPost;
};

/** Params are checked by hand, so the errors read as instructions to the assistant. */
const ANY_PARAMS: StandardSchemaV1<Record<string, unknown>> = {
  "~standard": {
    version: 1,
    vendor: "duoduo",
    validate: (value) => ({ value: isRecord(value) ? value : {} })
  }
};

function invalid(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, message);
}

function callbackError(reason: "invalid_url" | "challenge_failed" | "timeout", url: string) {
  return new ProtocolError(CALLBACK_ENDPOINT_ERROR, renderCallbackRefused(reason, url), {
    reason
  });
}

function checkScopes(auth: Authenticated, method: string): void {
  const missing = missingScopes(auth, MAIL_SCOPES);
  if (missing.length > 0) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidRequest,
      renderInsufficientScope(method, missing)
    );
  }
}

function checkEvent(params: Record<string, unknown>): void {
  if (params.name !== MAILBOX_EVENT) throw invalid(renderNoSuchEvent(String(params.name)));
  const args = params.arguments;
  if (args !== undefined && args !== null && !(isRecord(args) && Object.keys(args).length === 0)) {
    throw invalid(renderEventArguments());
  }
}

function deliveryOf(params: Record<string, unknown>): Record<string, unknown> {
  const delivery = params.delivery;
  if (!isRecord(delivery) || delivery.mode !== "webhook" || typeof delivery.url !== "string") {
    throw invalid(renderEventDelivery());
  }
  return delivery;
}

/** The lifetime the assistant asked for; absent or null asks for none. */
function refreshBefore(ttlMs: unknown, now: Date): string | null {
  if (ttlMs === undefined || ttlMs === null) return null;
  if (typeof ttlMs !== "number" || !Number.isSafeInteger(ttlMs) || ttlMs < 0) {
    throw invalid(renderEventTtl());
  }
  const at = new Date(now.getTime() + ttlMs);
  // Past the last date a Date can hold, toISOString would throw.
  if (Number.isNaN(at.getTime())) throw invalid(renderEventTtl());
  return at.toISOString();
}

/**
 * The verification handshake: a signed `{type: "verification", challenge}`
 * POST that must answer 2xx with the same challenge, compared in constant time.
 */
async function verify(
  deps: EventDeps,
  url: string,
  secret: string,
  subscriptionId: string
): Promise<void> {
  const challenge = randomSecret();
  const body = JSON.stringify({ type: "verification", challenge });
  const headers = {
    "content-type": "application/json",
    ...signedHeaders(secret, `verify_${crypto.randomUUID()}`, deps.store.clock(), body),
    "x-mcp-subscription-id": subscriptionId
  };
  let response;
  try {
    response = await (deps.postCallback ?? postCallback)(url, headers, body, deps.callbackLimits);
  } catch (error) {
    if (error instanceof BlockedAddressError) throw callbackError("invalid_url", url);
    if (isTimeout(error)) throw callbackError("timeout", url);
    throw callbackError("challenge_failed", url);
  }
  let echoed: unknown;
  try {
    echoed = (JSON.parse(response.body) as { challenge?: unknown }).challenge;
  } catch {
    echoed = undefined;
  }
  const expected = Buffer.from(challenge);
  const got = Buffer.from(typeof echoed === "string" ? echoed : "");
  const matches = got.length === expected.length && crypto.timingSafeEqual(got, expected);
  if (response.status < 200 || response.status > 299 || !matches) {
    throw callbackError("challenge_failed", url);
  }
}

async function subscribe(deps: EventDeps, auth: Authenticated, params: Record<string, unknown>) {
  checkScopes(auth, "events/subscribe");
  checkEvent(params);
  const delivery = deliveryOf(params);
  const url = delivery.url as string;
  const secret = typeof delivery.secret === "string" ? delivery.secret : "";
  const key = secret.startsWith("whsec_") ? webhookKey(secret) : null;
  if (key === null || key.length < SECRET_MIN_BYTES || key.length > SECRET_MAX_BYTES) {
    throw invalid(renderEventSecret());
  }
  const lifetime = refreshBefore(params.ttlMs, deps.store.clock());
  if (isRefusedCallbackUrl(url)) throw callbackError("invalid_url", url);

  // Under the mutex: refresh the subscription of this URL, or, when `id` is
  // given, store a new one. Null when there is none and no id.
  const write = (id?: string) =>
    deps.store.serialize(async () => {
      const grants = await deps.store.readGrants();
      const grant = grants[auth.grant.grant_id];
      if (grant === undefined) {
        throw new ProtocolError(ProtocolErrorCode.InvalidRequest, renderRevokedMidCall());
      }
      const current = grant.subscriptions?.find((entry) => entry.url === url);
      if (current === undefined && id === undefined) return null;
      const subscription: Subscription = {
        id: current?.id ?? (id as string),
        url,
        secret,
        refresh_before: lifetime
      };
      grant.subscriptions = [
        ...(grant.subscriptions ?? []).filter((entry) => entry.url !== url),
        subscription
      ];
      await deps.store.writeGrants(grants);
      return { id: subscription.id, refreshBefore: lifetime, cursor: null, truncated: false };
    });

  // A verified callback stays verified until unsubscribe or revoke, so a
  // stored one is refreshed in a single turn of the mutex. Only
  // a new one leaves the mutex to be verified, then re-enters to be stored.
  const refreshed = await write();
  if (refreshed !== null) return refreshed;
  const id = `sub_${crypto.randomUUID()}`;
  await verify(deps, url, secret, id);
  const stored = await write(id);
  if (stored === null) throw new Error("a subscription with an id is always stored");
  return stored;
}

async function unsubscribe(deps: EventDeps, auth: Authenticated, params: Record<string, unknown>) {
  checkScopes(auth, "events/unsubscribe");
  checkEvent(params);
  const url = deliveryOf(params).url as string;
  await deps.store.serialize(async () => {
    const grants = await deps.store.readGrants();
    const grant = grants[auth.grant.grant_id];
    if (grant?.subscriptions?.some((entry) => entry.url === url) !== true) return;
    grant.subscriptions = grant.subscriptions.filter((entry) => entry.url !== url);
    await deps.store.writeGrants(grants);
  });
  return {};
}

export function registerEventHandlers(server: Server, deps: EventDeps, auth: Authenticated): void {
  server.setRequestHandler("events/list", { params: ANY_PARAMS }, async () => {
    checkScopes(auth, "events/list");
    return {
      events: [
        {
          name: MAILBOX_EVENT,
          description: EVENT_DESCRIPTION,
          delivery: ["webhook"],
          inputSchema: EMPTY_OBJECT_SCHEMA,
          payloadSchema: EMPTY_OBJECT_SCHEMA
        }
      ]
    };
  });
  server.setRequestHandler("events/subscribe", { params: ANY_PARAMS }, (params) =>
    subscribe(deps, auth, params)
  );
  server.setRequestHandler("events/unsubscribe", { params: ANY_PARAMS }, (params) =>
    unsubscribe(deps, auth, params)
  );
}
