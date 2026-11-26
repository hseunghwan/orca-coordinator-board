// The channel's names and exit codes, kept apart from its schemas so the CLI bundle carries no zod.
export const COMMANDS = ['read', 'classify', 'plan', 'assign', 'fact', 'review', 'report'] as const
export type Command = (typeof COMMANDS)[number]

/** 2 and 3 are the CLI's own: it never reached the worker, or lost it after sending. */
export const EXIT = { ok: 0, error: 1, absent: 2, dropped: 3, denied: 4 } as const

export const MAX_LINE = 1 << 20

/**
 * Protocol 2: while the worker answers a request, it may ask the command to run orca in the caller's own
 * shell, so Orca sees the caller as the one acting (a launch shows as its handoff). The command answers each
 * exec line with an exec-result line; the reply line ends the exchange.
 */
export type ExecFrame = { kind: 'exec'; id: number; args: string[]; timeoutMs: number }
/** stdout as orca printed it, even on a non-zero exit; error only when orca timed out, never started, or died without output. */
export type ExecResult = { kind: 'exec-result'; id: number; stdout: string; error: { code: 'timeout' | 'spawn_failed' | 'exec_failed'; message: string } | null }
