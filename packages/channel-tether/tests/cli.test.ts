// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRevoke } from "../src/admin";
import { LISTEN_TIMING, reconnectDelay } from "../src/cli/listen";
import type { CliIo, ListenTiming } from "../src/cli/io";
import { runCli } from "../src/cli/main";
import { tokenDir, tokenPath } from "../src/cli/tokens";
import type { MailRecord } from "../src/mail";
import { mailboxUri } from "../src/mail";
import {
  challengeOf,
  cleanupDirs,
  fakeDaemon,
  fakeOutbox,
  FORM,
  form,
  pluginHarness,
  PUBLIC,
  RP_ID,
  tempDir
} from "./helpers";

const HOST = new URL(PUBLIC).host;
const OWNER = "lark:oc_owner:abc";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await cleanupDirs();
});

function mailRecord(id: string, ts = "2026-10-04T09:00:00.000Z", from = OWNER): MailRecord {
  return {
    id: `out_${id}`,
    created_at: ts,
    payload: {
      text: `text of ${id}`,
      data: { event_id: id, event_ts: ts, source_session_key: from }
    }
  };
}

/** Standard input as the test feeds it, one line at a time. */
function lineQueue() {
  const waiting: Array<(line: IteratorResult<string>) => void> = [];
  const queued: string[] = [];
  let closed = false;
  return {
    push: (line: string) => {
      const next = waiting.shift();
      if (next) next({ value: line, done: false });
      else queued.push(line);
    },
    lines: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<string>>((resolve) => {
            const line = queued.shift();
            if (line !== undefined) resolve({ value: line, done: false });
            else if (closed) resolve({ value: undefined, done: true });
            else waiting.push(resolve);
          })
      })
    },
    close: () => {
      closed = true;
      for (const next of waiting.splice(0)) next({ value: undefined, done: true });
    }
  };
}

/**
 * A channel on a loopback port whose duoduo keeps assistant outboxes, approving
 * at 07:30 on 2026-10-04, and a CLI whose requests to the public URL reach it.
 */
async function cliHarness(
  options: { sessions?: Array<{ session_key: string; kind: string }> } = {}
) {
  const outbox = fakeOutbox();
  const daemon = await fakeDaemon({
    override: outbox.override,
    ...(options.sessions ? { sessions: options.sessions } : {})
  });
  const clock = { at: Date.parse("2026-10-04T07:30:00.000Z") };
  const h = await pluginHarness({ daemon, now: () => new Date(clock.at) });
  await h.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  closers.push(() => {
    // An open listen holds its connection; close() alone would wait for it.
    h.app.server.closeAllConnections();
    return h.app.close();
  });
  const home = await tempDir("tether-cli-home-");
  const toChannel: typeof fetch = (input, init) => {
    const url = String(input);
    return fetch(url.startsWith(PUBLIC) ? `${base}${url.slice(PUBLIC.length)}` : url, init);
  };
  const out = { stdout: "", stderr: "" };
  const opened: string[] = [];
  const sleeps: number[] = [];
  const stdin = lineQueue();
  const io: CliIo = {
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, "xdg") },
    fetch: toChannel,
    stdout: (text) => {
      out.stdout += text;
    },
    stderr: (text) => {
      out.stderr += text;
    },
    readStdin: async () => "from standard input\n",
    stdinLines: () => ({ lines: stdin.lines, close: stdin.close }),
    openBrowser: (url) => {
      opened.push(url);
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return new Promise((resolve) => setImmediate(resolve));
    },
    random: () => 0.5
  };
  const cli = (...argv: string[]) => runCli(argv, io);
  /** Opens the authorize URL login printed, approves it as `name`, and returns where it sends the browser. */
  const approve = async (name: string) => {
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    const authorize = new URL(opened[0] as string);
    const page = await h.app.inject({
      method: "GET",
      url: `${authorize.pathname}${authorize.search}`
    });
    expect(page.statusCode, page.payload).toBe(200);
    const challenge = challengeOf(page.payload);
    const approved = await h.app.inject({
      method: "POST",
      url: "/authorize",
      headers: FORM,
      payload: form({
        challenge,
        name,
        assertion: JSON.stringify(h.authenticator.get({ rpId: RP_ID, origin: PUBLIC, challenge }))
      })
    });
    expect(approved.statusCode, approved.payload).toBe(302);
    return new URL(String(approved.headers.location));
  };
  /** A full login whose browser returns to the loopback listener. */
  const loggedIn = async (name = "claude-code") => {
    const done = cli("login", PUBLIC);
    const location = await approve(name);
    await fetch(location);
    expect(await done).toBe(0);
    opened.length = 0;
    out.stdout = "";
    out.stderr = "";
    const grants = Object.values(await h.store.readGrants());
    return grants.find((grant) => grant.name === name)!;
  };
  const ring = (grantId: string) =>
    h.bus.publish({ kind: "resource_updated", uri: mailboxUri(grantId) });
  return { h, io, cli, out, opened, sleeps, stdin, approve, loggedIn, outbox, ring, home, base };
}

