# Deployment

Tether runs as a channel of a duoduo host: the daemon starts it, and it talks to the daemon over the
daemon's unix socket. It serves one thing: an MCP endpoint behind OAuth and passkey approval, bound to
loopback by default (`ALADUO_TETHER_HOST` names another IP literal). Making that address reachable as a public HTTPS origin is the owner's choice and the
owner's responsibility; see [Exposing it](#exposing-it).

## Install

```bash
duoduo channel install @openduo/channel-tether
duoduo channel tether start
duoduo channel tether status
```

The channel has no switch: installing and starting it is the opt-in, and
`duoduo channel tether stop` closes it. Its state (grants, passkeys, client documents, doorbells)
lives beside the installed package under the daemon's runtime directory, so a reinstall keeps it.

## Configuration

All keys go in `~/.config/duoduo/.env`. Restart the channel after a change
(`duoduo channel tether stop`, then `start`). An invalid value stops the channel at start, and the
channel log and `duoduo channel tether status` name the key.

| Key                        | Meaning                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALADUO_TETHER_PORT`       | Required. The port the channel listens on, on `ALADUO_TETHER_HOST`                                                                            |
| `ALADUO_TETHER_HOST`       | Optional. The IP address the channel binds (an IP literal, not a hostname); default `127.0.0.1`                                               |
| `ALADUO_TETHER_PUBLIC_URL` | The public origin: `https://host` on port 443, no path. OAuth issuer, MCP resource and passkey origin. Unset: no OAuth or MCP route is served |

Limits have defaults; set a key only to change one. Each takes a positive whole number.

| Key                                                                     | Default            | What it bounds                                                                       |
| ----------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------ |
| `ALADUO_TETHER_REQUEST_LIMIT_BYTES`                                     | 1 MiB              | The largest request the channel accepts                                              |
| `ALADUO_TETHER_CHALLENGE_CAP`                                           | 1000               | Authorize and enrollment challenges outstanding at once; at the cap the oldest drops |
| `ALADUO_TETHER_CODE_LIFETIME_MS`, `ALADUO_TETHER_CHALLENGE_LIFETIME_MS` | 10 minutes         | Authorization code and passkey challenge lifetime (RFC 6749 section 4.1.2)           |
| `ALADUO_TETHER_CIMD_TIMEOUT_MS`, `ALADUO_TETHER_CIMD_MAX_BYTES`         | 10 s, 64 KiB       | Fetching a client document, a key set, or an event-subscription callback             |
| `ALADUO_TETHER_TOOLS_LIST_TTL_MS`                                       | unset (no caching) | How long a 2026-07-28 client may cache the tool list                                 |

The mail stream reconnects after the daemon's `ALADUO_PULL_WAIT_MS`.

## Exposing it

The channel serves plain HTTP on its bind address; bound beyond loopback, it says so in its log
at start, and TLS and who can reach that address are the owner's.

Tether does not expose itself. How `<ALADUO_TETHER_HOST>:<ALADUO_TETHER_PORT>` becomes the public origin in
`ALADUO_TETHER_PUBLIC_URL` is chosen by the owner, or by the owner's agent, and its security is
theirs. Tether names no route as official and ships none.

Any route must:

- serve the public origin over HTTPS on port 443, with a hostname that does not change: grants and
  passkeys are bound to it;
- expose only the paths in [protocol.md](protocol.md#routes), and nothing else on the host;
- pass request and response bodies and headers unchanged;
- never rewrite `Origin`;
- never buffer a `text/event-stream` answer, and not cut it off while it stays open;
- pass a 3xx answer and its `Location` back as returned, never following it.

Options, each with its own trade-offs:

- A reverse proxy or gateway the owner already runs for a domain.
- A public host: a TLS-terminating proxy on a machine that has a public address.
- A Cloudflare tunnel on a domain the owner keeps on Cloudflare.
- Tailscale Funnel.
- ChatGPT's secure tunnel, for OpenAI clients only; the authorize and enrollment pages still need
  an origin the owner's browser reaches.
- Direct LAN access, for assistants on the same network, through a TLS-terminating gateway there.
- A relay over an outbound WebSocket, for a host with no domain and no inbound port. The duoduo
  skill `duoduo-tether` carries a reference implementation; it is not a supported
  component, and whoever deploys it owns its security.

## First passkey, first connection

1. With the public URL set and the channel running, `duoduo channel tether passkey add` prints a
   one-time enrollment link. The owner opens it and enrolls a passkey. While any assistant is
   connected, `passkey add` runs only from a terminal on the host.
2. In the assistant, add an MCP connector with the URL `<public URL>/mcp`. The assistant opens the
   authorize page; the owner names the connection and approves with the passkey.
3. `duoduo channel tether list` shows the connection.

## Operating

| Command                                            | Does                                                     |
| -------------------------------------------------- | -------------------------------------------------------- |
| `duoduo channel tether status`                     | Public URL, listen address, passkeys, connections        |
| `duoduo channel tether list`                       | Each connection: name, client, grant, last use           |
| `duoduo channel tether revoke <name>`              | End one connection; its next call gets 401               |
| `duoduo channel tether passkey add\|list\|remove`  | Manage the owner's passkeys                              |
| `duoduo channel tether client add\|list\|remove`   | Client documents this host keeps for clients without one |
| `duoduo channel tether doorbell add\|list\|remove` | Mail notices to an assistant's own HTTPS endpoint        |

Changing the public URL invalidates every connection and every passkey: both are bound to the old
origin. Revoke every connection, remove every passkey, enroll again, and reconnect each assistant.
