// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * A client that validates structured output (the official TypeScript client) must read
 * every refusal as text with a reason, never as a protocol error.
 */

import { describe, expect, it } from "vitest";
import { harness, runId, useCleanups } from "./helpers";

const cleanup = useCleanups();

describe("refusals through the official MCP client", () => {
  it("a refused SendMail reaches an SDK client as a readable refusal", async () => {
    const run = runId();
    const h = await harness(cleanup);
    const name = `dots-${run}`;
    await h.connectAs(name);
    // As `duoduo session notify` sends it from a terminal: a source label, no session.
    const notified = await h.daemon("session.notify", {
      target: `tether:${name}`,
      exact_key: true,
      message: "from the CLI"
    });
    expect(notified.result).toMatchObject({ ok: true });
    const client = await h.sdkClient(name);
    const read = await client.callTool({ name: "ReadMail", arguments: {} });
    const [mail] = (read.structuredContent as { mails: Array<{ id: string }> }).mails;
    const answered = await client.callTool({
      name: "SendMail",
      arguments: { in_reply_to: mail.id, message: "seen" }
    });
    expect(answered.isError).toBe(true);
    expect((answered._meta as Record<string, unknown>)["duoduo/reason"]).toBe("no_reply_address");
    expect((answered.content as Array<{ text: string }>)[0].text).not.toBe("");
  });

  it("a refused ReadEvents reaches an SDK client as a readable refusal", async () => {
    const run = runId();
    const h = await harness(cleanup);
    const name = `dots-${run}`;
    await h.connectAs(name);
    const client = await h.sdkClient(name);
    const refused = await client.callTool({ name: "ReadEvents", arguments: { date: "yesterday" } });
    expect(refused.isError).toBe(true);
    expect((refused._meta as Record<string, unknown>)["duoduo/reason"]).toBe("daemon_error");
    // The daemon's sentence ends in a period; the wrapper adds none of its own.
    expect((refused.content as Array<{ text: string }>)[0].text).not.toContain("..");
  });

  it.each<[string, string, (self: string) => Record<string, unknown>, string]>([
    ["SendMail with no recipient", "SendMail", () => ({ message: "x" }), "no_recipient"],
    [
      "SendMail to no address",
      "SendMail",
      () => ({ to: "rigchat:none:none", message: "x" }),
      "not_found"
    ],
    ["SendMail to a job", "SendMail", () => ({ to: "job:rig-none", message: "x" }), "job_address"],
    ["SendMail to itself", "SendMail", (self) => ({ to: `tether:${self}`, message: "x" }), "self"],
    [
      "SendMail answering mail it never had",
      "SendMail",
      () => ({ in_reply_to: "evt_none@2026-10-06", message: "x" }),
      "not_your_mail"
    ],
    [
      "ReadMail of mail it never had",
      "ReadMail",
      () => ({ id: "evt_none@2026-10-06" }),
      "not_found"
    ],
    ["ReadEvents with a bad date", "ReadEvents", () => ({ date: "yesterday" }), "daemon_error"],
    ["ReadMemory outside memory", "ReadMemory", () => ({ path: "../secret" }), "daemon_error"]
  ])("%s reaches an SDK client as a readable refusal", async (_label, tool, args, reason) => {
    const run = runId();
    const h = await harness(cleanup);
    const name = `dots-${run}`;
    await h.connectAs(name);
    const client = await h.sdkClient(name);
    const refused = await client.callTool({ name: tool, arguments: args(name) });
    expect(refused.isError).toBe(true);
    expect((refused._meta as Record<string, unknown>)["duoduo/reason"]).toBe(reason);
    expect((refused.content as Array<{ text: string }>)[0].text).not.toBe("");
  });
});