describe("login", () => {
  it("returns to the loopback listener, stores a 0600 file in a 0700 directory, and names no connection", async () => {
    const t = await cliHarness();
    const done = t.cli("login", PUBLIC);
    const location = await t.approve("claude-code");
    const authorize = new URL(t.opened[0] as string);
    expect(authorize.searchParams.get("client_id")).toBe(`${PUBLIC}/clients/duoduo-tether`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.searchParams.get("resource")).toBe(PUBLIC);
    expect(authorize.searchParams.has("name")).toBe(false);
    expect(t.out.stderr).toContain(authorize.href);
    const answered = await fetch(location);
    expect(answered.status).toBe(200);
    expect(await done).toBe(0);
    const grant = Object.values(await t.h.store.readGrants())[0]!;
    expect(grant).toMatchObject({ name: "claude-code", client_name: "duoduo-tether" });
    const file = tokenPath(t.io.env, HOST);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(tokenDir(t.io.env))).mode & 0o777).toBe(0o700);
    const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, string>;
    expect(Object.keys(stored).sort()).toEqual(["grant", "public_url", "token"]);
    expect(stored.public_url).toBe(PUBLIC);
    expect(stored.grant).toBe(grant.grant_id);
    expect(await fs.readdir(tokenDir(t.io.env))).toEqual([`${HOST}.json`]);
    expect(file).toBe(path.join(t.home, "xdg", "duoduo-tether", `${HOST}.json`));
  });

  it("the token directory is duoduo-tether under XDG_CONFIG_HOME, else under ~/.config", () => {
    expect(tokenDir({ HOME: "/home/a", XDG_CONFIG_HOME: "/x" })).toBe("/x/duoduo-tether");
    expect(tokenDir({ HOME: "/home/a" })).toBe("/home/a/.config/duoduo-tether");
    expect(tokenDir({ HOME: "/home/a", XDG_CONFIG_HOME: "relative" })).toBe(
      "/home/a/.config/duoduo-tether"
    );
  });

  it("takes the address pasted on standard input, approved on another device", async () => {
    const t = await cliHarness();
    const done = t.cli("login", PUBLIC, "--name", "codex");
    const location = await t.approve("codex");
    expect(new URL(t.opened[0] as string).searchParams.get("name")).toBe("codex");
    t.stdin.push("not an address");
    t.stdin.push(location.href);
    expect(await done).toBe(0);
    expect(t.out.stderr).toContain("That is not an address");
    expect(Object.values(await t.h.store.readGrants()).map((grant) => grant.name)).toEqual([
      "codex"
    ]);
  });

  it("refuses a pasted address whose state is not this login's and exchanges nothing", async () => {
    const t = await cliHarness();
    const done = t.cli("login", PUBLIC);
    const location = await t.approve("claude-code");
    location.searchParams.set("state", "another-login");
    t.stdin.push(location.href);
    expect(await done).toBe(1);
    expect(t.out.stderr).toContain("another login attempt");
    expect(await t.h.store.readGrants()).toEqual({});
    expect(await fs.readdir(t.home)).not.toContain("xdg");
  });

  it("a token file that cannot be written revokes the new token and says so", async () => {
    const t = await cliHarness();
    // A file where the directory should be: mkdir fails after the token is issued.
    await fs.mkdir(path.join(t.home, "xdg"), { recursive: true });
    await fs.writeFile(tokenDir(t.io.env), "in the way");
    const done = t.cli("login", PUBLIC);
    await fetch(await t.approve("claude-code"));
    expect(await done).toBe(1);
    expect(t.out.stderr).toContain("The new token was revoked");
    expect(await t.h.store.readGrants()).toEqual({});
  });

  it("refuses a public URL that is not https", async () => {
    const t = await cliHarness();
    expect(await t.cli("login", "http://tether.example.com")).toBe(2);
    expect(t.opened).toEqual([]);
  });
});

