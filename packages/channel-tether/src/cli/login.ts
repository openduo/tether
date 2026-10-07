// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * `login` and `logout`. Login is the authorization code flow with PKCE (S256)
 * through the client built into every tether host, returning to a loopback
 * listener on a free port (RFC 8252). The owner may approve on another device;
 * then the address that device's browser landed on is pasted on standard input.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { builtInClientId } from "../client-contract";
import { httpFailure, rpc, unreachable } from "./http";
import { CliExit, EXIT, type CliIo } from "./io";
import { loadConnection, saveConnection, type Connection } from "./tokens";

const b64url = (bytes: Buffer): string => bytes.toString("base64url");

/** The public URL as tether uses it: an https origin, no path. */
function publicOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CliExit(
      EXIT.usage,
      `${JSON.stringify(raw)} is not a URL. Give the host's public URL.`
    );
  }
  if (parsed.protocol !== "https:") {
    throw new CliExit(EXIT.usage, `${raw} is not https; a tether host's public URL always is.`);
  }
  return parsed.origin;
}

const CALLBACK_PAGE = (title: string, text: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body><h1>${title}</h1><p>${text}</p></body></html>`;

type Waiting = { arrived: Promise<URL>; redirectUri: string; stop: () => void };

/** The loopback listener and the pasted line, whichever brings a code first. */
async function waitForCode(io: CliIo, state: string): Promise<Waiting> {
  let arrive!: (url: URL) => void;
  const arrived = new Promise<URL>((resolve) => (arrive = resolve));
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const ours = url.searchParams.get("state") === state;
    response
      .writeHead(ours ? 200 : 400, { "content-type": "text/html; charset=utf-8" })
      .end(
        ours
          ? CALLBACK_PAGE("duoduo-tether has the approval", "You can close this page.")
          : CALLBACK_PAGE(
              "Not this login",
              "This address belongs to another login attempt. duoduo-tether stopped; start it again."
            )
      );
    arrive(url);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const input = io.stdinLines();
  void (async () => {
    for await (const line of input.lines) {
      const text = line.trim();
      if (text === "") continue;
      let url: URL;
      try {
        url = new URL(text);
      } catch {
        io.stderr("That is not an address. Paste the whole address the browser landed on.\n");
        continue;
      }
      if (!url.searchParams.has("code")) {
        io.stderr(
          "That address carries no code. Paste the address the browser landed on after approving.\n"
        );
        continue;
      }
      arrive(url);
      return;
    }
  })().catch(() => undefined);
  return {
    arrived,
    redirectUri: `http://127.0.0.1:${port}/callback`,
    stop: () => {
      input.close();
      server.closeAllConnections();
      server.close();
    }
  };
}

async function revokeQuietly(io: CliIo, connection: Connection): Promise<boolean> {
  try {
    const response = await io.fetch(`${connection.publicUrl}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: connection.token,
        client_id: builtInClientId(connection.publicUrl)
      }).toString()
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** A token was issued and cannot be kept: revoke it, so nothing stays connected unseen. */
async function abandon(io: CliIo, connection: Connection, why: string): Promise<CliExit> {
  const revoked = await revokeQuietly(io, connection);
  return new CliExit(
    EXIT.refused,
    `${why} ${
      revoked
        ? "The new token was revoked, so nothing is left connected. Log in again."
        : "Revoking the new token failed too: the owner revokes this connection with duoduo channel tether revoke <name>."
    }`
  );
}

export async function login(io: CliIo, rawUrl: string, name: string | undefined): Promise<number> {
  const publicUrl = publicOrigin(rawUrl);
  const clientId = builtInClientId(publicUrl);
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const waiting = await waitForCode(io, state);
  let code: string;
  try {
    const authorize = new URL(`${publicUrl}/authorize`);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: waiting.redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: publicUrl,
      ...(name !== undefined ? { name } : {})
    })) {
      authorize.searchParams.set(key, value);
    }
    io.stderr(
      `Approve this connection with the owner's passkey:\n\n  ${authorize.href}\n\n` +
        `If you approve on another device, its browser cannot reach this one and shows an error` +
        ` page; copy that page's whole address and paste it here.\n`
    );
    io.openBrowser(authorize.href);
    const url = await waiting.arrived;
    if (url.searchParams.get("state") !== state) {
      throw new CliExit(
        EXIT.refused,
        "That address belongs to another login attempt (its state is not this login's). Nothing was" +
          " exchanged. Start again with duoduo-tether login."
      );
    }
    const issuer = url.searchParams.get("iss");
    if (issuer !== null && issuer !== publicUrl) {
      throw new CliExit(
        EXIT.refused,
        `That approval was issued by ${issuer}, not ${publicUrl}. Nothing was exchanged.`
      );
    }
    code = url.searchParams.get("code") ?? "";
  } finally {
    waiting.stop();
  }
  const pending: Connection = { publicUrl, grant: "", token: "" };
  let response: Response;
  try {
    response = await io.fetch(`${publicUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: waiting.redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: publicUrl
      }).toString()
    });
  } catch (error) {
    throw unreachable(pending, error);
  }
  if (!response.ok) {
    const failure = await httpFailure(pending, response);
    // The token endpoint's 401 is about the client, not a token: it is not exit 3.
    throw new CliExit(EXIT.unreachable, failure.message);
  }
  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string") {
    throw new CliExit(EXIT.unreachable, `${publicUrl} issued no access token.`);
  }
  const connection: Connection = { publicUrl, grant: "", token: body.access_token };
  try {
    const listed = await rpc(io, connection, "resources/list", {});
    const resources = Array.isArray(listed.resources) ? (listed.resources as unknown[]) : [];
    const mailbox = resources
      .map((resource) => (resource as { uri?: unknown }).uri)
      .find((uri): uri is string => typeof uri === "string" && uri.startsWith("duoduo://mailbox/"));
    if (mailbox === undefined) throw new Error("the host listed no mailbox for this token");
    connection.grant = mailbox.slice("duoduo://mailbox/".length);
  } catch (error) {
    throw await abandon(
      io,
      connection,
      `The token was issued, but its connection could not be read (${error instanceof Error ? error.message : String(error)}).`
    );
  }
  let file: string;
  try {
    file = await saveConnection(io.env, connection);
  } catch (error) {
    throw await abandon(
      io,
      connection,
      `The token was issued, but the token file could not be written (${error instanceof Error ? error.message : String(error)}).`
    );
  }
  io.stdout(`Logged in to ${publicUrl}. The token is in ${file}.\n`);
  return EXIT.ok;
}

export async function logout(io: CliIo, host: string | undefined): Promise<number> {
  const { connection, file } = await loadConnection(io.env, host);
  let response: Response;
  try {
    response = await io.fetch(`${connection.publicUrl}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: connection.token,
        client_id: builtInClientId(connection.publicUrl)
      }).toString()
    });
  } catch (error) {
    throw new CliExit(
      EXIT.unreachable,
      `${unreachable(connection, error).message} The token was not revoked and ${file} is kept; run logout again.`
    );
  }
  if (!response.ok) {
    const failure = await httpFailure(connection, response);
    throw new CliExit(
      EXIT.unreachable,
      `${failure.message} The token was not revoked and ${file} is kept; run logout again.`
    );
  }
  await fs.rm(file, { force: true });
  io.stdout(
    `Logged out of ${connection.publicUrl}: the token is revoked and ${file} is deleted.\n`
  );
  return EXIT.ok;
}
