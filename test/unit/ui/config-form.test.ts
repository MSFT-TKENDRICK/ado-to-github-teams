import {Effect, Layer} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  CONFIG_FORM_CONTROLS,
  ConfigFormSurfaceTag,
  MAPPING_PREFIX,
  MAPPING_TOPOLOGY,
  configFormFields,
  configFormProblems,
  emptyConfigFormValues,
  reduceConfigForm,
  resolveConfigForm,
  runConfigForm,
  type ConfigFormContext,
  type ConfigFormField,
  type ConfigFormState,
} from '../../../src/ui/config-form.js'
import {renderConfigFormFrame, renderPlainConfigForm} from '../../../src/ui/config-form-view.js'
import {Chalk} from 'chalk'
import {decodeFormKey, makeScriptedTerminalInputLayer} from '../../../src/ui/terminal-input.js'

const sandboxContext: ConfigFormContext = {
  environment: 'sandbox',
  title: 'Sandbox • happy-path',
  scenarioId: 'happy-path',
  scenarioMode: 'dry-run',
  fixtureScope: {
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: 'Platform',
    githubOrg: 'contoso',
  },
  allowTopology: false,
}

const liveContext: ConfigFormContext = {
  environment: 'live',
  title: 'Migration configuration',
  allowTopology: true,
}

function state(overrides: Partial<ConfigFormState> = {}): ConfigFormState {
  return {
    values: emptyConfigFormValues(),
    focusedIndex: 0,
    showProblems: false,
    context: sandboxContext,
    ...overrides,
  }
}

function type(current: ConfigFormState, text: string): ConfigFormState {
  return [...text].reduce(
    (accumulator, character) => reduceConfigForm(accumulator, decodeFormKey(character)).state,
    current,
  )
}

function press(current: ConfigFormState, sequence: string): ConfigFormState {
  return reduceConfigForm(current, decodeFormKey(sequence)).state
}

describe('configuration form fields', () => {
  it('starts with nothing filled in for the operator', () => {
    const fields = configFormFields(state())

    expect(fields.filter((field) => field.kind === 'text').map((field) => field.value)).toEqual([
      '',
      '',
      '',
      '',
      '4',
      '',
    ])
    expect(fields.map((field) => field.id)).toEqual([
      'adoOrg',
      'adoProject',
      'githubOrg',
      'mapping',
      'mappingValue',
      'execution',
      'concurrency',
      'output',
      'start',
    ])
    expect(fields.every((field) => field.problem === undefined)).toBe(true)
  })

  it('shows the fixture scope as guidance rather than a prefilled value', () => {
    const [adoOrg] = configFormFields(state())

    expect(adoOrg?.value).toBe('')
    expect(adoOrg?.hint).toContain('https://dev.azure.com/contoso')
  })

  it('reshapes the naming input when the mapping choice changes', () => {
    const prefixed = state({values: {...emptyConfigFormValues(), mapping: MAPPING_PREFIX}})
    const field = configFormFields(prefixed).find((entry) => entry.id === 'mappingValue')

    expect(field?.label).toBe('Team name prefix')
    expect(field?.required).toBe(true)
    expect(field?.disabled).toBeUndefined()
  })

  it('hides the topology option where command preflight would reject it', () => {
    const sandboxMapping = configFormFields(state()).find((field) => field.id === 'mapping')
    const liveMapping = configFormFields(state({context: liveContext})).find(
      (field) => field.id === 'mapping',
    )

    expect(sandboxMapping?.choices).not.toContain(MAPPING_TOPOLOGY)
    expect(liveMapping?.choices).toContain(MAPPING_TOPOLOGY)
  })
})

describe('configuration form validation', () => {
  it('rejects an empty configuration with per-field guidance', () => {
    const problems = configFormProblems(state())

    expect(problems).toContain(
      'Azure DevOps organization: Required. Example: https://dev.azure.com/contoso',
    )
    expect(problems).toContain('Azure DevOps project: Required. The source project name.')
    expect(resolveConfigForm(state())).toBeUndefined()
  })

  it('rejects a scope that does not match the documented shape', () => {
    const typed = state({
      values: {
        ...emptyConfigFormValues(),
        adoOrg: 'contoso',
        adoProject: 'Platform',
        githubOrg: 'https://github.com/contoso',
      },
    })

    expect(configFormProblems(typed)).toEqual([
      'Azure DevOps organization: Must be an http or https Azure DevOps organization URL.',
      'GitHub organization: Use the organization login only, without a URL or owner/repo path.',
    ])
  })

  it('rejects an execution mode the scenario fixtures were not recorded in', () => {
    const typed = state({
      values: {
        ...emptyConfigFormValues(),
        adoOrg: 'https://dev.azure.com/contoso',
        adoProject: 'Platform',
        githubOrg: 'contoso',
        execution: 'apply',
      },
    })

    expect(configFormProblems(typed)).toEqual([
      'Execution mode: Scenario happy-path provides dry-run fixtures; choose dry-run.',
    ])
  })

  it('resolves a complete configuration into a migration selection', () => {
    const typed = state({
      values: {
        adoOrg: '  https://dev.azure.com/contoso  ',
        adoProject: 'Platform',
        githubOrg: 'contoso',
        mapping: MAPPING_PREFIX,
        mappingValue: 'ado-',
        execution: 'dry-run',
        concurrency: '6',
        output: 'report.md',
      },
    })

    expect(resolveConfigForm(typed)).toEqual({
      adoOrg: 'https://dev.azure.com/contoso',
      adoProject: 'Platform',
      githubOrg: 'contoso',
      apply: false,
      concurrency: 6,
      prefix: 'ado-',
      output: 'report.md',
    })
  })
})

