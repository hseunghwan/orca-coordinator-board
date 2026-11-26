// Ported from paseo-coordinator-board test/usage-routing.test.ts @ 2e9d128 (the display usage case).
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { AccountUsage } from '../paseo/shared/usage-routing'
import { readDisplayUsage } from './display-usage'

const now = Date.parse('2026-11-22T06:00:00Z')
function report(providerId: string, remaining: number, id = 'weekly'): AccountUsage {
  return { providerId, label: providerId, plan: null, fetchedAt: new Date(now).toISOString(), status: 'available', balances: [],
    windows: [{ id, label: id, summary: true, resetsAt: null, remainingPct: remaining }] }
}

test('host readings fill only configured provider gaps and preserve the original observation time', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'board-usage-'))
  try {
    const write = (rows: unknown[]) => writeFileSync(join(folder, 'account-usage.json'), JSON.stringify({ version: 1, reports: rows }))
    const host = report('custom', 0), paid = report('native', 70)
    const installed = [{ id: 'custom' }, { id: 'native' }]
    write([host, paid, report('absent', 50), { ...host, fetchedAt: 'invalid' }, { ...host, windows: [{ ...host.windows[0], remainingPct: 120 }] }])
    const empty = { ...host, status: 'unavailable' as const, windows: [] }
    expect(await readDisplayUsage(folder, installed, [paid, empty])).toEqual([host])
    expect(await readDisplayUsage(folder, installed, [host, paid])).toEqual([])
    const expired = { ...host, windows: [{ ...host.windows[0], resetsAt: '2000-01-01T00:00:00Z' }] }
    expect(await readDisplayUsage(folder, installed, [expired, paid])).toEqual([host])
    const credit = { ...host, windows: [], balances: [{ id: 'credits', label: 'Credits', remaining: 0, unit: 'credits', limit: null, resetsAt: null }] }
    expect(await readDisplayUsage(folder, installed, [credit, paid])).toEqual([])
    writeFileSync(join(folder, 'account-usage.json'), '{')
    expect(await readDisplayUsage(folder, installed, [])).toEqual([])
    writeFileSync(join(folder, 'account-usage.json'), ' '.repeat(131073))
    expect(await readDisplayUsage(folder, installed, [])).toEqual([])
    rmSync(join(folder, 'account-usage.json'))
    writeFileSync(join(folder, 'other'), JSON.stringify({ version: 1, reports: [host] }))
    // Windows lets only some accounts make a symbolic link; the case stands where it can be made.
    let linked = true
    try { symlinkSync(join(folder, 'other'), join(folder, 'account-usage.json')) } catch { linked = false }
    if (linked) expect(await readDisplayUsage(folder, installed, [])).toEqual([])
  } finally { rmSync(folder, { recursive: true, force: true }) }
})
