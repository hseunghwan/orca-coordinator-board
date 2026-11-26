// Ported from paseo-coordinator-board test/decision-actions.test.ts @ 2e9d128 onto a fake Orca behind
// the real Fleet. Assertions are Paseo's; only the transport differs: what a session received is
// read back from its transcript by the board's marker, and a lost answer is settled from it.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createCli } from '../orca/cli'
import { readMarked } from '../orca/conversation'
import { fakeOrca } from '../orca/fixtures/fake-orca'
import { createFleet, type SessionId } from '../orca'
import { sendDecision, type DecisionInput } from '../paseo/shared/decision-actions'
import { NoteStore } from '../paseo/server/notes'
import { PreferenceStore } from '../paseo/server/preferences'
import { ConversationReader } from './conversation'
import { decorateDecision, DecisionSender } from './decisions'
import { SessionPhotoStore } from '../paseo/server/session-photos'
import { existsSync, readFileSync } from 'node:fs'
import { discoverSessions } from './discovery'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'decision-card-test-'))
  dirs.push(root)
  const prefs = new PreferenceStore(join(root, 'scope.json'))
  prefs.change(s => { s.projects = ['acme']; s.coordinator = 'coordinator' })
  const notes = new NoteStore(join(root, 'notes.json'))
  const orca = fakeOrca([
    { id: 'worker', surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_w', title: 'worker' },
    { id: 'coordinator', surface: 'chat', state: 'done', updatedAt: 1, title: 'coordinator' },
    { id: 'other', surface: 'chat', state: 'done', updatedAt: 1, title: 'other', project: 'unmanaged' }
  ])
  orca.say('worker', 'assistant', '자막을 한 줄로 할까요?')
  const fleetOn = () => createFleet(createCli(orca.runner), Date.now, { dataDir: root, sleep: async () => {}, mailSender: async () => 'term_board' })
  const fleet = fleetOn()
  const reader = new ConversationReader()
  const sender = new DecisionSender(prefs, notes, reader, fleet)
  const sdk = fleet.paseo
  /** What each session received from the board, in order. */
  const sent = () => [...orca.transcripts].flatMap(([id, entries]) => entries.flatMap(e => {
    const marked = e.role === 'user' ? readMarked(e.text) : null
    return marked ? [{ id, text: marked.body, messageId: marked.messageId }] : []
  }))

  async function row() {
    fleet.invalidate()
    const result = (await discoverSessions(sdk)).find(r => r.id === 'worker')!
    const scope = prefs.read()
    await reader.decorate(sdk, [result], scope)
    decorateDecision(result, notes.visible(new Set(['worker'])).worker, scope)
    return result
  }
  const initial = await row()
  const input: DecisionInput = {
    projectId: 'acme', sessionId: 'worker', recipientId: 'worker', version: initial.decision!.version,
    action: 'reply', text: '한 줄로 해 주세요.', requestKey: 'send-000000001'
  }
  const send = (changes: Partial<DecisionInput> = {}) => sender.send(sdk, sendDecision.input.parse({ ...input, ...changes }))
  /** A worker restart: a new Fleet and sender over the same data folder. */
  const restart = () => { const next = fleetOn(); return { sdk: next.paseo, sender: new DecisionSender(prefs, notes, new ConversationReader(), next) } }
  return { prefs, notes, orca, sent, send, row, input, restart, root }
}

test('구조화 질문·추천·선택은 해당 근거에만 붙고 자유 입력은 클릭한 문장 그대로 원래 세션으로 간다', async () => {
  const f = await fixture()
  const original = await f.row()
  expect(original.decision!.source).toBe('conversation')
  f.prefs.change(scope => { scope.judgments.worker = {
    projectId: 'acme', evidenceId: original.evidenceId!, kind: 'question', text: '자막 줄 수',
    content: { question: '몇 줄로 만들까요?', recommendation: '한 줄로', options: [{ label: '두 줄', reply: '두 줄로 나눠 주세요.' }] }
  } })
  const current = await f.row()
  expect(current.decision).toMatchObject({ source: 'coordinator', question: '몇 줄로 만들까요?', options: [{ label: '두 줄', reply: '두 줄로 나눠 주세요.' }] })
  await expect(f.send()).rejects.toThrow('바뀌었습니다')
  const text = '두 줄로 나눠 주세요.\n마지막 자막은 유지해 주세요.'
  const r = await f.send({ version: current.decision!.version, text })
  expect(f.sent()).toHaveLength(1)
  expect(f.sent()[0]).toMatchObject({ id: 'worker', messageId: r.messageId })
  const [header, metadata, blank, ...body] = f.sent()[0].text.split('\n')
  expect(header).toContain('Coordinator Board')
  expect(JSON.parse(metadata)).toMatchObject({
    projectId: current.projectId, sourceSessionId: current.id, recipientSessionId: 'worker', revision: current.decision!.version,
    questions: [{ id: current.decision!.version, text: current.decision!.question }]
  })
  expect(blank).toBe('')
  expect(body.join('\n')).toBe(text)
  // Paseo's fake kept the session's activity time, so its cached excerpt marked the card answered.
  // Orca moves updatedAt when the text lands; the answer is recorded and the card leaves the human lane.
  expect(f.prefs.read().answers.worker?.version).toBe(current.decision!.version)
  expect((await f.row()).decision).toBeUndefined()
})