describe("tool commands", () => {
  it("context, memory, events, addresses and record each call their tool and print its text", async () => {
    const t = await cliHarness();
    await t.loggedIn();
    expect(await t.cli("memory", "entities/x.md")).toBe(0);
    expect(t.out.stdout).toContain("FILE");
    t.out.stdout = "";
    expect(await t.cli("events", "--date", "2026-10-04", "--types", "a,b", "--jsonl")).toBe(0);
    expect(t.out.stdout).toContain("EVENTS");
    const cat = t.h.daemon.mock.calls.filter(([method]) => method === "spine.cat").at(-1)?.[1];
    expect(cat).toMatchObject({ date: "2026-10-04", types: ["a", "b"] });
    expect(await t.cli("addresses")).toBe(0);
    t.out.stdout = "";
    expect(await t.cli("context")).toBe(0);
    expect(t.out.stdout.length).toBeGreaterThan(0);
    const raw = await t.cli("context", "--json");
    expect(raw).toBe(0);
    const json = JSON.parse(t.out.stdout.trim().split("\n").at(-1) as string) as Record<
      string,
      unknown
    >;
    const { conversation, board_rev: boardRev } = json.structuredContent as Record<string, string>;
    expect(
      await t.cli(
        "record",
        "--conversation",
        conversation,
        "--board-rev",
        boardRev,
        "--said",
        "hi",
        "--did",
        "said hi",
        "--outcome",
        "done"
      ),
      t.out.stderr
    ).toBe(0);
    expect(t.h.daemon.mock.calls.some(([method]) => method === "spine.record")).toBe(true);
  });

  it("mail reads the unread mail, which then counts as read", async () => {
    const t = await cliHarness();
    const grant = await t.loggedIn();
    t.outbox.add(`tether:${grant.name}`, mailRecord("evt_1"));
    expect(await t.cli("mail")).toBe(0);
    expect(t.out.stdout).toContain("text of evt_1");
    expect(t.outbox.unread(`tether:${grant.name}`)).toEqual([]);
  });

  it("send takes the message from standard input when no argument is given", async () => {
    const t = await cliHarness({ sessions: [{ session_key: OWNER, kind: "channel" }] });
    await t.loggedIn();
    expect(await t.cli("send", "--to", OWNER), t.out.stderr).toBe(0);
    const notify = t.h.daemon.mock.calls
      .filter(([method]) => method === "session.notify")
      .at(-1)?.[1];
    expect(String(notify?.message)).toContain("from standard input");
  });

  it("a refusal prints its text to standard error and exits 1; --json prints the raw result", async () => {
    const t = await cliHarness();
    await t.loggedIn();
    expect(await t.cli("send", "--to", "nobody:here", "hello", "--json")).toBe(1);
    expect(t.out.stderr.length).toBeGreaterThan(0);
    const raw = JSON.parse(t.out.stdout.trim()) as {
      isError: boolean;
      _meta: Record<string, unknown>;
    };
    expect(raw.isError).toBe(true);
    expect(typeof raw._meta["duoduo/reason"]).toBe("string");
  });

  it("status checks the token live and names the grant", async () => {
    const t = await cliHarness();
    const grant = await t.loggedIn();
    expect(await t.cli("status")).toBe(0);
    expect(t.out.stdout).toContain(`grant ${grant.grant_id}`);
  });
});

