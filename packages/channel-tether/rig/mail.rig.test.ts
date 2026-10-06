// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Mail between duoduo's sessions and connected assistants, through a real daemon.
 *
 * Not here, because the rig cannot set them up without starting a model or writing the
 * daemon's files behind its back (the unit suite covers the channel's half of each):
 * - mail from a job, and a job's outcome, bounced to the job: a job session exists only
 *   once a job runs, and a run starts a model;
 * - a delivery with no text (a wake) reaching an assistant as readable mail: only the
 *   daemon itself writes such a route;
 * - mail left unread past the consumer gate, and a session dropping out of ListAddresses
 *   for unread output: both need records dated hours back;
 * - ReadEvents answering the external-view goldens: they need a fixed day of events
 *   written into the spine.
 */

import { describe, expect, it, vi } from "vitest";
import { handleAdmin } from "../src/admin";
import { mailboxUri, mailIdOf } from "../src/mail";
import { renderBounce } from "../src/texts";
import { CLAUDE, CLAUDE_REDIRECT } from "../tests/helpers";
import { deliveries, harness, openOwner, runId, today, useCleanups, type Json } from "./helpers";

const cleanup = useCleanups();

/** The mail id the channel gives a delivery, from the event the daemon reported. */
function mailIdOfEvent(eventId: string, eventTs: string): string {
  return mailIdOf({
    id: "",
    created_at: eventTs,
    payload: { data: { event_id: eventId, event_ts: eventTs } }
  } as never);
}

