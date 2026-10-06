// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The host verbs, `duoduo channel tether list | revoke <name> | status |
 * passkey add | passkey list | passkey remove <id> | client add | client list |
 * client remove <name> | doorbell add | doorbell list | doorbell remove`.
 *
 * A verb runs as a short process (the plugin entry with the verb, started by
 * the daemon's verb passthrough), which talks to the running plugin over
 * `run/admin.sock` (0600 in a 0700 directory: same-uid only, never reachable
 * through whatever exposes the channel). The plugin process is the only writer of
 * its state, so the verb process never touches `state/`.
 */

import crypto from "node:crypto";
import http from "node:http";
import { promises as fs } from "node:fs";
import { isRecord } from "@openduo/protocol";
import { handleClientVerb, hostedNameOf } from "./clients";
import { listenAddress, parseTetherConfig, type TetherConfig } from "./config";
import { DaemonUnreachableError, type DaemonCall, type DaemonReply } from "./forward";
import { webhookKey, type Mailroom } from "./mail";
import type { Doorbell, Store } from "./store";
import {
  CLIENT_HELP,
  DOORBELL_HELP,
  renderDoorbellAdded,
  renderDoorbells,
  renderDoorbellSecret,
  renderDoorbellSecretInArgv,
  renderDoorbellUrl,
  PASSKEY_HELP,
  PASSKEY_REMOVE_LAST_GRANTS_TEXT,
  PASSKEY_REMOVE_LAST_SESSION_TEXT,
  renderEnrollLink,
  renderList,
  renderNoPublicUrl,
  renderPasskeyAddInSession,
  renderPasskeys,
  renderRevoked,
  renderUnvoided,
  renderStatus,
  renderTodayCounts,
  REVOKE_HELP
} from "./texts";

export type VerbOutput = { exitCode: number; stdout: string; stderr: string };

const EXIT_DONE = 0;
const EXIT_OTHER = 1;
const EXIT_RETYPE = 2;

const done = (stdout: string): VerbOutput => ({ exitCode: EXIT_DONE, stdout, stderr: "" });
const failed = (stderr: string, exitCode = EXIT_OTHER): VerbOutput => ({
  exitCode,
  stdout: "",
  stderr: stderr.endsWith("\n") ? stderr : `${stderr}\n`
});

/** First 16 hex of sha256: a 64-bit prefix names a passkey in `list` and `remove`. */
const FINGERPRINT_HEX = 16;

export function passkeyFingerprint(id: string): string {
  return crypto.createHash("sha256").update(id).digest("hex").slice(0, FINGERPRINT_HEX);
}

function hostOf(clientId: string): string | null {
  try {
    return new URL(clientId).host;
  } catch {
    return null;
  }
}

/** `authenticate` refuses every call of a grant bound to another resource. */
function isRefused(resource: string, publicUrl: string | null): boolean {
  return publicUrl !== null && resource !== publicUrl;
}

export type AdminDeps = {
  store: Store;
  config: TetherConfig;
  daemon: DaemonCall;
  mail: Mailroom;
};

// --- the verbs, inside the plugin process ------------------------------------------------

export async function runList(store: Store, publicUrl: string | null): Promise<VerbOutput> {
  const grants = await store.readGrants();
  return done(
    renderList(
      Object.values(grants)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((grant) => ({
          name: grant.name,
          clientName: grant.client_name,
          hosted: publicUrl !== null && hostedNameOf(grant.client_id, publicUrl) !== null,
          clientId: grant.client_id,
          grantId: grant.grant_id,
          scopes: grant.scopes,
          approvedAt: grant.approved_at,
          lastUsed: store.lastUsedOf(grant.grant_id)?.toISOString() ?? null,
          refusedResource: isRefused(grant.resource, publicUrl) ? grant.resource : null
        }))
    )
  );
}

/**
 * By assistant name: deletes its grant and every approval bound to the name,
 * then bounces the grant's rung but unread mail in the same turn of the mutex.
 */
export async function runRevoke(deps: AdminDeps, name: string): Promise<VerbOutput> {
  return deps.store.serialize(async () => {
    const grants = await deps.store.readGrants();
    const entry = Object.entries(grants).find(([, grant]) => grant.name === name);
    if (entry !== undefined) {
      delete grants[entry[0]];
      await deps.store.writeGrants(grants);
    }
    const codes = deps.store.dropCodesNamed(name);
    if (entry === undefined && codes === 0) {
      return failed(
        `${name} is no connected assistant this duoduo knows. Nothing was changed. duoduo channel` +
          ` tether list shows the connected assistants.`,
        EXIT_RETYPE
      );
    }
    const unvoided = entry === undefined ? 0 : await deps.mail.revoked(entry[1]);
    return done(
      `${renderRevoked(name, entry?.[1].client_id ?? null, codes)}` +
        `${unvoided > 0 ? ` ${renderUnvoided(name)}` : ""}\n`
    );
  });
}

/**
 * `Today` is one `spine.cat` over the socket, grouped by name (the first
 * segment of the session key) and client host (payload.client).
 */
export async function runStatus(deps: AdminDeps, now: Date = new Date()): Promise<VerbOutput> {
  let reply: DaemonReply;
  try {
    reply = await deps.daemon("spine.cat", {
      date: now.toISOString().slice(0, 10),
      // An assistant's records: `external.record` now, the legacy
      // `body.experience` type in older days.
      types: ["external.record", "body.experience"],
      json: true
    });
  } catch (error) {
    if (!(error instanceof DaemonUnreachableError)) throw error;
    reply = { error: { code: -1, message: "duoduo did not answer" } };
  }
  let today: string;
  const result = reply.result as { text?: unknown; ok?: unknown; message?: unknown } | undefined;
  if (reply.error) {
    today = `unavailable (${reply.error.message})`;
  } else if (isRecord(result) && result.ok === false) {
    today = `unavailable (${String(result.message)})`;
  } else {
    const counts = new Map<
      string,
      { name: string; client: string; records: number; bytes: number }
    >();
    const text = isRecord(result) && typeof result.text === "string" ? result.text : "";
    for (const row of text.split("\n")) {
      if (row === "") continue;
      let parsed: { session_key?: unknown; client?: { id?: unknown } };
      try {
        parsed = JSON.parse(row) as typeof parsed;
      } catch {
        continue;
      }
      const name = typeof parsed.session_key === "string" ? parsed.session_key.split(":")[0] : "";
      const clientId = typeof parsed.client?.id === "string" ? parsed.client.id : null;
      // A parsed host carries no control characters; a raw client_id may.
      const client =
        clientId === null ? "on the host" : (hostOf(clientId) ?? JSON.stringify(clientId));
      // Counted per full client_id; two clients on one host stay two rows.
      const key = `${name}\u0000${clientId ?? ""}`;
      const count = counts.get(key) ?? { name, client, records: 0, bytes: 0 };
      count.records += 1;
      count.bytes += Buffer.byteLength(row);
      counts.set(key, count);
    }
    today = renderTodayCounts([...counts.values()]);
  }
  const grants = Object.values(await deps.store.readGrants());
  const refused = grants.filter((grant) => isRefused(grant.resource, deps.config.publicUrl)).length;
  return done(
    renderStatus({
      publicUrl: deps.config.publicUrl,
      address: listenAddress(deps.config.host, deps.config.port),
      passkeys: (await deps.store.readPasskeys()).length,
      grants: grants.length - refused,
      refusedGrants: refused,
      today
    })
  );
}

/**
 * Inside a session the link lands in the spine. That is safe only while no
 * grant exists, because a grant's token can read the spine, so the check and
 * the issue share one turn of the mutex.
 */
export async function runPasskeyAdd(deps: AdminDeps, inSession: boolean): Promise<VerbOutput> {
  if (deps.config.publicUrl === null) return failed(renderNoPublicUrl("passkey add"));
  type Issued = { refused: true; grants: number } | { refused: false; secret: string };
  const issued = await deps.store.serialize(async (): Promise<Issued> => {
    if (inSession) {
      const grants = Object.keys(await deps.store.readGrants()).length;
      if (grants > 0) return { refused: true, grants };
    }
    return { refused: false, secret: await deps.store.issueEnrollLink(inSession) };
  });
  if (issued.refused) return failed(renderPasskeyAddInSession(issued.grants), EXIT_RETYPE);
  return done(renderEnrollLink(`${deps.config.publicUrl}/enroll#${issued.secret}`, inSession));
}