describe("exit codes", () => {
  it("usage errors, no login and several hosts without --host are 2", async () => {
    const t = await cliHarness();
    expect(await t.cli("frobnicate")).toBe(2);
    expect(await t.cli("memory")).toBe(2);
    expect(await t.cli("mail", "--bogus")).toBe(2);
    expect(await t.cli("status")).toBe(2);
    expect(t.out.stderr).toContain("Not logged in");
    await t.loggedIn();
    const other = path.join(tokenDir(t.io.env), "other.example.com.json");
    await fs.writeFile(
      other,
      JSON.stringify({ public_url: "https://other.example.com", grant: "g", token: "t" })
    );
    expect(await t.cli("status")).toBe(2);
    expect(t.out.stderr).toContain("several hosts");
    expect(await t.cli("status", "--host", HOST)).toBe(0);
  });

  it("a revoked token is 3", async () => {
    const t = await cliHarness();
    const grant = await t.loggedIn();
    await runRevoke(
      { store: t.h.store, config: t.h.config, daemon: t.h.daemon, mail: t.h.mail },
      grant.name
    );
    expect(await t.cli("addresses")).toBe(3);
    expect(t.out.stderr).toContain("refused the token");
  });

  it("an unreadable grants file is 503 on the host and 4 here", async () => {
    const t = await cliHarness();
    await t.loggedIn();
    await fs.writeFile(path.join(t.h.stateDir, "grants.json"), "{ not json");
    expect(await t.cli("addresses")).toBe(4);
    expect(t.out.stderr).toContain("HTTP 503");
  });

  it("an unreachable host is 4", async () => {
    const t = await cliHarness();
    await t.loggedIn();
    t.io.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await t.cli("addresses")).toBe(4);
    expect(t.out.stderr).toContain("Could not reach");
  });
});

describe("logout", () => {
  it("revokes the token on the host and deletes the file", async () => {
    const t = await cliHarness();
    await t.loggedIn();
    expect(await t.cli("logout")).toBe(0);
    expect(await t.h.store.readGrants()).toEqual({});
    expect(await fs.readdir(tokenDir(t.io.env))).toEqual([]);
  });

  it("keeps the file when the host cannot be reached, and exits 4", async () => {
    const t = await cliHarness();
    await t.loggedIn();
    t.io.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await t.cli("logout")).toBe(4);
    expect(await fs.readdir(tokenDir(t.io.env))).toEqual([`${HOST}.json`]);
    expect(Object.keys(await t.h.store.readGrants())).toHaveLength(1);
  });
});