test('질문과 코디네이터 조율은 답변 처리하지 않고, 지정한 세션이나 코디네이터 이외에는 보내지 않는다', async () => {
  const f = await fixture()
  await expect(f.send({ recipientId: 'other' })).rejects.toThrow()
  await expect(f.send({ action: 'coordinate', recipientId: 'worker' })).rejects.toThrow('바뀌었습니다')
  expect(f.orca.writes).toEqual([])
  await f.send({ action: 'coordinate', recipientId: 'coordinator', text: '두 작업의 순서를 조율해 주세요.' })
  expect(f.sent()).toEqual([expect.objectContaining({ id: 'coordinator' })])
  expect(f.sent()[0].text.endsWith('두 작업의 순서를 조율해 주세요.')).toBe(true)
  await f.send({ action: 'question', text: '두 줄로 나누면 어디에서 끊나요?', requestKey: 'send-000000002' })
  expect(f.sent().map(s => s.id).sort()).toEqual(['coordinator', 'worker'])
  expect(f.prefs.read().answers).toEqual({})
  expect(Object.values(f.prefs.read().decisionReceipts).map(r => r.activity?.coordinator).sort()).toEqual([false, true])
})

test('권한 요청, 관리 범위 철회, 변경된 발췌, 바뀐 활동 시각을 전송 직전 거절한다', async () => {
  for (const scenario of ['native', 'stale', 'removed', 'activity']) {
    const f = await fixture()
    if (scenario === 'native') {
      f.orca.find('worker')!.state = 'blocked'
      expect((await f.row()).decision?.source).toBe('permission')
    }
    if (scenario === 'removed') f.orca.behavior.beforePs = () => f.prefs.change(s => { s.projects = [] })
    if (scenario === 'activity') f.orca.behavior.beforePs = () => { f.orca.find('worker')!.updatedAt += 1 }
    if (scenario === 'stale') f.orca.say('worker', 'assistant', '새 기획 제목을 정해 주세요.')
    await expect(f.send(), scenario).rejects.toThrow()
    expect(f.orca.writes).toEqual([])
  }
})

test('수신 확인이 끊겨도 동일 요청을 재전송하지 않고 기록의 같은 메시지 ID로 복구한다', async () => {
  const f = await fixture()
  f.orca.behavior.loseAnswer = true
  f.orca.behavior.dropText = true
  const text = '한 줄로 해 주세요.'
  await expect(f.send()).rejects.toThrow('전송 결과')
  await expect(f.send({ text: '바뀐 답' })).rejects.toThrow()
  await expect(f.send({ text: '다른 부탁', requestKey: 'other-000000000' })).rejects.toThrow()
  const messageId = Object.keys(f.prefs.read().decisionReceipts)[0]
  const stamped = f.orca.writes[0][f.orca.writes[0].indexOf('--text') + 1]
  f.orca.say('worker', 'user', stamped)
  const restarted = f.restart()
  const result = await restarted.sender.send(restarted.sdk, { ...f.input, requestKey: 'after-restart-0001' })
  expect(result.messageId).toBe(messageId)
  await expect(restarted.sender.send(restarted.sdk, { ...f.input, text: 'different', requestKey: 'after-restart-0001' })).rejects.toThrow('같은 전송 키')
  const replay = await restarted.sender.send(restarted.sdk, { ...f.input, text })
  expect(replay).toEqual(result)
  expect(f.orca.writes).toHaveLength(1)
})

test('답을 잃어도 글이 도착했으면 같은 전송 안에서 기록으로 확인해 보냄으로 남긴다', async () => {
  const f = await fixture()
  f.orca.behavior.loseAnswer = true
  const result = await f.send()
  expect(f.prefs.read().decisionReceipts[result.messageId].status).toBe('sent')
  expect(f.orca.writes).toHaveLength(1)
})

