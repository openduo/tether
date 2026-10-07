# Protocol surface

Tether is one MCP server behind OAuth 2.1, served by a duoduo channel. Everything an assistant can
do goes through the routes below. Each tool call becomes one JSON-RPC call to the duoduo daemon over
its local unix socket; the daemon does not know tether exists.

## Routes

| Path                                           | Methods   | Purpose                                                            |
| ---------------------------------------------- | --------- | ------------------------------------------------------------------ |
| `/mcp`                                         | POST      | The MCP endpoint (Streamable HTTP); GET answers 405, no SSE stream |
| `/.well-known/oauth-protected-resource`        | GET       | Protected resource metadata (RFC 9728)                             |
| `/.well-known/oauth-authorization-server`      | GET       | Authorization server metadata (RFC 8414)                           |
| `/authorize`                                   | GET, POST | The authorize page; the owner approves with a passkey              |
| `/token`                                       | POST      | Authorization code exchange                                        |
| `/revoke`                                      | POST      | Token revocation (RFC 7009)                                        |
| `/enroll`, `/enroll/options`, `/enroll/finish` | GET, POST | One-time passkey enrollment for the owner                          |

Until `ALADUO_TETHER_PUBLIC_URL` is set, no OAuth or MCP route is served. Nothing else is served:
there are no cookies, and no route reads one.

## OAuth

- Clients identify with a Client ID Metadata Document: the `client_id` is an `https` URL whose JSON
  document names the client and its return addresses. There is no dynamic registration.
- Grant type `authorization_code` only, with PKCE `S256`.
- Token endpoint authentication is `none` or `private_key_jwt` (RS256, keys from the document's
  `jwks_uri`), as the client's document declares. A client bound to `private_key_jwt` never gets a
  token on PKCE alone.
- Every authorization needs the owner's passkey on the authorize page. The page shows the client
  document URL and the return address, marked not yet verified. Only after the passkey does the
  channel fetch the client document and check the return address against it. The check is exact,
  except for an `http` return address on `127.0.0.1`, `[::1]` or `localhost`: there any port is
  accepted, as RFC 8252 section 7.3 requires for native apps, and scheme, host, path and query
  still match exactly (`localhost` does not match `127.0.0.1`). The token request must send the
  return address of its authorization request exactly, port included.
- The owner names each connection (lowercase letters, digits and `-`). The name is how duoduo knows
  the assistant: its session is `tether:<name>`, and its records carry that name as their source.
- Tokens do not expire. A connection ends when the owner revokes it
  (`duoduo channel tether revoke <name>`), when the assistant revokes its token, or when the public
  URL changes: every grant is bound to the public URL it was issued under.

An assistant whose client has no document of its own can be given one that the duoduo host keeps
locally (nothing is served for it; `/authorize` reads it from the host's state):
`duoduo channel tether client add <name> --redirect <uri>`. Its return addresses are loopback
`http` addresses and are checked by the same rule: any port, everything else exact.

### Scopes

| Scope              | Allows                                |
| ------------------ | ------------------------------------- |
| `context:read`     | `GetContext`                          |
| `memory:read`      | `ReadMemory`                          |
| `events:read`      | `ReadEvents`                          |
| `sessions:read`    | Mail, together with `sessions:notify` |
| `sessions:notify`  | Mail, together with `sessions:read`   |
| `experience:write` | `RecordExperience`                    |

The three mail tools (`ListAddresses`, `SendMail`, `ReadMail`), MCP Events and push each need both
session scopes.

## Tools

| Tool               | What it does                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `GetContext`       | Who the assistant is, duoduo's board in full, and a conversation id to pass on later calls in a chat |
| `ReadMemory`       | One file of duoduo's memory, as the board names it. Read-only                                        |
| `ReadEvents`       | duoduo's event log, one day per call, in the redacted external view. Read-only                       |
| `ListAddresses`    | Who the assistant can mail: the owner's channel sessions and the other connected assistants          |
| `SendMail`         | Mail to an address, or an answer to a mail with `in_reply_to`. Takes an `idempotency_key`            |
| `ReadMail`         | The mail sent to this assistant; with no argument, the unread mail, which then counts as read        |
| `RecordExperience` | Record the message answered, what was done and the outcome, so duoduo learns from it. Idempotent     |

A refused call is a tool result with `isError: true`, a sentence saying what happened and what to do
next, and a machine-readable reason in `_meta["duoduo/reason"]`. A successful call may also carry
`structuredContent`. Argument errors are JSON-RPC errors (`-32602`) with readable text.

The server speaks the legacy MCP initialize handshake and the 2026-07-28 protocol. On 2026-07-28,
`tools/list` carries a cache hint only when the operator sets one (`ALADUO_TETHER_TOOLS_LIST_TTL_MS`).

### What the event log shows

`ReadEvents` returns the external view: human messages, duoduo's replies, mail and assistant records
in full; a tool call only as its name and whether it succeeded; job and internal events left out.

## Mail

- Each connected assistant is a duoduo session `tether:<name>` that runs no model. Sessions mail it
  with duoduo's `Notify` tool; the assistant reads with `ReadMail` and sends with `SendMail`.
- Mail to a channel session starts a turn there. Mail to an assistant starts nothing: it waits until
  that assistant reads it.
- Addresses are channel sessions and connected assistants. Jobs, subconscious and system sessions
  are not addresses; mail from a job to an assistant is returned to the job with the reason.
- Mail to an assistant that is not connected, or whose connection ends before it reads the mail,
  comes back to the sender once.
- A mail carries no task state, no expiry and no retry. The sender session a mail names says where
  it was sent from. It is not an authorization.

### Being told about mail

Three ways, all carrying no mail content; the assistant then calls `ReadMail`:

- **Push** (2026-07-28 clients): `subscriptions/listen` on the resource `duoduo://mailbox/<grant>`
  holds an event stream open and sends `notifications/resources/updated` per mail.
- **MCP Events**: an event subscription with a callback URL; one signed delivery per mail.
- **Doorbells**: the operator registers an HTTPS endpoint per assistant
  (`duoduo channel tether doorbell add <name> --url <url> --auth hmac|bearer`); one POST per mail,
  signed per Standard Webhooks with `hmac`, no retry.

A missed notice costs only latency: the mail is there at the next `ReadMail`.
