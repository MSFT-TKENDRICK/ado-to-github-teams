import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  decodeTerminalKey,
  makeScriptedTerminalInputLayer,
  makeTerminalInput,
  TerminalInputTag,
  type TerminalKeyStream,
} from '../../../src/ui/terminal-input.js'

class FakeKeyStream implements TerminalKeyStream {
  public isTTY = true
  public rawModes: boolean[] = []
  public dataListeners: Array<(chunk: Buffer | string) => void> = []
  private errorListeners: Array<(error?: unknown) => void> = []
  private endListeners: Array<(error?: unknown) => void> = []

  setRawMode(mode: boolean): void {
    this.rawModes.push(mode)
  }

  resume(): void {}

  pause(): void {}

  on(_event: 'data', listener: (chunk: Buffer | string) => void): void {
    this.dataListeners.push(listener)
  }

  off(_event: 'data', listener: (chunk: Buffer | string) => void): void {
    this.dataListeners = this.dataListeners.filter((candidate) => candidate !== listener)
  }

  once(event: 'error' | 'end', listener: (error?: unknown) => void): void {
    if (event === 'error') {
      this.errorListeners.push(listener)
      return
    }
    this.endListeners.push(listener)
  }

  removeListener(event: 'error' | 'end', listener: (error?: unknown) => void): void {
    if (event === 'error') {
      this.errorListeners = this.errorListeners.filter((candidate) => candidate !== listener)
      return
    }
    this.endListeners = this.endListeners.filter((candidate) => candidate !== listener)
  }

  emitData(sequence: string): void {
    for (const listener of [...this.dataListeners]) {
      listener(sequence)
    }
  }

  emitEnd(): void {
    for (const listener of [...this.endListeners]) {
      listener()
    }
  }
}

describe('terminal input capability', () => {
  it('decodes navigation, confirmation, guide, and exit keys', () => {
    expect(decodeTerminalKey('\u001b[A').action).toBe('previous')
    expect(decodeTerminalKey('k').action).toBe('previous')
    expect(decodeTerminalKey('\u001b[B').action).toBe('next')
    expect(decodeTerminalKey('j').action).toBe('next')
    expect(decodeTerminalKey('\u001b[H').action).toBe('first')
    expect(decodeTerminalKey('\u001b[F').action).toBe('last')
    expect(decodeTerminalKey('\r').action).toBe('confirm')
    expect(decodeTerminalKey(' ').action).toBe('confirm')
    expect(decodeTerminalKey('g').action).toBe('guide')
    expect(decodeTerminalKey('?').action).toBe('guide')
    expect(decodeTerminalKey('r').action).toBe('review')
    expect(decodeTerminalKey('q').action).toBe('exit')
    expect(decodeTerminalKey('\u001b').action).toBe('exit')
    expect(decodeTerminalKey('\u0003').action).toBe('exit')
    expect(decodeTerminalKey('\u0004').action).toBe('exit')
    expect(decodeTerminalKey('z')).toEqual({action: 'ignored', sequence: 'z'})
  })

  it('releases raw mode and listeners after a single key so prompts can own stdin', async () => {
    const stream = new FakeKeyStream()
    const input = makeTerminalInput(stream)
    const pending = Effect.runPromise(input.readKey)
    await Promise.resolve()

    expect(stream.rawModes).toEqual([true])
    expect(stream.dataListeners).toHaveLength(1)

    stream.emitData('\r')

    await expect(pending).resolves.toEqual({action: 'confirm', sequence: '\r'})
    expect(stream.rawModes).toEqual([true, false])
    expect(stream.dataListeners).toHaveLength(0)
  })

  it('fails with a typed error when the stream is not a terminal', async () => {
    const stream = new FakeKeyStream()
    stream.isTTY = false

    const exit = await Effect.runPromiseExit(makeTerminalInput(stream).readKey)

    expect(exit._tag).toBe('Failure')
    await expect(
      Effect.runPromise(Effect.flip(makeTerminalInput(stream).readKey)),
    ).resolves.toMatchObject({_tag: 'TerminalInputFailure', reason: 'not-a-terminal'})
  })

  it('fails with a typed error when the stream closes', async () => {
    const stream = new FakeKeyStream()
    const pending = Effect.runPromiseExit(makeTerminalInput(stream).readKey)
    await Promise.resolve()

    stream.emitEnd()

    const exit = await pending
    expect(exit._tag).toBe('Failure')
  })

  it('replays scripted keys deterministically and then reports a closed stream', async () => {
    const layer = makeScriptedTerminalInputLayer(['j', 'q'])
    const read = Effect.gen(function* () {
      const input = yield* TerminalInputTag
      const first = yield* input.readKey
      const second = yield* input.readKey
      return [first.action, second.action]
    }).pipe(Effect.provide(layer))

    await expect(Effect.runPromise(read)).resolves.toEqual(['next', 'exit'])
  })
})
