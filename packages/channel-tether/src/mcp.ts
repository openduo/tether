// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The MCP endpoint: Streamable HTTP, POST only, stateless, both protocol eras.
 * Each request gets its own SDK server, so no `Mcp-Session-Id` exists. Seven
 * tools; no tool takes an assistant name, client, source, force, worker_token
 * or store argument, because the plugin fills the name and client from the
 * grant.
 */

import {
  createMcpHandler,
  isLegacyRequest,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type AuthInfo,
  type CallToolResult,
  type McpHttpHandler,
  type ServerCapabilities,
  type ServerEventBus,
  WebStandardStreamableHTTPServerTransport
} from "@modelcontextprotocol/server";
import crypto from "node:crypto";
import { describeConversationProblem, isRecord, SOURCE_NAME_PATTERN } from "@openduo/protocol";
import { MAIL_SCOPES, type Scope } from "./config";
import {
  DaemonUnreachableError,
  resolveTarget,
  stripped,
  type DaemonCall,
  type SessionEntry
} from "./forward";
import type { CallbackLimits, CallbackPost } from "./callback";
import { registerEventHandlers } from "./events";
import {
  TETHER_ADDRESS_PREFIX,
  tetherSessionKey,
  DUODUO_SENDER,
  isBareEventId,
  isJobSender,
  mailboxUri,
  mailOf,
  mintMailId,
  ownedBy,
  parseMailId,
  replyTargetOf,
  senderOf,
  type Mail,
  type MailRecord,
  type Mailroom
} from "./mail";
import { missingScopes, type Authenticated, type Grant, type Store } from "./store";
import {
  MAILBOX_RESOURCE_DESCRIPTION,
  MAILBOX_RESOURCE_TEXT,
  MCP_INSTRUCTIONS,
  renderAmbiguous,
  renderDaemonError,
  renderDeliveryFailed,
  renderForeignListen,
  renderIdempotencyConflict,
  renderInsufficientScope,
  renderContext,
  renderJobAddress,
  renderMailSent,
  renderMailToSession,
  renderMails,
  renderNoBoard,
  renderNoRecipient,
  renderNotFound,
  renderNotifyKind,
  renderNoReplyAddress,
  renderNotYourMail,
  renderMailboxUnreachable,
  renderNotYourMailbox,
  renderRevokedMidCall,
  renderSelfMail,
  renderUnreachable,
  TOOL_DESCRIPTIONS
} from "./texts";
import { LISTEN_KEEP_ALIVE_MS } from "./client-contract";

// --- schemas ------------------------------------------------------------------------

type JsonSchema = {
  type: "object";
  properties: Record<string, PropertySchema>;
  required?: string[];
  additionalProperties: false;
};
type PropertySchema =
  | { type: "string"; minLength?: number; description?: string }
  | { type: "boolean"; description?: string }
  | { type: "array"; items: { type: "string" | "object" }; description?: string };

const text = (description?: string): PropertySchema => ({
  type: "string",
  minLength: 1,
  ...(description ? { description } : {})
});
const flag = (description?: string): PropertySchema => ({
  type: "boolean",
  ...(description ? { description } : {})
});

function object(properties: Record<string, PropertySchema>, required: string[] = []): JsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false
  };
}

const RECEIPT_SCHEMA = object(
  {
    ok: flag(),
    event_id: text(),
    ts: text(),
    duplicate: flag(),
    session_key: text(),
    route_id: text()
  },
  ["ok"]
);

type ToolName =
  | "GetContext"
  | "ReadMemory"
  | "ReadEvents"
  | "ListAddresses"
  | "SendMail"
  | "ReadMail"
  | "RecordExperience";

type ToolSpec = {
  name: ToolName;
  title: string;
  /** Every one is required. */
  scopes: readonly Scope[];
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: Record<string, boolean>;
};

