// Paseo keeps whether a session may report to the board in the agent's metadata (reportingKey); Orca has no agent
// metadata, so the board keeps the flag in its data folder. A worker the coordinator started through the board
// reports by default, as Paseo's dispatch sets the metadata; board.set-reporting overrides either way.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const file = z.object({ version: z.literal(1), sessions: z.record(z.string(), z.boolean()) });

export class ReportingStore {
  constructor(private readonly path: string, private readonly dispatched: (sessionId: string) => boolean = () => false) {}
  private read(): Record<string, boolean> {
    try { return file.parse(JSON.parse(readFileSync(this.path, "utf8"))).sessions; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
  enabled(sessionId: string): boolean {
    return this.read()[sessionId] ?? this.dispatched(sessionId);
  }
  set(sessionId: string, enabled: boolean) {
    const sessions = { ...this.read(), [sessionId]: enabled };
    mkdirSync(join(this.path, ".."), { recursive: true, mode: 0o700 });
    const temp = this.path + "." + randomUUID();
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, sessions }), { flag: "wx", mode: 0o600 });
      renameSync(temp, this.path);
    } finally { rmSync(temp, { force: true }); }
  }
}
