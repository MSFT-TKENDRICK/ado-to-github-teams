import {Schema} from 'effect'

export const PresentationModeSchema = Schema.Literal('guided', 'compact')
export type PresentationMode = typeof PresentationModeSchema.Type

export const DEFAULT_PRESENTATION_MODE: PresentationMode = 'guided'

export function decodePresentationMode(value: unknown): PresentationMode {
  return Schema.decodeUnknownSync(PresentationModeSchema)(value)
}

export function presentationModeDescription(mode: PresentationMode): string {
  return mode === 'guided'
    ? 'Guided detail: safety facts are paired with section labels and orientation.'
    : 'Compact detail: the same safety facts are grouped for faster scanning.'
}