export const TOOLS: readonly ToolSpec[] = [
  {
    name: "GetContext",
    title: "Load duoduo's context",
    scopes: ["context:read"],
    inputSchema: object({
      conversation: text("This chat's conversation id, from the first GetContext of the chat.")
    }),
    outputSchema: object({ conversation: text(), board_rev: text() }, [
      "conversation",
      "board_rev"
    ]),
    annotations: { readOnlyHint: true }
  },
  {
    name: "ReadMemory",
    title: "Read a duoduo memory file",
    scopes: ["memory:read"],
    inputSchema: object({ path: text("Relative to memory/, for example entities/<slug>.md.") }, [
      "path"
    ]),
    outputSchema: object({ path: text() }, ["path"]),
    annotations: { readOnlyHint: true }
  },
  {
    name: "ReadEvents",
    title: "Read duoduo's event log",
    scopes: ["events:read"],
    inputSchema: object({
      date: text("yyyy-mm-dd"),
      interval: text(),
      from: text(),
      to: text(),
      session: text(),
      types: { type: "array", items: { type: "string" } },
      kind: text("all, external or internal"),
      after: text(),
      unfiltered: flag(),
      count_only: flag(),
      sessions: flag(),
      json: flag(),
      show: text("An event id; needs date.")
    }),
    outputSchema: object({}),
    annotations: { readOnlyHint: true }
  },
  {
    name: "ListAddresses",
    title: "List duoduo's mail addresses",
    scopes: MAIL_SCOPES,
    inputSchema: object({}),
    outputSchema: object({ addresses: { type: "array", items: { type: "object" } } }, [
      "addresses"
    ]),
    annotations: { readOnlyHint: true }
  },
  {
    name: "SendMail",
    title: "Send mail to a duoduo session or connected assistant",
    scopes: MAIL_SCOPES,
    inputSchema: object(
      {
        to: text("An address or alias from ListAddresses."),
        in_reply_to: text("The id of a mail you received; alone, it answers that mail's sender."),
        message: text("What you are telling or asking, and why."),
        idempotency_key: text("Repeat it only to retry a call whose answer was lost.")
      },
      ["message"]
    ),
    outputSchema: RECEIPT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  },
  {
    name: "ReadMail",
    title: "Read this assistant's mail",
    scopes: MAIL_SCOPES,
    inputSchema: object({
      id: text("One mail by id."),
      after: text("The mails after this mail id.")
    }),
    outputSchema: object({ mails: { type: "array", items: { type: "object" } } }, ["mails"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  {
    name: "RecordExperience",
    title: "Record this turn for duoduo",
    scopes: ["experience:write"],
    inputSchema: object(
      {
        conversation: text("This chat's conversation id from GetContext."),
        board_rev: text("The board rev GetContext returned."),
        said: text("The message you answered, verbatim and whole."),
        did: text("What you did and are about to answer."),
        outcome: text("Done, failed and why, or waiting."),
        from: text("Who said it, when it was not your owner."),
        artifact: text("Where anything you made lives: path or URL."),
        model: text("Your model id, when you know it.")
      },
      ["conversation", "board_rev", "said", "did", "outcome"]
    ),
    outputSchema: RECEIPT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }
];

export function toolDescriptors(): Array<Record<string, unknown>> {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: TOOL_DESCRIPTIONS[tool.name],
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    securitySchemes: [{ type: "oauth2", scopes: [...tool.scopes] }]
  }));
}

/** Arguments against a strict flat schema; the first problem, or null. */
export function describeArgumentProblem(schema: JsonSchema, args: unknown): string | null {
  if (args === undefined || args === null) args = {};
  if (!isRecord(args)) return "arguments must be one JSON object";
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties, key)) return `unknown argument "${key}"`;
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(args, key)) return `missing argument "${key}"`;
  }
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    if (property.type === "string") {
      if (typeof value !== "string" || (property.minLength && value.trim().length === 0)) {
        return `"${key}" must be non-empty text`;
      }
    } else if (property.type === "boolean") {
      if (typeof value !== "boolean") return `"${key}" must be true or false`;
    } else if (property.type === "array") {
      if (!Array.isArray(value) || !value.every((item) => typeof item === property.items.type)) {
        return `"${key}" must be an array of ${property.items.type === "string" ? "strings" : "objects"}`;
      }
    }
  }
  return null;
}

// --- tool handlers -----------------------------------------------------------------------

export type McpDeps = {
  daemon: DaemonCall;
  store: Store;
  publicUrl: string;
  version: string;
  /** ALADUO_TETHER_TOOLS_LIST_TTL_MS; null leaves the SDK's own hint. */
  toolsListTtlMs: number | null;
  callbackLimits: CallbackLimits;
  postCallback?: CallbackPost;
  /** The Mailroom publishes to it; listen streams read it. */
  bus: ServerEventBus;
  mail: Pick<Mailroom, "readUnread" | "unreadMailId" | "unreadSummary">;
};

function textResult(body: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: body }], structuredContent: structured };
}

/** The `_meta` key a refusal's reason code travels under. */
export const REASON_META_KEY = "duoduo/reason";

/**
 * A refusal: text the assistant reads, the reason code in `_meta`. No
 * structuredContent: a client that validates it against the tool's
 * outputSchema (the official TypeScript SDK does, error or not) would turn the
 * refusal into a -32602 the assistant cannot read.
 */
function toolError(
  reason: string,
  message: string,
  meta?: Record<string, unknown>
): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    _meta: { [REASON_META_KEY]: reason, ...meta }
  };
}

export function protectedResourceMetadataUrl(publicUrl: string): string {
  return `${publicUrl}/.well-known/oauth-protected-resource`;
}

type DaemonOutcome = { result: unknown } | { failed: CallToolResult };

async function call(
  deps: McpDeps,
  tool: ToolName,
  method: string,
  params: Record<string, unknown>,
  writes: boolean
): Promise<DaemonOutcome> {
  let reply;
  try {
    reply = await deps.daemon(method, params);
  } catch (error) {
    if (!(error instanceof DaemonUnreachableError)) throw error;
    return { failed: toolError("unreachable", renderUnreachable(tool, writes)) };
  }
  if (reply.error) {
    const { message } = stripped(reply.error);
    return { failed: toolError("daemon_error", renderDaemonError(tool, message, writes)) };
  }
  const result = reply.result;
  if (isRecord(result) && result.ok === false && typeof result.message === "string") {
    return { failed: toolError(String(result.reason), result.message) };
  }
  return { result };
}

type Address = {
  address: string;
  kind: "channel" | "assistant";
  alias: string | null;
  last_read_at?: string | null;
};

