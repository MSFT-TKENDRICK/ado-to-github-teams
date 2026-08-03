import {type ChalkInstance} from 'chalk'
import {CONFIG_FORM_CONTROLS, type ConfigFormContext, type ConfigFormField} from './config-form.js'
import {
  panelBorder,
  panelContentLine,
  sanitizeText,
  truncateToWidth,
  visibleWidth,
  type DashboardFrameOptions,
} from './terminal-dashboard.js'

export interface ConfigFormView {
  readonly fields: readonly ConfigFormField[]
  readonly focusedIndex: number
  readonly context: ConfigFormContext
}

function displayValue(field: ConfigFormField, focused: boolean): string {
  if (field.kind === 'action') {
    return ''
  }
  if (field.kind === 'choice') {
    return focused ? `‹ ${field.value} ›` : field.value
  }
  if (field.disabled === true) {
    return 'not required'
  }
  if (field.value === '') {
    return focused ? '▏' : field.required ? '(required)' : '(optional)'
  }
  return focused ? `${field.value}▏` : field.value
}

function fieldRow(
  field: ConfigFormField,
  focused: boolean,
  innerWidth: number,
  chalk: ChalkInstance,
): string {
  const marker = focused ? '❯' : ' '
  const label = sanitizeText(field.label)
  const labelWidth = Math.min(30, Math.max(18, Math.floor(innerWidth / 3)))
  const paddedLabel = truncateToWidth(label, labelWidth).padEnd(labelWidth, ' ')
  const value = sanitizeText(displayValue(field, focused))
  const valueBudget = Math.max(1, innerWidth - labelWidth - 6)
  const shown = truncateToWidth(value, valueBudget)
  if (field.kind === 'action') {
    const row = ` ${marker} ${truncateToWidth(label, Math.max(1, innerWidth - 4))} `
    return panelContentLine(focused ? chalk.cyan.bold(row) : chalk.dim(row), innerWidth)
  }
  const tone =
    field.problem !== undefined ? chalk.red : field.disabled === true ? chalk.dim : chalk.white
  const row = ` ${marker} ${chalk.dim(paddedLabel)}  ${tone(shown)} `
  return panelContentLine(focused ? chalk.cyan(`${row}`) : row, innerWidth)
}

export function renderConfigFormFrame(
  view: ConfigFormView,
  options: DashboardFrameOptions,
  chalk: ChalkInstance,
): readonly string[] {
  const columns = Math.max(1, Math.floor(options.columns))
  const rows = Math.max(1, Math.floor(options.rows))
  const innerWidth = Math.max(1, columns - 2)
  const focused = view.fields[view.focusedIndex]
  const problems = view.fields
    .map((field) => (field.problem ? `${field.label}: ${field.problem}` : ''))
    .filter((entry) => entry !== '')
  const brand = ` ${view.context.title}`
  const badge =
    view.context.environment === 'sandbox'
      ? 'SANDBOX • NO PROVIDER WRITES'
      : 'LIVE • NOTHING RUNS UNTIL YOU START'
  const badgeLabel = truncateToWidth(badge, Math.max(8, innerWidth - visibleWidth(brand) - 2))
  const headerSpace = Math.max(1, innerWidth - visibleWidth(brand) - visibleWidth(badgeLabel) - 1)
  const listBudget = Math.max(1, rows - 9)
  const start = Math.max(
    0,
    Math.min(view.focusedIndex - Math.floor(listBudget / 2), view.fields.length - listBudget),
  )
  const visible = view.fields.slice(start, start + listBudget)
  const statusLine =
    problems.length === 0
      ? focused
        ? sanitizeText(focused.hint)
        : 'Choose a field to edit.'
      : sanitizeText(problems[0] ?? '')
  return [
    panelBorder(chalk, '╭', columns, '╮'),
    panelContentLine(
      `${chalk.bold(brand)}${' '.repeat(headerSpace)}${chalk.yellow(badgeLabel)}`,
      innerWidth,
    ),
    panelContentLine(
      ` ${chalk.dim('MIGRATION CONFIGURATION')}  ${chalk.dim('you supply every value below')}`,
      innerWidth,
    ),
    panelBorder(chalk, '├', columns, '┤'),
    ...visible.map((field) =>
      fieldRow(field, view.fields.indexOf(field) === view.focusedIndex, innerWidth, chalk),
    ),
    panelBorder(chalk, '├', columns, '┤'),
    panelContentLine(
      ` ${problems.length === 0 ? chalk.dim(truncateToWidth(statusLine, Math.max(1, innerWidth - 2))) : chalk.red(truncateToWidth(statusLine, Math.max(1, innerWidth - 2)))}`,
      innerWidth,
    ),
    panelContentLine(
      ` ${chalk.dim(truncateToWidth(CONFIG_FORM_CONTROLS, Math.max(1, innerWidth - 2)))}`,
      innerWidth,
    ),
    panelBorder(chalk, '╰', columns, '╯'),
  ].slice(0, rows)
}

export function renderPlainConfigForm(view: ConfigFormView): readonly string[] {
  const problems = view.fields
    .map((field) => (field.problem ? `${field.label}: ${field.problem}` : ''))
    .filter((entry) => entry !== '')
  return [
    sanitizeText(`${view.context.title} — you supply every value below.`),
    ...view.fields.map((field, index) =>
      sanitizeText(
        `${index === view.focusedIndex ? '>' : ' '} ${field.label}${
          field.kind === 'action' ? '' : `: ${displayValue(field, false)}`
        }`,
      ),
    ),
    ...problems.map((problem) => sanitizeText(`! ${problem}`)),
    CONFIG_FORM_CONTROLS,
  ]
}
