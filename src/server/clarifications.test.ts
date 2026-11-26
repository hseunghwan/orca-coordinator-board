// Ported from paseo-coordinator-board test/clarification-routing.test.ts and the session parts of
// test/clarification-integration.test.ts @ 2e9d128, onto a fake Orca behind the real Fleet. Routing
// assertions are Paseo's. Orca has no permission request ids, so a new request is a new updatedAt.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createCli } from '../orca/cli'
import { readMarked, unframe } from '../orca/conversation'
import { fakeOrca } from '../orca/fixtures/fake-orca'
import { fixturePulls } from '../orca/fixtures/load'
import { createFleet } from '../orca'
import { askClarification, clarificationKey, clarificationRecipient, sessionClarificationCard, type ClarificationCard } from '../paseo/shared/clarifications'
import { boardScope, boardSnapshot, type SessionRow } from '../paseo/shared/contract'
import { sendDecision } from '../paseo/shared/decision-actions'
import { PreferenceStore } from '../paseo/server/preferences'
import { contribute } from './board'
import { ClarificationSender, restoreClarifiedDecision } from './clarifications'
import { permissionVersion } from './discovery'
import { rpcServer } from './rpc'

const scratch: string[] = []
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const iso = (ms: number) => new Date(ms).toISOString()

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'clarification-routing-'))
  scratch.push(dir)
  const prefs = new PreferenceStore(join(dir, 'prefs.json'))
  prefs.change(scope => { scope.projects = ['book']; scope.coordinator = 'coordinator' })
  const orca = fakeOrca([
    { id: 'worker', surface: 'chat', state: 'done', updatedAt: 1, title: 'Writer', project: 'book' },
    { id: 'coordinator', surface: 'chat', state: 'done', updatedAt: 1, title: 'Coordinator', project: 'book' }
  ])
  const worker = { id: 'worker', title: 'Writer', projectId: 'book', activityAt: iso(1), status: 'idle', lane: 'human',
    decision: { source: 'conversation', question: 'Release the book?', version: 'r1' } } as SessionRow
  const view = { sessions: [worker, { ...worker, id: 'coordinator' }], notes: {}, coordinator: 'coordinator' }
  const fleet = createFleet(createCli(orca.runner), Date.now, { dataDir: dir, sleep: async () => {}, mailSender: async () => 'term_board' })
  const sdk = fleet.paseo
  const calls = () => [...orca.transcripts].flatMap(([id, entries]) => entries.flatMap(e => {
    const marked = e.role === 'user' ? readMarked(e.text) : null
    return marked ? [{ id, text: marked.body, messageId: marked.messageId }] : []
  }))
  const sender = new ClarificationSender(prefs, fleet, async () => view)
  const card = sessionClarificationCard(worker)!
  const request = { card, recipientId: 'worker', requestKey: 'fixture-first-clarification', question: 'What does this change?' }
  return { orca, fleet, worker, view, prefs, sdk, sender, request, calls, dir }
}

test('a question about a session card reaches that session, marked, with the original question', async () => {
  const f = fixture()
  const { messageId } = await f.sender.send(f.sdk, f.request)
  expect(f.calls()).toEqual([{ id: 'worker', messageId, text: expect.stringContaining('What does this change?') }])
  expect(f.calls()[0].text.startsWith('[Coordinator Board · 추가 질문]')).toBe(true)
  expect(f.calls()[0].text).toContain('Release the book?')
  expect(f.prefs.read().clarifications[messageId]).toMatchObject({ status: 'sent', recipientId: 'worker' })
  expect((await f.sender.send(f.sdk, f.request)).messageId).toBe(messageId)
  expect(f.orca.writes).toHaveLength(1)
})

test('permission explanations reach the coordinator, never the session waiting for consent', async () => {
  const f = fixture()
  f.orca.find('worker')!.state = 'blocked'
  const live = (await f.sdk.agents.ref('worker').refresh())!.agent
  f.worker.nativePending = true
  f.worker.permissionVersion = permissionVersion(live as never)
  f.worker.decision = { source: 'permission', question: 'Export draft', version: 'permission-card' }
  const card = sessionClarificationCard(f.worker)!
  expect(sessionClarificationCard({ ...f.worker, permissionVersion: undefined })).toBeNull()
  expect(clarificationRecipient(card, f.view)).toBe('coordinator')
  expect(clarificationRecipient(card, { ...f.view, coordinator: 'worker' })).toBeNull()
  const input = { ...f.request, card, recipientId: 'coordinator' }
  await f.sender.send(f.sdk, input)
  expect(f.calls().map(c => c.id)).toEqual(['coordinator'])
  expect(f.calls()[0].text).toContain('Export draft')
  expect(f.calls()[0].text).toContain('"sourceSessionId":"worker"')
  expect(f.orca.find('worker')!.state).toBe('blocked')
  expect(f.prefs.read().answers).toEqual({})
  expect(f.prefs.read().decisionReceipts).toEqual({})
  f.orca.find('worker')!.updatedAt += 1
  await expect(f.sender.send(f.sdk, { ...input, requestKey: 'fixture-new-clarification' })).rejects.toThrow()
  expect(f.calls()).toHaveLength(1)
})

