import {Context, Data, Effect} from 'effect'
import {decodeFormKey, TerminalInputTag, type FormKey} from './terminal-input.js'

export const MAPPING_EXACT = 'exact team names'
export const MAPPING_PREFIX = 'add a name prefix'
export const MAPPING_SUFFIX = 'add a name suffix'
export const MAPPING_TOPOLOGY = 'topology file'

export const MAPPING_CHOICES = [
  MAPPING_EXACT,
  MAPPING_PREFIX,
  MAPPING_SUFFIX,
  MAPPING_TOPOLOGY,
] as const

export const EXECUTION_DRY_RUN = 'dry-run'
export const EXECUTION_APPLY = 'apply'
export const EXECUTION_CHOICES = [EXECUTION_DRY_RUN, EXECUTION_APPLY] as const

export const CONFIG_FORM_CONTROLS =
  '↑↓/Tab move • type to edit • ←→ change option • Enter next or start • Esc cancel'

export type ConfigFieldId =
  | 'adoOrg'
  | 'adoProject'
  | 'githubOrg'
  | 'mapping'
  | 'mappingValue'
  | 'execution'
  | 'concurrency'
  | 'output'

export type ConfigFormRowId = ConfigFieldId | 'start'

export interface ConfigFormValues {
  readonly adoOrg: string
  readonly adoProject: string
  readonly githubOrg: string
  readonly mapping: string
  readonly mappingValue: string
  readonly execution: string
  readonly concurrency: string
  readonly output: string
}

export interface ConfigFormContext {
  readonly environment: 'sandbox' | 'live'
  readonly title: string
  readonly scenarioId?: string
  readonly scenarioMode?: 'dry-run' | 'apply'
  /**
   * Values the deterministic fixtures were authored around. They are shown as guidance only and are
   * never written into the form, so the operator still supplies every value.
   */
  readonly fixtureScope?: {
    readonly adoOrg: string
    readonly adoProject: string
    readonly githubOrg: string
  }
  /** Sandbox scenarios cannot accept a topology file; command preflight rejects that combination. */
  readonly allowTopology: boolean
}

export interface ConfigFormField {
  readonly id: ConfigFormRowId
  readonly label: string
  readonly hint: string
  readonly kind: 'text' | 'choice' | 'action'
  readonly value: string
  readonly required: boolean
  readonly choices?: readonly string[]
  readonly problem?: string
  readonly disabled?: boolean
}

export interface ConfigFormState {
  readonly values: ConfigFormValues
  readonly focusedIndex: number
  readonly context: ConfigFormContext
  /** Field problems stay hidden until the operator first tries to start the migration. */
  readonly showProblems: boolean
}

export interface MigrationConfigSelection {
  readonly adoOrg: string
  readonly adoProject: string
  readonly githubOrg: string
  readonly apply: boolean
  readonly concurrency: number
  readonly prefix?: string
  readonly suffix?: string
  readonly teamTopology?: string
  readonly output?: string
}

export type ConfigFormCommand =
  | {readonly _tag: 'render'}
  | {readonly _tag: 'cancel'}
  | {readonly _tag: 'submit'; readonly selection: MigrationConfigSelection}

export interface ConfigFormTransition {
  readonly state: ConfigFormState
  readonly command: ConfigFormCommand
}

export type ConfigFormResult =
  | {readonly _tag: 'submitted'; readonly selection: MigrationConfigSelection}
  | {readonly _tag: 'cancelled'}

export class ConfigFormFailure extends Data.TaggedError('ConfigFormFailure')<{
  readonly operation: 'read-input' | 'render'
  readonly reason: 'input-unavailable' | 'surface-failed'
  readonly detail?: string
}> {}

export interface ConfigFormSurface {
  readonly showForm: (
    fields: readonly ConfigFormField[],
    focusedIndex: number,
    context: ConfigFormContext,
  ) => Effect.Effect<void, ConfigFormFailure>
}

