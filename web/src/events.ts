// Server→browser event bus, standing in for the Tauri event system.
//
// The desktop app pushes `agent-status`, `setup-progress` and `chat-stream`
// events at the webview; here every connected browser holds one SSE connection
// on /api/events and receives the same named payloads. `chat-stream` frames
// carry a requestId, so a tab that didn't start a turn ignores its frames (the
// frontend already filters on it) and several tabs can watch at once.

import type { Response } from "express";

interface Client {
  res: Response;
}

const clients = new Set<Client>();

/** Push a named event to every connected browser. */
export function broadcast(event: string, payload: unknown): void {
  const frame = `data: ${JSON.stringify({ event, payload })}\n\n`;
  for (const client of clients) {
    // A client that has gone away throws on write; drop it rather than let the
    // error escape into whatever triggered the broadcast.
    try {
      client.res.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

/** Attach a response as an SSE stream until the browser disconnects. */
export function addClient(res: Response): Client {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Defeat proxy buffering — without this an nginx in front would hold frames.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const client: Client = { res };
  clients.add(client);

  // Comment frames keep idle connections from being reaped by intermediaries.
  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(keepAlive);
      clients.delete(client);
    }
  }, 25_000);

  res.on("close", () => {
    clearInterval(keepAlive);
    clients.delete(client);
  });

  return client;
}

/** Send one event to a single client (used to prime a fresh connection). */
export function sendTo(client: Client, event: string, payload: unknown): void {
  try {
    client.res.write(`data: ${JSON.stringify({ event, payload })}\n\n`);
  } catch {
    clients.delete(client);
  }
}