test('PR questions require a current review item and select a single verified workspace or the coordinator', () => {
  const f = fixture()
  const card: ClarificationCard = { kind: 'pull', projectId: 'book', repo: 'a/book', number: 2, updatedAt: 'r2' }
  const pr = { ...card, projectIds: ['book'], title: 'Fix pagination', lane: 'review', url: 'https://example.com/a/book/pull/2' }
  const view = { ...f.view, pullRequests: { items: [pr] } } as never
  const match = { kind: 'pr', repo: 'a/book', number: 2 }
  expect(clarificationRecipient(card, view)).toBe('coordinator')
  f.worker.workspacePull = match as never
  expect(clarificationRecipient(card, view)).toBe('worker')
  f.view.sessions.push({ ...f.worker, id: 'other' })
  expect(clarificationRecipient(card, view)).toBe('coordinator')
  pr.updatedAt = 'r3'
  expect(clarificationRecipient(card, view)).toBeNull()
  pr.updatedAt = 'r2'
  pr.lane = 'progress'
  expect(clarificationRecipient(card, view)).toBeNull()
})

test('a source update, revoked project, or changed recipient during refresh cannot create a receipt', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.orca.find('worker')!.updatedAt += 1 },
    f => { f.prefs.change(p => { p.projects = [] }) },
    f => { f.worker.status = 'running' },
    f => { f.orca.find('worker')!.state = 'blocked' },
    f => { f.prefs.change(p => { p.answers.worker = { version: 'r1' } }) }
  ]
  for (const change of changes) {
    const f = fixture()
    const sender = new ClarificationSender(f.prefs, f.fleet, async () => { change(f); return f.view })
    await expect(sender.send(f.sdk, f.request)).rejects.toThrow()
    expect(f.orca.writes).toEqual([])
    expect(f.prefs.read().clarifications).toEqual({})
  }
})

test('a photo goes with the question as a file path after the marker, and the receipt counts it', async () => {
  const f = fixture()
  const png = { mimeType: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mOYvLAHAAOLAcF4E9p3AAAAAElFTkSuQmCC' }
  const { messageId } = await f.sender.send(f.sdk, { ...f.request, images: [png] })
  expect(messageId.startsWith('c0bdf070')).toBe(true)
  const mail = f.calls()
  expect(mail).toHaveLength(1)
  expect(mail[0].text.startsWith('[Coordinator Board · 추가 질문]')).toBe(true)
  const sentBody = unframe(f.orca.transcripts.get('worker')!.at(-1)!.text).split('\n')
  expect(sentBody[1]).toMatch(/^\[사진 1\] .+\.png$/)
  expect(f.prefs.read().clarifications[messageId]).toMatchObject({ status: 'sent', imageCount: 1 })
})

test('classifying an explanation as informational cannot clear the original question', async () => {
  const f = fixture()
  const { messageId } = await f.sender.send(f.sdk, f.request)
  f.prefs.change(p => {
    p.judgments.worker = { projectId: 'book', evidenceId: 'explanation', kind: 'idle', text: 'Explanation complete.' }
  })
  const current = { ...f.worker, lane: 'idle', decision: undefined } as SessionRow
  const evidence = { id: 'explanation', lastInputIds: [messageId], turns: [] }
  restoreClarifiedDecision(current, undefined, f.prefs.read(), evidence)
  expect(current.decision).toEqual(f.worker.decision)
  expect(current.lane).toBe('human')
  const independent = { ...current, decision: undefined, lane: 'idle' } as SessionRow
  restoreClarifiedDecision(independent, undefined, f.prefs.read(), { ...evidence, laterInput: true })
  expect(independent.decision).toBeUndefined()
})

test('through the board RPCs: a question keeps the card open, its answer shows, then a reply is recorded with the response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-send-'))
  scratch.push(dir)
  const orca = fakeOrca([{ id: 'editor', surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_e', title: 'Studio editor', project: 'studio' }])
  orca.say('editor', 'assistant', '패딩을 몇 초로 할까요?')
  const fleet = createFleet(createCli(orca.runner), Date.now, { dataDir: dir, sleep: async () => {}, mailSender: async () => 'term_board' })
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>()
  contribute(rpcServer((name, fn) => handlers.set(name, fn), fleet.paseo), fleet, dir, fixturePulls)
  const rpc = async <T>(def: { name: string; output: { parse(v: unknown): T } }, input: unknown) => def.output.parse(await handlers.get(def.name)!(input))
  await rpc(boardScope, { kind: 'project', projectId: 'studio', enabled: true })
  const snapshot = () => rpc(boardSnapshot, { fresh: true })

  const first = await snapshot()
  const row = first.sessions.find(s => s.id === 'editor')!
  expect(row.decision?.source).toBe('conversation')
  const card = sessionClarificationCard(row)!
  const asked = await rpc(askClarification, { card, recipientId: 'editor', question: 'Which clip?', requestKey: 'fixture-question-editor' })
  orca.say('editor', 'assistant', 'The first clip shows the edit.')
  let board = await snapshot()
  expect(board.clarifications).toEqual([expect.objectContaining({ cardKey: clarificationKey(card), messageId: asked.messageId, status: 'sent', response: 'The first clip shows the edit.' })])
  const open = board.sessions.find(s => s.id === 'editor')!
  expect(open.decision?.version).toBe(row.decision!.version)
  expect(board.replyHistory ?? []).toEqual([])

  const reply = await rpc(sendDecision, { projectId: 'studio', sessionId: 'editor', recipientId: 'editor', version: open.decision!.version,
    action: 'reply', text: 'Use 0.10 seconds.', requestKey: 'fixture-answer-editor' })
  orca.say('editor', 'assistant', 'Padding set to 0.10 seconds.')
  board = await snapshot()
  expect(board.replyHistory).toEqual([expect.objectContaining({ messageId: reply.messageId, status: 'sent', answer: 'Use 0.10 seconds.', response: 'Padding set to 0.10 seconds.', canOpen: true })])
  expect(orca.writes.map(w => w.slice(0, 2).join(' '))).toEqual(['terminal send', 'terminal send'])
})