export async function runPasskeyList(store: Store): Promise<VerbOutput> {
  const passkeys = await store.readPasskeys();
  return done(
    renderPasskeys(
      passkeys.map((passkey) => ({
        fingerprint: passkeyFingerprint(passkey.id),
        label: passkey.label,
        createdAt: passkey.created_at
      }))
    )
  );
}

/**
 * Without a passkey the next enrollment needs only the link, so the last one
 * goes only from outside a session (the flag is advisory) and, while a grant
 * exists, not at all: a connected assistant could race the link.
 */
export async function runPasskeyRemove(
  store: Store,
  id: string,
  inSession: boolean
): Promise<VerbOutput> {
  return store.serialize(async () => {
    const passkeys = await store.readPasskeys();
    const kept = passkeys.filter(
      (passkey) => passkey.id !== id && passkeyFingerprint(passkey.id) !== id
    );
    if (kept.length === passkeys.length) {
      return failed(
        `No passkey has id ${id}. Nothing was changed. duoduo channel tether passkey list shows them.`,
        EXIT_RETYPE
      );
    }
    if (kept.length === 0 && Object.keys(await store.readGrants()).length > 0) {
      return failed(PASSKEY_REMOVE_LAST_GRANTS_TEXT, EXIT_RETYPE);
    }
    if (kept.length === 0 && inSession)
      return failed(PASSKEY_REMOVE_LAST_SESSION_TEXT, EXIT_RETYPE);
    await store.writePasskeys(kept);
    return done(
      `Removed passkey ${id}. Connections it approved stay connected; revoke them with` +
        ` duoduo channel tether revoke <name>.\n`
    );
  });
}