describe("mail through the rig daemon", () => {
  it("a session and an assistant mail each other, each answer naming the mail it answers", async () => {
    const run = runId();
    const h = await harness(cleanup);
    const owner = await openOwner(h.daemon, run, cleanup);
    const name = `dots-${run}`;
    const grant = await h.connectAs(name);
    const rung: unknown[] = [];
    h.bus.subscribe((event) => rung.push(event));

    const asked = await h.daemon("session.notify", {
      target: `tether:${name}`,
      message: "which ratio?",
      caller_session: owner.key
    });
    expect(asked.result).toMatchObject({ ok: true });
    // The pull stream rings the grant's mailbox.
    await vi.waitFor(() =>
      expect(rung).toEqual([{ kind: "resource_updated", uri: mailboxUri(grant.grant_id) }])
    );
    const [question] = await h.unread(name);
    expect(question).toMatchObject({ from: owner.key, text: "which ratio?" });
    expect(await h.unread(name)).toEqual([]);

    const answer = await h.tool(name, "SendMail", {
      in_reply_to: question.id,
      message: "vertical"
    });
    const answerId = /as mail (mail_[0-9a-f]{16})/.exec(answer.content[0].text)?.[1];
    expect(answerId).toBeDefined();
    await vi.waitFor(() => expect(owner.records()).toHaveLength(1));
    expect(owner.records()[0].payload.data).toMatchObject({
      notify_source: `tether:${name}`,
      notify_in_reply_to: question.id
    });

    await h.daemon("session.notify", {
      target: `tether:${name}`,
      message: "thanks",
      in_reply_to: answerId,
      caller_session: owner.key
    });
    expect(await h.unread(name)).toEqual([
      expect.objectContaining({ from: owner.key, text: "thanks", in_reply_to: answerId })
    ]);
  });

  it("a bare event id names the unread mail it arrived as, and reading it acknowledges nothing", async () => {
    const run = runId();
    const h = await harness(cleanup);
    const owner = await openOwner(h.daemon, run, cleanup);
    const name = `dots-${run}`;
    await h.connectAs(name);
    const sent = (
      await h.daemon("session.notify", {
        target: `tether:${name}`,
        message: "which ratio?",
        caller_session: owner.key
      })
    ).result as Json;
    expect(sent).toMatchObject({ ok: true });
    const mailId = mailIdOfEvent(sent.event_id, sent.ts);

    const one = await h.tool(name, "ReadMail", { id: sent.event_id });
    expect(one.structuredContent.mails).toEqual([expect.objectContaining({ id: mailId })]);
    await h.tool(name, "SendMail", { in_reply_to: sent.event_id, message: "vertical" });
    await vi.waitFor(() => expect(owner.records()).toHaveLength(1));
    expect(owner.records()[0].payload.data).toMatchObject({ notify_in_reply_to: mailId });
    expect(await h.unread(name)).toEqual([expect.objectContaining({ id: mailId })]);
  });

  it("two assistants mail each other through their void sessions", async () => {
    const run = runId();
    const h = await harness(cleanup);
    const dots = `dots-${run}`;
    const muse = `muse-${run}`;
    await h.connectAs(dots);
    await h.connectAs(muse, { id: CLAUDE, redirect: CLAUDE_REDIRECT });
    await h.tool(dots, "SendMail", { to: `tether:${muse}`, message: "seen the cut?" });
    const [asked] = await h.unread(muse);
    expect(asked).toMatchObject({ from: `tether:${dots}`, text: "seen the cut?" });
    await h.tool(muse, "SendMail", { in_reply_to: asked.id, message: "yes" });
    expect(await h.unread(dots)).toEqual([
      expect.objectContaining({ from: `tether:${muse}`, text: "yes", in_reply_to: asked.id })
    ]);
  });

  it("revoke bounces unread mail to its sender and archives the assistant's session", async () => {
    const run = runId();
    const h = await harness(cleanup);
    const owner = await openOwner(h.daemon, run, cleanup);
    const name = `dots-${run}`;
    await h.connectAs(name);
    const sent = (
      await h.daemon("session.notify", {
        target: `tether:${name}`,
        message: "unread",
        caller_session: owner.key
      })
    ).result as Json;
    expect(sent).toMatchObject({ ok: true });
    const revoked = await handleAdmin(
      { store: h.store, config: h.config, daemon: h.daemon, mail: h.mail },
      { verb: "revoke", args: [name] }
    );
    expect(revoked.exitCode).toBe(0);
    await vi.waitFor(() => expect(owner.records()).toHaveLength(1));
    expect(owner.records()[0].payload.data).toMatchObject({
      notify_source: "duoduo",
      text: renderBounce(name, mailIdOfEvent(sent.event_id, sent.ts))
    });
    const sessions = (await h.daemon("session.list", {})).result as Array<{ session_key: string }>;
    expect(sessions.map((entry) => entry.session_key)).not.toContain(`tether:${name}`);
  });

  it("ListAddresses lists the sessions a Notify would reach and every granted assistant", async () => {
    const run = runId();
    const h = await harness(cleanup);
    const owner = await openOwner(h.daemon, run, cleanup);
    const dots = `dots-${run}`;
    const muse = `muse-${run}`;
    await h.connectAs(dots);
    await h.connectAs(muse, { id: CLAUDE, redirect: CLAUDE_REDIRECT });
    const mine = new Set([`tether:${dots}`, `tether:${muse}`, owner.key]);
    const listed = ((await h.tool(dots, "ListAddresses", {})).structuredContent.addresses as Json[])
      .map((row: { address: string }) => row.address)
      .filter((address: string) => mine.has(address));
    // Sorted by address, as the tool lists them.
    expect(listed).toEqual(
      [owner.key, `tether:${dots}`, `tether:${muse}`].sort((a, b) => a.localeCompare(b))
    );
  });

  it("a CLI notify run inside a session comes from that session, and the assistant can answer it", async () => {
    const run = runId();
    const h = await harness(cleanup);
    const owner = await openOwner(h.daemon, run, cleanup);
    const name = `dots-${run}`;
    await h.connectAs(name);
    const notified = (
      await h.daemon("session.notify", {
        target: `tether:${name}`,
        message: "from the session's shell",
        caller_session: owner.key
      })
    ).result as Json;
    expect(notified).toMatchObject({ ok: true, session_key: `tether:${name}` });
    const [route] = await deliveries(h.daemon, `tether:${name}`);
    // The same route source as the Notify tool's.
    expect(route.payload).toMatchObject({
      source_event_type: "notify",
      source_session_key: owner.key
    });
    const [mail] = await h.unread(name);
    expect(mail).toMatchObject({ from: owner.key, text: "from the session's shell" });

    await h.tool(name, "SendMail", { in_reply_to: mail.id, message: "got it" });
    await vi.waitFor(() => expect(owner.records()).toHaveLength(1));
    expect(owner.records()[0].payload.data).toMatchObject({
      notify_source: `tether:${name}`,
      notify_in_reply_to: mail.id
    });
  });

  it("a CLI notify without a caller session keeps its source label", async () => {
    const run = runId();
    const h = await harness(cleanup);
    const name = `dots-${run}`;
    await h.connectAs(name);
    await h.daemon("session.notify", { target: `tether:${name}`, message: "from a terminal" });
    const [route] = await deliveries(h.daemon, `tether:${name}`);
    expect(route.payload).toMatchObject({
      source_event_type: "external.notify",
      source_session_key: "external:session.notify"
    });
    expect(await h.unread(name)).toEqual([
      expect.objectContaining({ from: "session.notify", text: "from a terminal" })
    ]);
  });

  it("a caller naming the target itself keeps the source label", async () => {
    const run = runId();
    const h = await harness(cleanup);
    const owner = await openOwner(h.daemon, run, cleanup);
    const notified = await h.daemon("session.notify", {
      target: owner.key,
      message: "watcher fired",
      caller_session: owner.key
    });
    expect(notified.result).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(owner.records()).toHaveLength(1));
    expect(owner.records()[0].payload.data).toMatchObject({
      source_session_key: "external:session.notify",
      notify_source: "session.notify"
    });
  });

  it("an unknown caller session is refused in words, and nothing is sent", async () => {
    const run = runId();
    const h = await harness(cleanup);
    const name = `dots-${run}`;
    await h.connectAs(name);
    const gone = `rigchat:${run}:gone`;
    const notified = await h.daemon("session.notify", {
      target: `tether:${name}`,
      message: "from a gone session",
      caller_session: gone
    });
    expect(notified.result).toMatchObject({
      ok: false,
      reason: "unknown_caller",
      caller_session: gone
    });
    expect((notified.result as { error: string }).error).toContain(gone);
    expect(await deliveries(h.daemon, `tether:${name}`)).toEqual([]);
  });

  it("RecordExperience appends one external.record; a retry is a duplicate", async () => {
    const run = runId();
    const h = await harness(cleanup);
    const name = `dots-${run}`;
    const grant = await h.connectAs(name);
    const args = {
      conversation: "c-1",
      board_rev: "rev",
      said: "vertical by default",
      did: "re-exported",
      outcome: "done"
    };
    const first = await h.tool(name, "RecordExperience", args);
    const retry = await h.tool(name, "RecordExperience", args);
    expect(first.structuredContent.duplicate).toBe(false);
    expect(retry.structuredContent).toMatchObject({
      duplicate: true,
      event_id: first.structuredContent.event_id
    });
    const listed = (
      await h.daemon("spine.cat", {
        date: today(),
        session: `${name}:c-1`,
        types: ["external.record"],
        unfiltered: true,
        json: true
      })
    ).result as { text: string };
    expect(listed.text.split("\n").filter((line) => line !== "")).toHaveLength(1);
    const reply = await h.daemon("spine.cat", {
      date: today(),
      show: first.structuredContent.event_id
    });
    expect(JSON.parse((reply.result as { text: string }).text)).toMatchObject({
      type: "external.record",
      source: { kind: name },
      session_key: `${name}:c-1`,
      payload: { text: "vertical by default", client: { grant: grant.grant_id } }
    });
  });
});