export class ConfigFormSurfaceTag extends Context.Tag('ConfigFormSurface')<
  ConfigFormSurfaceTag,
  ConfigFormSurface
>() {}

export function emptyConfigFormValues(): ConfigFormValues {
  return {
    adoOrg: '',
    adoProject: '',
    githubOrg: '',
    mapping: MAPPING_EXACT,
    mappingValue: '',
    execution: EXECUTION_DRY_RUN,
    concurrency: '4',
    output: '',
  }
}

function mappingHint(mapping: string): string {
  switch (mapping) {
    case MAPPING_PREFIX:
      return 'Text placed in front of every migrated team name.'
    case MAPPING_SUFFIX:
      return 'Text appended to every migrated team name.'
    case MAPPING_TOPOLOGY:
      return 'Path to a YAML or JSON hierarchy plan holding the exact target names.'
    default:
      return 'Exact team names are used; no naming input is required.'
  }
}

function mappingLabel(mapping: string): string {
  switch (mapping) {
    case MAPPING_PREFIX:
      return 'Team name prefix'
    case MAPPING_SUFFIX:
      return 'Team name suffix'
    case MAPPING_TOPOLOGY:
      return 'Topology file'
    default:
      return 'Naming input'
  }
}

function trimmed(value: string): string {
  return value.trim()
}

function fieldProblem(
  id: ConfigFormRowId,
  values: ConfigFormValues,
  context: ConfigFormContext,
): string | undefined {
  const mapping = values.mapping
  switch (id) {
    case 'adoOrg': {
      const value = trimmed(values.adoOrg)
      if (value === '') {
        return 'Required. Example: https://dev.azure.com/contoso'
      }
      return /^https?:\/\/\S+$/u.test(value)
        ? undefined
        : 'Must be an http or https Azure DevOps organization URL.'
    }
    case 'adoProject':
      return trimmed(values.adoProject) === '' ? 'Required. The source project name.' : undefined
    case 'githubOrg': {
      const value = trimmed(values.githubOrg)
      if (value === '') {
        return 'Required. The GitHub organization that receives the teams.'
      }
      return /^[\w.-]+$/u.test(value)
        ? undefined
        : 'Use the organization login only, without a URL or owner/repo path.'
    }
    case 'mapping':
      return mapping === MAPPING_TOPOLOGY && !context.allowTopology
        ? 'Sandbox scenarios use fixture topology; choose exact names, a prefix, or a suffix.'
        : undefined
    case 'mappingValue':
      return mapping !== MAPPING_EXACT && trimmed(values.mappingValue) === ''
        ? `Required for ${mapping}.`
        : undefined
    case 'execution':
      return context.scenarioMode && values.execution !== context.scenarioMode
        ? `Scenario ${context.scenarioId ?? ''} provides ${context.scenarioMode} fixtures; choose ${context.scenarioMode}.`.trim()
        : undefined
    case 'concurrency': {
      const parsed = Number(trimmed(values.concurrency))
      return Number.isInteger(parsed) && parsed >= 1
        ? undefined
        : 'Must be a positive whole number of concurrent mapping requests.'
    }
    default:
      return undefined
  }
}