// --- doorbells ---------------------------------------------------------------------------

/** https anywhere; plain http only to this machine. */
function isDoorbellUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.protocol === "https:") return true;
  return (
    parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
  );
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

/**
 * `doorbell add <name> --url <url> --auth hmac|bearer`, the secret from the
 * verb process (stdin or --secret-file), never argv. One doorbell per URL:
 * adding the same URL again replaces it.
 */
export async function runDoorbellAdd(
  deps: AdminDeps,
  args: readonly string[],
  secret: string | undefined
): Promise<VerbOutput> {
  const [name] = args;
  const url = flagValue(args, "--url");
  const auth = flagValue(args, "--auth");
  if (!name || name.startsWith("--") || url === undefined || auth === undefined) {
    return failed(DOORBELL_HELP, EXIT_RETYPE);
  }
  if (!isDoorbellUrl(url)) return failed(renderDoorbellUrl(url), EXIT_RETYPE);
  if (auth !== "hmac" && auth !== "bearer") return failed(DOORBELL_HELP, EXIT_RETYPE);
  const key = secret?.trim() ?? "";
  // A space or control character could split the Authorization header it is sent in.
  const unsendable =
    /\s/.test(key) || [...key].some((char) => char.charCodeAt(0) < 0x20 || char === "\u007f");
  if (key === "" || unsendable || (auth === "hmac" && webhookKey(key) === null)) {
    return failed(renderDoorbellSecret(auth), EXIT_RETYPE);
  }
  return deps.store.serialize(async () => {
    const grants = await deps.store.readGrants();
    const grant = Object.values(grants).find((candidate) => candidate.name === name);
    if (grant === undefined) {
      return failed(
        `${name} is no connected assistant this duoduo knows. Nothing was added. duoduo channel` +
          ` tether list shows the connected assistants.`,
        EXIT_RETYPE
      );
    }
    const doorbell: Doorbell = {
      url,
      auth,
      secret: key,
      added_at: deps.store.clock().toISOString()
    };
    grant.doorbells = [
      ...(grant.doorbells ?? []).filter((existing) => existing.url !== url),
      doorbell
    ];
    await deps.store.writeGrants(grants);
    return done(renderDoorbellAdded(name, url, auth));
  });
}

