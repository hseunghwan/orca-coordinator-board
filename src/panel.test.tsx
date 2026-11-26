import { assert, mockHost, mount } from 'orca/testing'
import { test } from 'vitest'
import * as panel from './panel'

// A plain string, so the post stays the bare change signal whatever the old frame declares.
const BOARD_CHANGED: string = 'board.changed'

const ready = (over = {}) => ({ configured: true, coordinator: null, decisionTitles: ['Pick a layout', 'Delete build cache'], ...over })

test('shows how many decisions wait, the first ones, and opens the board', async () => {
  const opened: unknown[] = []
  const host = mockHost({
    requests: {
      'board.decision-count': { count: 2 },
      'board.readiness': ready(),
      'board.open-dashboard': (input: unknown) => { opened.push(input); return { message: null } }
    }
  })
  const view = await mount(panel, { host, locale: 'en' })
  assert.ok(view.find({ text: '2 to decide' }))
  assert.ok(view.find({ label: 'Pick a layout' }))
  assert.ok(view.find({ label: 'Delete build cache' }))
  await view.press({ text: 'Open board' })
  assert.equal(opened.length, 1)
  assert.equal(view.persisted.storage.locale, 'en')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('asks to choose projects on the board before any are managed', async () => {
  const host = mockHost({ requests: { 'board.decision-count': { count: 0 }, 'board.readiness': ready({ configured: false, decisionTitles: [] }) } })
  const view = await mount(panel, { host, locale: 'ko' })
  assert.ok(view.find({ text: '보드를 열어 관리할 프로젝트를 고르세요.' }))
  assert.ok(view.find({ text: '보드 열기' }))
  await view.unmount()
})

test('says why the dashboard did not open', async () => {
  const host = mockHost({
    requests: {
      'board.decision-count': { count: 0 },
      'board.readiness': ready({ decisionTitles: [] }),
      'board.open-dashboard': { message: 'Open a workspace, then try again.' }
    }
  })
  const view = await mount(panel, { host, locale: 'en' })
  assert.ok(view.find({ text: 'Nothing to decide right now.' }))
  await view.press({ text: 'Open board' })
  assert.ok(view.find({ text: 'Open a workspace, then try again.' }))
  await view.unmount()
})

test('reads again when the worker says the board changed, and shows a failed read', async () => {
  let n = 1
  const host = mockHost({ requests: { 'board.decision-count': () => ({ count: n }), 'board.readiness': ready() } })
  const view = await mount(panel, { host, locale: 'en' })
  assert.ok(view.find({ text: '1 to decide' }))
  n = 3
  await view.post(BOARD_CHANGED, {})
  assert.ok(view.find({ text: '3 to decide' }))
  await view.unmount()
  const broken = mockHost({ requests: {} })
  const failed = await mount(panel, { host: broken, locale: 'en' })
  assert.ok(failed.find({ label: 'Could not load the board' }))
  await failed.unmount()
})
