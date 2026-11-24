import { assert, test } from 'orca/testing'
import { githubRepository, parseOpenPulls } from './github'

test('reads GitHub.com remotes only', () => {
  assert.equal(githubRepository('https://github.com/Acme/App.git'), 'acme/app')
  assert.equal(githubRepository('git@github.com:acme/app.git'), 'acme/app')
  assert.equal(githubRepository('ssh://git@github.com/acme/app/'), 'acme/app')
  assert.equal(githubRepository('https://gitlab.com/acme/app.git'), null)
  assert.equal(githubRepository('https://github.com/acme/..'), null)
  assert.equal(githubRepository(null), null)
})

const row = (over: Record<string, unknown>) => ({
  number: 1, title: 'Fix', state: 'OPEN', updatedAt: '2026-11-20T00:00:00Z', isDraft: false,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
  checks: [{ status: 'COMPLETED', conclusion: 'SUCCESS', state: null }], autoMerge: false, ...over
})

test('classifies open pull requests the way the Paseo board does', () => {
  const parsed = parseOpenPulls('acme/app', JSON.stringify([
    row({ number: 1 }),
    row({ number: 2, isDraft: true }),
    row({ number: 3, mergeable: 'CONFLICTING' }),
    row({ number: 4, checks: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }),
    row({ number: 5, checks: [{ status: 'IN_PROGRESS', conclusion: null }] }),
    row({ number: 6, reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' }),
    row({ number: 1 }),
    { number: 'x' }
  ]))
  assert.equal(parsed.status, 'ok')
  assert.deepEqual(parsed.items.map((p) => [p.number, p.reason]), [
    [1, 'ready'], [2, 'draft'], [3, 'conflict'], [4, 'checks-failed'], [5, 'checks-pending'], [6, 'blocked']
  ])
  assert.equal(parsed.items[0].url, 'https://github.com/acme/app/pull/1')
})

test('cleans pull request titles', () => {
  const [pull] = parseOpenPulls('acme/app', JSON.stringify([row({ title: 'evil\u202etitle\n' })])).items
  assert.equal(pull.title, 'evil title ')
})