export async function runDoorbellList(store: Store): Promise<VerbOutput> {
  const grants = Object.values(await store.readGrants()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  return done(
    renderDoorbells(
      grants.flatMap((grant) =>
        (grant.doorbells ?? []).map((doorbell) => ({
          name: grant.name,
          url: doorbell.url,
          auth: doorbell.auth,
          addedAt: doorbell.added_at
        }))
      ),
      // The assistant chose these URLs; only the host is shown, as in the logs.
      grants.flatMap((grant) =>
        (grant.subscriptions ?? []).map((subscription) => ({
          name: grant.name,
          id: subscription.id,
          host: new URL(subscription.url).host,
          refreshBefore: subscription.refresh_before
        }))
      )
    )
  );
}

export async function runDoorbellRemove(
  store: Store,
  name: string,
  url: string
): Promise<VerbOutput> {
  return store.serialize(async () => {
    const grants = await store.readGrants();
    const grant = Object.values(grants).find((candidate) => candidate.name === name);
    const kept = (grant?.doorbells ?? []).filter((doorbell) => doorbell.url !== url);
    if (grant === undefined || kept.length === (grant.doorbells ?? []).length) {
      return failed(
        `${name} has no doorbell at ${url}. Nothing was changed. duoduo channel tether doorbell` +
          ` list shows them.`,
        EXIT_RETYPE
      );
    }
    grant.doorbells = kept;
    await store.writeGrants(grants);
    return done(`Removed ${name}'s doorbell at ${url}; it rings no more.\n`);
  });
}

export async function handleAdmin(deps: AdminDeps, request: AdminRequest): Promise<VerbOutput> {
  const [first, second] = request.args;
  switch (request.verb) {
    case "list":
      return runList(deps.store, deps.config.publicUrl);
    case "status":
      return runStatus(deps);
    case "revoke":
      return first ? runRevoke(deps, first) : failed(REVOKE_HELP, EXIT_RETYPE);
    case "passkey":
      if (first === "add") return runPasskeyAdd(deps, request.in_session === true);
      if (first === "list") return runPasskeyList(deps.store);
      if (first === "remove" && second) {
        return runPasskeyRemove(deps.store, second, request.in_session === true);
      }
      return failed(PASSKEY_HELP, EXIT_RETYPE);
    case "client":
      // In a session too: a hosted document approves nothing without the passkey.
      return handleClientVerb(deps.store, deps.config.publicUrl, request.args);
    case "doorbell":
      if (first === "add") return runDoorbellAdd(deps, request.args.slice(1), request.secret);
      if (first === "list") return runDoorbellList(deps.store);
      if (first === "remove" && second && request.args[2]) {
        return runDoorbellRemove(deps.store, second, request.args[2]);
      }
      return failed(DOORBELL_HELP, EXIT_RETYPE);
    default:
      return failed(`unknown admin verb ${request.verb}`, EXIT_RETYPE);
  }
}

// --- the admin socket -------------------------------------------------------------------------

/**
 * `in_session`: the verb process runs inside a duoduo session (by process ancestry).
 * `secret`: a doorbell secret the verb process read from stdin or a file; it
 * crosses only this same-uid socket, never argv.
 */
export type AdminRequest = { verb: string; args: string[]; in_session?: boolean; secret?: string };

export async function listenAdmin(
  socketPath: string,
  handle: (request: AdminRequest) => Promise<VerbOutput>
): Promise<http.Server> {
  await fs.rm(socketPath, { force: true });
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        let output: VerbOutput;
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          if (!isRecord(parsed) || typeof parsed.verb !== "string") throw new Error("bad request");
          const args = Array.isArray(parsed.args)
            ? parsed.args.filter((arg): arg is string => typeof arg === "string")
            : [];
          output = await handle({
            verb: parsed.verb,
            args,
            in_session: parsed.in_session === true,
            ...(typeof parsed.secret === "string" ? { secret: parsed.secret } : {})
          });
        } catch (error) {
          output = failed(`tether channel admin request failed: ${String(error)}`);
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(output));
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  await fs.chmod(socketPath, 0o600);
  return server;
}