/**
 * Who an assistant can mail: channel sessions a Notify would deliver to right
 * now (the consumer gate), and every granted assistant (`tether:<name>`, a
 * void session). Never a job or a kernel session. An assistant's
 * `last_read_at` is the last time its mail was acknowledged.
 */
async function listAddresses(
  deps: McpDeps,
  tool: ToolName
): Promise<{ addresses: Address[] } | { failed: CallToolResult }> {
  const listed = await call(
    deps,
    tool,
    "session.list",
    { kind: "channel", deliverable: true },
    false
  );
  if ("failed" in listed) return listed;
  const rows = Array.isArray(listed.result) ? (listed.result as SessionEntry[]) : [];
  const names = [...new Set(Object.values(await deps.store.readGrants()).map((g) => g.name))];
  let lastRead = new Map<string, string>();
  if (names.length > 0) {
    const read = await lastReads(deps, tool);
    if ("failed" in read) return read;
    lastRead = read.lastRead;
  }
  const addresses: Address[] = [
    ...rows
      .filter((row) => !row.session_key.startsWith(TETHER_ADDRESS_PREFIX))
      .map((row): Address => ({
        address: row.session_key,
        kind: "channel",
        alias: row.display_name?.trim() || null
      })),
    ...names.map((name): Address => {
      const address = tetherSessionKey(name);
      return {
        address,
        kind: "assistant",
        alias: null,
        last_read_at: lastRead.get(address) ?? null
      };
    })
  ];
  return { addresses: addresses.sort((a, b) => a.address.localeCompare(b.address)) };
}

/**
 * When each assistant last acknowledged its mail: the consumer view's last cursor
 * advance of its session, which only ReadMail (and a bounce of mail it never
 * gets to read) moves.
 */
async function lastReads(
  deps: McpDeps,
  tool: ToolName
): Promise<{ lastRead: Map<string, string> } | { failed: CallToolResult }> {
  const status = await call(deps, tool, "system.status", {}, false);
  if ("failed" in status) return status;
  const sessions =
    isRecord(status.result) && Array.isArray(status.result.sessions)
      ? (status.result.sessions as Array<Record<string, unknown>>)
      : [];
  return {
    lastRead: new Map(
      sessions.flatMap((row) =>
        typeof row.session_key === "string" && typeof row.last_cursor_advance_at === "string"
          ? [[row.session_key, row.last_cursor_advance_at] as [string, string]]
          : []
      )
    )
  };
}

/** A channel session by address or alias; assistants are matched by their prefix. */
function resolveAddress(addresses: readonly Address[], target: string) {
  const entries: SessionEntry[] = addresses
    .filter((row) => row.kind === "channel")
    .map((row) => ({ session_key: row.address, display_name: row.alias, kind: row.kind }));
  return resolveTarget(entries, target);
}

type Notified =
  | {
      ok: true;
      session_key: string;
      route_id: string;
      event_id?: string;
      ts?: string;
      duplicate: boolean;
    }
  | { failed: CallToolResult };

/**
 * One `session.notify` from this assistant, its failures in the assistant's
 * terms. duoduo has one key space for every caller, so the key it sees is the
 * grant id and the assistant's key as a JSON pair: two connections, even of one
 * client, never share a key, and no pair spells another.
 */
async function notifyFrom(
  deps: McpDeps,
  auth: Authenticated,
  target: string,
  message: string,
  extra: Record<string, unknown>
): Promise<Notified> {
  const { idempotency_key: key, ...rest } = extra;
  const sent = await call(
    deps,
    "SendMail",
    "session.notify",
    {
      target,
      exact_key: true,
      message,
      source: tetherSessionKey(auth.grant.name),
      ...rest,
      ...(typeof key === "string"
        ? { idempotency_key: JSON.stringify([auth.grant.grant_id, key]) }
        : {})
    },
    true
  );
  if ("failed" in sent) return sent;
  const result = isRecord(sent.result) ? sent.result : {};
  if (result.ok === true) {
    return {
      ok: true,
      session_key: String(result.session_key),
      route_id: String(result.route_id),
      ...(typeof result.event_id === "string" ? { event_id: result.event_id } : {}),
      ...(typeof result.ts === "string" ? { ts: result.ts } : {}),
      duplicate: result.duplicate === true
    };
  }
  switch (result.reason) {
    case "idempotency_conflict":
      return {
        failed: toolError(
          "idempotency_conflict",
          renderIdempotencyConflict(String(extra.idempotency_key))
        )
      };
    case "no_consumer":
      return { failed: toolError("no_consumer", String(result.error)) };
    case "not_found":
      return { failed: toolError("not_found", renderNotFound(target)) };
    case "forbidden_kind":
      return { failed: toolError("notify_kind", renderNotifyKind(target, String(result.kind))) };
    default:
      return {
        failed: toolError(
          "delivery_failed",
          renderDeliveryFailed(target, typeof result.error === "string" ? result.error : undefined)
        )
      };
  }
}

function receiptOf(notified: Extract<Notified, { ok: true }>) {
  return {
    ok: true,
    session_key: notified.session_key,
    route_id: notified.route_id,
    ...(notified.event_id !== undefined ? { event_id: notified.event_id } : {}),
    ...(notified.ts !== undefined ? { ts: notified.ts } : {}),
    duplicate: notified.duplicate
  };
}

