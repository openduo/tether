// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  callAdmin,
  handleAdmin,
  listenAdmin,
  passkeyFingerprint,
  runVerbProcess,
  type AdminDeps
} from "../src/admin";
import { DEFAULTS, isLoopbackHost, parseTetherConfig } from "../src/config";
import { DaemonUnreachableError } from "../src/forward";
import {
  PASSKEY_REMOVE_LAST_GRANTS_TEXT,
  renderPasskeyAddInSession,
  renderTodayCounts
} from "../src/texts";
import {
  CHATGPT,
  CLAUDE,
  CLAUDE_REDIRECT,
  cleanupDirs,
  clientsOf,
  connect,
  CURSOR,
  CURSOR_REDIRECT,
  fakeDaemon,
  GROK_REDIRECT,
  grantNamed,
  pluginHarness,
  PUBLIC,
  SoftAuthenticator,
  tempDir
} from "./helpers";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await cleanupDirs();
});

type Harness = Awaited<ReturnType<typeof pluginHarness>>;

function deps(h: Harness, overrides: Partial<AdminDeps> = {}): AdminDeps {
  return {
    store: h.store,
    config: h.config,
    daemon: h.daemon,
    mail: h.mail,
    ...overrides
  };
}

const verb = (h: Harness, name: string, ...args: string[]) =>
  handleAdmin(deps(h), { verb: name, args });

describe("list and revoke", () => {
  it("list shows one row per grant with its name, client and grant ids, and never a token", async () => {
    const h = await pluginHarness();
    const { accessToken } = await connect(h.app, h.authenticator, { name: "dots" });
    const grant = grantNamed(await h.store.readGrants(), "dots");
    const output = await verb(h, "list");
    expect(output.exitCode).toBe(0);
    for (const fact of ["dots", CHATGPT, grant.grant_id, "ChatGPT"])
      expect(output.stdout).toContain(fact);
    expect(output.stdout).not.toContain(accessToken);
    expect(output.stdout).not.toContain(grant.token_digest);
  });

  it("revoke by name deletes the grant and frees its name", async () => {
    const h = await pluginHarness();
    await connect(h.app, h.authenticator, { name: "dots" });
    expect((await verb(h, "revoke", "dots")).exitCode).toBe(0);
    expect(await h.store.readGrants()).toEqual({});
    const claude = await connect(h.app, h.authenticator, {
      name: "dots",
      clientId: CLAUDE,
      redirectUri: CLAUDE_REDIRECT
    });
    expect(claude.token.statusCode).toBe(200);
  });

  it("revoke of one assistant leaves the other assistant of the same client connected", async () => {
    const h = await pluginHarness();
    const mcp = (token: string) =>
      h.app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream"
        },
        payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      });
    const grok = await connect(h.app, h.authenticator, {
      name: "grok",
      clientId: CURSOR,
      redirectUri: GROK_REDIRECT
    });
    const cursor = await connect(h.app, h.authenticator, {
      name: "cursor",
      clientId: CURSOR,
      redirectUri: CURSOR_REDIRECT
    });
    const output = await verb(h, "revoke", "grok");
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain(CURSOR);
    expect((await mcp(grok.accessToken)).statusCode).toBe(401);
    expect((await mcp(cursor.accessToken)).statusCode).toBe(200);
    expect(Object.values(await h.store.readGrants()).map((grant) => grant.name)).toEqual([
      "cursor"
    ]);
  });

  it("revoke takes a name, not a client: a client id or host changes nothing", async () => {
    const h = await pluginHarness();
    await connect(h.app, h.authenticator, { name: "dots" });
    for (const target of [CHATGPT, "chatgpt.com", "nobody"]) {
      expect((await verb(h, "revoke", target)).exitCode).toBe(2);
    }
    expect(clientsOf(await h.store.readGrants())).toEqual([CHATGPT]);
  });

  it("list shows two assistants of one client, each with its client", async () => {
    const h = await pluginHarness();
    await connect(h.app, h.authenticator, {
      name: "grok",
      clientId: CURSOR,
      redirectUri: GROK_REDIRECT
    });
    await connect(h.app, h.authenticator, {
      name: "cursor",
      clientId: CURSOR,
      redirectUri: CURSOR_REDIRECT
    });
    const output = await verb(h, "list");
    const lines = output.stdout.split("\n");
    expect(lines.filter((line) => line !== "" && !line.startsWith(" "))).toEqual([
      "cursor",
      "grok"
    ]);
    expect(
      lines.filter((line) => line === `  client      "Cursor" (its own claim) · "${CURSOR}"`)
    ).toHaveLength(2);
  });
});

