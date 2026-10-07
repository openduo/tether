// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * `listen`: a subscriptions/listen stream on the assistant's mailbox, and a
 * read of the mailbox resource (ids and senders, nothing acknowledged) every
 * time the stream is acknowledged and every time it rings. Reading on every
 * acknowledgment reports mail that arrived while no stream was open.
 */

import { isRecord } from "@openduo/protocol";
import { LISTEN_KEEP_ALIVE_MS, mailboxUri } from "../client-contract";
import { httpFailure, postMcp, rpc, sseMessages, unreachable } from "./http";
import { CliExit, EXIT, type CliIo, type ListenTiming } from "./io";
import type { Connection } from "./tokens";

export const LISTEN_TIMING: ListenTiming = {
  // Derived: three missed keep-alives. A relay that drops a connection can
  // leave it half open, with no error ever arriving; silence is the only sign.
  idleMs: 3 * LISTEN_KEEP_ALIVE_MS,
  // Judgment, not measurement: soon enough after a short relay drop, and at
  // most a minute apart while a host is down for longer.
  retryMinMs: 1_000,
  retryMaxMs: 60_000
};

/** Full jitter: a uniform delay below a ceiling that doubles per failed attempt. */
export function reconnectDelay(attempt: number, timing: ListenTiming, random: number): number {
  const ceiling = Math.min(timing.retryMaxMs, timing.retryMinMs * 2 ** attempt);
  return Math.floor(random * ceiling);
}

type Unread = { id: string; from: string };

type Outcome = { exit: number } | { drop: string; acknowledged: boolean };

function unreadOf(result: Record<string, unknown>): Unread[] | null {
  const contents = Array.isArray(result.contents) ? result.contents : [];
  const first: unknown = contents[0];
  if (!isRecord(first) || typeof first.text !== "string") return null;
  try {
    const body = JSON.parse(first.text) as unknown;
    if (!isRecord(body) || !Array.isArray(body.unread)) return null;
    return body.unread.filter(
      (mail): mail is Unread =>
        isRecord(mail) && typeof mail.id === "string" && typeof mail.from === "string"
    );
  } catch {
    return null;
  }
}

class Stream {
  private readonly abort = new AbortController();
  private idle: ReturnType<typeof setTimeout> | undefined;
  private silent = false;
  private decided: Outcome | null = null;
  private acknowledged = false;
  private peeking: Promise<void> | null = null;
  private peekAgain = false;

  constructor(
    private readonly io: CliIo,
    private readonly connection: Connection,
    private readonly follow: boolean,
    private readonly timing: ListenTiming,
    /** Mail ids already printed by this process (follow mode). */
    private readonly seen: Set<string>
  ) {}

