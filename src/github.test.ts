import { assert } from 'orca/testing'
import { test } from 'vitest'
import { commandEnv } from './github'

test('gives gh its Windows profile folders when Orca leaves them out', () => {
  const env = commandEnv({ USERPROFILE: 'C:\\Users\\me', PATH: 'p' }, 'win32')
  assert.equal(env.APPDATA, 'C:\\Users\\me\\AppData\\Roaming')
  assert.equal(env.LOCALAPPDATA, 'C:\\Users\\me\\AppData\\Local')
  assert.equal(env.HOME, 'C:\\Users\\me')
  assert.equal(env.GH_PROMPT_DISABLED, '1')
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(commandEnv({ USERPROFILE: 'C:\\Users\\me', APPDATA: 'D:\\roam' }, 'win32').APPDATA, 'D:\\roam')
  assert.equal(commandEnv({ HOME: '/home/me' }, 'linux').APPDATA, undefined)
})
