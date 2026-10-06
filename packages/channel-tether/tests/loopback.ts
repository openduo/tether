// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The channel's routes on a real loopback port, called over HTTP as whatever
 * exposes the channel would call them. A `text/event-stream` answer resolves
 * once its headers arrive and keeps collecting its text.
 */

import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

/** A streamed answer: the text so far, how it ended, and the client going away. */
export type LoopbackStream = {
  data: string;
  ended: "end" | "cancelled" | null;
  cancel: () => void;
};

export type LoopbackResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
  stream?: LoopbackStream;
};

export type LoopbackRequest = (input: {
  method: "GET" | "POST";
  path: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<LoopbackResponse>;

/** Listens on 127.0.0.1 at a free port; the caller closes the app. */
export async function listenLoopback(app: FastifyInstance): Promise<LoopbackRequest> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return async (input) => {
    const leave = new AbortController();
    const response = await fetch(`${base}${input.path}`, {
      method: input.method,
      headers: input.headers ?? {},
      redirect: "manual",
      signal: leave.signal,
      ...(input.method === "POST" ? { body: input.body ?? "" } : {})
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    if (!headers["content-type"]?.startsWith("text/event-stream") || response.body === null) {
      return { status: response.status, headers, body: await response.text() };
    }
    const stream: LoopbackStream = {
      data: "",
      ended: null,
      cancel: () => {
        stream.ended = "cancelled";
        leave.abort();
      }
    };
    void (async () => {
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          stream.data += value;
        }
        stream.ended ??= "end";
      } catch {
        // The client cancelled: the read ends with an abort.
      }
    })();
    return { status: response.status, headers, body: "", stream };
  };
}
