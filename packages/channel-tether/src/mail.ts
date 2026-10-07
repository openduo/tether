// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Mail in the plugin. Each assistant is a session that runs no model,
 * `tether:<name>`: what reaches it is an outbox record, and its unread mail is
 * exactly that session's unacknowledged outbox.
 * The plugin holds one `channel.pull` WebSocket per assistant, opened with
 * `advance: "ack"`, rings the grant on each pushed record, and
 * acknowledges only when ReadMail returns the mail, or when it bounces mail a
 * grant will never read. It keeps no unread store and no cursor of its own.
 *
 * Every decision about a record, every acknowledgement and every revoke or
 * replace runs inside the store's mutex, so a mail is bounced by exactly one
 * path; a bounce carries an idempotency key, so a replayed push never bounces
 * twice.
 */

import crypto from "node:crypto";
import net from "node:net";
import { isRecord } from "@openduo/protocol";
import type { ServerEventBus } from "@modelcontextprotocol/server";
import WebSocket from "ws";
import type { FetchLike } from "./cimd";
import { DaemonUnreachableError, type DaemonCall } from "./forward";
import { postCallback, type CallbackLimits, type CallbackPost } from "./callback";
import type { Doorbell, Grant, Logger, Store, Subscription } from "./store";
import { renderBounce, renderJobBounce } from "./texts";
import { mailboxUri } from "./client-contract";

/** The one consumer of every assistant session's outbox. */
export const TETHER_CONSUMER_ID = "tether-plugin";

/** Mail from a bounce: not an address, so nothing answers or bounces it. */
export const DUODUO_SENDER = "duoduo";

export const TETHER_ADDRESS_PREFIX = "tether:";

/** An assistant's session: one per name, kept across grant replacement. */
export function tetherSessionKey(name: string): string {
  return `${TETHER_ADDRESS_PREFIX}${name}`;
}

export function tetherChannelId(name: string): string {
  return `tether-${name}`;
}

/** The grant's mailbox resource, the URI a listen stream subscribes to. */
export { mailboxUri };

/** The one event an assistant can subscribe to. */
export const MAILBOX_EVENT = "mailbox.new";

/** An outbox record of an assistant session, as `channel.pull` returns it. */
export type MailRecord = {
  id: string;
  created_at: string;
  payload: { text?: string; data?: Record<string, unknown> };
};

/** One mail as ReadMail shows it. */
export type Mail = { id: string; ts: string; from: string; in_reply_to?: string; text: string };

function dataOf(record: MailRecord): Record<string, unknown> {
  return isRecord(record.payload?.data) ? record.payload.data : {};
}

