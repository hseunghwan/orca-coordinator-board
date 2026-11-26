import { assert } from 'orca/testing'
import { test } from 'vitest'
import { translator } from './i18n'
import { statusItem, withExcludeLine, focusedWorkspace } from './summary'

const en = translator('en')
const ko = translator('ko')
test('the status bar shows the decision count, a quiet board, no projects chosen, and a failed read', () => {
  assert.deepEqual([statusItem(en, 2).text, statusItem(en, 2).tone], ['2 to decide', 'accent'])
  assert.equal(statusItem(ko, 2).text, '내 결정 2')
  assert.deepEqual([statusItem(en, 0).text, statusItem(en, 0).tone], ['Nothing to decide', 'neutral'])
  assert.equal(statusItem(en, null).text, 'Board')
  assert.equal(statusItem(en, null, true).tone, 'warning')
})

test('adds the dashboard folder to the exclude file once', () => {
  const added = withExcludeLine('# git ls-files --others\n*.log')
  assert.equal(added, '# git ls-files --others\n*.log\n# Coordinator Board (Orca plugin): the dashboard key file\n/.coordinator-board/\n')
  assert.equal(withExcludeLine(added!), null)
  assert.equal(withExcludeLine('.coordinator-board/\r\n'), null)
  assert.equal(withExcludeLine(''), '# Coordinator Board (Orca plugin): the dashboard key file\n/.coordinator-board/\n')
})

test('finds the focused workspace by id, by the path in a project::path id, or by a unique name', () => {
  const rows = [
    { id: 'identity:wt2:local:a', name: 'main', path: 'C:/repo', branch: 'main' },
    { id: 'identity:wt2:local:b', name: 'feat-x', path: 'C:/ws/repo/feat-x', branch: 'feat/x' },
    { id: 'folder:c', name: 'notes', path: 'C:\\notes', branch: null }
  ]
  assert.equal(focusedWorkspace({ workspaceId: 'folder:c', branch: '', displayName: 'notes' }, rows)?.id, 'folder:c')
  assert.equal(focusedWorkspace({ workspaceId: 'p1::C:\\ws\\repo\\feat-x\\', branch: 'feat/x', displayName: 'feat-x' }, rows)?.id, 'identity:wt2:local:b')
  assert.equal(focusedWorkspace({ branch: 'main', displayName: 'main' }, rows)?.id, 'identity:wt2:local:a')
  assert.equal(focusedWorkspace({ workspaceId: 'other', branch: 'dev', displayName: 'main' }, rows), undefined)
  assert.equal(focusedWorkspace(null, rows), undefined)
})
