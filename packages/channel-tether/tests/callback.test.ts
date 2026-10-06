// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import type dns from "node:dns";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  BlockedAddressError,
  guardedLookup,
  isBlockedAddress,
  isRefusedCallbackUrl,
  readBoundedBody
} from "../src/callback";

// Callback URL validation for doorbells and event subscriptions.

describe("isRefusedCallbackUrl", () => {
  it.each([
    ["https://receiver.example.com/cb", false],
    ["https://93.184.216.34/cb", false],
    ["http://receiver.example.com/cb", true],
    ["not a url", true],
    ["https://u:p@receiver.example.com/cb", true],
    ["https://127.0.0.1/cb", true],
    ["https://[::1]/cb", true],
    ["https://[fe80::1]/cb", true],
    ["https://[::ffff:10.0.0.1]/cb", true]
  ])("%s → %s", (url, refused) => {
    expect(isRefusedCallbackUrl(url)).toBe(refused);
  });
});

describe("readBoundedBody", () => {
  it("returns a body within the limit", async () => {
    expect(await readBoundedBody(Readable.from([Buffer.from("ab"), Buffer.from("cd")]), 4)).toBe(
      "abcd"
    );
  });

  it("rejects and destroys the stream once the body crosses the limit, never a prefix", async () => {
    const stream = Readable.from([Buffer.from("abc"), Buffer.from("de"), Buffer.from("f")]);
    await expect(readBoundedBody(stream, 4)).rejects.toThrow();
    expect(stream.destroyed).toBe(true);
  });
});

describe("isBlockedAddress", () => {
  it.each([
    ["10.1.2.3", true],
    ["172.31.0.1", true],
    ["192.168.1.1", true],
    ["100.64.0.1", true],
    ["169.254.169.254", true],
    ["0.0.0.0", true],
    ["224.0.0.1", true],
    ["fc00::1", true],
    ["2002:a00:1::", true],
    ["64:ff9b::a00:1", true],
    ["192.31.196.1", true],
    ["192.52.193.1", true],
    ["192.175.48.1", true],
    ["fec0::1", true],
    ["100:0:0:1::1", true],
    ["2620:4f:8000::1", true],
    ["3fff::1", true],
    ["5f00::1", true],
    ["8.8.8.8", false],
    ["2606:4700:4700::1111", false],
    ["not-an-ip", true]
  ])("%s → %s", (address, blocked) => {
    expect(isBlockedAddress(address)).toBe(blocked);
  });
});

describe("guardedLookup", () => {
  const resolving =
    (addresses: dns.LookupAddress[]) =>
    (
      _host: string,
      _options: { all: true },
      callback: (error: NodeJS.ErrnoException | null, found: dns.LookupAddress[]) => void
    ) =>
      callback(null, addresses);

  const run = (addresses: dns.LookupAddress[], all: boolean) =>
    new Promise<{ error: unknown; address: unknown; family: unknown }>((resolve) =>
      guardedLookup(resolving(addresses))(
        "receiver.example.com",
        { all },
        (error, address, family) => resolve({ error, address, family })
      )
    );

  it("hands the socket every checked address, or the first, as asked", async () => {
    const addresses = [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::248", family: 6 }
    ];
    expect(await run(addresses, true)).toEqual({
      error: null,
      address: addresses,
      family: undefined
    });
    expect(await run(addresses, false)).toEqual({
      error: null,
      address: "93.184.216.34",
      family: 4
    });
  });

  it("refuses the name when any one address is private", async () => {
    const outcome = await run(
      [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.1", family: 4 }
      ],
      true
    );
    expect(outcome.error).toBeInstanceOf(BlockedAddressError);
  });
});
