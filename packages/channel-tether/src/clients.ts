// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Client documents hosted by this duoduo, for a client with no document of its
 * own whose OAuth callback
 * is on the owner's device. Nothing is served for them: `/authorize` reads
 * `clients.json` locally and never fetches a `client_id` under `/clients/`.
 */

import { SOURCE_NAME_PATTERN } from "@openduo/protocol";
import type { VerbOutput } from "./admin";
import { BUILT_IN_CLIENT_NAME } from "./client-contract";
import type { HostedClient, HostedClients, Store } from "./store";
import {
  CLIENT_HELP,
  renderClientAdded,
  renderClientExists,
  renderClientName,
  renderClientReserved,
  renderClientRemoved,
  renderClients,
  renderNoPublicUrl,
  renderNotLoopback,
  renderShadowedClient,
  renderUnknownClient
} from "./texts";

const EXIT_OTHER = 1;
const EXIT_RETYPE = 2;

const done = (stdout: string): VerbOutput => ({ exitCode: 0, stdout, stderr: "" });
const refused = (stderr: string, exitCode = EXIT_RETYPE): VerbOutput => ({
  exitCode,
  stdout: "",
  stderr: stderr.endsWith("\n") ? stderr : `${stderr}\n`
});

const CLIENTS_PATH = "/clients/";

export function hostedClientId(publicUrl: string, name: string): string {
  return `${publicUrl}${CLIENTS_PATH}${name}`;
}

/**
 * null when `clientId` is not under this duoduo's `/clients/`: an external
 * document. Otherwise the name it names, or "" for any other spelling
 * under the prefix (a case variant, a further segment, a query): an unknown
 * hosted document, never fetched.
 */
export function hostedNameOf(clientId: string, publicUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(clientId);
  } catch {
    return null;
  }
  if (parsed.origin !== publicUrl || !parsed.pathname.startsWith(CLIENTS_PATH)) return null;
  const prefix = hostedClientId(publicUrl, "");
  return clientId.startsWith(prefix) ? clientId.slice(prefix.length) : "";
}

/** The stored document of `name`; an own key only, so `constructor` names nothing. */
export function hostedClientOf(clients: HostedClients, name: string): HostedClient | null {
  return Object.hasOwn(clients, name) ? (clients[name] ?? null) : null;
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/**
 * http to 127.0.0.1, localhost or [::1], any port and path. A URI holds
 * no whitespace or control character, and the URL parser strips tabs and
 * newlines silently, so a string with one would match something else.
 */
export function isLoopbackRedirect(uri: string): boolean {
  const control = [...uri].some((char) => char.charCodeAt(0) < 0x20 || char === "\u007f");
  if (control || /\s/.test(uri)) return false;
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "http:" && LOOPBACK_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Whether a client document listing `listed` accepts `requested`. RFC 8252
 * section 7.3: a loopback redirect may use any port, since a native app binds
 * whatever port is free at login; so for http on a loopback host the port is
 * ignored on both sides and everything else must match. Hosts compare
 * literally: localhost is not 127.0.0.1. Any other address matches exactly.
 */
export function redirectListed(listed: readonly string[], requested: string): boolean {
  if (listed.includes(requested)) return true;
  if (!isLoopbackRedirect(requested)) return false;
  const portless = (uri: string): string => {
    const parsed = new URL(uri);
    parsed.port = "";
    return parsed.href;
  };
  const wanted = portless(requested);
  return listed.some((uri) => isLoopbackRedirect(uri) && portless(uri) === wanted);
}

/** The start-up warning when clients.json holds a document under the built-in client's name. */
export function shadowedClientWarning(clients: HostedClients): string | null {
  return hostedClientOf(clients, BUILT_IN_CLIENT_NAME) === null
    ? null
    : renderShadowedClient(BUILT_IN_CLIENT_NAME);
}

function parseAdd(args: string[]): { name: string; redirects: string[] } | null {
  const [name, ...rest] = args;
  if (name === undefined || name.startsWith("--")) return null;
  const redirects: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === "--redirect") {
      const value = rest[index + 1];
      if (value === undefined) return null;
      redirects.push(value);
      index += 1;
    } else if (arg.startsWith("--redirect=")) {
      redirects.push(arg.slice("--redirect=".length));
    } else {
      return null;
    }
  }
  return redirects.length === 0 ? null : { name, redirects: [...new Set(redirects)] };
}

export async function runClientAdd(
  store: Store,
  publicUrl: string,
  args: string[]
): Promise<VerbOutput> {
  const parsed = parseAdd(args);
  if (parsed === null) return refused(CLIENT_HELP);
  if (!SOURCE_NAME_PATTERN.test(parsed.name)) return refused(renderClientName(parsed.name));
  if (parsed.name === BUILT_IN_CLIENT_NAME) return refused(renderClientReserved(parsed.name));
  const outside = parsed.redirects.find((uri) => !isLoopbackRedirect(uri));
  if (outside !== undefined) return refused(renderNotLoopback(outside));
  const clientId = hostedClientId(publicUrl, parsed.name);
  return store.serialize(async () => {
    const clients = await store.readClients();
    if (hostedClientOf(clients, parsed.name) !== null) {
      return refused(renderClientExists(parsed.name, clientId));
    }
    clients[parsed.name] = {
      name: parsed.name,
      redirect_uris: parsed.redirects,
      created_at: store.clock().toISOString()
    };
    await store.writeClients(clients);
    return done(renderClientAdded(clientId, publicUrl, parsed.redirects));
  });
}

function assistantsUsing(
  grants: Awaited<ReturnType<Store["readGrants"]>>,
  clientId: string
): number {
  return Object.values(grants).filter((grant) => grant.client_id === clientId).length;
}

export async function runClientList(store: Store, publicUrl: string): Promise<VerbOutput> {
  const clients = await store.readClients();
  const grants = await store.readGrants();
  return done(
    renderClients(
      Object.values(clients)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((client) => {
          const clientId = hostedClientId(publicUrl, client.name);
          return {
            name: client.name,
            clientId,
            redirects: client.redirect_uris,
            assistants: assistantsUsing(grants, clientId),
            createdAt: client.created_at
          };
        })
    )
  );
}

/** Blocks new authorizations only; assistants connected through it stay connected. */
export async function runClientRemove(
  store: Store,
  publicUrl: string,
  name: string
): Promise<VerbOutput> {
  return store.serialize(async () => {
    const clients = await store.readClients();
    if (hostedClientOf(clients, name) === null) return refused(renderUnknownClient(name));
    delete clients[name];
    await store.writeClients(clients);
    const clientId = hostedClientId(publicUrl, name);
    return done(renderClientRemoved(name, assistantsUsing(await store.readGrants(), clientId)));
  });
}

export async function handleClientVerb(
  store: Store,
  publicUrl: string | null,
  args: string[]
): Promise<VerbOutput> {
  const [sub, ...rest] = args;
  if (sub !== "add" && sub !== "list" && sub !== "remove") return refused(CLIENT_HELP);
  if (publicUrl === null) return refused(renderNoPublicUrl(`client ${sub}`), EXIT_OTHER);
  if (sub === "add") return runClientAdd(store, publicUrl, rest);
  if (sub === "list") return runClientList(store, publicUrl);
  return rest[0] ? runClientRemove(store, publicUrl, rest[0]) : refused(CLIENT_HELP);
}