/** Mail to another assistant: its void session gets the message as sent. */
async function sendToTether(
  deps: McpDeps,
  auth: Authenticated,
  name: string,
  args: Record<string, unknown>,
  inReplyTo: string | undefined
): Promise<CallToolResult> {
  const address = tetherSessionKey(name);
  if (name === auth.grant.name) return toolError("self", renderSelfMail());
  const grants = Object.values(await deps.store.readGrants());
  if (!SOURCE_NAME_PATTERN.test(name) || !grants.some((grant) => grant.name === name)) {
    return toolError("not_found", renderNotFound(address));
  }
  const notified = await notifyFrom(deps, auth, address, String(args.message), {
    ...(inReplyTo !== undefined ? { in_reply_to: inReplyTo } : {}),
    ...(args.idempotency_key !== undefined ? { idempotency_key: args.idempotency_key } : {})
  });
  if ("failed" in notified) return notified.failed;
  const id =
    notified.event_id !== undefined && notified.ts !== undefined
      ? `${notified.event_id}@${notified.ts.slice(0, 10)}`
      : notified.route_id;
  // The receipt stands even when the last-read time cannot be read.
  const read = await lastReads(deps, "SendMail");
  const lastReadAt = "failed" in read ? undefined : (read.lastRead.get(address) ?? null);
  return textResult(
    renderMailSent(address, id, lastReadAt, notified.duplicate),
    receiptOf(notified)
  );
}

/** Mail to a session: the plugin's text carries the mail id and how to answer. */
async function sendToSession(
  deps: McpDeps,
  auth: Authenticated,
  target: string,
  args: Record<string, unknown>,
  inReplyTo: string | undefined
): Promise<CallToolResult> {
  const listed = await listAddresses(deps, "SendMail");
  if ("failed" in listed) return listed.failed;
  const resolution = resolveAddress(listed.addresses, target);
  if (!resolution.ok) {
    return resolution.reason === "ambiguous"
      ? toolError(
          "ambiguous",
          renderAmbiguous(
            target,
            resolution.candidates.map((entry) => entry.session_key)
          )
        )
      : toolError("not_found", renderNotFound(target));
  }
  const key = typeof args.idempotency_key === "string" ? args.idempotency_key : undefined;
  const mailId = mintMailId(auth.grant.grant_id, key);
  // The key resolved once, never the alias, so a rename in between cannot pick a new owner.
  const notified = await notifyFrom(
    deps,
    auth,
    resolution.entry.session_key,
    renderMailToSession({
      name: auth.grant.name,
      mailId,
      inReplyTo,
      message: String(args.message)
    }),
    {
      ...(inReplyTo !== undefined ? { in_reply_to: inReplyTo } : {}),
      // A retry keeps its key, so its mail id and text repeat and duoduo returns the first receipt.
      idempotency_key: key ?? mailId
    }
  );
  if ("failed" in notified) return notified.failed;
  return textResult(
    notified.duplicate
      ? `Already delivered to ${notified.session_key} as mail ${mailId} by the first call with this key; no new turn started.`
      : `Delivered to ${notified.session_key} as mail ${mailId}; duoduo starts a turn there.`,
    receiptOf(notified)
  );
}

/** `replyTo`: where in_reply_to alone sends an answer; absent for mail from outside duoduo's sessions. */
type FoundMail =
  { found: Mail; replyTo: string | undefined } | { missing: true } | { failed: CallToolResult };

/**
 * One mail of this grant by the id ReadMail showed: the event it arrived as,
 * read on its day. Mail to another grant, or before this one's approval, is
 * not this grant's. Nor is what ReadMail never shows: a delivery the consumer
 * gate refused (it reached no outbox) and mail from a job (bounced).
 * A bare event id, as ReadEvents shows it, names the unread mail it arrived as.
 */
async function mailById(
  deps: McpDeps,
  tool: ToolName,
  grant: Grant,
  id: string
): Promise<FoundMail> {
  let mailId = id;
  if (isBareEventId(id)) {
    const resolved = await deps.mail.unreadMailId(grant.name, id);
    if (resolved === null)
      return { failed: toolError("unreachable", renderUnreachable(tool, false)) };
    if (resolved === undefined) return { missing: true };
    mailId = resolved;
  }
  const parsed = parseMailId(mailId);
  if (parsed === null) return { missing: true };
  let reply;
  try {
    reply = await deps.daemon("spine.cat", { show: parsed.eventId, date: parsed.day });
  } catch (error) {
    if (!(error instanceof DaemonUnreachableError)) throw error;
    return { failed: toolError("unreachable", renderUnreachable(tool, false)) };
  }
  const text = isRecord(reply.result) ? reply.result.text : undefined;
  if (reply.error || typeof text !== "string") return { missing: true };
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    return { missing: true };
  }
  if (
    !isRecord(event) ||
    event.type !== "route.deliver" ||
    event.session_key !== tetherSessionKey(grant.name) ||
    typeof event.ts !== "string"
  ) {
    return { missing: true };
  }
  const outer = isRecord(event.payload) ? event.payload : {};
  const inner = isRecord(outer.payload) ? outer.payload : {};
  // The record the daemon's void delivery wrote for this event.
  const record: MailRecord = {
    id: String(event.id),
    created_at: event.ts,
    payload: {
      text: typeof inner.text === "string" ? inner.text : "",
      data: {
        ...inner,
        event_id: event.id,
        event_ts: event.ts,
        source_session_key: outer.source_session_key
      }
    }
  };
  if (inner.notify_refused_reason !== undefined || isJobSender(senderOf(record))) {
    return { missing: true };
  }
  return ownedBy(grant, record)
    ? { found: mailOf(record), replyTo: replyTargetOf(record) }
    : { missing: true };
}

