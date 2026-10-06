# Security model

Tether serves one MCP endpoint behind OAuth and passkey approval on a duoduo host, bound to
loopback by default (`ALADUO_TETHER_HOST` names another IP literal). This page says what it exposes, who can do what through it, and what does not protect you.

## What is exposed

- The channel serves plain HTTP on `ALADUO_TETHER_HOST` (default `127.0.0.1`); bound to any other
  address it is reachable there without TLS, and that is the owner's choice and responsibility.
- Tether itself exposes nothing beyond its bind address. Whatever makes it reachable from elsewhere (a
  proxy, a tunnel, a relay) is the owner's choice, and its security is the owner's: it decides who
  can reach the channel, and it sees everything that crosses it. The requirements any such route
  must meet are in [deployment.md](deployment.md#exposing-it).
- Only the routes in [protocol.md](protocol.md#routes) are served.
- Anyone can open the authorize page and read the OAuth metadata. The public hostname is not a
  secret: certificate-transparency logs publish it with its first certificate.
- No route serves the daemon's own API. Each tool is one fixed JSON-RPC call to the daemon.

## Who can connect

- **Only the owner approves.** Every authorization needs the owner's passkey, bound to the public
  origin. No text, link or token can stand in for it.
- **Enrollment is the weak moment.** While no passkey exists, whoever opens an enrollment link first
  enrolls the first passkey. Enroll the owner's passkey as soon as the public URL is up;
  `duoduo channel tether status` warns while none exists.
- **Connected assistants cannot enroll.** Once any assistant is connected, a new enrollment link is
  issued only from a terminal on the host, never from inside a duoduo session: the session's output
  is readable through the event log, which connected assistants can read.
- **Client documents are fetched only after approval.** Nothing is fetched for a client before the
  owner's passkey, and the return address is checked against the document after it.
- **Grants are bound to the origin.** A token issued under one public URL is refused under another.

## What a connected assistant can reach

Per its scopes (see [protocol.md](protocol.md#scopes)):

- duoduo's board and memory files, read-only;
- the event log in the external view: human messages and duoduo's replies in full, tool calls only
  as name and outcome, internal events left out;
- mail to and from the owner's channel sessions and the other connected assistants;
- records it writes into the event log, under its own name.

It cannot run commands on the host, call the daemon's API, or read tool output.

## What a mail means

A mail is a request in text, never the owner's permission. The sender a mail names, an assistant or a
duoduo session, says where it was sent from; it is not proof of identity and not an authorization.
Any process of the host's OS user can reach the daemon's full-control socket and send as any
session, so the sender adds no capability. What holds is the rule both sides follow: any outward or
irreversible step a mail asks for (sending to someone else, deleting, paying) needs the owner's
first-hand confirmation.

## Secrets

- **Bearer tokens** do not expire; revoke a connection to end it. They cross whatever route
  exposes the channel, so whoever controls that route sees them, and any secret the route itself
  uses guards them too.

## If something is compromised

1. Revoke every connection `duoduo channel tether list` shows, including ones you do not recognise.
2. Check what the sessions it mailed did.
3. Rotate every secret that ever appeared in a message or a reply: connected assistants read those
   in full.
4. If a secret of the route that exposes the channel may have leaked, rotate it.