describe("client-controlled strings in verbs", () => {
  it("list prints a client_name with a newline and an ANSI escape as JSON escapes", async () => {
    const h = await pluginHarness();
    await connect(h.app, h.authenticator, { name: "dots" });
    const grants = await h.store.readGrants();
    const grant = grantNamed(grants, "dots");
    const hostile = 'Chat\nGPT\u001b[2J"x"';
    grants[grant.grant_id] = { ...grant, client_name: hostile };
    await h.store.writeGrants(grants);
    const output = await verb(h, "list");
    expect(output.stdout).toContain(`  client      ${JSON.stringify(hostile)} (its own claim)`);
    expect(output.stdout).toContain("\\n");
    expect(output.stdout).toContain("\\u001b[2J");
    expect(output.stdout).not.toContain("\u001b");
    expect(output.stdout).not.toContain("Chat\nGPT");
  });
});

describe("status", () => {
  it("counts today's records per name and client from one spine.cat", async () => {
    const rows = [
      JSON.stringify({ session_key: "dots:c1", client: { id: CHATGPT, grant: "g" } }),
      JSON.stringify({ session_key: "dots:c2", client: { id: CHATGPT, grant: "g" } }),
      JSON.stringify({ session_key: "muse:c1" })
    ];
    const daemon = await fakeDaemon({
      override: (method) =>
        method === "spine.cat" ? { result: { text: `${rows.join("\n")}\n` } } : undefined
    });
    const h = await pluginHarness({ daemon });
    const output = await handleAdmin(deps(h), {
      verb: "status",
      args: []
    });
    expect(daemon.mock.calls.filter(([method]) => method === "spine.cat")).toHaveLength(1);
    expect(output.stdout).toContain(
      renderTodayCounts([
        {
          name: "dots",
          client: "chatgpt.com",
          records: 2,
          bytes: Buffer.byteLength(rows[0]) + Buffer.byteLength(rows[1])
        },
        { name: "muse", client: "on the host", records: 1, bytes: Buffer.byteLength(rows[2]) }
      ])
    );
    expect(output.stdout).toContain(PUBLIC);
    expect(output.stdout).toContain(`127.0.0.1:${h.config.port}`);
  });
});

describe("status per client", () => {
  it("two clients on one host are two rows, each showing the host", async () => {
    const other = "https://chatgpt.com/oauth/other.json";
    const rows = [
      JSON.stringify({ session_key: "dots:c1", client: { id: CHATGPT, grant: "g" } }),
      JSON.stringify({ session_key: "dots:c2", client: { id: other, grant: "h" } })
    ];
    const daemon = await fakeDaemon({
      override: (method) =>
        method === "spine.cat" ? { result: { text: `${rows.join("\n")}\n` } } : undefined
    });
    const h = await pluginHarness({ daemon });
    const output = await verb(h, "status");
    expect(output.stdout).toContain(
      renderTodayCounts([
        { name: "dots", client: "chatgpt.com", records: 1, bytes: Buffer.byteLength(rows[0]) },
        { name: "dots", client: "chatgpt.com", records: 1, bytes: Buffer.byteLength(rows[1]) }
      ])
    );
  });
});

