// When a session may take a queued board message: one pure reducer that both agent.status.changed and
// every World read (poll, snapshot) feed, so the two never judge a turn's end differently.
import type { OrcaState, SessionId, World } from './view'

export type Signal =
  /** working became done or waiting: Paseo's agent.turn.after. Never from a first sighting. */
  | { kind: 'turn-ended'; session: SessionId }
  /** blocked became anything else: Paseo's agent.permission.after. */
  | { kind: 'permission-cleared'; session: SessionId }
  /**
   * Missing from two non-empty World reads in a row, or its workspace was removed: Paseo's close and archive hooks.
   * A consumer that drops records still confirms it against a fresh read (src/server/board.ts forget).
   */
  | { kind: 'gone'; session: SessionId }

export type Observation =
  | { kind: 'status'; session: SessionId; state: OrcaState }
  | { kind: 'world'; world: Pick<World, 'sessions'> }
  | { kind: 'workspace-removed'; sessions: readonly SessionId[] }

type Seen = { readonly state: OrcaState; readonly missing: number }
export type SignalState = ReadonlyMap<SessionId, Seen>

export const noSignals: SignalState = new Map()

/** Reads in a row a session may be missing before it is gone: one ps can miss a pane being redrawn. */
const GONE_AFTER = 2

function transition(session: SessionId, before: OrcaState | undefined, after: OrcaState): Signal[] {
  if (before === 'working' && (after === 'done' || after === 'waiting')) return [{ kind: 'turn-ended', session }]
  if (before === 'blocked' && after !== 'blocked') return [{ kind: 'permission-cleared', session }]
  return []
}

export function reduceSignals(state: SignalState, observation: Observation): { state: SignalState; signals: Signal[] } {
  const next = new Map(state)
  const signals: Signal[] = []
  if (observation.kind === 'status') {
    signals.push(...transition(observation.session, state.get(observation.session)?.state, observation.state))
    next.set(observation.session, { state: observation.state, missing: 0 })
  } else if (observation.kind === 'world') {
    // A read that lists no session at all is Orca starting or restarting, not every session closing: it says
    // nothing, so no consumer of 'gone' (queued replies, the board's records, tracked work) acts on it.
    if (!observation.world.sessions.size) return { state, signals }
    for (const [id, session] of observation.world.sessions) {
      signals.push(...transition(id, state.get(id)?.state, session.state))
      next.set(id, { state: session.state, missing: 0 })
    }
    for (const [id, seen] of state) {
      if (observation.world.sessions.has(id)) continue
      if (seen.missing + 1 >= GONE_AFTER) {
        next.delete(id)
        signals.push({ kind: 'gone', session: id })
      } else next.set(id, { ...seen, missing: seen.missing + 1 })
    }
  } else {
    for (const id of observation.sessions) {
      if (!next.delete(id)) continue
      signals.push({ kind: 'gone', session: id })
    }
  }
  return { state: next, signals }
}