describe("listen", () => {
  const fast: ListenTiming = { ...LISTEN_TIMING, retryMinMs: 1, retryMaxMs: 8 };

  it("waits, then exits 0 with one line per unread mail when the mailbox rings", async () => {
    const t = await cliHarness();
    const grant = await t.loggedIn();
    const pulls = () =>
      t.h.daemon.mock.calls.filter(([method]) => method === "channel.pull").length;
    const before = pulls();
    const done = t.cli("listen");
    // Fence: the stream is acknowledged and its first mailbox read found nothing.
    await vi.waitFor(() => expect(pulls()).toBeGreaterThan(before));
    expect(t.out.stdout).toBe("");
    t.outbox.add(`tether:${grant.name}`, mailRecord("evt_1"));
    t.ring(grant.grant_id);
    expect(await done).toBe(0);
    expect(t.out.stdout).toBe(`mail evt_1@2026-10-04 from ${OWNER}\n`);
    // Reporting read nothing: the mail is still unread.
    expect(t.outbox.unread(`tether:${grant.name}`)).toEqual(["out_evt_1"]);
  });

  it("exits at once when unread mail is already waiting", async () => {
    const t = await cliHarness();
    const grant = await t.loggedIn();
    t.outbox.add(
      `tether:${grant.name}`,
      mailRecord("evt_1"),
      mailRecord("evt_job", undefined, "job:x")
    );
    expect(await t.cli("listen")).toBe(0);
    expect(t.out.stdout).toBe(`mail evt_1@2026-10-04 from ${OWNER}\n`);
  });

  it("--follow prints each mail once, across repeated rings and a reconnect", async () => {
    const t = await cliHarness();
    t.io.listenTiming = fast;
    const grant = await t.loggedIn();
    const inbox = `tether:${grant.name}`;
    const done = t.cli("listen", "--follow");
    t.outbox.add(inbox, mailRecord("evt_1"));
    t.ring(grant.grant_id);
    await vi.waitFor(() => expect(t.out.stdout).toBe(`mail evt_1@2026-10-04 from ${OWNER}\n`));
    t.ring(grant.grant_id);
    t.ring(grant.grant_id);
    // The relay drops the stream; the command reconnects inside the process.
    t.h.app.server.closeAllConnections();
    await vi.waitFor(() => expect(t.out.stderr).toContain("reconnecting"));
    t.outbox.add(inbox, mailRecord("evt_2", "2026-10-04T09:30:00.000Z"));
    t.ring(grant.grant_id);
    await vi.waitFor(() =>
      expect(t.out.stdout).toBe(
        `mail evt_1@2026-10-04 from ${OWNER}\nmail evt_2@2026-10-04 from ${OWNER}\n`
      )
    );
    // A revoked connection ends it with 3.
    await runRevoke(
      { store: t.h.store, config: t.h.config, daemon: t.h.daemon, mail: t.h.mail },
      grant.name
    );
    expect(await done).toBe(3);
    expect(t.out.stderr).toContain("refused the token");
  });

  it("a 503 reconnects; the mail is reported once the host can read its grants again", async () => {
    const t = await cliHarness();
    t.io.listenTiming = fast;
    const grant = await t.loggedIn();
    const grantsFile = path.join(t.h.stateDir, "grants.json");
    const grants = await fs.readFile(grantsFile, "utf8");
    await fs.writeFile(grantsFile, "{ not json");
    const done = t.cli("listen");
    await vi.waitFor(() => expect(t.out.stderr).toContain("HTTP 503"));
    t.outbox.add(`tether:${grant.name}`, mailRecord("evt_1"));
    await fs.writeFile(grantsFile, grants);
    expect(await done).toBe(0);
    expect(t.out.stdout).toBe(`mail evt_1@2026-10-04 from ${OWNER}\n`);
  });

  it("a silent stream counts as dropped after the idle timeout", async () => {
    const t = await cliHarness();
    t.io.listenTiming = { ...fast, idleMs: 50 };
    const grant = await t.loggedIn();
    const done = t.cli("listen");
    await vi.waitFor(() => expect(t.out.stderr).toContain("silent"));
    t.outbox.add(`tether:${grant.name}`, mailRecord("evt_1"));
    t.ring(grant.grant_id);
    expect(await done).toBe(0);
  });

  it("an HTTP 4xx other than 401 exits 4 without reconnecting", async () => {
    const t = await cliHarness();
    await t.loggedIn();
    t.io.fetch = async () => new Response("", { status: 404 });
    expect(await t.cli("listen")).toBe(4);
    expect(t.sleeps).toEqual([]);
  });

  it("reconnect delays double from the minimum to the maximum, under full jitter", () => {
    const ceilings = [0, 1, 2, 3, 4, 5, 6, 7].map((attempt) =>
      reconnectDelay(attempt, LISTEN_TIMING, 0.999999)
    );
    expect(ceilings).toEqual([999, 1999, 3999, 7999, 15999, 31999, 59999, 59999]);
    expect(reconnectDelay(3, LISTEN_TIMING, 0)).toBe(0);
    expect(LISTEN_TIMING.idleMs).toBe(45_000);
  });
});