function dataString(record: MailRecord, key: string): string | undefined {
  const value = dataOf(record)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Who sent it: a `session.notify` caller's source label (`tether:<name>`,
 * `duoduo` for a bounce, or a script's label), else the session the route
 * came from (a Notify, a job, a wake).
 */
export function senderOf(record: MailRecord): string {
  return (
    dataString(record, "notify_source_label") ??
    dataString(record, "source_session_key") ??
    DUODUO_SENDER
  );
}

/** Where an answer or a bounce goes: a session, or an assistant; a script's label has no address. */
export function replyTargetOf(record: MailRecord): string | undefined {
  const label = dataString(record, "notify_source_label");
  if (label === undefined) return dataString(record, "source_session_key");
  return label.startsWith(TETHER_ADDRESS_PREFIX) ? label : undefined;
}

/** The record's own fields, not the route's. */
const RECORD_FIELDS = new Set(["event_id", "event_ts", "source_session_key"]);

/**
 * What the mail says: its text, else every plain field of the route that
 * carried it (a job's result, a wake's context), one `name: value` per line.
 */
export function textOf(record: MailRecord): string {
  const text = record.payload?.text;
  if (typeof text === "string" && text !== "") return text;
  return Object.entries(dataOf(record))
    .filter(([key, value]) => !RECORD_FIELDS.has(key) && isPlain(value))
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
}

function isPlain(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function mailOf(record: MailRecord): Mail {
  const inReplyTo = dataString(record, "notify_in_reply_to");
  return {
    id: mailIdOf(record),
    ts: mailTs(record),
    from: senderOf(record),
    ...(inReplyTo !== undefined ? { in_reply_to: inReplyTo } : {}),
    text: textOf(record)
  };
}

/**
 * The id an assistant sees for a mail in its session: the event it arrived as, and
 * that event's UTC day, which is what reading it back by id needs.
 */
export function mailIdOf(record: MailRecord): string {
  const eventId = dataString(record, "event_id") ?? record.id;
  const day = mailTs(record).slice(0, 10);
  return `${eventId}@${day}`;
}

/** An event id alone, as ReadEvents shows it: a mail id without its `@<day>`. */
export function isBareEventId(id: string): boolean {
  return /^evt_[^@\s]+$/.test(id);
}

/** A mail id `mailIdOf` made, split; null for any other text. */
export function parseMailId(id: string): { eventId: string; day: string } | null {
  const match = /^(evt_[^@\s]+)@(\d{4}-\d{2}-\d{2})$/.exec(id);
  return match === null ? null : { eventId: match[1], day: match[2] };
}

/**
 * When the mail arrived: its event's time, which reading it back by id sees
 * too; the record is written a moment later.
 */
export function mailTs(record: MailRecord): string {
  return dataString(record, "event_ts") ?? record.created_at;
}

/** Mail that arrived before the grant's approval belongs to the grant it replaced. */
export function ownedBy(grant: Grant, record: MailRecord): boolean {
  return Date.parse(mailTs(record)) > Date.parse(grant.approved_at);
}

export function isJobSender(from: string): boolean {
  return from.startsWith("job:");
}

/**
 * Mail ReadMail returns to this grant; anything else is bounced. The mailbox
 * resource lists by the same test, so listen never reports mail ReadMail would not show.
 */
export function readableBy(grant: Grant, record: MailRecord): boolean {
  return !isJobSender(senderOf(record)) && ownedBy(grant, record);
}

/**
 * An assistant's mail to a session carries an id the plugin mints, for the session to answer.
 * 16 hex digits are 64 bits of the hash: no two mails collide in practice.
 */
export function mintMailId(grantId: string, idempotencyKey: string | undefined): string {
  const seed =
    idempotencyKey === undefined ? crypto.randomUUID() : JSON.stringify([grantId, idempotencyKey]);
  return `mail_${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

// --- the pull streams ------------------------------------------------------------------

export type PullStream = { close(): void };
export type OpenPull = (
  sessionKey: string,
  handlers: { onRecord: (record: MailRecord) => void; onClose: () => void }
) => PullStream;

/** One `channel.pull` WebSocket over the daemon's unix socket, moving no cursor on push. */
export function socketPull(socketPath: string): OpenPull {
  return (sessionKey, handlers) => {
    const ws = new WebSocket("ws://localhost/ws", {
      createConnection: () => net.connect({ path: socketPath })
    });
    let closedByUs = false;
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "pull",
          method: "channel.pull",
          params: { session_key: sessionKey, consumer_id: TETHER_CONSUMER_ID, advance: "ack" }
        })
      );
    });
    ws.on("message", (data: WebSocket.RawData) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!isRecord(message) || message.method !== "session.output") return;
      const params = message.params;
      if (isRecord(params) && isRecord(params.record)) {
        handlers.onRecord(params.record as unknown as MailRecord);
      }
    });
    // An error is always followed by close; close alone decides the reconnect.
    ws.on("error", () => undefined);
    ws.on("close", () => {
      if (!closedByUs) handlers.onClose();
    });
    return {
      close: () => {
        closedByUs = true;
        ws.close();
      }
    };
  };
}

// --- rings -------------------------------------------------------------------------------

/** Standard Webhooks: `whsec_` and base64, or bare base64. Null when it is neither. */
export function webhookKey(secret: string): Buffer | null {
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const key = Buffer.from(encoded, "base64");
  return key.length > 0 ? key : null;
}

/**
 * One ring: content-free. HMAC mode signs per Standard Webhooks
 * (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>` over
 * `id.timestamp.body`); bearer mode sends the secret as the bearer token.
 * A redirect is an error: the signature or token must reach only the URL the
 * owner registered.
 */
export function ringRequest(
  doorbell: Doorbell,
  mailId: string,
  now: Date
): {
  url: string;
  init: { method: "POST"; redirect: "error"; headers: Record<string, string>; body: string };
} {
  const body = JSON.stringify({ type: "mailbox.new", timestamp: now.toISOString(), data: {} });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (doorbell.auth === "bearer") {
    headers.authorization = `Bearer ${doorbell.secret}`;
  } else {
    Object.assign(headers, signedHeaders(doorbell.secret, mailId, now, body));
  }
  return { url: doorbell.url, init: { method: "POST", redirect: "error", headers, body } };
}

/** Standard Webhooks headers: `v1,<base64 HMAC-SHA256>` over `id.timestamp.body`. */
export function signedHeaders(
  secret: string,
  id: string,
  now: Date,
  body: string
): Record<string, string> {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const key = webhookKey(secret) ?? Buffer.alloc(0);
  const signature = crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`
  };
}

/**
 * One MCP Events delivery: the event id is the mail id, the payload is
 * empty and nothing is replayable, so `cursor` is null.
 */
export function deliveryRequest(
  subscription: Subscription,
  mailId: string,
  now: Date
): { headers: Record<string, string>; body: string } {
  const body = JSON.stringify({
    eventId: mailId,
    name: MAILBOX_EVENT,
    timestamp: now.toISOString(),
    data: {},
    cursor: null
  });
  return {
    headers: {
      "content-type": "application/json",
      ...signedHeaders(subscription.secret, mailId, now, body),
      "x-mcp-subscription-id": subscription.id
    },
    body
  };
}

// --- the mailroom --------------------------------------------------------------------------

export type MailroomDeps = {
  store: Store;
  daemon: DaemonCall;
  openPull: OpenPull;
  /** ALADUO_PULL_WAIT_MS: the pause before a dropped stream is opened again. */
  reconnectMs: number;
  /** `channel.spawn`'s cwd_abs. A void session runs nothing there; the plugin's own directory serves. */
  workspace: string;
  log: Logger;
  fetchImpl?: FetchLike;
  /** ALADUO_TETHER_CIMD_TIMEOUT_MS and _MAX_BYTES: a callback is a client-named URL like a CIMD one. */
  callbackLimits: CallbackLimits;
  postCallback?: CallbackPost;
  /** The bus the MCP endpoint's `subscriptions/listen` streams read. */
  bus: ServerEventBus;
};

type StreamEntry = { stream: PullStream | null; timer: NodeJS.Timeout | null };

export class Mailroom {
  private running = false;
  private readonly streams = new Map<string, StreamEntry>();
  /** Open listen requests per grant, ended when the grant ends. */
  private readonly listens = new Map<string, Set<AbortController>>();

  constructor(private readonly deps: MailroomDeps) {}

  /**
   * Every granted assistant gets its session and its stream, and every assistant's
   * session is settled against the grants file: a grant that ended while
   * duoduo did not answer is finished here.
   */
  async start(): Promise<void> {
    this.running = true;
    const grants = Object.values(await this.deps.store.readGrants());
    for (const grant of grants) await this.spawn(grant.name);
    await this.deps.store.serialize(async () => {
      await this.settleAll(Object.values(await this.deps.store.readGrants()));
    });
    this.reconcile(grants);
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const name of [...this.streams.keys()]) this.close(name);
  }

  private reconcile(grants: readonly Grant[]): void {
    const names = new Set(grants.map((grant) => grant.name));
    for (const name of [...this.streams.keys()]) if (!names.has(name)) this.close(name);
    for (const name of names) if (!this.streams.has(name)) this.open(name);
  }

  private open(name: string): void {
    if (!this.running) return;
    const entry: StreamEntry = this.streams.get(name) ?? { stream: null, timer: null };
    this.streams.set(name, entry);
    entry.stream = this.deps.openPull(tetherSessionKey(name), {
      onRecord: (record) => void this.received(name, record),
      onClose: () => this.reopenLater(name, entry)
    });
  }

  private reopenLater(name: string, entry: StreamEntry): void {
    if (!this.running || this.streams.get(name) !== entry) return;
    entry.stream = null;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.streams.get(name) === entry) this.open(name);
    }, this.deps.reconnectMs);
    entry.timer.unref?.();
  }

  private close(name: string): void {
    const entry = this.streams.get(name);
    if (entry === undefined) return;
    this.streams.delete(name);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.stream?.close();
  }

  private async received(name: string, record: MailRecord): Promise<void> {
    try {
      await this.deps.store.serialize(() => this.pushed(name, record));
    } catch (error) {
      this.deps.log.warn("[tether] could not handle a pushed mail", {
        tether: name,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * One pushed record, under the mutex: mail from a job is bounced, because jobs
   * and assistants never mail each other;
   * mail the current grant owns rings it. A replayed push rings again: the
   * mail is still unread.
   */
  private async pushed(name: string, record: MailRecord): Promise<void> {
    const grant = Object.values(await this.deps.store.readGrants()).find(
      (candidate) => candidate.name === name
    );
    if (grant === undefined) return;
    if (isJobSender(senderOf(record))) {
      await this.bounce(name, record);
      return;
    }
    if (ownedBy(grant, record)) this.ring(grant, mailIdOf(record));
  }

  /**
   * A grant was just committed (call inside the mutex): its session exists
   * before any assistant is told it can mail, and the session is settled against
   * it. Returns how many steps duoduo did not answer or refused.
   */
  async approved(grant: Grant): Promise<number> {
    const grants = await this.deps.store.readGrants();
    // A grant this approval replaced is gone from the file; its token no longer works.
    this.endListens((grantId) => !Object.hasOwn(grants, grantId));
    let failed = (await this.spawn(grant.name)) ? 0 : 1;
    failed += await this.settle(grant.name, grant);
    this.reconcile(Object.values(await this.deps.store.readGrants()));
    return failed;
  }

  /**
   * Holds an open listen request of `grantId` until the returned release runs;
   * the grant ending aborts `request`, which ends the stream.
   */
  holdListen(grantId: string, request: AbortController): () => void {
    const held = this.listens.get(grantId) ?? new Set<AbortController>();
    held.add(request);
    this.listens.set(grantId, held);
    return () => {
      held.delete(request);
      if (held.size === 0 && this.listens.get(grantId) === held) this.listens.delete(grantId);
    };
  }

  /** Ends the open listens of every grant `ended` picks. */
  private endListens(ended: (grantId: string) => boolean): void {
    for (const [grantId, held] of [...this.listens]) {
      if (!ended(grantId)) continue;
      this.listens.delete(grantId);
      for (const request of held) request.abort();
    }
  }

  /**
   * A grant was revoked and not replaced (call inside the mutex, after it left
   * the file): its session is settled with no grant. Returns how many steps
   * duoduo did not answer or refused; the next start finishes them.
   */
  async revoked(grant: Grant): Promise<number> {
    this.endListens((grantId) => grantId === grant.grant_id);
    this.close(grant.name);
    return this.settle(grant.name, undefined);
  }

  /**
   * Every assistant's session against the grants file (call inside the mutex): the
   * granted names and every `tether:` session duoduo lists.
   */
  private async settleAll(grants: readonly Grant[]): Promise<number> {
    const byName = new Map(grants.map((grant) => [grant.name, grant]));
    const names = new Set(byName.keys());
    const listed = await this.ask("session.list", { kind: "channel" });
    for (const row of Array.isArray(listed) ? listed : []) {
      const key = isRecord(row) ? row.session_key : undefined;
      if (typeof key === "string" && key.startsWith(TETHER_ADDRESS_PREFIX)) {
        names.add(key.slice(TETHER_ADDRESS_PREFIX.length));
      }
    }
    let failed = 0;
    for (const name of names) failed += await this.settle(name, byName.get(name));
    return failed;
  }

  /**
   * One assistant's session made to match the grants file, from facts alone — the
   * grant and the session's unacknowledged records — so a step duoduo did not
   * take is redone by the next settle. With a grant: unread mail from before
   * its approval is bounced and acknowledged. Without: all unread mail is,
   * then the session is archived; a session whose mail was not all
   * bounced stays.
   */
  private async settle(name: string, grant: Grant | undefined): Promise<number> {
    const failed = await this.endUnread(
      name,
      (record) => grant === undefined || !ownedBy(grant, record)
    );
    if (grant !== undefined || failed > 0) return failed;
    const archived = await this.ask("session.archive", { session_key: tetherSessionKey(name) });
    // `not_found`: no session to archive is not a failure.
    return isRecord(archived) && (archived.archived === true || archived.reason === "not_found")
      ? 0
      : 1;
  }

  /**
   * ReadMail with no argument (call inside the mutex): the session's
   * unacknowledged records, acknowledged up to the last one returned.
   * Mail this grant will never read (a job's, an earlier grant's) is bounced
   * on the way, never shown. Null when duoduo did not answer.
   */
  async readUnread(grant: Grant): Promise<Mail[] | null> {
    const records = await this.pullAll(grant.name);
    if (records === null) return null;
    const mails: Mail[] = [];
    let last: MailRecord | undefined;
    // The ack is cumulative: nothing past a bounce duoduo did not take is
    // acknowledged, so the next ReadMail bounces it again.
    for (const record of records) {
      if (!readableBy(grant, record)) {
        if (!(await this.bounce(grant.name, record))) break;
      } else {
        mails.push(mailOf(record));
      }
      last = record;
    }
    if (last !== undefined && !(await this.ack(grant.name, last.id))) return null;
    return mails;
  }

  /**
   * The unread mail ReadMail would return, as id and sender, acknowledging
   * nothing and bouncing nothing. Null when duoduo did not answer.
   */
  async unreadSummary(grant: Grant): Promise<Array<{ id: string; from: string }> | null> {
    const records = await this.pullAll(grant.name);
    if (records === null) return null;
    return records
      .filter((record) => readableBy(grant, record))
      .map((record) => ({ id: mailIdOf(record), from: senderOf(record) }));
  }

  /**
   * The mail id of the assistant's unread record that arrived as `eventId`,
   * acknowledging nothing: what a bare event id (as ReadEvents shows it)
   * names. Undefined when no unread record has it; null when duoduo did not
   * answer. Only unread mail: reading by id needs the event's day, and
   * nothing the plugin may call finds an event without one.
   */
  async unreadMailId(name: string, eventId: string): Promise<string | undefined | null> {
    const records = await this.pullAll(name);
    if (records === null) return null;
    const found = records.find(
      (record) => (dataString(record, "event_id") ?? record.id) === eventId
    );
    return found === undefined ? undefined : mailIdOf(found);
  }

  /**
   * Bounce and acknowledge the unread records `ends` picks; they lead the
   * session's outbox. Nothing past a bounce duoduo did not take is acknowledged.
   */
  private async endUnread(name: string, ends: (record: MailRecord) => boolean): Promise<number> {
    const records = await this.pullAll(name);
    if (records === null) return 1;
    let last: MailRecord | undefined;
    let failed = 0;
    for (const record of records) {
      if (!ends(record)) break;
      if (!(await this.bounce(name, record))) {
        failed = 1;
        break;
      }
      last = record;
    }
    if (last !== undefined && !(await this.ack(name, last.id))) failed = 1;
    return failed;
  }

  /** Every unacknowledged record of an assistant's session, oldest first; null when duoduo did not answer. */
  private async pullAll(name: string): Promise<MailRecord[] | null> {
    const records: MailRecord[] = [];
    let cursor: string | undefined;
    for (;;) {
      const result = await this.ask("channel.pull", {
        session_key: tetherSessionKey(name),
        consumer_id: TETHER_CONSUMER_ID,
        ...(cursor !== undefined ? { cursor } : {})
      });
      if (!isRecord(result) || !Array.isArray(result.records)) return null;
      const page = result.records as MailRecord[];
      if (page.length === 0) return records;
      records.push(...page);
      cursor = page[page.length - 1].id;
    }
  }

  private async ack(name: string, recordId: string): Promise<boolean> {
    const result = await this.ask("channel.ack", {
      session_key: tetherSessionKey(name),
      consumer_id: TETHER_CONSUMER_ID,
      cursor: recordId
    });
    return isRecord(result) && result.committed === true;
  }

  /** The assistant's session; re-spawning an existing one changes nothing. */
  private async spawn(name: string): Promise<boolean> {
    const result = await this.ask("channel.spawn", {
      channel_kind: "tether",
      channel_id: tetherChannelId(name),
      cwd_abs: this.deps.workspace,
      runtime: "void",
      display_name: name,
      session_key: tetherSessionKey(name)
    });
    return isRecord(result) && result.ok === true;
  }

  /** One daemon call; null, logged, when duoduo did not answer or answered an error. */
  private async ask(method: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      const reply = await this.deps.daemon(method, params);
      if (reply.error) {
        this.deps.log.warn(`[tether] ${method} refused`, { error: reply.error.message });
        return null;
      }
      if (isRecord(reply.result) && reply.result.ok === false) {
        this.deps.log.warn(`[tether] ${method} refused`, {
          reason: reply.result.reason ?? reply.result.error
        });
      }
      return reply.result ?? null;
    } catch (error) {
      if (!(error instanceof DaemonUnreachableError)) throw error;
      this.deps.log.warn(`[tether] ${method}: duoduo did not answer`, { error: error.message });
      return null;
    }
  }

  /**
   * One bounce to the sender: a session through `session.notify`, an assistant
   * into its own session, sent as `duoduo`. A bounce is never bounced, and mail
   * from a script (a label, no session) has nobody to bounce to. `force`: an
   * automatic delivery cannot pick another target. The key makes a replayed
   * push bounce once, and the text is a function of the record alone, so every
   * place that bounces it sends what the key first carried. True when duoduo
   * took it or nobody is left to tell.
   */
  private async bounce(name: string, record: MailRecord): Promise<boolean> {
    const mailId = mailIdOf(record);
    const text = isJobSender(senderOf(record))
      ? renderJobBounce(name, mailId)
      : renderBounce(name, mailId);
    const target = replyTargetOf(record);
    if (target === undefined) return true;
    const result = await this.ask("session.notify", {
      target,
      exact_key: true,
      message: text,
      source: DUODUO_SENDER,
      force: true,
      idempotency_key: `bounce:${record.id}`
    });
    if (isRecord(result) && result.ok === true) return true;
    // The sender's session is gone: nobody is left to tell.
    if (isRecord(result) && result.reason === "not_found") return true;
    this.deps.log.warn("[tether] bounce not delivered", { mail: mailId, to: target });
    return false;
  }

  /**
   * Every doorbell, every live subscription and every open listen stream of
   * the grant, once each. No retry: the recipient is an agent and can check
   * its mail itself.
   */
  private ring(grant: Grant, mailId: string): void {
    this.deps.bus.publish({ kind: "resource_updated", uri: mailboxUri(grant.grant_id) });
    const fetchImpl = this.deps.fetchImpl ?? (fetch as unknown as FetchLike);
    const post = this.deps.postCallback ?? postCallback;
    const now = this.deps.store.clock();
    for (const doorbell of grant.doorbells ?? []) {
      const { url, init } = ringRequest(doorbell, mailId, now);
      this.fire(grant, url, () => fetchImpl(url, init as never));
    }
    for (const subscription of grant.subscriptions ?? []) {
      // A subscription the assistant did not refresh in time has lapsed.
      if (
        subscription.refresh_before !== null &&
        Date.parse(subscription.refresh_before) <= now.getTime()
      ) {
        continue;
      }
      const { headers, body } = deliveryRequest(subscription, mailId, now);
      this.fire(grant, subscription.url, () =>
        post(subscription.url, headers, body, this.deps.callbackLimits)
      );
    }
  }

  /** One POST; a failure or a non-2xx answer is logged, never retried. */
  private fire(grant: Grant, url: string, send: () => Promise<{ status: number }>): void {
    // A header-validation message quotes the bearer value; the URL path may carry a token.
    const where = { tether: grant.name, host: new URL(url).host };
    void Promise.resolve()
      .then(send)
      .then(({ status }) => {
        if (status < 200 || status > 299) {
          this.deps.log.warn("[tether] doorbell ring failed", { ...where, status });
        }
      })
      .catch((error: unknown) => {
        this.deps.log.warn("[tether] doorbell ring failed", {
          ...where,
          error: error instanceof Error ? error.name : typeof error
        });
      });
  }
}
