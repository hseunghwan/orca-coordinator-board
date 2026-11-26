// Adapted from paseo-coordinator-board server/display-usage.ts @ 2e9d128: import paths only. The folder is
// the board's data folder; account-usage.json there is a reading a host tool may keep for agents Orca does
// not report usage for.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { accountUsage, hasUsageReading, type AccountUsage } from "../paseo/shared/usage-routing";

const timestamp = z.iso.datetime({offset:true});
const report = accountUsage.extend({
  providerId: z.string().trim().min(1).max(256),
  label: z.string().trim().min(1).max(256),
  fetchedAt: timestamp,
  windows: accountUsage.shape.windows.element.extend({resetsAt:timestamp.nullable()}).array().max(32),
  balances: accountUsage.shape.balances.element.extend({resetsAt:timestamp.nullable()}).array().max(32),
});
const feed = z.object({version:z.literal(1),reports:z.array(z.unknown()).max(128)});
const maxBytes = 128 * 1024;

// Optional host-maintained readings are for display only. Remote callers cannot select a file.
export async function readDisplayUsage(directory: string, providers: readonly {id:string}[], native: readonly AccountUsage[]): Promise<AccountUsage[]> {
  const eligible = new Set(providers.map(p => p.id));
  for (const entry of native) if (hasUsageReading(entry)) eligible.delete(entry.providerId);
  if (!eligible.size) return [];
  let file;
  try {
    file = await open(join(directory, "account-usage.json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) return [];
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== stat.size) return [];
    const entries = feed.parse(JSON.parse(bytes.toString("utf8", 0, length))).reports;
    return entries.flatMap(raw => {
      const entry = report.safeParse(raw);
      return entry.success && eligible.has(entry.data.providerId) ? [entry.data] : [];
    });
  } catch { return []; }
  finally { await file?.close(); }
}
