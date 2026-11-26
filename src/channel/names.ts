// The channel's names and exit codes, kept apart from its schemas so the CLI bundle carries no zod.
export const COMMANDS = ['read', 'classify', 'plan', 'assign', 'fact', 'review', 'report'] as const
export type Command = (typeof COMMANDS)[number]

/** 2 and 3 are the CLI's own: it never reached the worker, or lost it after sending. */
export const EXIT = { ok: 0, error: 1, absent: 2, dropped: 3, denied: 4 } as const

export const MAX_LINE = 1 << 20
