// The parts of the Paseo plugin SDK (@getpaseo/plugin 0.16) that the ported files import, with the
// same call shapes and name checks, so those files run here with only their import paths changed.
import type { ZodType } from "zod";

export interface PluginRpcContract<InputSchema extends ZodType = ZodType, OutputSchema extends ZodType = ZodType> {
  name: string;
  input: InputSchema;
  output: OutputSchema;
}

const RPC_NAME = /^[a-z][a-z0-9._-]*$/;

export function defineRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
  definition: PluginRpcContract<InputSchema, OutputSchema>,
): PluginRpcContract<InputSchema, OutputSchema> {
  const name = definition.name.trim();
  if (!RPC_NAME.test(name)) throw new Error(`Invalid plugin RPC method: ${definition.name}`);
  return { ...definition, name };
}

export interface SettingsDefinition<Schema extends ZodType = ZodType> {
  id: string;
  scope: "host" | "device";
  version: number;
  schema: Schema;
  migrate?: (values: unknown, fromVersion: number) => unknown | Promise<unknown>;
}

export function defineSettings<Schema extends ZodType>(definition: SettingsDefinition<Schema>): SettingsDefinition<Schema> {
  if (!/^[a-z][a-z0-9_-]*$/.test(definition.id)) throw new Error("Invalid settings ID");
  if (definition.scope !== "host" && definition.scope !== "device") throw new Error("Invalid settings scope");
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) throw new Error("Invalid settings version");
  return definition;
}

// The fields of the Paseo client API (@getpaseo/client 0.16) that client/remote-sessions.ts reads.
type PageRequest = { limit: number; cursor?: string };
type Page<T> = { entries: T[]; pageInfo: { nextCursor: string | null; prevCursor: string | null; hasMore: boolean } };
type Sort<Key extends string> = { key: Key; direction: "asc" | "desc" }[];
type Checkout = { currentBranch?: string | null; remoteUrl?: string | null };

export type PaseoAgent = {
  id: string;
  title: string | null;
  status: "error" | "initializing" | "idle" | "running" | "closed";
  workspaceId?: string;
  internal?: boolean;
  updatedAt: string;
  pendingPermissions: unknown[];
  attentionReason?: "error" | "finished" | "permission" | null;
  archivedAt?: string | null;
};
export type PaseoProject = { projectKey: string; projectName: string; checkout: Checkout; workspaceName?: string | null };
export type PaseoWorkspace = {
  id: string;
  projectId: string;
  internal?: boolean;
  archivingAt: string | null;
  gitRuntime?: Checkout | null;
  githubRuntime?: {
    pullRequest?: { url: string; title: string; state: string; headRefName: string; isMerged: boolean; number?: number } | null;
  } | null;
  project?: { checkout: Checkout };
};

export type PaseoClient = {
  agents: {
    list(options?: {
      filter?: {
        statuses?: PaseoAgent["status"][];
        includeArchived?: boolean;
        includeBackground?: boolean;
        includeInternal?: boolean;
      };
      sort?: Sort<"title" | "status_priority" | "created_at" | "updated_at">;
      page?: PageRequest;
    }): Promise<Page<{ agent: PaseoAgent; project: PaseoProject }>>;
    ref(id: string): { refresh(): Promise<{ agent: PaseoAgent; project: PaseoProject | null } | null> };
  };
  workspaces: {
    list(options?: {
      filter?: { includeBackground?: boolean };
      sort?: Sort<"status_priority" | "name" | "activity_at" | "project_id">;
      page?: PageRequest;
    }): Promise<Page<PaseoWorkspace>>;
  };
};

export declare function getPaseoClient(serverId: string): PaseoClient;
