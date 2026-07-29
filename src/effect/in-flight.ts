export interface InFlightDeduplicator {
  readonly run: <A>(key: string, load: () => Promise<A>) => Promise<A>
}

export function makeInFlightDeduplicator(): InFlightDeduplicator {
  const pending = new Map<string, Promise<unknown>>()

  return {
    run: <A>(key: string, load: () => Promise<A>): Promise<A> => {
      const existing = pending.get(key)
      if (existing) {
        return existing as Promise<A>
      }

      const shared = load().then(
        (value) => {
          if (pending.get(key) === shared) {
            pending.delete(key)
          }
          return value
        },
        (error: unknown) => {
          if (pending.get(key) === shared) {
            pending.delete(key)
          }
          throw error
        },
      )
      pending.set(key, shared)
      return shared
    },
  }
}
