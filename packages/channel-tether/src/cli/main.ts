// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * duoduo-tether: each command is one MCP tool of a tether host, plus login,
 * logout, status and listen. docs/cli.md is the contract.
 */

import { isRecord } from "@openduo/protocol";
import { mailboxUri } from "../client-contract";
import { rpc, type Json } from "./http";
import { CliExit, EXIT, type CliIo } from "./io";
import { listen } from "./listen";
import { login, logout } from "./login";
import { loadConnection } from "./tokens";

type Spec = {
  /** The positional arguments' names; a trailing `?` makes one optional. */
  positionals: string[];
  options: string[];
  flags: string[];
};

const COMMANDS: Record<string, Spec> = {
  login: { positionals: ["url"], options: ["name"], flags: [] },
  logout: { positionals: [], options: [], flags: [] },
  status: { positionals: [], options: [], flags: [] },
  context: { positionals: [], options: ["conversation"], flags: [] },
  memory: { positionals: ["path"], options: [], flags: [] },
  events: {
    positionals: [],
    options: ["date", "interval", "from", "to", "session", "types", "kind", "after", "show"],
    flags: ["unfiltered", "count-only", "sessions", "jsonl"]
  },
  addresses: { positionals: [], options: [], flags: [] },
  mail: { positionals: ["id?"], options: ["after"], flags: [] },
  send: { positionals: ["message?"], options: ["to", "in-reply-to", "idempotency-key"], flags: [] },
  record: {
    positionals: [],
    options: ["conversation", "board-rev", "said", "did", "outcome", "from", "artifact", "model"],
    flags: []
  },
  listen: { positionals: [], options: [], flags: ["follow"] }
};

/** Options every command but login takes. */
const GLOBAL_OPTIONS = ["host"];
const GLOBAL_FLAGS = ["json"];

export const USAGE = `duoduo-tether: connect an agent to a duoduo host as a connected assistant.

  duoduo-tether login <public url> [--name <name>]
  duoduo-tether logout
  duoduo-tether status
  duoduo-tether context [--conversation <id>]
  duoduo-tether memory <path>
  duoduo-tether events [--date <yyyy-mm-dd>] [--interval <i>] [--from <t>] [--to <t>]
                       [--session <key>] [--types <a,b>] [--kind <k>] [--after <id>]
                       [--show <event id>] [--unfiltered] [--count-only] [--sessions] [--jsonl]
  duoduo-tether addresses
  duoduo-tether mail [<id>] [--after <id>]
  duoduo-tether send [--to <address>] [--in-reply-to <id>] [--idempotency-key <key>] [<message>]
  duoduo-tether record --conversation <id> --board-rev <rev> --said <text> --did <text>
                       --outcome <text> [--from <who>] [--artifact <where>] [--model <id>]
  duoduo-tether listen [--follow]

Every command but login takes --host <host> (needed when logged in to several hosts) and
--json (print the raw tool result). Exit codes: 0 done, 1 refused, 2 usage, 3 token refused,
4 host unreachable or HTTP error.
`;

type Parsed = {
  command: string;
  positionals: string[];
  options: Record<string, string>;
  flags: Set<string>;
};

function usage(problem: string): CliExit {
  return new CliExit(EXIT.usage, `${problem} Run duoduo-tether help for the commands.`);
}

export function parseArgs(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  if (command === undefined) throw usage("No command given.");
  const spec = COMMANDS[command];
  if (spec === undefined) throw usage(`${JSON.stringify(command)} is not a command.`);
  const options = command === "login" ? spec.options : [...spec.options, ...GLOBAL_OPTIONS];
  const flags = command === "login" ? spec.flags : [...spec.flags, ...GLOBAL_FLAGS];
  const parsed: Parsed = { command, positionals: [], options: {}, flags: new Set() };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (!arg.startsWith("--")) {
      parsed.positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const key = arg.slice(2, equals === -1 ? undefined : equals);
    if (flags.includes(key)) {
      if (equals !== -1) throw usage(`--${key} takes no value.`);
      parsed.flags.add(key);
    } else if (options.includes(key)) {
      const value = equals === -1 ? rest[(index += 1)] : arg.slice(equals + 1);
      if (value === undefined) throw usage(`--${key} needs a value.`);
      parsed.options[key] = value;
    } else {
      throw usage(`${command} takes no option --${key}.`);
    }
  }
  const required = spec.positionals.filter((name) => !name.endsWith("?")).length;
  if (parsed.positionals.length < required) {
    throw usage(`${command} needs <${spec.positionals[parsed.positionals.length]}>.`);
  }
  if (parsed.positionals.length > spec.positionals.length) {
    throw usage(`${command} takes at most ${spec.positionals.length} argument(s).`);
  }
  return parsed;
}