describe("grants bound to an earlier public URL", () => {
  it("list marks the refused grant and status counts it apart from the connected ones", async () => {
    const h = await pluginHarness();
    await connect(h.app, h.authenticator, { name: "dots" });
    await connect(h.app, h.authenticator, {
      name: "muse",
      clientId: CLAUDE,
      redirectUri: CLAUDE_REDIRECT
    });
    const old = "https://old.example.com";
    const grants = await h.store.readGrants();
    grantNamed(grants, "dots").resource = old;
    await h.store.writeGrants(grants);

    // A row starts at an unindented line: the assistant name.
    const rows = new Map<string, string[]>();
    let current: string[] = [];
    for (const line of (await verb(h, "list")).stdout.split("\n")) {
      if (line !== "" && !line.startsWith(" ")) rows.set(line, (current = []));
      else current.push(line);
    }
    const refusedLines = (name: string) =>
      rows.get(name)!.filter((line) => line.trimStart().startsWith("refused"));
    expect(refusedLines("dots")).toHaveLength(1);
    expect(refusedLines("dots")[0]).toContain(old);
    expect(refusedLines("muse")).toHaveLength(0);

    const counts = (await verb(h, "status")).stdout
      .split("\n")
      .find((line) => line.startsWith("Passkeys"))!;
    expect(counts).toMatch(/connected assistants 1 · refused assistants 1\b/);
  });

  it("status shows no refused count when every grant matches", async () => {
    const h = await pluginHarness();
    await connect(h.app, h.authenticator, { name: "dots" });
    const counts = (await verb(h, "status")).stdout
      .split("\n")
      .find((line) => line.startsWith("Passkeys"))!;
    expect(counts).toMatch(/connected assistants 1$/);
  });
});

describe("status before the first passkey", () => {
  it.each([
    ["a public URL and no passkey warns", PUBLIC, 0, true],
    ["a public URL and a passkey is silent", PUBLIC, 1, false],
    ["no public URL is silent", null, 0, false]
  ])("%s", async (_label, publicUrl, passkeys, warns) => {
    const h = await pluginHarness({ config: { publicUrl } });
    if (passkeys === 0) await h.store.writePasskeys([]);
    const output = await verb(h, "status");
    expect(output.exitCode).toBe(0);
    const lines = output.stdout.split("\n");
    const warning = lines.filter((line) => line.startsWith("No passkey yet"));
    expect(warning).toHaveLength(warns ? 1 : 0);
    // Names the verbs that issue and show passkeys, both of which exist.
    for (const line of warning) {
      expect(line).toContain("duoduo channel tether passkey add");
      expect(line).toContain("duoduo channel tether passkey list");
    }
  });
});

describe("status without a daemon", () => {
  it("still prints, saying today's counts are unavailable", async () => {
    const daemon = await fakeDaemon({
      override: (method) => {
        if (method === "spine.cat") throw new DaemonUnreachableError("ENOENT");
        return undefined;
      }
    });
    const h = await pluginHarness({ daemon });
    const output = await verb(h, "status");
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("unavailable");
  });
});

