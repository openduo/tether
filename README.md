# tether

A channel for the [duoduo](https://github.com/openduo/duoduo) daemon that lets the owner's other AI
assistants (ChatGPT, Claude, Codex, Cursor, Grok, a self-built agent, …) connect to duoduo over MCP
and share its memory and context. Each connected assistant loads duoduo's board at the start of a
chat, reads its memory and event log, mails the owner's duoduo sessions and the other assistants,
and records what it did so duoduo learns from it.

Tether is one MCP server behind OAuth, bound to loopback by default (`ALADUO_TETHER_HOST` names
another IP literal). The owner approves every
connection with a passkey, and chooses how the port is exposed. Each tool is one call to the duoduo daemon over its local unix socket;
the daemon itself does not know tether exists.

## Layout

| path                      | what it is                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/channel-tether` | The channel: OAuth and passkeys, the MCP endpoint, mail, host verbs                                                                            |
| `docs/`                   | [Protocol surface](docs/protocol.md), [deployment](docs/deployment.md), [security model](docs/security.md), [client command line](docs/cli.md) |

## Quick start

```bash
duoduo channel install @openduo/channel-tether
# set ALADUO_TETHER_PORT in ~/.config/duoduo/.env
duoduo channel tether start
duoduo channel tether status
```

The channel now listens on `127.0.0.1:<ALADUO_TETHER_PORT>` (`ALADUO_TETHER_HOST` changes the
address) and nothing else. To let an assistant
reach it, choose a route and set `ALADUO_TETHER_PUBLIC_URL`
([Exposing it](docs/deployment.md#exposing-it)); then the owner enrolls a passkey
(`duoduo channel tether passkey add`), adds `<public URL>/mcp` as an MCP connector in the assistant,
and approves it with the passkey.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run lint:types
pnpm test
pnpm run build
pnpm run lint
pnpm run format:check
```

`pnpm test:rig` runs the integration suite against a real duoduo daemon; see `CLAUDE.md`.

## License

[FSL-1.1-Apache-2.0](LICENSE).
