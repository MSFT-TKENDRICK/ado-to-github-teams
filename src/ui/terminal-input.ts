import {Context, Data, Effect, Layer} from 'effect'

export type TerminalKeyAction =
  'previous' | 'next' | 'first' | 'last' | 'confirm' | 'guide' | 'review' | 'exit' | 'ignored'

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
const ARROW_RIGHT = '\u001b[C'
const ARROW_LEFT = '\u001b[D'
const HOME_SEQUENCE = '\u001b[H'
const END_SEQUENCE = '\u001b[F'
const SHIFT_TAB = '\u001b[Z'
const TAB = '\t'
const BACKSPACE = '\u007f'
const BACKSPACE_CONTROL = '\b'
const ESCAPE = '\u001b'
const ETX = '\u0003'
const EOT = '\u0004'

/** Ctrl+C. Exposed so an editable surface can keep ending the whole session on interrupt. */
export const INTERRUPT_SEQUENCE = ETX

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
    case 'r':
      return {action: 'review', sequence}
    case 'q':
    case ESCAPE:
    case ETX:
    case EOT:
      return {action: 'exit', sequence}
    default:
      return {action: 'ignored', sequence}
  }
}

export type FormKeyAction =
  'up' | 'down' | 'left' | 'right' | 'submit' | 'cancel' | 'backspace' | 'character' | 'ignored'

export interface FormKey {
  readonly action: FormKeyAction
  readonly sequence: string
  readonly character?: string
}

function isPrintableCharacter(sequence: string): boolean {
  if ([...sequence].length !== 1) {
    return false
  }
  const codePoint = sequence.codePointAt(0)
  return codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f
}

/**
 * Decodes the same raw sequence for an editable form, where letters are operator-typed text rather
 * than menu shortcuts. Menu decoding through {@link decodeTerminalKey} is deliberately untouched so
 * a browsing surface and an input field can share one key stream without either reinterpreting the
 * other's keys.
 */
export function decodeFormKey(sequence: string): FormKey {
  switch (sequence) {
    case ARROW_UP:
    case SHIFT_TAB:
      return {action: 'up', sequence}
    case ARROW_DOWN:
    case TAB:
      return {action: 'down', sequence}
    case ARROW_LEFT:
      return {action: 'left', sequence}
    case ARROW_RIGHT:
      return {action: 'right', sequence}
    case '\r':
    case '\n':
      return {action: 'submit', sequence}
    case ESCAPE:
    case ETX:
    case EOT:
      return {action: 'cancel', sequence}
    case BACKSPACE:
    case BACKSPACE_CONTROL:
      return {action: 'backspace', sequence}
    default:
      return isPrintableCharacter(sequence)
        ? {action: 'character', sequence, character: sequence}
        : {action: 'ignored', sequence}
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
