// Agent liveness tracking.
//
// The desktop app knows when the agent comes up because it started it; the web
// server has to watch instead. It polls /health and broadcasts `agent-status`
// on every change, which is what releases the frontend's boot gate and triggers
// its reconnect work (plugin list refresh, pending-create flush).

import { checkHealth } from "./agent.js";
import { broadcast } from "./events.js";

export type AgentStatus = "running" | "starting" | "error";

const POLL_MS = 5_000;
// While the agent has never yet answered, report "starting" rather than
// "error" for this long — on a cold VM boot the web server is usually up first,
// and flashing a failure at someone who just needs to wait is worse than a spinner.
const STARTUP_GRACE_MS = 45_000;

const startedAt = Date.now();
let healthy = false;
let everHealthy = false;

export function currentStatus(): AgentStatus {
  if (healthy) return "running";
  if (!everHealthy && Date.now() - startedAt < STARTUP_GRACE_MS) return "starting";
  return "error";
}

/** Probe the agent now; broadcast if the answer changed. Returns the status. */
export async function refreshStatus(): Promise<AgentStatus> {
  const before = currentStatus();
  healthy = await checkHealth();
  if (healthy) everHealthy = true;
  const after = currentStatus();
  if (after !== before) broadcast("agent-status", after);
  return after;
}

export function startHealthPoller(): void {
  void refreshStatus();
  setInterval(() => void refreshStatus(), POLL_MS).unref();
}