const TOOL_OPTIONS: Record<string, string> = {
  "board-rev": "board_rev",
  "in-reply-to": "in_reply_to",
  "idempotency-key": "idempotency_key",
  "count-only": "count_only",
  jsonl: "json"
};

/** The tool's arguments: option names with `_` for `-`; nothing added. */
function toolArgs(parsed: Parsed): Json {
  const args: Json = {};
  for (const [key, value] of Object.entries(parsed.options)) {
    if (key === "host") continue;
    args[TOOL_OPTIONS[key] ?? key] = key === "types" ? value.split(",") : value;
  }
  for (const flag of parsed.flags) {
    if (flag === "json" || flag === "follow") continue;
    args[TOOL_OPTIONS[flag] ?? flag] = true;
  }
  return args;
}

function textOf(result: Json): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        isRecord(block) && typeof block.text === "string"
    )
    .map((block) => block.text)
    .join("\n");
}

const withNewline = (text: string): string => (text.endsWith("\n") ? text : `${text}\n`);

const TOOLS: Record<string, string> = {
  context: "GetContext",
  memory: "ReadMemory",
  events: "ReadEvents",
  addresses: "ListAddresses",
  mail: "ReadMail",
  send: "SendMail",
  record: "RecordExperience"
};

async function runTool(io: CliIo, parsed: Parsed): Promise<number> {
  const { connection } = await loadConnection(io.env, parsed.options.host);
  const args = toolArgs(parsed);
  if (parsed.command === "memory") args.path = parsed.positionals[0];
  if (parsed.command === "mail" && parsed.positionals[0] !== undefined) {
    args.id = parsed.positionals[0];
  }
  if (parsed.command === "send") {
    args.message = parsed.positionals[0] ?? (await io.readStdin()).replace(/\n$/, "");
  }
  const tool = TOOLS[parsed.command] as string;
  const result = await rpc(io, connection, "tools/call", { name: tool, arguments: args }, tool);
  const json = parsed.flags.has("json");
  if (json) io.stdout(`${JSON.stringify(result)}\n`);
  if (result.isError === true) {
    io.stderr(withNewline(textOf(result)));
    return EXIT.refused;
  }
  if (!json) io.stdout(withNewline(textOf(result)));
  return EXIT.ok;
}

async function status(io: CliIo, parsed: Parsed): Promise<number> {
  const { connection, file } = await loadConnection(io.env, parsed.options.host);
  const result = await rpc(io, connection, "resources/list", {});
  if (parsed.flags.has("json")) {
    io.stdout(`${JSON.stringify(result)}\n`);
    return EXIT.ok;
  }
  const own = mailboxUri(connection.grant);
  const listed = Array.isArray(result.resources)
    ? result.resources.some((resource) => isRecord(resource) && resource.uri === own)
    : false;
  io.stdout(
    `${connection.publicUrl}: the token works${listed ? ` (grant ${connection.grant})` : ", but it lists no mailbox for the grant in the token file"}.\n` +
      `Token file: ${file}\n`
  );
  return EXIT.ok;
}

async function dispatch(io: CliIo, argv: string[]): Promise<number> {
  if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  const parsed = parseArgs(argv);
  switch (parsed.command) {
    case "login":
      return login(io, parsed.positionals[0] as string, parsed.options.name);
    case "logout":
      return logout(io, parsed.options.host);
    case "status":
      return status(io, parsed);
    case "listen": {
      const { connection } = await loadConnection(io.env, parsed.options.host);
      return listen(io, connection, parsed.flags.has("follow"));
    }
    default:
      return runTool(io, parsed);
  }
}

/** Runs one command; every failure is a message on standard error and an exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  try {
    return await dispatch(io, argv);
  } catch (error) {
    if (error instanceof CliExit) {
      io.stderr(withNewline(error.message));
      return error.code;
    }
    io.stderr(`duoduo-tether failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.refused;
  }
}
