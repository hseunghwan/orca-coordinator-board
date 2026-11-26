import { defineRpc } from "../plugin-shim";
import { z } from "zod";

// GitHub.com owner/repository only. Keep remote credentials, paths and CLI flags out of settings.
export const repositorySlug = z.string().trim()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/i)
  .refine(value => ![".", ".."].includes(value.split("/")[1]))
  .transform(value => value.toLowerCase());
export const repositoryMode = z.enum(["auto", "manual", "off"]);
export const repositoryOverride = z.discriminatedUnion("mode", [
  z.object({ mode:z.literal("manual"), repo:repositorySlug }), z.object({mode:z.literal("off")}),
]);
export const pullReason = z.enum(["ready","draft","conflict","checks-failed","checks-pending","changes-requested","blocked","unknown","auto-merge"]);
const pull = z.object({
  repo:repositorySlug, number:z.number().int().positive(), title:z.string(), url:z.string().url(),
  headRepo:repositorySlug.optional(), headBranch:z.string().optional(),
  projectIds:z.array(z.string()), lane:z.enum(["review","progress"]), reason:pullReason, updatedAt:z.string(),
});
export const pullRequestViewSchema = z.object({
  items:z.array(pull),
  projects:z.array(z.object({
    projectId:z.string(), repo:repositorySlug.nullable(), mode:repositoryMode,
    status:z.enum(["ok","unmapped","unavailable","off","truncated"]),
  })),
});
export type PullRequestView = z.infer<typeof pullRequestViewSchema>;
export type PullRequestItem = z.infer<typeof pull>;
export const setProjectRepository = defineRpc({
  name:"board.set-project-repository",
  input:z.strictObject({
    projectId:z.string().min(1).max(4096), mode:repositoryMode, repo:repositorySlug.nullable().optional(),
    expectedMode:repositoryMode, expectedRepo:repositorySlug.nullable(),
  }).refine(input => input.mode === "manual" ? !!input.repo : !input.repo),
  output:z.object({ok:z.literal(true)}),
});

export const mergeMethod = z.enum(["merge", "squash", "rebase"]);
export type MergeMethod = z.infer<typeof mergeMethod>;
const mergeReason = z.enum([...pullReason.options, "merged", "closed", "queue", "permission", "no-method",
  "changed", "expired", "scope", "unavailable", "unconfirmed"]);
export type MergeReason = z.infer<typeof mergeReason>;
const mergeTarget = z.strictObject({
  projectId: z.string().min(1).max(4096), repo: repositorySlug, number: z.number().int().positive().max(2147483647),
});
export type MergeTarget = z.infer<typeof mergeTarget>;
export const mergeNotification = z.object({
  status: z.enum(["sent", "queued", "unavailable", "unconfirmed"]),
  recipientId: z.string().optional(),
});
export type MergeNotification = z.infer<typeof mergeNotification>;
export const pullMergeEvidence = mergeTarget.omit({projectId:true}).extend({
  status: z.enum(["merged", "already-merged"]),
  mergeSha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  notification: mergeNotification.optional(),
});
export const pullMergeActivity = z.object({
  projectId: z.string(), title: z.string(), at: z.string().datetime(), pullMerge: pullMergeEvidence,
});
export type PullMergeActivity = z.infer<typeof pullMergeActivity>;
export const pullLifecycle = z.enum(["OPEN", "CLOSED", "MERGED", "UNKNOWN"]);
export const readPullLifecycle = defineRpc({
  name: "board.read-pull-lifecycle", input: mergeTarget, output: z.object({ state: pullLifecycle }),
});
export const pullUrl = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}`;
const mergePreview = z.object({
  status: z.enum(["ready", "blocked", "merged"]), reason: mergeReason, title: z.string(),
  headSha: z.string(), headRef: z.string(), baseRef: z.string(), baseSha: z.string(), checks: z.number().int().nonnegative(),
  methods: z.array(mergeMethod), defaultMethod: mergeMethod.nullable(), token: z.string().uuid().nullable(),
});
export type MergePreview = z.infer<typeof mergePreview>;
const mergeResult = z.object({
  status: z.enum(["merged", "already-merged", "changed", "blocked", "unconfirmed"]),
  reason: mergeReason, mergeSha: z.string().nullable(), notification: mergeNotification.optional(),
});
export type MergeResult = z.infer<typeof mergeResult>;
export const previewPullRequestMerge = defineRpc({ name: "board.preview-pull-request-merge", input: mergeTarget, output: mergePreview });
export const confirmPullRequestMerge = defineRpc({
  name: "board.confirm-pull-request-merge",
  input: mergeTarget.extend({ token: z.string().uuid(), method: mergeMethod }), output: mergeResult,
});