/**
 * ReadEvents' answer with this grant's mail ids: a delivery row into its
 * session shows only a short event id, but in_reply_to needs the mail id,
 * `<event id>@<day>`, which ReadMail shows once. Rows print `mail=<id>`;
 * NDJSON rows carry `mail_id`. The full ids come from the NDJSON form and
 * which deliveries are mail (not refused, not from a job) from the rows, so
 * a view naming this session costs a second spine.cat in the other form.
 * Mail from before the grant is not its mail either. Any failure of that
 * second read answers the first unchanged.
 */
async function withMailIds(
  deps: McpDeps,
  grant: Grant,
  args: Record<string, unknown>,
  text: string
): Promise<string> {
  if (args.show !== undefined || args.count_only === true || args.sessions === true) return text;
  const inbox = tetherSessionKey(grant.name);
  const json = args.json === true;
  if (!text.includes(inbox)) return text;
  let other: string;
  try {
    const reply = await deps.daemon("spine.cat", { ...args, json: !json, redact: "external" });
    const otherText = isRecord(reply.result) ? reply.result.text : undefined;
    if (typeof otherText !== "string") return text;
    other = otherText;
  } catch (error) {
    if (!(error instanceof DaemonUnreachableError)) throw error;
    return text;
  }
  const ids = mailIdsByShortId(json ? text : other, json ? other : text, inbox, grant);
  if (ids.size === 0) return text;
  if (json) {
    return text.replace(/^.+$/gm, (line) => {
      const row = parseRow(line);
      const mailId = row === null ? undefined : ids.get(shortEventId(String(row.id)));
      return mailId === undefined ? line : JSON.stringify({ ...row, mail_id: mailId });
    });
  }
  return text.replace(/^(.* {2}(evt_\S+))$/gm, (line, _all, short: string) => {
    const mailId = ids.get(short);
    return mailId === undefined || !line.includes(`→ ${inbox}`) ? line : `${line}  mail=${mailId}`;
  });
}

/** Short row id → mail id, for each delivery into `inbox` that is this grant's mail. */
function mailIdsByShortId(
  ndjson: string,
  rows: string,
  inbox: string,
  grant: Grant
): Map<string, string> {
  const notMail = new Set<string>();
  for (const line of rows.split("\n")) {
    const match = /·\s+route\.deliver (REFUSED )?(\S+) → (\S+).* {2}(evt_\S+)$/.exec(line);
    // A refused row reads `→ <target>: <reason>` when the route has no id.
    if (match === null || match[3].replace(/:$/, "") !== inbox) continue;
    if (match[1] !== undefined || isJobSender(match[2])) notMail.add(match[4]);
  }
  const ids = new Map<string, string>();
  for (const line of ndjson.split("\n")) {
    const row = parseRow(line);
    if (row === null || row.type !== "route.deliver" || row.session_key !== inbox) continue;
    if (typeof row.id !== "string" || typeof row.ts !== "string") continue;
    if (Date.parse(row.ts) <= Date.parse(grant.approved_at)) continue;
    const short = shortEventId(row.id);
    if (!notMail.has(short)) ids.set(short, `${row.id}@${row.ts.slice(0, 10)}`);
  }
  return ids;
}

function parseRow(line: string): Record<string, unknown> | null {
  try {
    const row: unknown = JSON.parse(line);
    return isRecord(row) ? row : null;
  } catch {
    return null;
  }
}

/** The row form of an event id, as spine.cat prints it: `evt_` and 8 characters. */
function shortEventId(id: string): string {
  return id.startsWith("evt_") && id.length > 12 ? id.slice(0, 12) : id;
}

/** The mails of this grant after `anchor`, read back day by day to today. */
async function mailsAfter(
  deps: McpDeps,
  grant: Grant,
  anchor: Mail
): Promise<Mail[] | { failed: CallToolResult }> {
  const ids: string[] = [];
  const today = deps.store.clock().toISOString().slice(0, 10);
  for (let day = anchor.ts.slice(0, 10); day <= today; day = nextDay(day)) {
    let reply;
    try {
      reply = await deps.daemon("spine.cat", {
        date: day,
        session: tetherSessionKey(grant.name),
        types: ["route.deliver"],
        json: true
      });
    } catch (error) {
      if (!(error instanceof DaemonUnreachableError)) throw error;
      return { failed: toolError("unreachable", renderUnreachable("ReadMail", false)) };
    }
    const text = isRecord(reply.result) ? reply.result.text : undefined;
    if (typeof text !== "string") continue;
    for (const line of text.split("\n")) {
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (isRecord(row) && typeof row.id === "string" && typeof row.ts === "string") {
        if (row.ts > anchor.ts) ids.push(`${row.id}@${day}`);
      }
    }
  }
  const mails: Mail[] = [];
  for (const id of ids) {
    const found = await mailById(deps, "ReadMail", grant, id);
    if ("failed" in found) return found;
    if ("found" in found) mails.push(found.found);
  }
  return mails;
}

