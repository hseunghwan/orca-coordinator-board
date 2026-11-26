import { expect, test } from 'vitest'
import { noSignals, reduceSignals, type Observation, type SignalState } from './signals'
import type { OrcaState, SessionId, World } from './view'

const A = 'a' as SessionId
const B = 'b' as SessionId
const world = (states: Record<string, OrcaState>): Observation =>
  ({ kind: 'world', world: { sessions: new Map(Object.entries(states).map(([id, state]) => [id as SessionId, { state }])) as unknown as World['sessions'] } })
const status = (session: SessionId, state: OrcaState): Observation => ({ kind: 'status', session, state })

function run(observations: Observation[], from: SignalState = noSignals) {
  let state = from
  return observations.map((o) => {
    const result = reduceSignals(state, o)
    state = result.state
    return result.signals
  })
}

test('a turn ends when working becomes done or waiting, from an event or a World read alike', () => {
  expect(run([status(A, 'working'), status(A, 'done')])).toEqual([[], [{ kind: 'turn-ended', session: A }]])
  expect(run([world({ a: 'working' }), world({ a: 'waiting' })])).toEqual([[], [{ kind: 'turn-ended', session: A }]])
  expect(run([status(A, 'working'), world({ a: 'done' }), status(A, 'done')])).toEqual([[], [{ kind: 'turn-ended', session: A }], []])
})

test('a first sighting is never a turn end, even when it is done', () => {
  expect(run([status(A, 'done'), world({ a: 'done', b: 'done' })])).toEqual([[], []])
})

test('a permission clears when blocked becomes anything else', () => {
  expect(run([status(A, 'blocked'), status(A, 'working')])).toEqual([[], [{ kind: 'permission-cleared', session: A }]])
  expect(run([status(A, 'blocked'), status(A, 'blocked'), world({ a: 'done' })])).toEqual([[], [], [{ kind: 'permission-cleared', session: A }]])
})

test('a session is gone after two World reads without it, or when its workspace is removed', () => {
  expect(run([world({ a: 'done', b: 'done' }), world({ b: 'done' }), world({ b: 'done' }), world({ b: 'done' })]))
    .toEqual([[], [], [{ kind: 'gone', session: A }], []])
  expect(run([world({ a: 'done' }), world({}), world({ a: 'done' }), world({})])).toEqual([[], [], [], []])
  expect(run([world({ a: 'done', b: 'working' }), { kind: 'workspace-removed', sessions: [A, A, 'c' as SessionId] }]))
    .toEqual([[], [{ kind: 'gone', session: A }]])
  expect(run([status(B, 'working'), { kind: 'workspace-removed', sessions: [B] }, status(B, 'done')]))
    .toEqual([[], [{ kind: 'gone', session: B }], []])
})
