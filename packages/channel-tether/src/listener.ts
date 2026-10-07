// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The tether channel's routes: MCP, OAuth discovery, authorize, token, revoke
 * and passkey enrollment. Nothing else is registered: no /rpc, no /pair, no /ws, no health
 * route. They are served on loopback only; whatever exposes them is the
 * owner's choice. Without a public URL no OAuth or MCP route exists, because
 * issuer, resource and RP ID all derive from it.
 */

import { Readable } from "node:stream";
import type { ServerEventBus } from "@modelcontextprotocol/server";
import { isRecord } from "@openduo/protocol";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { FetchLike } from "./cimd";
import { SCOPES, type TetherConfig } from "./config";
import type { DaemonCall } from "./forward";
import type { CallbackPost } from "./callback";
import {
  createMcpEndpoint,
  handleMcpPost,
  protectedResourceMetadataUrl,
  type McpDeps
} from "./mcp";
import {
  authorizationServerMetadata,
  authorizeGet,
  authorizePost,
  enrollFinish,
  enrollOptions,
  exchangeToken,
  protectedResourceMetadata,
  revokeToken,
  type OAuthDeps,
  type Reply
} from "./oauth";
import type { Mailroom } from "./mail";
import { enrollPage } from "./pages";
import type { Store } from "./store";

export type TetherAppDeps = {
  config: TetherConfig;
  store: Store;
  daemon: DaemonCall;
  version: string;
  fetchImpl?: FetchLike;
  mail: Mailroom;
  /** Tests stand in for the network on events/subscribe verification. */
  postCallback?: CallbackPost;
  /** Shared with the Mailroom: what it publishes reaches the listen streams. */
  bus: ServerEventBus;
};

function send(reply: FastifyReply, out: Reply): FastifyReply {
  return reply.code(out.status).headers(out.headers).send(out.body);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function isListenRequest(body: unknown): boolean {
  return isRecord(body) && body.method === "subscriptions/listen";
}

async function grantStands(store: Store, grantId: string): Promise<boolean> {
  try {
    return Object.hasOwn(await store.readGrants(), grantId);
  } catch {
    // Unreadable: the reconnect gets 503 and tries again.
    return false;
  }
}

export function createTetherApp(deps: TetherAppDeps): FastifyInstance {
  // The request size is config, with a code default.
  const app = Fastify({ logger: false, bodyLimit: deps.config.requestLimitBytes });
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    }
  );

  const publicUrl = deps.config.publicUrl;
  if (publicUrl === null) return app;
  const mcpDeps: McpDeps = {
    daemon: deps.daemon,
    store: deps.store,
    publicUrl,
    version: deps.version,
    toolsListTtlMs: deps.config.toolsListTtlMs,
    callbackLimits: deps.config.cimd,
    ...(deps.postCallback ? { postCallback: deps.postCallback } : {}),
    bus: deps.bus,
    mail: deps.mail
  };
  const mcpEndpoint = createMcpEndpoint(mcpDeps);
  const oauth: OAuthDeps = {
    config: { ...deps.config, publicUrl },
    store: deps.store,
    daemon: deps.daemon,
    mail: deps.mail,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
  };
  const challenge =
    `Bearer resource_metadata="${protectedResourceMetadataUrl(publicUrl)}",` +
    ` scope="${SCOPES.join(" ")}"`;

  app.get("/.well-known/oauth-protected-resource", async (_request, reply) =>
    send(reply, protectedResourceMetadata(publicUrl))
  );
  app.get("/.well-known/oauth-authorization-server", async (_request, reply) =>
    send(reply, authorizationServerMetadata(publicUrl))
  );
  app.get("/authorize", async (request, reply) =>
    send(reply, await authorizeGet(oauth, record(request.query)))
  );
  app.post("/authorize", async (request, reply) =>
    send(reply, await authorizePost(oauth, record(request.body)))
  );
  app.post("/token", async (request, reply) =>
    send(reply, await exchangeToken(oauth, record(request.body)))
  );
  app.post("/revoke", async (request, reply) =>
    send(reply, await revokeToken(oauth, record(request.body)))
  );
  app.get("/enroll", async (_request, reply) => send(reply, enrollPage()));
  app.post("/enroll/options", async (request, reply) =>
    send(reply, await enrollOptions(oauth, request.body))
  );
  app.post("/enroll/finish", async (request, reply) =>
    send(reply, await enrollFinish(oauth, request.body))
  );

  app.get("/mcp", async (_request, reply) =>
    reply.code(405).header("allow", "POST").send({
      error: "method_not_allowed",
      message: "This MCP endpoint takes POST only; no SSE stream."
    })
  );
  app.post("/mcp", async (request, reply) => {
    // The transport spec's rebinding check; server-side hosts send no Origin.
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== publicUrl) {
      return reply
        .code(403)
        .send({ error: "forbidden", message: "Origin is not this server's origin." });
    }
    const auth = await deps.store.authenticate(request.headers.authorization, publicUrl);
    if (auth === "unavailable") {
      return reply.code(503).send({
        error: "temporarily_unavailable",
        error_description:
          "duoduo could not read its connections, so this token was not checked. Nothing was done." +
          " Try again; if this repeats, the owner checks the duoduo host."
      });
    }
    if (auth === null) {
      return reply
        .code(401)
        .header("www-authenticate", challenge)
        .send({
          error: "invalid_token",
          error_description:
            "No valid duoduo token: it is missing, revoked or replaced. Reconnect this app to duoduo;" +
            " the owner approves it with a passkey."
        });
    }
    // The response closing early means the client went away: end its stream.
    const gone = new AbortController();
    reply.raw.on("close", () => gone.abort());
    // A listen also ends when its grant does (revoked or replaced): the stream
    // would otherwise stay open on a token that no longer works, and never ring.
    const listen = isListenRequest(request.body);
    if (listen) reply.raw.on("close", deps.mail.holdListen(auth.grant.grant_id, gone));
    const out = await handleMcpPost(
      mcpEndpoint,
      auth,
      { headers: request.headers, body: request.body },
      gone.signal
    );
    // A grant that ended after authentication but before the hold was taken
    // was not in the registry when it ended; the hold comes first, so this read sees it.
    if (listen && !(await grantStands(deps.store, auth.grant.grant_id))) gone.abort();
    reply.code(out.status).headers(out.headers);
    return "stream" in out
      ? reply.send(Readable.fromWeb(out.stream as never))
      : reply.send(out.body);
  });

  return app;
}
