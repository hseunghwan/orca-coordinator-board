import { defineSettings } from "../plugin-shim";
import { z } from "zod";

export const hostVisibility = defineSettings({
  id: "host-visibility",
  scope: "host",
  version: 1,
  schema: z.object({ hidden: z.array(z.string().min(1)).default([]) }),
});

type Status = "idle" | "connecting" | "online" | "offline" | "error" | "unknown";
export type BoardHost = { serverId: string; label: string; status: Status };

export function boardHosts(current: { id: string; label: string }, registered: readonly BoardHost[]) {
  const directory = new Map(registered.map(host => [host.serverId, host]));
  if (!directory.has(current.id)) {
    directory.set(current.id, { serverId: current.id, label: current.label, status: "unknown" });
  }
  const hosts = [...directory.values()];
  return hosts.map(host => {
    const peers = hosts.filter(other => other.label === host.label && other.serverId !== host.serverId);
    if (!peers.length) return host;
    let suffix = host.serverId.slice(-7);
    while (suffix.length < host.serverId.length && peers.some(other => other.serverId.endsWith(suffix))) {
      suffix = host.serverId.slice(-(suffix.length + 1));
    }
    return { ...host, label: `${host.label} · ${suffix}` };
  });
}

export function hiddenAfter(hidden: string[], id: string, show: boolean) {
  const next = hidden.filter(value => value !== id);
  return show ? next : [...next, id];
}
