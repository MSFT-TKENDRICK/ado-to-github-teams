import {mkdir, readdir, readFile, rename, rm, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import path from 'node:path'
import {CHECKPOINT_SCHEMA_VERSION, type CheckpointState} from '../types/index.js'

interface CheckpointListItem {
  runId: string
  timestamp: string
  phase: string
}

export class CheckpointManager {
  private readonly dir: string

  public constructor(dir = path.join(homedir(), '.ado-github-teams', 'checkpoints')) {
    this.dir = dir
  }

  public async save(state: CheckpointState): Promise<void> {
    await mkdir(this.dir, {recursive: true})
    const target = path.join(this.dir, `${state.runId}.json`)
    const temp = path.join(this.dir, `${state.runId}.${Date.now()}.tmp`)
    const payload = `${JSON.stringify(state, null, 2)}\n`
    await writeFile(temp, payload, 'utf8')
    await rename(temp, target)
  }

  public async load(runId: string): Promise<CheckpointState | null> {
    try {
      const file = path.join(this.dir, `${runId}.json`)
      const content = await readFile(file, 'utf8')
      const parsed = JSON.parse(content) as Partial<CheckpointState>
      if (parsed.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
        throw new Error(
          `Checkpoint ${runId} uses an unsupported schema version and cannot be resumed safely.`,
        )
      }
      return parsed as CheckpointState
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException
      if (nodeError.code === 'ENOENT') {
        return null
      }

      throw error
    }
  }

  public async listCheckpoints(): Promise<CheckpointListItem[]> {
    await mkdir(this.dir, {recursive: true})
    const files = await readdir(this.dir, {withFileTypes: true})
    const checkpoints: CheckpointListItem[] = []

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) {
        continue
      }

      const runId = file.name.slice(0, -'.json'.length)
      const state = await this.load(runId)
      if (!state) {
        continue
      }

      checkpoints.push({
        runId,
        timestamp: state.timestamp,
        phase: state.phase,
      })
    }

    return checkpoints.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  }

  public async delete(runId: string): Promise<void> {
    const file = path.join(this.dir, `${runId}.json`)
    await rm(file, {force: true})
  }

  public isTeamCompleted(state: CheckpointState, slug: string): boolean {
    return state.completedTeams.includes(slug)
  }

  public isMemberCompleted(state: CheckpointState, slug: string, login: string): boolean {
    return state.completedMemberPairs.includes(`${slug}:${login}`)
  }

  public markTeamCompleted(state: CheckpointState, slug: string): void {
    if (!this.isTeamCompleted(state, slug)) {
      state.completedTeams.push(slug)
    }
  }

  public markMemberCompleted(state: CheckpointState, slug: string, login: string): void {
    const pair = `${slug}:${login}`
    if (!state.completedMemberPairs.includes(pair)) {
      state.completedMemberPairs.push(pair)
    }
  }
}
