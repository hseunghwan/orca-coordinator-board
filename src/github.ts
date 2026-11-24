// GitHub lookups the worker runs through git and gh, parsed without dependencies.
import { cleanLine, type PullItem, type PullReason } from './model'

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/i

/** GitHub.com owner/repository only, lowercased; null for anything else. */
export function repositorySlug(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const slug = value.trim()
  if (!SLUG.test(slug) || ['.', '..'].includes(slug.split('/')[1])) return null
  return slug.toLowerCase()
}

export function githubRepository(remote: string | null | undefined): string | null {
  if (!remote || remote.length > 512) return null
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/?#\s]+\/[^/?#\s]+?)\/?$/i.exec(remote.trim())
  return match ? repositorySlug(match[1].replace(/\.git$/i, '')) : null
}

export const pullUrl = (repo: string, number: number): string => `https://github.com/${repo}/pull/${number}`

export const SCAN_LIMIT = 200
export const GH_FIELDS = 'number,title,state,updatedAt,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,autoMergeRequest'
export const GH_PROJECTION = '[.[] | {number,title,state,updatedAt,isDraft,mergeable,mergeStateStatus,reviewDecision,checks:[.statusCheckRollup[]? | {status,conclusion,state}],autoMerge:(.autoMergeRequest != null)}]'

type Check = { status?: string | null; conclusion?: string | null; state?: string | null }
type RawPull = {
  number: number
  title: string
  updatedAt: string
  isDraft: boolean
  mergeable: string | null
  mergeStateStatus: string | null
  reviewDecision: string | null
  checks: Check[]
  autoMerge: boolean
}

const text = (value: unknown): value is string | null => value === null || typeof value === 'string'

function rawPull(value: unknown): RawPull | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (!Number.isInteger(row.number) || (row.number as number) <= 0 || typeof row.title !== 'string') return null
  if (row.state !== 'OPEN' || typeof row.updatedAt !== 'string' || Number.isNaN(Date.parse(row.updatedAt))) return null
  if (typeof row.isDraft !== 'boolean' || typeof row.autoMerge !== 'boolean' || !Array.isArray(row.checks)) return null
  if (!text(row.mergeable) || !text(row.mergeStateStatus) || !text(row.reviewDecision)) return null
  return row as unknown as RawPull
}

const FAILING = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']
const GREEN = ['SUCCESS', 'NEUTRAL', 'SKIPPED']

export function pullReason(p: RawPull): PullReason {
  if (p.isDraft || p.mergeStateStatus === 'DRAFT') return 'draft'
  if (p.mergeable === 'CONFLICTING' || p.mergeStateStatus === 'DIRTY') return 'conflict'
  if (p.checks.some((c) => FAILING.includes(c.conclusion || c.state || ''))) return 'checks-failed'
  if (p.reviewDecision === 'CHANGES_REQUESTED') return 'changes-requested'
  if (p.checks.some((c) => (c.status ? c.status !== 'COMPLETED' : ['PENDING', 'EXPECTED'].includes(c.state ?? '')))) return 'checks-pending'
  if (p.autoMerge) return 'auto-merge'
  if (p.reviewDecision === 'REVIEW_REQUIRED' || ['BLOCKED', 'BEHIND', 'UNSTABLE', 'HAS_HOOKS'].includes(p.mergeStateStatus ?? '')) return 'blocked'
  if (p.reviewDecision && p.reviewDecision !== 'APPROVED') return 'unknown'
  if (p.checks.some((c) => !(c.status === 'COMPLETED' && GREEN.includes(c.conclusion ?? '')) && c.state !== 'SUCCESS')) return 'unknown'
  return p.mergeable === 'MERGEABLE' && p.mergeStateStatus === 'CLEAN' ? 'ready' : 'unknown'
}

export function parseOpenPulls(repo: string, json: string): { status: 'ok' | 'truncated'; items: PullItem[] } {
  const rows: unknown = JSON.parse(json)
  if (!Array.isArray(rows)) throw new Error('gh returned something other than a list')
  const seen = new Set<number>()
  const items: PullItem[] = []
  for (const row of rows.slice(0, SCAN_LIMIT)) {
    const pull = rawPull(row)
    if (!pull || seen.has(pull.number)) continue
    seen.add(pull.number)
    // A title is text anyone with push access wrote: no control or bidirectional characters.
    items.push({ repo, number: pull.number, title: cleanLine(pull.title), url: pullUrl(repo, pull.number), reason: pullReason(pull), updatedAt: pull.updatedAt })
  }
  return { status: rows.length > SCAN_LIMIT ? 'truncated' : 'ok', items }
}
