import {createHash, randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {mkdir, open, readFile, rename, rm, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import path from 'node:path'

const runtimeDirectory = path.join(homedir(), '.ado-github-teams')
const workerDirectory = path.join(runtimeDirectory, 'workers')
const logDirectory = path.join(runtimeDirectory, 'logs')

interface WorkerLease {
  readonly token: string
  readonly pid: number
  readonly updatedAt: string
}

function leasePath(runId: string): string {
  return path.join(workerDirectory, `${runId}.lock`)
}

async function readLease(leaseId: string): Promise<WorkerLease | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return JSON.parse(await readFile(leasePath(leaseId), 'utf8')) as WorkerLease
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException
      if (nodeError.code === 'ENOENT') {
        return null
      }
      if (error instanceof SyntaxError && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        continue
      }
      throw error
    }
  }
  return null
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function writeLease(leaseId: string, lease: WorkerLease): Promise<void> {
  const target = leasePath(leaseId)
  const temp = `${target}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(lease)}\n`, 'utf8')
  await rename(temp, target)
}

export function migrationScopeLeaseId(
  adoOrg: string,
  adoProject: string,
  githubOrg: string,
): string {
  return createHash('sha256')
    .update(`${adoOrg}\0${adoProject}\0${githubOrg}`)
    .digest('hex')
    .slice(0, 32)
}

export async function acquireWorkerLease(leaseId: string): Promise<string | null> {
  await mkdir(workerDirectory, {recursive: true})
  const token = randomUUID()

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(leasePath(leaseId), 'wx')
      try {
        await handle.writeFile(
          `${JSON.stringify({
            token,
            pid: process.pid,
            updatedAt: new Date().toISOString(),
          } satisfies WorkerLease)}\n`,
          'utf8',
        )
      } finally {
        await handle.close()
      }
      return token
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException
      if (nodeError.code !== 'EEXIST') {
        throw error
      }
      const existing = await readLease(leaseId)
      if (existing && isProcessAlive(existing.pid)) {
        return null
      }
      await rm(leasePath(leaseId), {force: true})
    }
  }

  return null
}

export async function adoptWorkerLease(leaseId: string, token: string): Promise<boolean> {
  const existing = await readLease(leaseId)
  if (!existing || existing.token !== token) {
    return false
  }
  await writeLease(leaseId, {
    token,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  })
  return true
}

export async function releaseWorkerLease(leaseId: string, token: string): Promise<void> {
  const existing = await readLease(leaseId)
  if (existing?.token === token) {
    await rm(leasePath(leaseId), {force: true})
  }
}

export interface LaunchedMigrationWorker {
  readonly logPath: string
  readonly pid: number
}

export async function launchMigrationWorker(
  runId: string,
  leaseId: string,
  token: string,
  args: readonly string[],
): Promise<LaunchedMigrationWorker> {
  const entrypoint = process.argv[1]
  if (!entrypoint) {
    throw new Error('Unable to locate the CLI entrypoint for the background worker.')
  }

  await mkdir(logDirectory, {recursive: true})
  const logPath = path.join(logDirectory, `${runId}.log`)
  const log = await open(logPath, 'a')
  try {
    const child = spawn(process.execPath, [...process.execArgv, entrypoint, ...args], {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log.fd, log.fd],
      env: {
        ...process.env,
        ADO_GITHUB_TEAMS_WORKER_TOKEN: token,
      },
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    if (!child.pid) {
      throw new Error('The background migration worker did not start.')
    }
    await writeLease(leaseId, {
      token,
      pid: child.pid,
      updatedAt: new Date().toISOString(),
    })
    child.unref()
    return {logPath, pid: child.pid}
  } finally {
    await log.close()
  }
}
