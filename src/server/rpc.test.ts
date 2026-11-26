import { assert } from 'orca/testing'
import { test } from 'vitest'
import { z } from 'zod'
import { rpcServer } from './rpc'

test('a reply leaves the worker as JSON, without undefined fields', async () => {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>()
  const server = rpcServer((name, fn) => { handlers.set(name, fn) }, {} as never)
  const rpc = { name: 'board.test', input: z.object({}), output: z.object({ projects: z.array(z.object({ id: z.string(), icon: z.string().optional() })) }) }
  server.handle(rpc as never, async () => ({ projects: [{ id: 'p1', icon: undefined }] }))
  const out = await handlers.get('board.test')!({})
  assert.deepEqual(out, { projects: [{ id: 'p1' }] })
  assert.equal(Object.hasOwn((out as { projects: object[] }).projects[0], 'icon'), false)
})