/** Derives the visible rows from the raw values so a mapping choice reshapes its own input row. */
export function configFormFields(state: ConfigFormState): readonly ConfigFormField[] {
  const {values, context} = state
  const suggestion = (value: string | undefined): string =>
    value ? ` Scenario fixtures were authored around ${value}.` : ''
  const problem = (id: ConfigFormRowId): {problem?: string} => {
    if (!state.showProblems) {
      return {}
    }
    const detail = fieldProblem(id, values, context)
    return detail ? {problem: detail} : {}
  }
  const mappingDisabled = values.mapping === MAPPING_EXACT
  const rows: ConfigFormField[] = [
    {
      id: 'adoOrg',
      label: 'Azure DevOps organization',
      hint: `Where the teams are migrated from.${suggestion(context.fixtureScope?.adoOrg)}`,
      kind: 'text',
      value: values.adoOrg,
      required: true,
      ...problem('adoOrg'),
    },
    {
      id: 'adoProject',
      label: 'Azure DevOps project',
      hint: `The source project inside that organization.${suggestion(context.fixtureScope?.adoProject)}`,
      kind: 'text',
      value: values.adoProject,
      required: true,
      ...problem('adoProject'),
    },
    {
      id: 'githubOrg',
      label: 'GitHub organization',
      hint: `Where the teams are migrated to.${suggestion(context.fixtureScope?.githubOrg)}`,
      kind: 'text',
      value: values.githubOrg,
      required: true,
      ...problem('githubOrg'),
    },
    {
      id: 'mapping',
      label: 'Team name mapping',
      hint: 'How source team names become target team names.',
      kind: 'choice',
      value: values.mapping,
      required: true,
      choices: context.allowTopology
        ? MAPPING_CHOICES
        : MAPPING_CHOICES.filter((choice) => choice !== MAPPING_TOPOLOGY),
      ...problem('mapping'),
    },
    {
      id: 'mappingValue',
      label: mappingLabel(values.mapping),
      hint: mappingHint(values.mapping),
      kind: 'text',
      value: values.mappingValue,
      required: !mappingDisabled,
      ...(mappingDisabled ? {disabled: true} : {}),
      ...problem('mappingValue'),
    },
    {
      id: 'execution',
      label: 'Execution mode',
      hint: 'dry-run previews the plan; apply performs the approved writes.',
      kind: 'choice',
      value: values.execution,
      required: true,
      choices: EXECUTION_CHOICES,
      ...problem('execution'),
    },
    {
      id: 'concurrency',
      label: 'Concurrency',
      hint: 'Maximum concurrent mapping requests.',
      kind: 'text',
      value: values.concurrency,
      required: true,
      ...problem('concurrency'),
    },
    {
      id: 'output',
      label: 'Report path',
      hint: 'Optional. Leave empty to use the default report location.',
      kind: 'text',
      value: values.output,
      required: false,
      ...problem('output'),
    },
    {
      id: 'start',
      label:
        values.execution === EXECUTION_APPLY
          ? 'Start migration (apply still asks for approval)'
          : 'Start migration (dry-run)',
      hint: 'Nothing runs until this row is selected and confirmed.',
      kind: 'action',
      value: '',
      required: false,
    },
  ]
  return rows
}

export function configFormProblems(state: ConfigFormState): readonly string[] {
  return configFormFields({...state, showProblems: true})
    .map((field) => (field.problem ? `${field.label}: ${field.problem}` : ''))
    .filter((entry) => entry !== '')
}

export function resolveConfigForm(state: ConfigFormState): MigrationConfigSelection | undefined {
  if (configFormProblems(state).length > 0) {
    return undefined
  }
  const {values} = state
  const mappingValue = trimmed(values.mappingValue)
  const output = trimmed(values.output)
  return {
    adoOrg: trimmed(values.adoOrg),
    adoProject: trimmed(values.adoProject),
    githubOrg: trimmed(values.githubOrg),
    apply: values.execution === EXECUTION_APPLY,
    concurrency: Number(trimmed(values.concurrency)),
    ...(values.mapping === MAPPING_PREFIX && mappingValue ? {prefix: mappingValue} : {}),
    ...(values.mapping === MAPPING_SUFFIX && mappingValue ? {suffix: mappingValue} : {}),
    ...(values.mapping === MAPPING_TOPOLOGY && mappingValue ? {teamTopology: mappingValue} : {}),
    ...(output ? {output} : {}),
  }
}

function moveFocus(
  state: ConfigFormState,
  fields: readonly ConfigFormField[],
  delta: number,
): ConfigFormState {
  const total = fields.length
  if (total === 0) {
    return state
  }
  let index = state.focusedIndex
  for (let step = 0; step < total; step += 1) {
    index = (((index + delta) % total) + total) % total
    if (fields[index]?.disabled !== true) {
      return {...state, focusedIndex: index}
    }
  }
  return state
}

