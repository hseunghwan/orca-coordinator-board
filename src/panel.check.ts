// `orca plugin check` renders the panel once per scenario with the worker on a fresh host. The
// worker reads Orca through its CLI; where none answers, the panel shows the failed read. The card
// scenarios answer board.focus-cards themselves with the shapes the worker sends. Check draws in
// English whatever the stored locale, so the fixtures are English.
import { defineCheck } from 'orca/testing'
import type { FocusCard, FocusDeck } from './contract'

const question: FocusCard = {
  key: '["session","app","writer","v7"]', tone: 'danger', priority: 'Needs a decision now', projects: 'acme-app', session: 'Release notes',
  headline: 'Which **layout** should the release page use?', body: 'Name the page width if neither fits.',
  recommendation: 'Two columns, like the docs home.', recommendationReason: 'The guide asks for one layout across docs pages.', openSessionId: 'writer',
  answer: {
    kind: 'reply', projectId: 'app', sessionId: 'writer', version: 'v7', suggested: 'Two columns, like the docs home.',
    options: [{ label: 'Two columns', reply: 'Use two columns.' }, { label: 'One column', reply: 'Use one column.' }]
  }
}
const permission: FocusCard = {
  key: '["session","app","tester","v2"]', tone: 'warning', priority: 'Awaiting permission · 12m', projects: 'acme-app', session: 'Test runner',
  headline: 'Requests awaiting a response: 1', body: null, recommendation: null, recommendationReason: null, openSessionId: 'tester', answer: { kind: 'permission' }
}
const deck = (cards: FocusCard[]): FocusDeck => ({ configured: true, incomplete: false, cards })

export default defineCheck({
  firstRun: { storage: { locale: 'en' } },
  korean: { storage: { locale: 'ko' } },
  card: { storage: { locale: 'en' }, requests: { 'board.focus-cards': deck([question, permission]) } },
  permission: { storage: { locale: 'en' }, requests: { 'board.focus-cards': deck([permission]) } },
  empty: { storage: { locale: 'en' }, requests: { 'board.focus-cards': deck([]) } }
})