describe('configuration form reducer', () => {
  it('treats letters as typed text rather than menu shortcuts', () => {
    expect(type(state(), 'quit').values.adoOrg).toBe('quit')
  })

  it('removes one character per backspace', () => {
    const typed = type(state(), 'contoso')

    expect(press(typed, '\u007f').values.adoOrg).toBe('contos')
  })

  it('moves focus with arrows and tabs, skipping inputs the mapping does not need', () => {
    const start = state({focusedIndex: 2})

    expect(press(start, '\t').focusedIndex).toBe(3)
    expect(press(press(start, '\t'), '\t').focusedIndex).toBe(5)
    expect(press(start, '\u001b[Z').focusedIndex).toBe(1)
  })

  it('changes an option without touching any other field', () => {
    const focused = state({focusedIndex: 5})
    const applied = press(focused, '\u001b[C')

    expect(applied.values.execution).toBe('apply')
    expect(applied.values.adoOrg).toBe('')
    expect(press(applied, '\u001b[D').values.execution).toBe('dry-run')
  })

  it('never submits from a value field', () => {
    const transition = reduceConfigForm(state(), decodeFormKey('\r'))

    expect(transition.command).toEqual({_tag: 'render'})
    expect(transition.state.focusedIndex).toBe(1)
  })

  it('reveals problems instead of starting an incomplete migration', () => {
    const onStart = state({focusedIndex: configFormFields(state()).length - 1})
    const transition = reduceConfigForm(onStart, decodeFormKey('\r'))

    expect(transition.command).toEqual({_tag: 'render'})
    expect(transition.state.showProblems).toBe(true)
    expect(configFormFields(transition.state)[0]?.problem).toBeDefined()
  })

  it('submits only from the start row once every field is valid', () => {
    const complete = state({
      focusedIndex: 8,
      values: {
        ...emptyConfigFormValues(),
        adoOrg: 'https://dev.azure.com/contoso',
        adoProject: 'Platform',
        githubOrg: 'contoso',
      },
    })
    const transition = reduceConfigForm(complete, decodeFormKey('\r'))

    expect(transition.command).toMatchObject({
      _tag: 'submit',
      selection: {adoOrg: 'https://dev.azure.com/contoso', apply: false, concurrency: 4},
    })
  })

  it('cancels without producing a selection', () => {
    expect(reduceConfigForm(state(), decodeFormKey('\u001b')).command).toEqual({_tag: 'cancel'})
  })
})

describe('runConfigForm', () => {
  const keys = [
    ...'https://dev.azure.com/contoso',
    '\r',
    ...'Platform',
    '\r',
    ...'contoso',
    '\r',
    '\r',
    '\r',
    '\r',
    '\r',
    '\r',
  ]

  it('only completes when the operator drives it to the start row', async () => {
    const painted: Array<readonly ConfigFormField[]> = []
    const layer = Layer.mergeAll(
      Layer.succeed(ConfigFormSurfaceTag, {
        showForm: (fields: readonly ConfigFormField[]) =>
          Effect.sync(() => {
            painted.push(fields)
          }),
      }),
      makeScriptedTerminalInputLayer(keys),
    )

    const result = await Effect.runPromise(runConfigForm(state()).pipe(Effect.provide(layer)))

    expect(result).toEqual({
      _tag: 'submitted',
      selection: {
        adoOrg: 'https://dev.azure.com/contoso',
        adoProject: 'Platform',
        githubOrg: 'contoso',
        apply: false,
        concurrency: 4,
      },
    })
    expect(painted.length).toBe(keys.length)
  })

  it('reports a typed failure when the key stream ends instead of guessing values', async () => {
    const layer = Layer.mergeAll(
      Layer.succeed(ConfigFormSurfaceTag, {showForm: () => Effect.void}),
      makeScriptedTerminalInputLayer([]),
    )

    const failure = await Effect.runPromise(
      Effect.flip(runConfigForm(state()).pipe(Effect.provide(layer))),
    )

    expect(failure).toMatchObject({
      _tag: 'ConfigFormFailure',
      operation: 'read-input',
      reason: 'input-unavailable',
    })
  })
})

describe('configuration form view', () => {
  const view = {
    fields: configFormFields(state({showProblems: true})),
    focusedIndex: 0,
    context: sandboxContext,
  }

  it('fits its viewport and states that nothing runs on its own', () => {
    const frame = renderConfigFormFrame(
      view,
      {columns: 120, rows: 24, reducedMotion: true, color: false},
      new Chalk({level: 0}),
    )

    expect(frame.length).toBeLessThanOrEqual(24)
    expect(frame.every((line) => line.length <= 120)).toBe(true)
    expect(frame.join('\n')).toContain('SANDBOX')
    expect(frame.join('\n')).toContain(CONFIG_FORM_CONTROLS)

    const narrow = renderConfigFormFrame(
      view,
      {columns: 60, rows: 18, reducedMotion: true, color: false},
      new Chalk({level: 0}),
    )

    expect(narrow.length).toBeLessThanOrEqual(18)
    expect(narrow.every((line) => line.length <= 60)).toBe(true)
  })

  it('surfaces the first outstanding problem without hiding the controls', () => {
    const frame = renderConfigFormFrame(
      view,
      {columns: 100, rows: 24, reducedMotion: true, color: false},
      new Chalk({level: 0}),
    ).join('\n')

    expect(frame).toContain('Azure DevOps organization')
    expect(frame).toContain('Required')
  })

  it('renders a stable plain form when the terminal cannot frame it', () => {
    const lines = renderPlainConfigForm(view)

    expect(lines[0]).toContain('Sandbox')
    expect(lines.at(-1)).toBe(CONFIG_FORM_CONTROLS)
    expect(lines.join('\n')).not.toContain('\u001b')
  })
})
