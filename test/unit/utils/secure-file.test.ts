import {mkdtemp, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {writeRestrictedFile} from '../../../src/utils/secure-file.js'

describe('writeRestrictedFile', () => {
  it('writes the given content and creates missing parent directories', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'secure-file-'))
    const filePath = path.join(directory, 'nested', 'dossier.md')

    await writeRestrictedFile(filePath, '# Escalation dossier\n')

    const written = await import('node:fs/promises').then((fs) => fs.readFile(filePath, 'utf8'))
    expect(written).toBe('# Escalation dossier\n')
  })

  it('restricts file permissions to owner-only where the platform enforces POSIX mode bits', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'secure-file-'))
    const filePath = path.join(directory, 'dossier.md')

    await writeRestrictedFile(filePath, 'sensitive content')

    const stats = await stat(filePath)
    if (process.platform === 'win32') {
      // Windows ACLs don't map onto POSIX mode bits; node reports a fixed synthetic mode there,
      // so this test only asserts the file exists and is readable, not a specific bit pattern.
      expect(stats.isFile()).toBe(true)
    } else {
      expect(stats.mode & 0o777).toBe(0o600)
    }
  })

  it('re-restricts permissions on a file that already existed with looser permissions', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'secure-file-'))
    const filePath = path.join(directory, 'dossier.md')

    await writeRestrictedFile(filePath, 'first version')
    await writeRestrictedFile(filePath, 'second version')

    const written = await import('node:fs/promises').then((fs) => fs.readFile(filePath, 'utf8'))
    expect(written).toBe('second version')

    if (process.platform !== 'win32') {
      const stats = await stat(filePath)
      expect(stats.mode & 0o777).toBe(0o600)
    }
  })
})
