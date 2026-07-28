export class HttpStatusError extends Error {
  public readonly status: number
  public readonly headers: Record<string, string | undefined>
  public readonly responseBody?: unknown

  public constructor(
    message: string,
    status: number,
    headers: Record<string, string | undefined> = {},
    responseBody?: unknown,
  ) {
    super(message)
    this.name = 'HttpStatusError'
    this.status = status
    this.headers = headers
    this.responseBody = responseBody
  }
}

export class PermissionError extends Error {
  public readonly status?: number
  public readonly headers?: Record<string, string | undefined>

  public constructor(
    message: string,
    status?: number,
    headers?: Record<string, string | undefined>,
  ) {
    super(message)
    this.name = 'PermissionError'
    if (status !== undefined) {
      this.status = status
    }
    if (headers !== undefined) {
      this.headers = headers
    }
  }
}

export class ValidationError extends Error {
  public readonly status?: number

  public constructor(message: string, status?: number) {
    super(message)
    this.name = 'ValidationError'
    if (status !== undefined) {
      this.status = status
    }
  }
}

export class NotFoundError extends Error {
  public readonly status?: number

  public constructor(message: string, status?: number) {
    super(message)
    this.name = 'NotFoundError'
    if (status !== undefined) {
      this.status = status
    }
  }
}

export class AmbiguousMatchError extends Error {
  public readonly candidates: string[]

  public constructor(message: string, candidates: string[]) {
    super(message)
    this.name = 'AmbiguousMatchError'
    this.candidates = candidates
  }
}