describe("passkeys", () => {
  // Inside a session only while no grant exists; the decision is the plugin's.
  async function passkeyAddVia(h: Harness, inSession: boolean) {
    const dir = await tempDir("tether-admin-sock-");
    const socket = path.join(dir, "admin.sock");
    const server = await listenAdmin(socket, (request) => handleAdmin(deps(h), request));
    closers.push(() => new Promise((resolve) => server.close(resolve)));
    const env = inSession ? { ALADUO_CALLER_IN_SESSION: "1" } : {};
    const output = await runVerbProcess("passkey", ["add"], env, socket);
    return { output, secret: /\/enroll#(\S+)/.exec(output.stdout)?.[1] ?? null };
  }

  it("passkey add inside a session with no grant issues a link", async () => {
    const h = await pluginHarness();
    const { output, secret } = await passkeyAddVia(h, true);
    expect(output.exitCode).toBe(0);
    expect(await h.store.isCurrentEnrollSecret(secret)).toBe(true);
  });

  it("passkey add inside a session while a grant exists is refused and issues nothing", async () => {
    const h = await pluginHarness();
    await connect(h.app, h.authenticator, { name: "dots" });
    const { output } = await passkeyAddVia(h, true);
    expect(output).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: `${renderPasskeyAddInSession(1)}\n`
    });
    await expect(fs.stat(path.join(h.stateDir, "enroll.json"))).rejects.toThrow();
  });

  it("passkey add outside a session issues a link while grants exist", async () => {
    const h = await pluginHarness();
    await connect(h.app, h.authenticator, { name: "dots" });
    const { output, secret } = await passkeyAddVia(h, false);
    expect(output.exitCode).toBe(0);
    expect(await h.store.isCurrentEnrollSecret(secret)).toBe(true);
  });

  it.each([
    ["inside a session is voided", true, false],
    ["outside a session survives", false, true]
  ])("at the first grant commit, a link issued %s", async (_label, inSession, survives) => {
    const h = await pluginHarness();
    const { secret } = await passkeyAddVia(h, inSession);
    expect(await h.store.isCurrentEnrollSecret(secret)).toBe(true);
    expect((await connect(h.app, h.authenticator, { name: "dots" })).token.statusCode).toBe(200);
    expect(await h.store.isCurrentEnrollSecret(secret)).toBe(survives);
  });

  it("passkey add needs a public URL", async () => {
    const h = await pluginHarness({ config: { publicUrl: null } });
    const output = await verb(h, "passkey", "add");
    expect(output.exitCode).toBe(1);
    expect(output.stdout).toBe("");
  });

  it("passkey add prints one link whose fragment is the only copy of the secret", async () => {
    const h = await pluginHarness();
    const output = await verb(h, "passkey", "add");
    const link = /(https:\S+\/enroll#(\S+))/.exec(output.stdout);
    expect(link?.[1].startsWith(`${PUBLIC}/enroll#`)).toBe(true);
    const secret = link?.[2] ?? "";
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await fs.readFile(path.join(h.stateDir, "enroll.json"), "utf8");
    expect(stored).not.toContain(secret);
    expect(await h.store.isCurrentEnrollSecret(secret)).toBe(true);
  });

  it("list shows a fingerprint per passkey; remove takes it and keeps grants", async () => {
    const h = await pluginHarness();
    await connect(h.app, h.authenticator, { name: "dots" });
    const second = new SoftAuthenticator();
    await h.store.writePasskeys([...(await h.store.readPasskeys()), second.passkey("phone")]);
    const fingerprint = passkeyFingerprint(h.authenticator.id);
    expect((await verb(h, "passkey", "list")).stdout).toContain(fingerprint);
    expect((await verb(h, "passkey", "remove", fingerprint)).exitCode).toBe(0);
    expect((await h.store.readPasskeys()).map((passkey) => passkey.id)).toEqual([second.id]);
    expect(clientsOf(await h.store.readGrants())).toEqual([CHATGPT]);
    expect((await verb(h, "passkey", "remove", fingerprint)).exitCode).toBe(2);
  });

  it.each([
    ["inside a session is refused", true, 2, 1],
    ["from a terminal goes", false, 0, 0]
  ])("removing the last passkey %s", async (_label, inSession, exitCode, left) => {
    const h = await pluginHarness();
    const output = await handleAdmin(deps(h), {
      verb: "passkey",
      args: ["remove", h.authenticator.id],
      in_session: inSession
    });
    expect(output.exitCode).toBe(exitCode);
    expect(await h.store.readPasskeys()).toHaveLength(left);
  });

  it.each([
    ["inside a session", true],
    ["from a terminal", false]
  ])("removing the last passkey %s while a grant exists is refused", async (_label, inSession) => {
    const h = await pluginHarness();
    await connect(h.app, h.authenticator, { name: "dots" });
    const output = await handleAdmin(deps(h), {
      verb: "passkey",
      args: ["remove", passkeyFingerprint(h.authenticator.id)],
      in_session: inSession
    });
    expect(output).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: `${PASSKEY_REMOVE_LAST_GRANTS_TEXT}\n`
    });
    expect((await h.store.readPasskeys()).map((passkey) => passkey.id)).toEqual([
      h.authenticator.id
    ]);
  });

  it("removing the last passkey from a terminal goes once every assistant is revoked", async () => {
    const h = await pluginHarness();
    await connect(h.app, h.authenticator, { name: "dots" });
    expect((await verb(h, "revoke", "dots")).exitCode).toBe(0);
    expect((await verb(h, "passkey", "remove", h.authenticator.id)).exitCode).toBe(0);
    expect(await h.store.readPasskeys()).toEqual([]);
  });

  it("a passkey that is not the last can be removed inside a session", async () => {
    const h = await pluginHarness();
    const other = new SoftAuthenticator();
    await h.store.writePasskeys([h.authenticator.passkey(), other.passkey()]);
    const output = await handleAdmin(deps(h), {
      verb: "passkey",
      args: ["remove", other.id],
      in_session: true
    });
    expect(output.exitCode).toBe(0);
    expect((await h.store.readPasskeys()).map((p) => p.id)).toEqual([h.authenticator.id]);
  });
});

