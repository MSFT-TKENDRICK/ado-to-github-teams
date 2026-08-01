import {Context, Data, Effect, Layer} from 'effect'

export type TerminalKeyAction =
  'previous' | 'next' | 'first' | 'last' | 'confirm' | 'guide' | 'exit' | 'ignored'

export interface TerminalKey {
  readonly action: TerminalKeyAction
  readonly sequence: string
}

export class TerminalInputFailure extends Data.TaggedError('TerminalInputFailure')<{
  readonly reason: 'not-a-terminal' | 'stream-error' | 'stream-closed'
}> {}

export interface TerminalInput {
  readonly readKey: Effect.Effect<TerminalKey, TerminalInputFailure>
}

export class TerminalInputTag extends Context.Tag('TerminalInput')<
  TerminalInputTag,
  TerminalInput
>() {}

const ARROW_UP = '\u001b[A'
const ARROW_DOWN = '\u001b[B'
const HOME_SEQUENCE = '\u001b[H'
const END_SEQUENCE = '\u001b[F'
const ESCAPE = '\u001b'
const ETX = '\u0003'
const EOT = '\u0004'

export function decodeTerminalKey(sequence: string): TerminalKey {
  switch (sequence) {
    case ARROW_UP:
    case 'k':
      return {action: 'previous', sequence}
    case ARROW_DOWN:
    case 'j':
      return {action: 'next', sequence}
    case HOME_SEQUENCE:
      return {action: 'first', sequence}
    case END_SEQUENCE:
      return {action: 'last', sequence}
    case '\r':
    case '\n':
    case ' ':
      return {action: 'confirm', sequence}
    case 'g':
    case '?':
      return {action: 'guide', sequence}
    case 'q':
    case ESCAPE:
    case ETX:
    case EOT:
      return {action: 'exit', sequence}
    default:
      return {action: 'ignored', sequence}
  }
}

export interface TerminalKeyStream {
  readonly isTTY?: boolean
  setRawMode?(mode: boolean): unknown
  resume?(): unknown
  pause?(): unknown
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  once(event: 'error' | 'end', listener: (error?: unknown) => void): unknown
  removeListener(event: 'error' | 'end', listener: (error?: unknown) => void): unknown
}

/**
 * Reads exactly one key and immediately releases raw mode and the data listener so approval
 * prompts and other production interfaces own stdin while a migration is executing.
 */
export function makeTerminalInput(stream: TerminalKeyStream): TerminalInput {
  return {
    readKey: Effect.suspend(() =>
      stream.isTTY === true
        ? Effect.async<TerminalKey, TerminalInputFailure>((resume) => {
            const onData = (chunk: Buffer | string): void => {
              release()
              resume(Effect.succeed(decodeTerminalKey(chunk.toString('utf8'))))
            }
            const onError = (): void => {
              release()
              resume(Effect.fail(new TerminalInputFailure({reason: 'stream-error'})))
            }
            const onEnd = (): void => {
              release()
              resume(Effect.fail(new TerminalInputFailure({reason: 'stream-closed'})))
            }
            const release = (): void => {
              stream.off('data', onData)
              stream.removeListener('error', onError)
              stream.removeListener('end', onEnd)
              stream.setRawMode?.(false)
              stream.pause?.()
            }
            stream.setRawMode?.(true)
            stream.resume?.()
            stream.on('data', onData)
            stream.once('error', onError)
            stream.once('end', onEnd)
            return Effect.sync(release)
          })
        : Effect.fail(new TerminalInputFailure({reason: 'not-a-terminal'})),
    ),
  }
}

export function makeTerminalInputLayer(stream: TerminalKeyStream): Layer.Layer<TerminalInputTag> {
  return Layer.succeed(TerminalInputTag, makeTerminalInput(stream))
}

/**
 * Deterministic Layer for tests: replays scripted key sequences and then reports a closed stream
 * instead of blocking forever.
 */
export function makeScriptedTerminalInputLayer(
  sequences: readonly string[],
): Layer.Layer<TerminalInputTag> {
  const pending = [...sequences]
  return Layer.succeed(TerminalInputTag, {
    readKey: Effect.suspend(() => {
      const next = pending.shift()
      return next === undefined
        ? Effect.fail(new TerminalInputFailure({reason: 'stream-closed'}))
        : Effect.succeed(decodeTerminalKey(next))
    }),
  })
}
