import {chmod, mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'

/**
 * Writes a file with owner-only permissions, cross-platform. Mirrors the existing
 * `auth/manager.ts` `saveConfig` pattern: create the parent directory, write with a restrictive
 * mode, then follow up with an explicit `chmod` (since `writeFile`'s `mode` option only applies
 * when the file is newly created; an explicit `chmod` also restricts a pre-existing file).
 */
export async function writeRestrictedFile(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), {recursive: true})
  await writeFile(filePath, content, {encoding: 'utf8', mode: 0o600})
  await chmod(filePath, 0o600)
}
