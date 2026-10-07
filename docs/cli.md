# duoduo-tether, the client command line

`duoduo-tether` connects any agent that can run a shell command to a duoduo host as a connected
assistant: Claude Code, Codex, an agent you built yourself. Each command is one MCP tool of the
tether endpoint (see [protocol.md](protocol.md#tools)), so the agent needs no MCP client, one
connection and one credential. `listen` is a command that exits, or prints a line, when mail
arrives, so an agent can be woken by it.

It ships in the same package as the channel:

```bash
npm install -g @openduo/channel-tether
duoduo-tether login https://tether.example.com
```

The channel's plugin entry (which duoduo starts) and this command are separate entry points of the
package; installing the package to use the command starts nothing.

## Logging in

```bash
duoduo-tether login <public url> [--name <name>]
```

1. The command listens on `127.0.0.1` at a free port and builds an authorization request for the
   client built into every tether host, `duoduo-tether` (see
   [protocol.md](protocol.md#the-built-in-client)): PKCE `S256`, `resource` set to the public URL,
   all scopes, a random `state`, and the return address `http://127.0.0.1:<port>/callback`.
2. It opens the authorize page in a browser when it can start one, and always prints the URL.
3. The owner approves with a passkey and names the connection. The name field starts empty;
   `--name` fills it in advance, and the owner can change it.
4. The browser returns to the loopback address. The command exchanges the code, reads the grant id
   from the host, stores the token, and prints where the token file is.

**Approving on another device.** When the agent's machine has no browser the owner uses (a VM, a
server, a remote session), open the printed URL on any device and approve there. That device's
browser then fails to load `http://127.0.0.1:<port>/callback?...`, since the listener is on the
agent's machine. Copy that address from its address bar and paste it into the waiting `login` as one
line on standard input. The command accepts whichever comes first, the callback or the pasted
address. An address whose `state` is not the one it sent ends `login` with exit 1, and nothing is
exchanged.

`login` has no time limit of its own. The authorize page and the authorization code expire on the
host (`ALADUO_TETHER_CHALLENGE_LIFETIME_MS`, `ALADUO_TETHER_CODE_LIFETIME_MS`); after that, start
again. A denial never reaches `login`: the page tells the owner, not the app. After a denial, or when
the owner never approves, stop `login` by hand (Ctrl-C).

If the token is issued but the token file cannot be written, `login` revokes that token at once
and says so, so no connection is left that nothing holds.

Logging in again to a host that already has a token file replaces that file once the new token is
issued. Whether the old connection stays depends on the name the owner gives: the same name replaces
it (the page says so after the passkey), another name adds a second connection.

## The token file

One file per host: `$XDG_CONFIG_HOME/tether/<host>.json`, with `XDG_CONFIG_HOME` defaulting to
`~/.config`. The file is mode `0600`, written to a temporary file and renamed into place; the
directory is mode `0700`. `<host>` is the public URL's host name. Two agents of one OS user hold
separate connections to one host by running with different `XDG_CONFIG_HOME` values.

```json
{
  "public_url": "https://tether.example.com",
  "grant": "1f0c…",
  "token": "…"
}
```

The connection's name is not stored: the owner may change it, and `context` reports who this
assistant is.

The token does not expire. Anyone who can read this file acts as this assistant until the owner
revokes it.

Every command except `login` takes `--host <host>`. Without it, the command uses the only token file
there is; with none, or several, it exits 2 and names the hosts it found.

## Commands

| Command                                                                                                                        | Tool               | What it does                                                          |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------ | --------------------------------------------------------------------- |
| `login <url> [--name <name>]`                                                                                                  | (OAuth)            | Connect; see above                                                    |
| `logout`                                                                                                                       | (`/revoke`)        | Revoke the token on the host, then delete the token file              |
| `status`                                                                                                                       | (resource list)    | The host and grant, with the token checked live                       |
| `context [--conversation <id>]`                                                                                                | `GetContext`       | Who this assistant is, duoduo's board, and a conversation id          |
| `memory <path>`                                                                                                                | `ReadMemory`       | One memory file, as the board names it                                |
| `events [options]`                                                                                                             | `ReadEvents`       | One day of duoduo's event log, external view                          |
| `addresses`                                                                                                                    | `ListAddresses`    | Who this assistant can mail                                           |
| `mail [<id>] [--after <id>]`                                                                                                   | `ReadMail`         | Unread mail (which then counts as read), or one mail by id            |
| `send [--to <a>] [--in-reply-to <id>] [--idempotency-key <k>] [<message>]`                                                     | `SendMail`         | Send mail; the message is the argument, or standard input when absent |
| `record --conversation <id> --board-rev <rev> --said <t> --did <t> --outcome <t> [--from <t>] [--artifact <t>] [--model <id>]` | `RecordExperience` | Record a turn for duoduo                                              |
| `listen [--follow]`                                                                                                            | (push)             | Wait for mail; see [Listening](#listening)                            |

`events` takes the tool's arguments as options: `--date`, `--interval`, `--from`, `--to`,
`--session`, `--types <a,b>`, `--kind`, `--after`, `--show`, and the flags `--unfiltered`,
`--count-only`, `--sessions`, `--jsonl` (the tool's `json`: one JSON object per row).

Options use the tool's argument names with `-` for `_`. Nothing is added: the command sends what you
give it, once, with no retry and no idempotency key of its own. One-shot commands have no time limit;
interrupt one that hangs.

`logout` keeps the token file when the host cannot be reached or answers an HTTP error (exit 4): the
token was not revoked, so run `logout` again.

### Output

- By default a command prints the tool result's text, which the tool already writes for a reader.
- `--json` prints the raw tool result (`content`, `structuredContent`, `isError`, `_meta`) as one
  JSON object.
- A refusal (`isError: true`) prints its text to standard error, and the command exits 1. Its
  reason is in `_meta["duoduo/reason"]`, shown with `--json`.

### Exit codes

| Code | Meaning                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| 0    | Done; for `listen`, mail is waiting                                                                          |
| 1    | The tool refused (`isError`), the server answered a JSON-RPC error, or `login` could not keep the token      |
| 2    | The command line is wrong, or no token file is chosen: not logged in, or several hosts and no `--host`       |
| 3    | The host refused the token (HTTP 401): revoked, replaced, or issued under another public URL                 |
| 4    | The host could not be reached or answered another HTTP error; `listen` reconnects instead on a drop or `5xx` |

## Listening

`listen` opens `subscriptions/listen` (MCP 2026-07-28) on this assistant's mailbox,
`duoduo://mailbox/<grant>`. Each time the stream is acknowledged and each time it rings, `listen`
reads the mailbox resource, which lists the unread mail as id and sender, exactly the mail
`duoduo-tether mail` would return, and acknowledges nothing. `listen` never reads mail: after it
reports, the agent runs `duoduo-tether mail`.

Each report is one line on standard output, one per unread mail:

```text
mail evt_…@2026-10-07 from tether:muse
```

- **Default.** `listen` exits 0 after its first report. If unread mail is already waiting when it
  connects, it reports that at once and exits.
- **`--follow`.** `listen` keeps running and prints one line per new mail, each mail once per
  process, even when the host rings again for it or the stream reconnects. Unread mail waiting when
  it connects is printed first.

Reading the mailbox on every acknowledgment reports mail that arrived while no stream was open: before
`listen` started, or during a reconnect.

**Reconnecting.** A dropped stream, a `5xx` answer, or a stream silent for 45 seconds is reconnected
inside the process; it never ends the command. The host sends a keep-alive every 15 seconds, so 45
seconds of silence is three missed keep-alives: a relay can leave a dead connection half open, and
silence is then the only sign. The delay before each attempt is random below a ceiling that starts at
1 second and doubles per failed attempt up to 60 seconds; an acknowledged stream resets it. Each
reconnect writes one line to standard error.

**Ending.** The host refusing the token (HTTP 401: revoked, replaced, the public URL changed) ends
`listen` with exit 3 and a line on standard error. When the connection is revoked or replaced while
the stream is open, the host ends the stream, and the reconnect gets the 401. Any other `4xx` ends
`listen` with exit 4, without reconnecting; a refused listen (a JSON-RPC error, such as a grant
without the mail scopes) with exit 1.

## Waking an agent

`listen` holds no state. Anything that can run a process and react to its exit or its output can
be woken by mail.

**Claude Code, background command.** Run `duoduo-tether listen` with Bash in the background. When
mail arrives the command exits, and Claude Code is told the background command finished, with its
output. The agent reads the mail with `duoduo-tether mail`, answers, and starts `listen` again.

**Claude Code, Monitor.** Start `duoduo-tether listen --follow` with the Monitor tool. Each mail is
one output line, and each line is an event for the agent; the process stays up across mails.

**A runtime that tracks a foreground process** (an agent you built, like one that runs a command
and waits for it): run `duoduo-tether listen` as the waiting step of the agent's loop. Exit 0 means
read mail; exit 3 means the connection is gone, and the owner has to approve a new one; any other
exit is a fault to report.

In every recipe the mail itself is read by `duoduo-tether mail`; `listen` only says that there is
some.

## Handling mail without a session open

An agent with no session running can still answer mail: a loop waits with `listen`, then starts the
agent once per wake. Tether does not run this loop and ships no command for it. It is a recipe that
you assemble and keep alive with your own supervisor; tether's part ends when `listen` exits.

```sh
#!/bin/sh
# tether-loop.sh: wait for duoduo mail, then let Claude Code handle it.
cd "$HOME/work/assistant" || exit 1
while :; do
  duoduo-tether listen
  case $? in
    0) ;;
    3) echo "tether connection is gone; log in again with duoduo-tether login" >&2; exit 0 ;;
    *) exit 1 ;;
  esac
  claude -p "You have duoduo mail. Read it with duoduo-tether mail, handle it, and answer with duoduo-tether send." \
    --allowedTools "Bash(duoduo-tether:*)" || exit 1
done
```

- The agent reads the mail itself with `duoduo-tether mail`; the loop passes it nothing. Unread mail
  stays unread until the agent reads it, so a run that fails before reading is not lost.
- Exit 0 means stop for good (the connection was revoked); exit 1 means a fault, and the supervisor
  restarts the script with its own delay. Do not loop straight back after a failed run: `listen`
  reports waiting unread mail at once, so a run that keeps failing would start again immediately and
  spend on every pass. The same holds for a run that succeeds without reading its mail: the prompt must make the
  agent read it.
- `--allowedTools "Bash(duoduo-tether:*)"` lets the agent run `duoduo-tether` without a prompt. Add
  only what the mail it handles needs.
- Run one listener per connection. Two loops on one connection both wake for the same mail and both
  start the agent; the second finds nothing to read and has spent for nothing. Nothing enforces this.

**Mail never grants permission.** A mail is a request in text from a duoduo session or another
assistant (see [security.md](security.md#what-a-mail-means)). An agent started by this loop runs
with whatever permissions you gave it, unattended; any outward or irreversible step a mail asks for
(sending to someone else, deleting, paying) still needs the owner's first-hand confirmation. Grant
the loop's agent no permission you would not give it for a message from a stranger.

Keep the script running with your own supervisor:

- **launchd** (macOS): a LaunchAgent with `KeepAlive` restarting it on failure only
  (`SuccessfulExit` false); set `EnvironmentVariables` so `duoduo-tether` and `claude` are on its
  `PATH`. Choose the restart delay by what a failed run costs.
- **systemd** (Linux): a user service with `Restart=on-failure`. Choose `RestartSec` by what a
  failed run costs.
