import { assert, mockHost, mount, test } from 'orca/testing'
import type { BoardView } from './model'
import * as panel from './panel'

const session = { key: 't1@100', terminalId: 't1', workspaceId: 'w1', workspaceName: 'feat-login', branch: 'feat/login', agent: 'claude', title: 'fix login', state: 'waiting' as const, since: 100 }
const board = (over: Partial<BoardView> = {}): BoardView => ({
  at: 1000,
  selected: ['p1'],
  projects: [{ projectId: 'p1', name: 'App', sessions: [session], repo: 'acme/app', pullStatus: 'ok', pulls: [] }],
  decisions: [{ key: 't1@100', kind: 'reply', projectName: 'App', since: 100, session, tail: ['Which branch?'] }],
  replies: [],
  truncated: false,
  ...over
})

test('sends the typed reply to the card\'s session', async () => {
  const sent: unknown[] = []
  const host = mockHost({
    requests: {
      'board.read': () => board(),
      'board.reply': (input) => { sent.push(input); return { status: 'sent', at: 2000 } }
    }
  })
  const view = await mount(panel, { host, locale: 'ko' })
  assert.ok(view.find({ text: '답 기다림' }))
  await view.type({ label: '답장' }, 'main으로 가세요')
  await view.press({ text: '보내기' })
  assert.equal(sent.length, 1)
  assert.deepEqual({ ...(sent[0] as object) }, {
    workspaceId: 'w1', terminalId: 't1', text: 'main으로 가세요', expectedSince: 100,
    projectName: 'App', workspaceName: 'feat-login', title: 'fix login'
  })
  assert.ok(view.find({ text: '보냈습니다.' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('asks for projects when none are selected', async () => {
  const saved: unknown[] = []
  const host = mockHost({
    requests: {
      'board.read': () => board({ selected: [], projects: [], decisions: [] }),
      'board.projects': () => ({ projects: [{ id: 'p1', name: 'App', path: '/w/app', remote: false }], selected: [] }),
      'board.select-projects': (input) => { saved.push(input); return { selected: ['p1'] } }
    }
  })
  const view = await mount(panel, { host, locale: 'en' })
  await view.toggle({ label: 'App' })
  await view.press({ text: 'Save' })
  assert.deepEqual(saved, [{ projectIds: ['p1'] }])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('shows a permission card without a reply box', async () => {
  const blocked = { ...session, state: 'blocked' as const }
  const host = mockHost({
    requests: { 'board.read': () => board({ decisions: [{ key: 't1@100', kind: 'permission', projectName: 'App', since: 100, session: blocked }] }) }
  })
  const view = await mount(panel, { host, locale: 'en' })
  assert.ok(view.find({ text: 'Open session' }))
  assert.equal(view.find({ label: 'Reply' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
