// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * `@openduo/channel-tether` — the tether channel: the only public surface of a
 * duoduo host, for the owner's other AI assistants.
 * One MCP endpoint behind OAuth with passkey approval; each tool is one call
 * to the daemon over the unix socket. The daemon does not import this package
 * and does not know OAuth exists.
 *
 *   node dist/plugin.js            serve: routes on 127.0.0.1:<ALADUO_TETHER_PORT>,
 *                                  plus the admin socket
 *   node dist/plugin.js <verb> …   one host verb (list, revoke, status, passkey,
 *                                  client, doorbell), through the running plugin's
 *                                  admin socket
 */

import { promises as fs, readFileSync } from "node:fs";
import { InMemoryServerEventBus } from "@modelcontextprotocol/server";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handleAdmin, listenAdmin, runVerbProcess } from "./admin";
import { isLoopbackHost, listenAddress, parseTetherConfig } from "./config";
import { socketDaemon } from "./forward";
import { createTetherApp } from "./listener";
import { Mailroom, socketPull } from "./mail";
import { Store, type Logger } from "./store";
import { renderNonLoopbackBind } from "./texts";

/**
 * `<runtime>/plugins/channels/tether/`: the bundle runs from `package/dist/`, and
 * `state/` and `run/` sit beside `package/`, so a reinstall keeps them.
 */
export function pluginRootOf(entryUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(entryUrl)), "..", "..");
}

export function adminSocketPath(pluginRoot: string): string {
  return path.join(pluginRoot, "run", "admin.sock");
}

/** `serverInfo.version`: the plugin's own package version. */
function pluginVersion(entryUrl: string): string {
  try {
    const file = path.join(path.dirname(fileURLToPath(entryUrl)), "..", "package.json");
    return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

function stamp(level: string, message: string, fields?: Record<string, unknown>): void {
  process.stderr.write(
    `${new Date().toISOString()} ${level} ${message}${fields ? ` ${JSON.stringify(fields)}` : ""}\n`
  );
}

const log: Logger & { info: (message: string) => void } = {
  warn: (message, fields) => stamp("WARN", message, fields),
  info: (message) => stamp("INFO", message)
};

async function serve(pluginRoot: string, env: NodeJS.ProcessEnv): Promise<number> {
  const configured = parseTetherConfig(env);
  if (!configured.ok) {
    process.stderr.write(`tether channel refused to start: ${configured.reason}\n`);
    return 1;
  }
  const socketPath = env.ALADUO_DAEMON_SOCKET?.trim();
  if (!socketPath) {
    process.stderr.write(
      "tether channel refused to start: ALADUO_DAEMON_SOCKET is not set; start it with duoduo channel tether start\n"
    );
    return 1;
  }
  const { config } = configured;
  const store = new Store(path.join(pluginRoot, "state"), log);
  await store.init();
  const daemon = socketDaemon(socketPath);
  // The Mailroom publishes a mail's resource_updated here; listen streams read it.
  const bus = new InMemoryServerEventBus();
  const mail = new Mailroom({
    store,
    daemon,
    openPull: socketPull(socketPath),
    reconnectMs: config.pullWaitMs,
    workspace: store.stateDir,
    log,
    callbackLimits: config.cimd,
    bus
  });
  const app = createTetherApp({
    config,
    store,
    daemon,
    version: pluginVersion(import.meta.url),
    mail,
    bus
  });
  await app.ready();

  const runDir = path.join(pluginRoot, "run");
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  await fs.chmod(runDir, 0o700);
  const admin = await listenAdmin(adminSocketPath(pluginRoot), (request) =>
    handleAdmin({ store, config, daemon, mail }, request)
  );

  // Every assistant's session exists and is streamed before any assistant is served.
  await mail.start();
  const address = listenAddress(config.host, config.port);
  if (!isLoopbackHost(config.host)) log.warn(renderNonLoopbackBind(address));
  await app.listen({ host: config.host, port: config.port });
  log.info(
    `tether channel listening on ${address}; public URL` +
      ` ${config.publicUrl ?? "not set: no OAuth or MCP route is served"}`
  );

  const shutdown = async (): Promise<void> => {
    await mail.stop().catch(() => undefined);
    await app.close().catch(() => undefined);
    await new Promise<void>((resolve) => admin.close(() => resolve()));
    await fs.rm(adminSocketPath(pluginRoot), { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  return await new Promise<number>(() => undefined);
}

async function main(): Promise<void> {
  const pluginRoot = pluginRootOf(import.meta.url);
  const [verb, ...args] = process.argv.slice(2);
  if (verb === undefined) {
    process.exitCode = await serve(pluginRoot, process.env);
    return;
  }
  const output = await runVerbProcess(verb, args, process.env, adminSocketPath(pluginRoot));
  process.stdout.write(output.stdout);
  process.stderr.write(output.stderr);
  process.exitCode = output.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(
      `tether channel failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
}