  private arm(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.silent = true;
      this.abort.abort();
    }, this.timing.idleMs);
  }

  private decide(outcome: Outcome): void {
    this.decided ??= outcome;
    this.abort.abort();
  }

  /** Reads the mailbox once more after the current read when a ring arrives mid-read. */
  private peek(): void {
    if (this.peeking !== null) {
      this.peekAgain = true;
      return;
    }
    this.peeking = (async () => {
      do {
        this.peekAgain = false;
        await this.readMailbox();
      } while (this.peekAgain && this.decided === null);
      this.peeking = null;
    })();
  }

  private async readMailbox(): Promise<void> {
    const uri = mailboxUri(this.connection.grant);
    let unread: Unread[] | null;
    try {
      unread = unreadOf(await rpc(this.io, this.connection, "resources/read", { uri }, uri));
    } catch (error) {
      if (error instanceof CliExit && error.code === EXIT.token) {
        this.io.stderr(`${error.message}\n`);
        this.decide({ exit: EXIT.token });
      } else {
        const why = error instanceof Error ? error.message : String(error);
        this.decide({ drop: `the mailbox could not be read (${why})`, acknowledged: false });
      }
      return;
    }
    if (unread === null) {
      this.decide({ drop: "the mailbox answered no unread list", acknowledged: false });
      return;
    }
    const fresh = unread.filter((mail) => !this.seen.has(mail.id));
    for (const mail of fresh) this.io.stdout(`mail ${mail.id} from ${mail.from}\n`);
    if (!this.follow) {
      if (fresh.length > 0) this.decide({ exit: EXIT.ok });
      return;
    }
    // Only what is still unread is remembered: read mail never comes back.
    this.seen.clear();
    for (const mail of unread) this.seen.add(mail.id);
  }

  private onMessage(message: Record<string, unknown>, uri: string): void {
    if (isRecord(message.error)) {
      this.io.stderr(`${String(message.error.message ?? "The listen was refused.")}\n`);
      this.decide({ exit: EXIT.refused });
      return;
    }
    if (message.method === "notifications/subscriptions/acknowledged") {
      this.acknowledged = true;
      this.peek();
    } else if (
      message.method === "notifications/resources/updated" &&
      isRecord(message.params) &&
      message.params.uri === uri
    ) {
      this.peek();
    }
  }

  async run(): Promise<Outcome> {
    const uri = mailboxUri(this.connection.grant);
    this.arm();
    try {
      return await this.read(uri);
    } finally {
      clearTimeout(this.idle);
      this.abort.abort();
    }
  }

  private async read(uri: string): Promise<Outcome> {
    let response: Response;
    try {
      response = await postMcp(
        this.io,
        this.connection,
        "subscriptions/listen",
        { notifications: { resourceSubscriptions: [uri] } },
        undefined,
        this.abort.signal
      );
    } catch (error) {
      return {
        drop: this.silent ? "no answer" : unreachable(this.connection, error).message,
        acknowledged: false
      };
    }
    if (!response.ok) {
      const failure = await httpFailure(this.connection, response);
      if (response.status >= 500) return { drop: failure.message, acknowledged: false };
      this.io.stderr(`${failure.message}\n`);
      return { exit: failure.code };
    }
    if (!response.headers.get("content-type")?.startsWith("text/event-stream")) {
      // A listen refused before it started answers one JSON-RPC message.
      const [message] = sseMessages(`data: ${await response.text()}\n\n`);
      if (message !== undefined && isRecord(message.error)) {
        this.io.stderr(`${String(message.error.message ?? "The listen was refused.")}\n`);
        return { exit: EXIT.refused };
      }
      this.io.stderr(`${this.connection.publicUrl} answered the listen without a stream.\n`);
      return { exit: EXIT.unreachable };
    }
    let buffer = "";
    let ended = "the stream ended";
    try {
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.arm();
        buffer += value;
        const cut = buffer.lastIndexOf("\n\n");
        if (cut === -1) continue;
        for (const message of sseMessages(buffer.slice(0, cut))) this.onMessage(message, uri);
        buffer = buffer.slice(cut + 2);
      }
    } catch (error) {
      if (this.decided === null) {
        ended = this.silent
          ? `the stream was silent for ${this.timing.idleMs / 1000} s`
          : `the stream broke (${error instanceof Error ? error.message : String(error)})`;
      }
    }
    // A read in flight decides how this stream ends: never report it after the reconnect starts.
    while (this.peeking !== null) await this.peeking;
    return this.decided ?? { drop: ended, acknowledged: this.acknowledged };
  }
}

export async function listen(io: CliIo, connection: Connection, follow: boolean): Promise<number> {
  const timing = io.listenTiming ?? LISTEN_TIMING;
  const seen = new Set<string>();
  let attempt = 0;
  for (;;) {
    const outcome = await new Stream(io, connection, follow, timing, seen).run();
    if ("exit" in outcome) return outcome.exit;
    if (outcome.acknowledged) attempt = 0;
    const delay = reconnectDelay(attempt, timing, io.random());
    attempt += 1;
    io.stderr(`listen: ${outcome.drop}; reconnecting in ${(delay / 1000).toFixed(1)} s\n`);
    await io.sleep(delay);
  }
}
