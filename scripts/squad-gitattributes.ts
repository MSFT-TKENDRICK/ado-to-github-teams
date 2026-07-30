import {readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

const SQUAD_UNION_MERGE_BLOCK = [
  '# Squad: union merge for append-only team state files',
  '.squad/decisions.md merge=union',
  '.squad/agents/*/history.md merge=union',
  '.squad/log/** merge=union',
  '.squad/orchestration-log/** merge=union',
  '.squad/rai/audit-trail.md merge=union',
  '.squad/fact-checker/audit-trail.md merge=union',
] as const

export const stripSquadUnionMergeAttributes = (content: string): string => {
  const lines = content.split(/\r?\n/)
  const blockStart = lines.indexOf(SQUAD_UNION_MERGE_BLOCK[0])

  if (blockStart === -1) return content

  const actualBlock = lines.slice(blockStart, blockStart + SQUAD_UNION_MERGE_BLOCK.length)
  if (!SQUAD_UNION_MERGE_BLOCK.every((line, index) => actualBlock[index] === line)) {
    throw new Error('Refusing to remove an unexpected Squad merge-attribute block.')
  }

  lines.splice(blockStart, SQUAD_UNION_MERGE_BLOCK.length)
  return lines.join(content.includes('\r\n') ? '\r\n' : '\n')
}

export const removeSquadUnionMergeAttributes = async (teamRoot: string): Promise<void> => {
  const attributesPath = join(teamRoot, '.gitattributes')
  const content = await readFile(attributesPath, 'utf8')
  const cleaned = stripSquadUnionMergeAttributes(content)

  if (cleaned !== content) {
    await writeFile(attributesPath, cleaned, 'utf8')
  }
}
