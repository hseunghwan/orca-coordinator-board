// Adapted from paseo-coordinator-board test/project-icons.test.ts @ 2e9d128: Orca keeps uploaded icons
// itself, and the board skips SVG.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { discoverIcon, ProjectIcons } from './project-icons'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ84AAAAASUVORK5CYII='

test('discovers a monorepo favicon, skipping SVG, and keeps Orca\'s own icon first', async () => {
  const home = await mkdtemp(join(tmpdir(), 'board-project-icon-'))
  try {
    const root = join(home, 'repo')
    const faviconDir = join(root, 'apps', 'frontend', 'static')
    await mkdir(faviconDir, { recursive: true })
    await writeFile(join(faviconDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    expect(await discoverIcon(root)).toBeUndefined()
    await writeFile(join(faviconDir, 'favicon.png'), Buffer.from(png, 'base64'))
    expect(await discoverIcon(root)).toBe(`data:image/png;base64,${png}`)
    await writeFile(join(faviconDir, 'favicon.png'), 'not an image')
    expect(await discoverIcon(root)).toBeUndefined()
    await mkdir(join(root, 'public'), { recursive: true })
    await writeFile(join(root, 'public', 'logo.png'), Buffer.from(png, 'base64'))
    expect(await discoverIcon(root)).toBe(`data:image/png;base64,${png}`)
    let now = 0
    const icons = new ProjectIcons(() => now)
    expect(await icons.read(root, 'data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(await icons.read(root, undefined)).toBe(`data:image/png;base64,${png}`)
    await rm(join(root, 'public'), { recursive: true })
    expect(await icons.read(root, undefined)).toBe(`data:image/png;base64,${png}`)
    now = 10 * 60_000
    expect(await icons.read(root, undefined)).toBeUndefined()
    expect(await discoverIcon('relative/path')).toBeUndefined()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