function cycleChoice(current: string, choices: readonly string[], delta: number): string {
  if (choices.length === 0) {
    return current
  }
  const index = choices.indexOf(current)
  const next =
    ((((index < 0 ? 0 : index) + delta) % choices.length) + choices.length) % choices.length
  return choices[next] ?? current
}

function withValue(state: ConfigFormState, id: ConfigFormRowId, value: string): ConfigFormState {
  if (id === 'start') {
    return state
  }
  return {...state, values: {...state.values, [id]: value}}
}

/**
 * Pure keyboard reducer for the configuration form. A migration can only ever begin through the
 * `submit` command, which requires the operator to focus the start row, confirm it, and satisfy
 * every field rule; no default or fixture can produce it on its own.
 */
export function reduceConfigForm(state: ConfigFormState, key: FormKey): ConfigFormTransition {
  const fields = configFormFields(state)
  const focused = fields[state.focusedIndex] ?? fields[0]
  if (!focused) {
    return {state, command: {_tag: 'render'}}
  }

  if (key.action === 'cancel') {
    return {state, command: {_tag: 'cancel'}}
  }
  if (key.action === 'up') {
    return {state: moveFocus(state, fields, -1), command: {_tag: 'render'}}
  }
  if (key.action === 'down') {
    return {state: moveFocus(state, fields, 1), command: {_tag: 'render'}}
  }

  if (focused.kind === 'choice') {
    const choices = focused.choices ?? []
    if (key.action === 'left' || key.action === 'right' || key.character === ' ') {
      const delta = key.action === 'left' ? -1 : 1
      const next = withValue(state, focused.id, cycleChoice(focused.value, choices, delta))
      return {state: next, command: {_tag: 'render'}}
    }
  }

  if (focused.kind === 'text' && focused.disabled !== true) {
    if (key.action === 'backspace') {
      return {
        state: withValue(state, focused.id, [...focused.value].slice(0, -1).join('')),
        command: {_tag: 'render'},
      }
    }
    if (key.action === 'character' && key.character) {
      return {
        state: withValue(state, focused.id, `${focused.value}${key.character}`),
        command: {_tag: 'render'},
      }
    }
  }

  if (key.action === 'submit') {
    if (focused.kind !== 'action') {
      return {state: moveFocus(state, fields, 1), command: {_tag: 'render'}}
    }
    const attempted: ConfigFormState = {...state, showProblems: true}
    const selection = resolveConfigForm(attempted)
    return selection
      ? {state: attempted, command: {_tag: 'submit', selection}}
      : {state: attempted, command: {_tag: 'render'}}
  }

  return {state, command: {_tag: 'render'}}
}

/**
 * Drives the configuration form as a standalone interactive surface. The loop only ends when the
 * operator submits a complete configuration or cancels; it never completes on its own.
 */
export function runConfigForm(
  initial: ConfigFormState,
): Effect.Effect<ConfigFormResult, ConfigFormFailure, ConfigFormSurfaceTag | TerminalInputTag> {
  return Effect.gen(function* () {
    const surface = yield* ConfigFormSurfaceTag
    const input = yield* TerminalInputTag
    let state = initial

    yield* surface.showForm(configFormFields(state), state.focusedIndex, state.context)

    while (true) {
      const key = yield* input.readKey.pipe(
        Effect.mapError(
          (failure) =>
            new ConfigFormFailure({
              operation: 'read-input',
              reason: 'input-unavailable',
              detail: failure.reason,
            }),
        ),
      )
      const transition = reduceConfigForm(state, decodeFormKey(key.sequence))
      state = transition.state

      if (transition.command._tag === 'cancel') {
        return {_tag: 'cancelled'} as const
      }
      if (transition.command._tag === 'submit') {
        return {_tag: 'submitted', selection: transition.command.selection} as const
      }
      yield* surface.showForm(configFormFields(state), state.focusedIndex, state.context)
    }
  })
}
