// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * What the channel and the duoduo-tether command line agree on. Both entry
 * points import this module, so it imports nothing.
 */

/** The built-in client's name: its client_id is `<public url>/clients/duoduo-tether`. */
export const BUILT_IN_CLIENT_NAME = "duoduo-tether";

/** Its one return address; any port is accepted (RFC 8252 section 7.3). */
export const BUILT_IN_REDIRECT_URIS: readonly string[] = ["http://127.0.0.1/callback"];

/**
 * The listen stream's keep-alive comment interval, pinned to the SDK's 15 s
 * default: the command line's idle timeout is three of these, so a change
 * here changes when it gives up on a silent stream.
 */
export const LISTEN_KEEP_ALIVE_MS = 15_000;

/** The MCP protocol version the command line speaks, and the only one with listen. */
export const MODERN_PROTOCOL = "2026-07-28";

export function builtInClientId(publicUrl: string): string {
  return `${publicUrl}/clients/${BUILT_IN_CLIENT_NAME}`;
}

export function mailboxUri(grantId: string): string {
  return `duoduo://mailbox/${grantId}`;
}