function nextDay(day: string): string {
  const next = new Date(`${day}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * SendMail. `in_reply_to` must name a mail this assistant received under its
 * current grant: knowing an id is not authority. Alone, it answers the
 * sender. Jobs and assistants never mail each other.
 */
async function sendMail(
  deps: McpDeps,
  auth: Authenticated,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  let inReplyTo = typeof args.in_reply_to === "string" ? args.in_reply_to.trim() : undefined;
  let target = typeof args.to === "string" ? args.to.trim() : undefined;
  if (target === undefined && inReplyTo === undefined) {
    return toolError("no_recipient", renderNoRecipient());
  }
  if (inReplyTo !== undefined) {
    const looked = await mailById(deps, "SendMail", auth.grant, inReplyTo);
    if ("failed" in looked) return looked.failed;
    if ("missing" in looked)
      return toolError("not_your_mail", renderNotYourMail(inReplyTo, isBareEventId(inReplyTo)));
    if (
      target === undefined &&
      looked.replyTo === undefined &&
      looked.found.from !== DUODUO_SENDER
    ) {
      return toolError("no_reply_address", renderNoReplyAddress(inReplyTo));
    }
    target ??= looked.found.from;
    // The recipient sees the id ReadMail shows, even when a bare event id named it.
    inReplyTo = looked.found.id;
  }
  const to = target as string;
  if (to === DUODUO_SENDER) return toolError("not_found", renderNotFound(to));
  if (isJobSender(to)) return toolError("job_address", renderJobAddress(to));
  if (to.startsWith(TETHER_ADDRESS_PREFIX)) {
    return sendToTether(deps, auth, to.slice(TETHER_ADDRESS_PREFIX.length), args, inReplyTo);
  }
  return sendToSession(deps, auth, to, args, inReplyTo);
}

/**
 * ReadMail. No argument: the unread mail, acknowledged as it is returned
 * in one turn of the store's mutex. `id` and `after` read back by id
 * and acknowledge nothing.
 */
async function readMail(
  deps: McpDeps,
  auth: Authenticated,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const grant = auth.grant;
  if (typeof args.id === "string" || typeof args.after === "string") {
    const id = String(args.id ?? args.after).trim();
    const looked = await mailById(deps, "ReadMail", grant, id);
    if ("failed" in looked) return looked.failed;
    if ("missing" in looked)
      return toolError("not_found", renderNotYourMail(id, isBareEventId(id)));
    if (typeof args.id === "string") {
      return textResult(renderMails([looked.found], "asked"), { mails: [looked.found] });
    }
    const after = await mailsAfter(deps, grant, looked.found);
    if ("failed" in after) return after.failed;
    return textResult(renderMails(after, "asked"), { mails: after });
  }
  return deps.store.serialize(async () => {
    const current = (await deps.store.readGrants())[grant.grant_id];
    if (current === undefined) return toolError("revoked", renderRevokedMidCall());
    const mails = await deps.mail.readUnread(current);
    if (mails === null) return toolError("unreachable", renderUnreachable("ReadMail", false));
    return textResult(renderMails(mails, "unread"), { mails });
  });
}

/** 16 hex = 64 bits: a collision inside one conversation is negligible. */
const RECORD_HASH_HEX = 16;

/**
 * The record's content identity: `from` is in it, so
 * the same words from the owner and from a colleague stay two records.
 */
function recordHash(args: Record<string, unknown>): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([args.from ?? null, args.said, args.did, args.outcome]))
    .digest("hex")
    .slice(0, RECORD_HASH_HEX);
}

export async function runTool(
  deps: McpDeps,
  auth: Authenticated,
  name: string,
  rawArgs: unknown
): Promise<CallToolResult> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
  }
  const problem =
    describeArgumentProblem(tool.inputSchema, rawArgs) ?? describeConversation(rawArgs);
  if (problem !== null) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `${name}: ${problem}. Nothing was done.`
    );
  }
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const missing = missingScopes(auth, tool.scopes);
  if (missing.length > 0) {
    return toolError("insufficient_scope", renderInsufficientScope(name, missing), {
      "mcp/www_authenticate": [
        `Bearer resource_metadata="${protectedResourceMetadataUrl(deps.publicUrl)}",` +
          ` error="insufficient_scope", scope="${tool.scopes.join(" ")}"`
      ]
    });
  }
  const connection = auth.grant.name;
  const client = { id: auth.clientId, grant: auth.grant.grant_id };
  switch (tool.name) {
    case "GetContext": {
      const outcome = await call(deps, tool.name, "memory.read", { path: BOARD_PATH }, false);
      if ("failed" in outcome) return boardMissing(outcome.failed) ?? outcome.failed;
      const board = (outcome.result as { text: string }).text;
      // A vendor's own conversation id is often invisible to its model; a
      // connected assistant passes back the one it got on its first call in this chat.
      const conversation =
        typeof args.conversation === "string" ? args.conversation : crypto.randomUUID();
      const boardRev = crypto.createHash("sha256").update(board).digest("hex").slice(0, 16);
      return textResult(
        renderContext({ name: connection, now: deps.store.clock(), conversation, boardRev, board }),
        { conversation, board_rev: boardRev }
      );
    }
    case "ReadMemory": {
      const outcome = await call(deps, tool.name, "memory.read", { path: args.path }, false);
      if ("failed" in outcome) return outcome.failed;
      const result = outcome.result as { path: string; text: string };
      return textResult(result.text, { path: result.path });
    }
    case "ReadEvents": {
      const outcome = await call(
        deps,
        tool.name,
        "spine.cat",
        { ...args, redact: "external" },
        false
      );
      if ("failed" in outcome) return outcome.failed;
      const text = (outcome.result as { text: string }).text;
      return textResult(await withMailIds(deps, auth.grant, args, text), {});
    }
    case "ListAddresses": {
      const listed = await listAddresses(deps, tool.name);
      if ("failed" in listed) return listed.failed;
      return textResult(JSON.stringify(listed.addresses, null, 2), {
        addresses: listed.addresses
      });
    }
    case "SendMail":
      return sendMail(deps, auth, args);
    case "ReadMail":
      return readMail(deps, auth, args);
    case "RecordExperience": {
      const outcome = await call(
        deps,
        tool.name,
        "spine.record",
        {
          source: connection,
          conversation: args.conversation,
          payload: {
            text: args.said,
            ...(args.from !== undefined ? { from: args.from } : {}),
            did: args.did,
            outcome: args.outcome,
            ...(args.artifact !== undefined ? { artifact: args.artifact } : {}),
            ...(args.model !== undefined ? { model: args.model } : {}),
            board_rev: args.board_rev,
            client
          },
          dedup_key: recordHash(args)
        },
        true
      );
      if ("failed" in outcome) return outcome.failed;
      const result = outcome.result as { event_id: string; ts: string; duplicate: boolean };
      const receipt = {
        ok: true,
        event_id: result.event_id,
        ts: result.ts,
        duplicate: result.duplicate
      };
      return textResult(
        result.duplicate
          ? `Already recorded as ${result.event_id}. Nothing to do.`
          : `Recorded as ${result.event_id}.`,
        receipt
      );
    }
  }
}

/** The board an assistant loads, relative to memory/. */
const BOARD_PATH = "CLAUDE.md";

/**
 * memory.read answers a missing file with `No file memory/<path>`: for the
 * board that is "duoduo has no board yet", said in the assistant's terms.
 */
function boardMissing(failed: CallToolResult): CallToolResult | null {
  const text = failed.content?.[0]?.type === "text" ? failed.content[0].text : "";
  return text.includes(`No file memory/${BOARD_PATH}`)
    ? toolError("no_board", renderNoBoard())
    : null;
}

/**
 * A conversation id becomes part of a record's key (`<name>:<conversation>`),
 * so a space or ':' is refused before anything is sent.
 */
function describeConversation(rawArgs: unknown): string | null {
  if (!isRecord(rawArgs) || typeof rawArgs.conversation !== "string") return null;
  return describeConversationProblem("conversation", rawArgs.conversation);
}

// --- the transport --------------------------------------------------------------------------

export type McpHttpRequest = {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};
/** A listen stream comes back as a stream; everything else as one body. */
export type McpHttpResponse = { status: number; headers: Record<string, string> } & (
  { body: string } | { stream: ReadableStream<Uint8Array> }
);

/** Answer headers worth passing on; the SSE ones keep gateways from buffering a stream. */
const ANSWER_HEADERS = ["content-type", "cache-control", "x-accel-buffering"];

type TetherAuthInfo = AuthInfo & { extra: { auth: Authenticated } };

/**
 * A fresh server bound to the caller's grant, for one request. The mailbox
 * resource exists for push, which only the 2026-07-28 era has.
 */
function serverFor(deps: McpDeps, auth: Authenticated, era: "legacy" | "modern"): Server {
  const modern = era === "modern";
  const server = new Server(
    { name: "duoduo", version: deps.version },
    {
      // `events` is OpenAI's capability (MCP Events), not the spec's.
      capabilities: {
        tools: {},
        events: {},
        ...(modern ? { resources: { subscribe: true } } : {})
      } as ServerCapabilities,
      instructions: MCP_INSTRUCTIONS,
      ...(deps.toolsListTtlMs !== null
        ? { cacheHints: { "tools/list": { ttlMs: deps.toolsListTtlMs } } }
        : {})
    }
  );
  server.setRequestHandler("tools/list", async () => ({ tools: toolDescriptors() as never }));
  server.setRequestHandler("tools/call", async (call) =>
    runTool(deps, auth, call.params.name, call.params.arguments)
  );
  registerEventHandlers(server, deps, auth);
  if (modern) {
    const uri = mailboxUri(auth.grant.grant_id);
    server.setRequestHandler("resources/list", async () => ({
      resources: [
        {
          uri,
          name: "mailbox",
          description: MAILBOX_RESOURCE_DESCRIPTION,
          mimeType: "application/json"
        }
      ]
    }));
    // Ids and senders only, and nothing acknowledged: no cursor moves and no read is recorded.
    // A listener reads it to report mail that arrived while no stream was open.
    server.setRequestHandler("resources/read", async (read) => {
      if (read.params.uri !== uri) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, renderNotYourMailbox(uri));
      }
      const unread = await deps.mail.unreadSummary(auth.grant);
      if (unread === null) {
        throw new ProtocolError(ProtocolErrorCode.InternalError, renderMailboxUnreachable());
      }
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ unread, note: MAILBOX_RESOURCE_TEXT })
          }
        ]
      };
    });
  }
  return server;
}

export type McpEndpoint = { deps: McpDeps; modern: McpHttpHandler };

/**
 * Both protocol eras on one route. A request carrying the
 * 2026-07-28 `_meta` envelope goes to the SDK's modern handler, which also
 * serves `subscriptions/listen` on the shared bus; any other request
 * is served statelessly with JSON responses, as before the SDK spoke
 * 2026-07-28, which the SDK's own legacy fallback cannot do (it answers over
 * SSE).
 */
export function createMcpEndpoint(deps: McpDeps): McpEndpoint {
  return {
    deps,
    modern: createMcpHandler(
      ({ authInfo, era }) => serverFor(deps, (authInfo as TetherAuthInfo).extra.auth, era),
      { legacy: "reject", bus: deps.bus, keepAliveMs: LISTEN_KEEP_ALIVE_MS }
    )
  };
}

/** Headers the SDK reads: content negotiation and the per-request MCP headers. */
/** No `Mcp-Param-*`: no tool declares `x-mcp-header`. */
const PASSED_HEADERS = new Set([
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name"
]);

function forwarded(headers: McpHttpRequest["headers"]): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (typeof value !== "string") continue;
    if (PASSED_HEADERS.has(lower)) {
      out.set(lower, value);
    }
  }
  return out;
}

async function serveLegacy(
  endpoint: McpEndpoint,
  auth: Authenticated,
  request: Request,
  parsedBody: unknown
): Promise<Response> {
  const server = serverFor(endpoint.deps, auth, "legacy");
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, { parsedBody });
  } finally {
    await server.close();
  }
}

/** The methods of push on an assistant's connection: mail scopes, like the mail tools. */
const PUSH_METHODS = new Set(["subscriptions/listen", "resources/list", "resources/read"]);

/**
 * Why a push request is refused before the SDK sees it, or null. The SDK
 * leaves authorization of a listen to the caller of its handler
 * (createMcpHandler: "Authorization the consumer performs inside the factory
 * therefore DOES see listen requests"); this is that check: the mail scopes,
 * and a listen names only the caller's own mailbox.
 */
function pushRefusal(body: unknown, auth: Authenticated): { code: number; message: string } | null {
  if (!isRecord(body) || typeof body.method !== "string" || !PUSH_METHODS.has(body.method)) {
    return null;
  }
  const missing = missingScopes(auth, MAIL_SCOPES);
  if (missing.length > 0) {
    return {
      code: ProtocolErrorCode.InvalidRequest,
      message: renderInsufficientScope(body.method, missing)
    };
  }
  if (body.method !== "subscriptions/listen" || !isRecord(body.params)) return null;
  const notifications = body.params.notifications;
  const uris = isRecord(notifications) ? notifications.resourceSubscriptions : undefined;
  if (!Array.isArray(uris)) return null;
  const own = mailboxUri(auth.grant.grant_id);
  const foreign = uris.find((uri) => uri !== own);
  return foreign === undefined
    ? null
    : { code: ProtocolErrorCode.InvalidParams, message: renderForeignListen(String(foreign), own) };
}

/** One POST /mcp, already authenticated. `signal` ends a stream when the client goes away. */
export async function handleMcpPost(
  endpoint: McpEndpoint,
  auth: Authenticated,
  request: McpHttpRequest,
  signal?: AbortSignal
): Promise<McpHttpResponse> {
  const refusal = pushRefusal(request.body, auth);
  if (refusal !== null) {
    const id = isRecord(request.body) ? (request.body.id ?? null) : null;
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: refusal
      })
    };
  }
  const web = new Request(`${endpoint.deps.publicUrl}/mcp`, {
    method: "POST",
    headers: forwarded(request.headers),
    body: JSON.stringify(request.body ?? null),
    ...(signal ? { signal } : {})
  });
  const authInfo: TetherAuthInfo = {
    // Pass-through only: the SDK never reads it, and the grant is the identity.
    token: "",
    clientId: auth.clientId,
    scopes: auth.grant.scopes,
    extra: { auth }
  };
  const response = (await isLegacyRequest(web, request.body))
    ? await serveLegacy(endpoint, auth, web, request.body)
    : await endpoint.modern.fetch(web, { authInfo, parsedBody: request.body });
  const headers: Record<string, string> = {};
  for (const name of ANSWER_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  // Only a listen answers with a stream today: the modern handler ('auto') answers JSON unless a
  // handler emits a mid-call message, and legacy has enableJsonResponse. A handler that sent
  // notifications mid-call would turn its result into a stream as well.
  if (response.body !== null && headers["content-type"]?.startsWith("text/event-stream")) {
    return { status: response.status, headers, stream: response.body };
  }
  return { status: response.status, headers, body: await response.text() };
}