test('동시 클릭을 한 번만 전달하고 세션 보고 질문 답장은 답한 것으로 남긴다', async () => {
  const f = await fixture()
  f.orca.transcripts.get('worker')!.length = 0
  f.orca.find('worker')!.updatedAt += 1
  f.notes.update({ sessionId: 'worker', kind: 'question', text: '제목을 정해 주세요.', expectedRevision: 0 }, 'agent')
  f.orca.say('worker', 'assistant', '작업을 마쳤습니다.')
  const note = await f.row()
  expect(note.decision).toMatchObject({ source: 'agent-note', question: '제목을 정해 주세요.' })
  const pair = await Promise.all([f.send({ version: note.decision!.version }), f.send({ version: note.decision!.version })])
  expect(pair[0]).toEqual(pair[1])
  expect(f.orca.writes).toHaveLength(1)
  expect((await f.row()).decisionAnswered).toBe(true)
  f.notes.update({ sessionId: 'worker', kind: 'question', text: '다음 제목은요?', expectedRevision: 1 }, 'agent')
  expect((await f.row()).decision?.question).toBe('다음 제목은요?')
})

test('발송 결과가 불명확하고 수신 기록에 해당 ID가 없으면 확인 없이 재전송하지 않는다', async () => {
  const f = await fixture()
  f.orca.behavior.loseAnswer = true
  f.orca.behavior.dropText = true
  await expect(f.send()).rejects.toThrow('전송 결과')
  // A matching sentence from another sender is not a receipt for this board message.
  const stamped = f.orca.writes[0][f.orca.writes[0].indexOf('--text') + 1]
  f.orca.say('worker', 'user', stamped.replace(/^\[cb:[^\]]+\]/, '[cb:00000000-0000-4000-8000-000000000000]'))
  await expect(f.send()).rejects.toThrow('이전 전송 결과')
  expect(f.orca.writes).toHaveLength(1)
  expect(f.prefs.read().answers).toEqual({})
})

test('a native card keeps a single durable record with the original question, recipient, and sent text', async () => {
  const f = await fixture()
  const original = await f.row()
  const delivered = await f.send({ text: 'Use two lines' })
  await f.send({ text: 'Use two lines', requestKey: 'repeat-0000001' })
  const owned = Object.entries(f.prefs.read().decisionReceipts).filter(([id, r]) => !r.messageId || r.messageId === id)
  expect(owned).toHaveLength(1)
  expect(owned[0][0]).toBe(delivered.messageId)
  expect(owned[0][1]).toMatchObject({ status: 'sent', activity: { projectId: 'acme', title: original.decision!.question, answer: 'Use two lines', recipientId: 'worker', coordinator: false } })
})

test('a photo is saved as Paseo saves it and named by its file path on a line after the marker', async () => {
  const f = await fixture()
  const png = { mimeType: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mOYvLAHAAOLAcF4E9p3AAAAAElFTkSuQmCC' }
  f.orca.behavior.loseAnswer = true
  const { messageId } = await f.send({ text: '이 화면처럼 해 주세요.', images: [png] })
  expect(messageId.startsWith('c0bdf070')).toBe(true)
  const raw = f.orca.transcripts.get('worker')!.at(-1)!.text.split('\n')
  expect(raw[0]).toBe('[cb:' + messageId + ']')
  const path = /^\[사진 1\] (.+\.png)$/.exec(raw[1])![1]
  expect(raw[2]).toBe('')
  expect(existsSync(path) && readFileSync(path).toString('base64')).toBe(png.data)
  expect(f.sent().at(-1)!.text).not.toContain('[사진')
  expect(f.sent().at(-1)!.text).toContain('이 화면처럼 해 주세요.')
  expect(f.prefs.read().decisionReceipts[messageId]).toMatchObject({ status: 'sent', activity: { imageCount: 1 } })
  expect(new SessionPhotoStore(join(f.root, 'session-photos')).read('worker', messageId, 0)).toEqual({ count: 1, image: png })
})

test('a send Orca refuses leaves no receipt, so the same click can be sent again', async () => {
  const f = await fixture()
  f.orca.behavior.refuseWith = 'terminal not found'
  await expect(f.send()).rejects.toThrow('보낼 수 없습니다')
  expect(f.prefs.read().decisionReceipts).toEqual({})
  f.orca.behavior.refuseWith = null
  const result = await f.send()
  expect(f.sent()).toEqual([expect.objectContaining({ id: 'worker', messageId: result.messageId })])
})

test('a pending receipt that never reached the outbox is sent as new, once', async () => {
  const f = await fixture()
  f.orca.behavior.onWrite = () => { throw new Error('worker stopped') }
  await expect(f.send()).rejects.toThrow()
  expect(Object.values(f.prefs.read().decisionReceipts).map(r => r.status)).toEqual(['pending'])
  const { rmSync: remove } = await import('node:fs')
  remove(join(f.root, 'outbox.json'), { force: true })
  f.orca.behavior.onWrite = () => {}
  const writesBefore = f.orca.writes.length
  const restarted = f.restart()
  await restarted.sender.send(restarted.sdk, f.input)
  expect(f.orca.writes.length - writesBefore).toBe(1)
  expect(f.sent()).toHaveLength(1)
})