/** null when no plugin answers on the socket: it is not running. */
export function callAdmin(socketPath: string, request: AdminRequest): Promise<VerbOutput | null> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(request);
    const call = http.request(
      {
        socketPath,
        path: "/admin",
        method: "POST",
        headers: { "content-type": "application/json" }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as VerbOutput);
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    call.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(null);
      else reject(error);
    });
    call.end(body);
  });
}

// --- the verb process ------------------------------------------------------------------------

const NOT_RUNNING =
  "The tether channel is not running, so it cannot answer. Nothing was done. Start it: duoduo" +
  " channel tether start.";

const USAGE = `Usage: duoduo channel tether list
       duoduo channel tether revoke <name>
       duoduo channel tether status
       duoduo channel tether passkey add | list | remove <id>
       duoduo channel tether client add <name> --redirect <uri> | list | remove <name>
       duoduo channel tether doorbell add <name> --url <url> --auth hmac|bearer [--secret-file <path>]
       duoduo channel tether doorbell list | remove <name> <url>
`;

/**
 * One host verb, from the verb process. Whether it runs inside a duoduo session
 * travels with the request; the plugin decides `passkey add` against the grant
 * store.
 */
export type SecretSource = {
  /** null when stdin is a terminal: nothing was piped in. */
  stdin: () => Promise<string | null>;
  file: (path: string) => Promise<string>;
};

const processSecret: SecretSource = {
  stdin: async () => {
    if (process.stdin.isTTY) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString("utf8");
  },
  file: (file) => fs.readFile(file, "utf8")
};

/** The secret never comes from argv: `--secret` is refused by name. */
async function readDoorbellSecret(
  args: readonly string[],
  source: SecretSource
): Promise<{ ok: true; args: string[]; secret: string } | { ok: false; text: string }> {
  if (args.some((arg) => arg === "--secret" || arg.startsWith("--secret="))) {
    return { ok: false, text: renderDoorbellSecretInArgv() };
  }
  const at = args.indexOf("--secret-file");
  const rest = at === -1 ? [...args] : [...args.slice(0, at), ...args.slice(at + 2)];
  let secret: string | null;
  try {
    secret = at === -1 ? await source.stdin() : await source.file(args[at + 1] ?? "");
  } catch (error) {
    return {
      ok: false,
      text: `The secret file could not be read (${String(error)}). Nothing was added.`
    };
  }
  if (secret === null) return { ok: false, text: renderDoorbellSecretInArgv() };
  return { ok: true, args: rest, secret };
}

export async function runVerbProcess(
  verb: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  socketPath: string,
  readSecret: SecretSource = processSecret
): Promise<VerbOutput> {
  const help = args.some((arg) => arg === "--help" || arg === "-h" || arg === "help");
  if (help) {
    const helps = new Map([
      ["revoke", REVOKE_HELP],
      ["passkey", PASSKEY_HELP],
      ["client", CLIENT_HELP],
      ["doorbell", DOORBELL_HELP]
    ]);
    return done(helps.get(verb) ?? USAGE);
  }
  if (!["list", "status", "revoke", "passkey", "client", "doorbell"].includes(verb)) {
    return failed(USAGE, EXIT_RETYPE);
  }
  let request: AdminRequest = { verb, args, in_session: env.ALADUO_CALLER_IN_SESSION === "1" };
  if (verb === "doorbell" && args[0] === "add") {
    const read = await readDoorbellSecret(args, readSecret);
    if (!read.ok) return failed(read.text, EXIT_RETYPE);
    request = { ...request, args: read.args, secret: read.secret };
  }
  const answer = await callAdmin(socketPath, request);
  if (answer !== null) return answer;
  // A configuration the plugin refuses is why it is not running; say which.
  const configured = parseTetherConfig(env);
  return failed(configured.ok ? NOT_RUNNING : `${configured.reason}. ${NOT_RUNNING}`);
}