describe("the admin socket and the verb process", () => {
  it("a verb reaches the running plugin through a 0600 socket", async () => {
    const h = await pluginHarness();
    const dir = await tempDir("tether-admin-sock-");
    const socket = path.join(dir, "admin.sock");
    const server = await listenAdmin(socket, (request) => handleAdmin(deps(h), request));
    closers.push(() => new Promise((resolve) => server.close(resolve)));
    expect((await fs.stat(socket)).mode & 0o777).toBe(0o600);
    const output = await runVerbProcess("list", [], {}, socket);
    expect(output.exitCode).toBe(0);
    expect(await callAdmin(socket, { verb: "status", args: [] })).toMatchObject({ exitCode: 0 });
  });

  it("with no plugin running, a configuration problem is named", async () => {
    const dir = await tempDir("tether-admin-none-");
    const output = await runVerbProcess(
      "status",
      [],
      { ALADUO_TETHER_PORT: "20240", ALADUO_TETHER_CHALLENGE_CAP: "many" },
      path.join(dir, "admin.sock")
    );
    expect(output.exitCode).toBe(1);
    expect(output.stderr).toContain("ALADUO_TETHER_CHALLENGE_CAP");
  });
});

describe("config", () => {
  const BASE = {
    ALADUO_TETHER_PORT: "20240",
    ALADUO_TETHER_PUBLIC_URL: PUBLIC,
    ALADUO_TETHER_REQUEST_LIMIT_BYTES: "1048576",
    ALADUO_TETHER_CHALLENGE_CAP: "8"
  };

  it("parses a full configuration; the two lifetimes default to RFC 6749's ten minutes", () => {
    const parsed = parseTetherConfig({
      ...BASE,
      ALADUO_TETHER_CIMD_TIMEOUT_MS: "5000",
      ALADUO_TETHER_CIMD_MAX_BYTES: "65536"
    });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.config.cimd).toEqual({ timeoutMs: 5000, maxBytes: 65536 });
    expect(parsed.config.codeLifetimeMs).toBe(600_000);
    expect(parsed.config.challengeLifetimeMs).toBe(600_000);
  });

  it("an unset number takes the owner's default", () => {
    const parsed = parseTetherConfig({ ALADUO_TETHER_PORT: "20240" });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.config.requestLimitBytes).toBe(DEFAULTS.requestLimitBytes);
    expect(parsed.config.challengeCap).toBe(DEFAULTS.challengeCap);
    expect(parsed.config.cimd).toEqual({
      timeoutMs: DEFAULTS.cimdTimeoutMs,
      maxBytes: DEFAULTS.cimdMaxBytes
    });
  });

  it("a value that is not a positive whole number is refused and named", () => {
    const parsed = parseTetherConfig({ ...BASE, ALADUO_TETHER_REQUEST_LIMIT_BYTES: "1MB" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("ALADUO_TETHER_REQUEST_LIMIT_BYTES");
  });

  it("binds loopback unless ALADUO_TETHER_HOST names another address", () => {
    const parsed = parseTetherConfig(BASE);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.config.host).toBe("127.0.0.1");
    expect(isLoopbackHost(parsed.config.host)).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
  });

  it.each(["localhost", "duoduo.lan", "192.168.1.300", "[::1]"])(
    "refuses ALADUO_TETHER_HOST=%s, which is not an IP literal",
    (host) => {
      const refused = parseTetherConfig({ ...BASE, ALADUO_TETHER_HOST: host });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.reason).toContain("ALADUO_TETHER_HOST");
    }
  );

  /** A non-loopback IPv4 address of this machine, if it has one. */
  const lanAddress = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;

  it.skipIf(lanAddress === undefined)("accepts a non-loopback IP and binds it", async () => {
    const parsed = parseTetherConfig({ ...BASE, ALADUO_TETHER_HOST: lanAddress! });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.config.host).toBe(lanAddress);
    expect(isLoopbackHost(parsed.config.host)).toBe(false);
    const h = await pluginHarness({ config: { host: parsed.config.host } });
    await h.app.listen({ host: h.config.host, port: 0 });
    try {
      // The bound socket, not a round trip: a host firewall may reset LAN connections to node.
      expect((h.app.server.address() as { address: string }).address).toBe(lanAddress);
    } finally {
      await h.app.close();
    }
  });

  it("refuses to start without a port", () => {
    const noPort: Record<string, string> = { ...BASE };
    delete noPort.ALADUO_TETHER_PORT;
    const refused = parseTetherConfig(noPort);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("ALADUO_TETHER_PORT");
  });
});
