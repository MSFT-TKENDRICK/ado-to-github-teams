import {Context, Data, Effect, Either, Schema} from 'effect'
import {
  buildCliCoverageReport,
  CLI_JOURNEYS,
  cliJourneyObservations,
  type CliCoverageReport,
  type CliJourneyLever,
} from './cli-journeys.js'

export const DEFAULT_PERSONA_ITERATIONS = 8

export const LeverNameSchema = Schema.Union(
  Schema.Literal('statusVisibility'),
  Schema.Literal('plainLanguage'),
  Schema.Literal('recoveryGuidance'),
  Schema.Literal('approvalContext'),
  Schema.Literal('adaptiveDetail'),
  Schema.Literal('confirmationClosure'),
  Schema.Literal('commandDiscoverability'),
  Schema.Literal('flagErgonomics'),
  Schema.Literal('scopeRepetition'),
  Schema.Literal('automationClarity'),
  Schema.Literal('credentialSetup'),
  Schema.Literal('errorPrevention'),
)

export type LeverName = Schema.Schema.Type<typeof LeverNameSchema>

const DesignLeversSchema = Schema.Struct({
  statusVisibility: Schema.Number.pipe(Schema.between(0, 1)),
  plainLanguage: Schema.Number.pipe(Schema.between(0, 1)),
  recoveryGuidance: Schema.Number.pipe(Schema.between(0, 1)),
  approvalContext: Schema.Number.pipe(Schema.between(0, 1)),
  adaptiveDetail: Schema.Number.pipe(Schema.between(0, 1)),
  confirmationClosure: Schema.Number.pipe(Schema.between(0, 1)),
  commandDiscoverability: Schema.Number.pipe(Schema.between(0, 1)),
  flagErgonomics: Schema.Number.pipe(Schema.between(0, 1)),
  scopeRepetition: Schema.Number.pipe(Schema.between(0, 1)),
  automationClarity: Schema.Number.pipe(Schema.between(0, 1)),
  credentialSetup: Schema.Number.pipe(Schema.between(0, 1)),
  errorPrevention: Schema.Number.pipe(Schema.between(0, 1)),
})

export const ExperimentBaselineIdSchema = Schema.Literal('production', 'synthetic')

export type ExperimentBaselineId = Schema.Schema.Type<typeof ExperimentBaselineIdSchema>

const DesignAlternativeIdSchema = Schema.Literal(
  'persistent-stage-status',
  'plain-language-layer',
  'command-ready-recovery',
  'decision-centered-approval',
  'adaptive-progressive-disclosure',
  'durable-outcome-receipt',
  'task-oriented-command-map',
  'consistent-flag-contract',
  'reusable-scope-profile',
  'machine-readable-noninteractive-contract',
  'credential-readiness-preflight',
  'conflict-aware-command-builder',
)

type DesignAlternativeId = Schema.Schema.Type<typeof DesignAlternativeIdSchema>

const ExperimentBaselineSchema = Schema.Struct({
  id: ExperimentBaselineIdSchema,
  label: Schema.String,
  source: Schema.String,
  context: Schema.String,
  implementedAlternativeIds: Schema.Array(DesignAlternativeIdSchema),
  levers: DesignLeversSchema,
})

export type ExperimentBaseline = Schema.Schema.Type<typeof ExperimentBaselineSchema>

const PersonaSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  role: Schema.String,
  goal: Schema.String,
  context: Schema.String,
  accessNeeds: Schema.String,
  sensitivities: Schema.Record({key: LeverNameSchema, value: Schema.Number}),
})

export type Persona = Schema.Schema.Type<typeof PersonaSchema>

export const ExperimentConfigSchema = Schema.Struct({
  baseline: ExperimentBaselineIdSchema,
  iterations: Schema.Number,
  optimizationStep: Schema.Number,
  painThreshold: Schema.Number,
})

export type ExperimentConfig = Schema.Schema.Type<typeof ExperimentConfigSchema>

export interface ScenarioObservation {
  readonly feature: string
  readonly scenario: string
  readonly status: string
  readonly durationMs: number
  readonly steps: ReadonlyArray<string>
  readonly source?: 'migration-bdd' | 'cli-journey'
  readonly personaIds?: ReadonlyArray<string>
  readonly stepLevers?: ReadonlyArray<CliJourneyLever>
  readonly journey?: {
    readonly id: string
    readonly entrypoint: string
    readonly command: string
    readonly flags: ReadonlyArray<string>
    readonly conflicts: ReadonlyArray<string>
    readonly expectedOutcome: string
  }
}

export interface DesignState {
  readonly iteration: number
  readonly levers: Readonly<Record<LeverName, number>>
}

export interface ExperienceTrace {
  readonly iteration: number
  readonly personaId: string
  readonly persona: string
  readonly feature: string
  readonly scenario: string
  readonly scenarioSource: 'migration-bdd' | 'cli-journey'
  readonly scenarioStatus: string
  readonly scenarioDurationMs: number
  readonly journeyId: string | null
  readonly entrypoint: string | null
  readonly command: string | null
  readonly flags: ReadonlyArray<string>
  readonly conflicts: ReadonlyArray<string>
  readonly expectedOutcome: string | null
  readonly actionIndex: number
  readonly action: string
  readonly thought: string
  readonly experience: string
  readonly frictionType: string
  readonly pain: string
  readonly whyPainful: string
  readonly potentialHarm: string
  readonly frictionScore: number
  readonly unintuitive: boolean
  readonly lever: LeverName
  readonly alternativeId: string
}

export interface IterationMetrics {
  readonly iteration: number
  readonly scenarioCount: number
  readonly migrationScenarioCount: number
  readonly cliJourneyCount: number
  readonly actionCount: number
  readonly meanFriction: number
  readonly p95Friction: number
  readonly unintuitiveActions: number
  readonly highHarmActions: number
  readonly cucumberDurationMs: number
}

export interface ExperimentIteration {
  readonly design: DesignState
  readonly scenarios: ReadonlyArray<ScenarioObservation>
  readonly traces: ReadonlyArray<ExperienceTrace>
  readonly metrics: IterationMetrics
}

export interface OptimizationDecision {
  readonly afterIteration: number
  readonly lever: LeverName
  readonly previousValue: number
  readonly nextValue: number
  readonly observedFriction: number
  readonly rationale: string
}

export interface OptimizationNote {
  readonly afterIteration: number
  readonly rationale: string
}

export interface LeverRanking {
  readonly rank: number
  readonly lever: LeverName
  readonly traceCount: number
  readonly meanFriction: number
  readonly p95Friction: number
  readonly remainingGap: number
  readonly observedOpportunity: number
}

export interface ExperimentCompletion {
  readonly requestedIterations: number
  readonly completedIterations: number
  readonly converged: boolean
  readonly reason: 'converged-no-candidate' | 'iteration-bound-reached-with-candidates'
  readonly remainingCandidateCount: number
}

export interface ResearchSource {
  readonly label: string
  readonly url: string
  readonly finding: string
}

export interface DesignAlternative {
  readonly id: DesignAlternativeId
  readonly lever: LeverName
  readonly title: string
  readonly implementation: string
  readonly expectedBenefit: string
  readonly evidence: ReadonlyArray<string>
}

export interface PersonaExperimentResult {
  readonly baseline: ExperimentBaseline
  readonly personas: ReadonlyArray<Persona>
  readonly iterations: ReadonlyArray<ExperimentIteration>
  readonly optimizationDecisions: ReadonlyArray<OptimizationDecision>
  readonly optimizationNotes: ReadonlyArray<OptimizationNote>
  readonly finalDesign: DesignState
  readonly alternatives: ReadonlyArray<DesignAlternative>
  readonly sources: ReadonlyArray<ResearchSource>
  readonly cliCoverage: CliCoverageReport
  readonly initialLeverRanking: ReadonlyArray<LeverRanking>
  readonly finalLeverRanking: ReadonlyArray<LeverRanking>
  readonly completion: ExperimentCompletion
}

export class ExperimentConfigurationFailure extends Data.TaggedError(
  'ExperimentConfigurationFailure',
)<{
  readonly message: string
}> {}

export class ScenarioRunFailure extends Data.TaggedError('ScenarioRunFailure')<{
  readonly message: string
}> {}

export class ExperimentArtifactFailure extends Data.TaggedError('ExperimentArtifactFailure')<{
  readonly message: string
}> {}

export class ExperimentCoverageFailure extends Data.TaggedError('ExperimentCoverageFailure')<{
  readonly message: string
}> {}

export interface ScenarioRunner {
  readonly run: (
    iteration: number,
  ) => Effect.Effect<ReadonlyArray<ScenarioObservation>, ScenarioRunFailure>
}

export interface ExperimentArtifactWriter {
  readonly write: (
    result: PersonaExperimentResult,
  ) => Effect.Effect<void, ExperimentArtifactFailure>
}

export class ScenarioRunnerTag extends Context.Tag('PersonaScenarioRunner')<
  ScenarioRunnerTag,
  ScenarioRunner
>() {}

export class ExperimentArtifactWriterTag extends Context.Tag('PersonaExperimentArtifactWriter')<
  ExperimentArtifactWriterTag,
  ExperimentArtifactWriter
>() {}

export const PERSONAS = Schema.decodeUnknownSync(Schema.Array(PersonaSchema))([
  {
    id: 'first-time-coordinator',
    name: 'Maya',
    role: 'Project coordinator leading a first migration',
    goal: 'Preview the migration, understand exceptions, and know exactly what to do next.',
    context:
      'Maya knows the teams and stakeholders but does not routinely work with Entra, EMU, SCIM, or command-line recovery.',
    accessNeeds:
      'Needs plain language, visible orientation, examples, and recognition instead of memorized provider terminology.',
    sensitivities: {
      statusVisibility: 1.15,
      plainLanguage: 1.45,
      recoveryGuidance: 1.35,
      approvalContext: 1.2,
      adaptiveDetail: 1.4,
      confirmationClosure: 1.25,
      commandDiscoverability: 1.5,
      flagErgonomics: 1.4,
      scopeRepetition: 1.25,
      automationClarity: 0.9,
      credentialSetup: 1.45,
      errorPrevention: 1.4,
    },
  },
  {
    id: 'risk-accountable-owner',
    name: 'Ravi',
    role: 'Identity governance owner accountable for access changes',
    goal: 'Confirm scope, evidence, and reversibility before authorizing any write.',
    context:
      'Ravi reviews migrations between meetings and must later demonstrate why an access decision was safe.',
    accessNeeds:
      'Needs decision-focused summaries, explicit consequences, durable receipts, and unambiguous stop or defer controls.',
    sensitivities: {
      statusVisibility: 1.1,
      plainLanguage: 1.05,
      recoveryGuidance: 1.25,
      approvalContext: 1.5,
      adaptiveDetail: 1.1,
      confirmationClosure: 1.45,
      commandDiscoverability: 1.05,
      flagErgonomics: 1.15,
      scopeRepetition: 1.1,
      automationClarity: 1.2,
      credentialSetup: 1.3,
      errorPrevention: 1.5,
    },
  },
  {
    id: 'time-pressured-engineer',
    name: 'Elena',
    role: 'Platform engineer migrating many organizations',
    goal: 'Recognize changes and failures quickly without rereading repetitive detail.',
    context:
      'Elena understands the providers and runs migrations frequently, often while responding to other operational work.',
    accessNeeds:
      'Needs compact defaults, stable terminology, command-ready recovery, and optional detail rather than mandatory verbosity.',
    sensitivities: {
      statusVisibility: 1.25,
      plainLanguage: 0.9,
      recoveryGuidance: 1.3,
      approvalContext: 1.05,
      adaptiveDetail: 1.35,
      confirmationClosure: 1.1,
      commandDiscoverability: 1.1,
      flagErgonomics: 1.35,
      scopeRepetition: 1.45,
      automationClarity: 1.3,
      credentialSetup: 1.0,
      errorPrevention: 1.25,
    },
  },
  {
    id: 'nonvisual-operator',
    name: 'Jordan',
    role: 'Operations specialist using a screen reader and keyboard',
    goal: 'Track state changes, inspect errors, and approve safely without relying on visual scanning.',
    context:
      'Jordan uses line-oriented terminal output and needs each update to make sense when announced independently.',
    accessNeeds:
      'Needs concise textual status, meaningful ordering, no color-only distinctions, and errors linked to corrective actions.',
    sensitivities: {
      statusVisibility: 1.5,
      plainLanguage: 1.2,
      recoveryGuidance: 1.45,
      approvalContext: 1.3,
      adaptiveDetail: 1.2,
      confirmationClosure: 1.35,
      commandDiscoverability: 1.35,
      flagErgonomics: 1.25,
      scopeRepetition: 1.15,
      automationClarity: 1.1,
      credentialSetup: 1.3,
      errorPrevention: 1.4,
    },
  },
  {
    id: 'unattended-automation-engineer',
    name: 'Sam',
    role: 'CI and automation engineer operating unattended migration jobs',
    goal: 'Compose deterministic commands, detect failures from exit status, and consume stable machine-readable output.',
    context:
      'Sam runs migrations in ephemeral CI agents where prompts, ambient state, and repetitive manual setup are unavailable.',
    accessNeeds:
      'Needs explicit noninteractive contracts, environment-safe credential setup, stable JSON, bounded execution, and actionable stderr.',
    sensitivities: {
      statusVisibility: 1.15,
      plainLanguage: 0.95,
      recoveryGuidance: 1.35,
      approvalContext: 1.25,
      adaptiveDetail: 1.0,
      confirmationClosure: 1.3,
      commandDiscoverability: 1.1,
      flagErgonomics: 1.35,
      scopeRepetition: 1.4,
      automationClarity: 1.55,
      credentialSetup: 1.4,
      errorPrevention: 1.45,
    },
  },
  {
    id: 'security-credential-administrator',
    name: 'Nia',
    role: 'Security administrator provisioning least-privilege provider credentials',
    goal: 'Verify credential source, scope, expiry, and provider readiness without exposing secrets.',
    context:
      'Nia configures separate Azure, GitHub, and Entra identities under enterprise policy and hands readiness evidence to operators.',
    accessNeeds:
      'Needs credential-specific preflight, redacted diagnostics, required-permission guidance, and clear interactive versus workload identity paths.',
    sensitivities: {
      statusVisibility: 1.05,
      plainLanguage: 1.2,
      recoveryGuidance: 1.35,
      approvalContext: 1.4,
      adaptiveDetail: 1.15,
      confirmationClosure: 1.35,
      commandDiscoverability: 1.15,
      flagErgonomics: 1.2,
      scopeRepetition: 1.25,
      automationClarity: 1.35,
      credentialSetup: 1.65,
      errorPrevention: 1.55,
    },
  },
  {
    id: 'incident-recovery-operator',
    name: 'Owen',
    role: 'On-call operator recovering interrupted or blocked migrations',
    goal: 'Identify the active run, understand retained state, and resume only the safe unit under time pressure.',
    context:
      'Owen joins after the initiating operator is unavailable and has incident notes but little memory of the original command.',
    accessNeeds:
      'Needs session discovery, exact resume commands, checkpoint compatibility, failure boundaries, and current-versus-next state.',
    sensitivities: {
      statusVisibility: 1.5,
      plainLanguage: 1.15,
      recoveryGuidance: 1.65,
      approvalContext: 1.35,
      adaptiveDetail: 1.25,
      confirmationClosure: 1.4,
      commandDiscoverability: 1.45,
      flagErgonomics: 1.3,
      scopeRepetition: 1.25,
      automationClarity: 1.2,
      credentialSetup: 1.3,
      errorPrevention: 1.6,
    },
  },
  {
    id: 'infrequent-low-bandwidth-operator',
    name: 'Luis',
    role: 'Infrequent operator working through a constrained remote terminal',
    goal: 'Complete a rare migration without memorizing commands or repeatedly transferring verbose output.',
    context:
      'Luis uses the CLI a few times a year over a high-latency connection and cannot rely on recent procedural memory.',
    accessNeeds:
      'Needs task-oriented help, compact line-oriented output, reusable scope, examples, and prevention before expensive remote retries.',
    sensitivities: {
      statusVisibility: 1.35,
      plainLanguage: 1.4,
      recoveryGuidance: 1.45,
      approvalContext: 1.2,
      adaptiveDetail: 1.55,
      confirmationClosure: 1.3,
      commandDiscoverability: 1.65,
      flagErgonomics: 1.5,
      scopeRepetition: 1.5,
      automationClarity: 1.1,
      credentialSetup: 1.4,
      errorPrevention: 1.55,
    },
  },
])

export const RESEARCH_SOURCES: ReadonlyArray<ResearchSource> = [
  {
    label: 'Nielsen Norman Group: 10 usability heuristics',
    url: 'https://www.nngroup.com/articles/ten-usability-heuristics/',
    finding:
      'Interfaces should expose system status, use familiar language, prevent errors, support recognition, and provide constructive recovery.',
  },
  {
    label: 'U.S. Web Design System: design principles',
    url: 'https://designsystem.digital.gov/design-principles/',
    finding:
      'Start with real user needs, earn trust, preserve user time, test assumptions, and build accessibility into every decision.',
  },
  {
    label: 'GOV.UK Service Standard: understand user needs',
    url: 'https://www.gov.uk/service-manual/service-standard/point-1-understand-user-needs',
    finding:
      'Study the whole user goal, test assumptions early and often, prototype alternatives, and combine qualitative and quantitative evidence.',
  },
  {
    label: 'GOV.UK Design System: confirmation pages',
    url: 'https://design-system.service.gov.uk/patterns/confirmation-pages/',
    finding:
      'Completion feedback should include a reference, what happened, what happens next, and a durable record.',
  },
  {
    label: 'WCAG 2.2: Error Identification',
    url: 'https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html',
    finding:
      'Errors need a textual description that identifies what is wrong; constructive correction guidance further reduces recovery burden.',
  },
  {
    label: 'Command Line Interface Guidelines',
    url: 'https://clig.dev/',
    finding:
      'Human-first CLIs provide discoverable help, consistent arguments, actionable errors, composable output, and explicit noninteractive behavior.',
  },
  {
    label: 'The Twelve-Factor App: Config',
    url: 'https://12factor.net/config',
    finding:
      'Deployment-varying configuration belongs in the environment rather than code, supporting repeatable automation without committing credentials.',
  },
]

export const DESIGN_ALTERNATIVES: ReadonlyArray<DesignAlternative> = [
  {
    id: 'persistent-stage-status',
    lever: 'statusVisibility',
    title: 'Persistent, line-oriented stage status',
    implementation:
      'Emit one stable status line at each phase boundary with run ID, current phase, completed/total units, elapsed time, and the next expected event. Avoid spinner-only or color-only state.',
    expectedBenefit:
      'Reduces uncertainty, duplicate starts, and screen-reader ambiguity while keeping high-volume progress compact.',
    evidence: [
      'Nielsen Norman Group: 10 usability heuristics',
      'U.S. Web Design System: design principles',
    ],
  },
  {
    id: 'plain-language-layer',
    lever: 'plainLanguage',
    title: 'Plain-language primary message with technical detail on demand',
    implementation:
      'Lead with the affected person, team, or decision and the corrective action. Put provider codes and raw payloads in a clearly labeled technical-detail block or --verbose output.',
    expectedBenefit:
      'Lets novice operators recover without hiding diagnostics that experienced operators need.',
    evidence: ['Nielsen Norman Group: 10 usability heuristics', 'WCAG 2.2: Error Identification'],
  },
  {
    id: 'command-ready-recovery',
    lever: 'recoveryGuidance',
    title: 'Command-ready recovery block',
    implementation:
      'On failure, print what completed, what did not, whether retry is safe, the retained checkpoint ID, and the exact resume or remediation command.',
    expectedBenefit:
      'Lowers memory demand and prevents unsafe retries, abandoned checkpoints, and repeated writes.',
    evidence: ['Nielsen Norman Group: 10 usability heuristics', 'WCAG 2.2: Error Identification'],
  },
  {
    id: 'decision-centered-approval',
    lever: 'approvalContext',
    title: 'Decision-centered approval summary',
    implementation:
      'Before a prompt, group exact writes by target and show affected counts, skipped exceptions, irreversible consequences, and explicit approve, defer, or abort choices.',
    expectedBenefit:
      'Makes consent informed and reviewable without forcing the operator to reconstruct scope from prior output.',
    evidence: [
      'Nielsen Norman Group: 10 usability heuristics',
      'U.S. Web Design System: design principles',
    ],
  },
  {
    id: 'adaptive-progressive-disclosure',
    lever: 'adaptiveDetail',
    title: 'Adaptive progressive disclosure',
    implementation:
      'Offer guided and compact presentation modes over the same validated plan. Keep essential safety facts always visible and expose examples, definitions, and raw details on demand.',
    expectedBenefit:
      'Supports first-time and expert operators without making either group pay the other group’s cognitive or time cost.',
    evidence: [
      'Nielsen Norman Group: 10 usability heuristics',
      'GOV.UK Service Standard: understand user needs',
    ],
  },
  {
    id: 'durable-outcome-receipt',
    lever: 'confirmationClosure',
    title: 'Durable outcome receipt',
    implementation:
      'End every run with status, run ID, report path, applied/skipped/failed counts, retained checkpoint state, and one recommended next action.',
    expectedBenefit:
      'Closes the task, supports audit handoff, and prevents uncertainty about whether a silent or partial completion succeeded.',
    evidence: [
      'GOV.UK Design System: confirmation pages',
      'U.S. Web Design System: design principles',
    ],
  },
  {
    id: 'task-oriented-command-map',
    lever: 'commandDiscoverability',
    title: 'Task-oriented command map and contextual next commands',
    implementation:
      'Make root help organize migrate, auth, and sessions by operator goal, show the no-argument reopen behavior, and include valid next-command examples in unknown-command and completion output.',
    expectedBenefit:
      'Reduces memorization and wrong-entrypoint attempts for new, infrequent, recovery, and constrained-terminal operators.',
    evidence: [
      'Command Line Interface Guidelines',
      'Nielsen Norman Group: 10 usability heuristics',
    ],
  },
  {
    id: 'consistent-flag-contract',
    lever: 'flagErgonomics',
    title: 'Consistent flag groups, aliases, and examples',
    implementation:
      'Group scope, execution, recovery, presentation, worker, topology, and sandbox flags consistently across command help, with representative valid combinations and explicit value domains.',
    expectedBenefit:
      'Lowers command-construction errors and makes related controls recognizable across the broad migration surface.',
    evidence: [
      'Command Line Interface Guidelines',
      'GOV.UK Service Standard: understand user needs',
    ],
  },
  {
    id: 'reusable-scope-profile',
    lever: 'scopeRepetition',
    title: 'Inspectable reusable scope profile',
    implementation:
      'Allow named, non-secret source and target scope profiles with precedence shown before execution, while retaining explicit flags as auditable overrides.',
    expectedBenefit:
      'Reduces repetitive organization and project entry without hiding the scope used for a destructive decision.',
    evidence: ['The Twelve-Factor App: Config', 'U.S. Web Design System: design principles'],
  },
  {
    id: 'machine-readable-noninteractive-contract',
    lever: 'automationClarity',
    title: 'Explicit machine-readable noninteractive contract',
    implementation:
      'Document and expose stable JSON event and outcome schemas, exit-code meanings, stdout/stderr boundaries, prompt suppression rules, and required credential sources for every command.',
    expectedBenefit:
      'Makes unattended CI behavior deterministic and prevents scripts from depending on presentation-oriented text.',
    evidence: ['Command Line Interface Guidelines', 'The Twelve-Factor App: Config'],
  },
  {
    id: 'credential-readiness-preflight',
    lever: 'credentialSetup',
    title: 'Provider-specific credential readiness preflight',
    implementation:
      'Report each provider credential source, required access, tenant or organization scope, interactive availability, and a redacted corrective command before migration planning.',
    expectedBenefit:
      'Separates authentication setup from migration failure and supports least-privilege handoff without exposing secrets.',
    evidence: ['WCAG 2.2: Error Identification', 'Nielsen Norman Group: 10 usability heuristics'],
  },
  {
    id: 'conflict-aware-command-builder',
    lever: 'errorPrevention',
    title: 'Conflict-aware preflight and command builder',
    implementation:
      'Validate dependencies, exclusions, scenario mode, required scope, and noninteractive readiness before provider or worker access, then render the corrected command shape.',
    expectedBenefit:
      'Prevents contradictory or unsupported runs before remote work, approval, or checkpoint state begins.',
    evidence: [
      'Nielsen Norman Group: 10 usability heuristics',
      'Command Line Interface Guidelines',
    ],
  },
]

export const EXPERIMENT_BASELINES = Schema.decodeUnknownSync(
  Schema.Struct({
    production: ExperimentBaselineSchema,
    synthetic: ExperimentBaselineSchema,
  }),
)({
  production: {
    id: 'production',
    label: 'Current production experience',
    source: 'Current production implementation',
    context:
      'The production CLI implements the original six migration-experience alternatives, a task-oriented command map with contextual next commands, provider-specific credential readiness diagnostics, and a stable noninteractive auth contract. The remaining expanded command-surface alternatives are not fully implemented.',
    implementedAlternativeIds: [
      'persistent-stage-status',
      'plain-language-layer',
      'command-ready-recovery',
      'decision-centered-approval',
      'adaptive-progressive-disclosure',
      'durable-outcome-receipt',
      'task-oriented-command-map',
      'machine-readable-noninteractive-contract',
      'credential-readiness-preflight',
    ],
    levers: {
      statusVisibility: 1,
      plainLanguage: 1,
      recoveryGuidance: 1,
      approvalContext: 1,
      adaptiveDetail: 1,
      confirmationClosure: 1,
      commandDiscoverability: 1,
      flagErgonomics: 0.5,
      scopeRepetition: 0.4,
      automationClarity: 1,
      credentialSetup: 1,
      errorPrevention: 0.65,
    },
  },
  synthetic: {
    id: 'synthetic',
    label: 'Legacy synthetic experience',
    source: 'Controlled design-experiment fixture',
    context:
      'This intentionally incomplete design state preserves the original modeled baseline for controlled comparisons and unit tests.',
    implementedAlternativeIds: [],
    levers: {
      statusVisibility: 0.3,
      plainLanguage: 0.3,
      recoveryGuidance: 0.2,
      approvalContext: 0.35,
      adaptiveDetail: 0.2,
      confirmationClosure: 0.3,
      commandDiscoverability: 0.2,
      flagErgonomics: 0.2,
      scopeRepetition: 0.15,
      automationClarity: 0.2,
      credentialSetup: 0.2,
      errorPrevention: 0.25,
    },
  },
})

const TOUCHPOINTS: Readonly<
  Record<
    LeverName,
    {
      readonly frictionType: string
      readonly baseDifficulty: number
      readonly pain: string
      readonly why: string
      readonly harm: string
      readonly thought: string
    }
  >
> = {
  statusVisibility: {
    frictionType: 'orientation and progress uncertainty',
    baseDifficulty: 0.68,
    pain: 'The interface does not make current progress or the next event easy to recognize.',
    why: 'The operator must infer state from scattered output and remember what has already completed.',
    harm: 'Unclear progress can cause duplicate runs, premature interruption, or wasted monitoring time.',
    thought: 'Where am I in the migration, and is it still moving safely?',
  },
  plainLanguage: {
    frictionType: 'provider jargon and interpretation',
    baseDifficulty: 0.72,
    pain: 'Provider-specific terms obscure the user goal and required response.',
    why: 'The operator must translate implementation vocabulary before deciding what the scenario means.',
    harm: 'Misinterpretation can exclude valid identities, delay remediation, or create unequal access outcomes.',
    thought: 'What does this provider term mean for the person or team I am responsible for?',
  },
  recoveryGuidance: {
    frictionType: 'error diagnosis and recovery',
    baseDifficulty: 0.9,
    pain: 'The failure state does not itself provide a complete, safe recovery path.',
    why: 'The operator must diagnose cause, retry safety, retained state, and the next command under stress.',
    harm: 'A mistaken retry can repeat work, strand a resumable migration, or leave access partially applied.',
    thought: 'What completed, what is safe to retry, and what exact action gets me unstuck?',
  },
  approvalContext: {
    frictionType: 'decision confidence and control',
    baseDifficulty: 0.86,
    pain: 'The approval action requires reconstructing scope and consequences from earlier information.',
    why: 'Consent is slower and less reliable when exact writes, exceptions, reversibility, and alternatives are not colocated.',
    harm: 'Insufficient decision context can cause unauthorized changes or unnecessary abandonment of safe work.',
    thought:
      'Can I prove what this approval changes and stop without losing the safe work already done?',
  },
  adaptiveDetail: {
    frictionType: 'cognitive load and efficiency',
    baseDifficulty: 0.62,
    pain: 'The same level of detail is imposed regardless of expertise, task frequency, or current pressure.',
    why: 'Novices need orientation while experts need scanability; a single presentation makes one group work around the interface.',
    harm: 'Excess cognitive load increases fatigue, missed exceptions, and dependence on a more technical colleague.',
    thought: 'Can I get the amount of explanation I need without losing the safety-critical facts?',
  },
  confirmationClosure: {
    frictionType: 'outcome uncertainty and handoff',
    baseDifficulty: 0.7,
    pain: 'The outcome is not packaged as a concise, durable receipt with a clear next step.',
    why: 'The operator must search logs and reports to establish completion, partial work, and follow-up obligations.',
    harm: 'Weak closure can hide partial outcomes, undermine audit evidence, and delay follow-up remediation.',
    thought: 'Is the task complete, where is the evidence, and what do I need to do next?',
  },
  commandDiscoverability: {
    frictionType: 'command discovery and task orientation',
    baseDifficulty: 0.82,
    pain: 'The operator must already know which command or entrypoint behavior matches the task.',
    why: 'Command names, default routing, sandbox shortcuts, and recovery entrypoints are hard to infer from the immediate context.',
    harm: 'A wrong starting point wastes time, obscures safer paths, and can make an infrequent operator abandon the task.',
    thought: 'Which command starts my task, and how can I discover it without trial and error?',
  },
  flagErgonomics: {
    frictionType: 'argument construction and flag consistency',
    baseDifficulty: 0.78,
    pain: 'The broad flag surface requires assembling valid combinations from memory.',
    why: 'Related scope, execution, presentation, recovery, worker, topology, and sandbox controls are not represented as one task-shaped contract.',
    harm: 'Misconstructed commands cause repeated attempts, incorrect modes, or delayed recovery before useful work begins.',
    thought:
      'Which flags belong together, which values are valid, and what combination expresses my intent?',
  },
  scopeRepetition: {
    frictionType: 'repetitive scope and configuration entry',
    baseDifficulty: 0.7,
    pain: 'Source and target scope must be repeated or reconstructed across setup, preview, automation, and recovery journeys.',
    why: 'Repeated organization and project entry increases memory, typing, and transcription burden while the operator must still verify exact scope.',
    harm: 'A copied scope can target the wrong organization or force costly remote retries and revalidation.',
    thought:
      'Why am I re-entering this scope, and can I verify a reusable value before it is applied?',
  },
  automationClarity: {
    frictionType: 'automation and noninteractive contract ambiguity',
    baseDifficulty: 0.88,
    pain: 'Unattended behavior, prompt suppression, output shape, and exit semantics are not one explicit cross-command contract.',
    why: 'Automation authors must infer which output is stable, when interaction can occur, and how credentials and approvals behave in CI.',
    harm: 'A pipeline can hang, parse presentation text incorrectly, miss a partial outcome, or use unsafe approval assumptions.',
    thought:
      'Can this run unattended, and which output and exit behavior can my automation safely depend on?',
  },
  credentialSetup: {
    frictionType: 'multi-provider credential readiness',
    baseDifficulty: 0.92,
    pain: 'Readiness depends on several credential sources, permissions, scopes, and interactive fallbacks.',
    why: 'The operator must coordinate Azure DevOps, GitHub, Entra, worker, and Copilot identities without exposing secrets or confusing validation scope.',
    harm: 'Credential ambiguity can block a migration late, broaden privileges unnecessarily, or leak sensitive setup details.',
    thought:
      'Which identity will each provider use, does it have the right access, and how do I fix it safely?',
  },
  errorPrevention: {
    frictionType: 'invalid mode and destructive-error prevention',
    baseDifficulty: 0.96,
    pain: 'Dependencies, exclusions, scenario modes, scope, and destructive intent must all be correct before execution.',
    why: 'A large conditional flag surface makes it difficult to predict invalid combinations and their safe correction.',
    harm: 'Late validation can waste remote work, create the wrong session state, or increase the chance of an unsafe target or mode.',
    thought:
      'Will this command be rejected safely before any remote or destructive work, and how do I correct it?',
  },
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function classifyAction(action: string): LeverName {
  const normalized = action.toLowerCase()
  if (
    /(fail|error|reject|incompatible|unsupported|permission|unavailable|revoked|collision|remediation)/.test(
      normalized,
    )
  ) {
    return 'recoveryGuidance'
  }
  if (/(approv|write|appl(?:y|ied)|create|assign|add member|remove|skip)/.test(normalized)) {
    return 'approvalContext'
  }
  if (/(report|complete|succeed|checkpoint|retained|removed|summary|evidence)/.test(normalized)) {
    return 'confirmationClosure'
  }
  if (/(retry|wait|concurren|enumerat|read|followed|phase|before|after|overlap)/.test(normalized)) {
    return 'statusVisibility'
  }
  if (
    /(entra|github|ado|identity|sso|scim|emu|ghemu|idp|slug|topology|transitive)/.test(normalized)
  ) {
    return 'plainLanguage'
  }
  return 'adaptiveDetail'
}

function quantile(values: ReadonlyArray<number>, fraction: number): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0
}

export function initialDesign(baseline: ExperimentBaselineId = 'synthetic'): DesignState {
  return {iteration: 1, levers: {...EXPERIMENT_BASELINES[baseline].levers}}
}

export function decodeExperimentConfig(
  input: unknown,
): Effect.Effect<ExperimentConfig, ExperimentConfigurationFailure> {
  const decoded = Schema.decodeUnknownEither(ExperimentConfigSchema, {
    onExcessProperty: 'error',
  })(input)
  if (Either.isLeft(decoded)) {
    return Effect.fail(
      new ExperimentConfigurationFailure({message: 'Experiment configuration is malformed'}),
    )
  }
  const config = decoded.right
  if (
    !Number.isInteger(config.iterations) ||
    config.iterations < 1 ||
    config.iterations > 20 ||
    config.optimizationStep <= 0 ||
    config.optimizationStep > 1 ||
    config.painThreshold < 0 ||
    config.painThreshold > 100
  ) {
    return Effect.fail(
      new ExperimentConfigurationFailure({
        message:
          'Experiment configuration requires 1-20 iterations, an optimization step in (0, 1], and a pain threshold from 0-100',
      }),
    )
  }
  return Effect.succeed(config)
}

export function evaluateIteration(
  design: DesignState,
  personas: ReadonlyArray<Persona>,
  scenarios: ReadonlyArray<ScenarioObservation>,
  painThreshold: number,
): ExperimentIteration {
  const traces = personas.flatMap((persona) =>
    scenarios
      .filter(
        (scenario) => scenario.personaIds === undefined || scenario.personaIds.includes(persona.id),
      )
      .flatMap((scenario) => {
        return scenario.steps.map((action, actionIndex): ExperienceTrace => {
          const lever = scenario.stepLevers?.[actionIndex] ?? classifyAction(action)
          const touchpoint = TOUCHPOINTS[lever]
          const sensitivity = persona.sensitivities[lever]
          const designMitigation = 1 - design.levers[lever] * 0.72
          const frictionScore = round(
            clamp(touchpoint.baseDifficulty * sensitivity * designMitigation * 62, 0, 100),
          )
          const unintuitive = frictionScore >= painThreshold
          const experience =
            frictionScore >= 60
              ? 'I cannot continue confidently without pausing to reconstruct missing context.'
              : unintuitive
                ? 'I have to slow down and interpret the interface before I can continue.'
                : 'The action remains understandable without a significant interruption.'
          return {
            iteration: design.iteration,
            personaId: persona.id,
            persona: persona.name,
            feature: scenario.feature,
            scenario: scenario.scenario,
            scenarioSource: scenario.source ?? 'migration-bdd',
            scenarioStatus: scenario.status,
            scenarioDurationMs: round(scenario.durationMs),
            journeyId: scenario.journey?.id ?? null,
            entrypoint: scenario.journey?.entrypoint ?? null,
            command: scenario.journey?.command ?? null,
            flags: scenario.journey?.flags ?? [],
            conflicts: scenario.journey?.conflicts ?? [],
            expectedOutcome: scenario.journey?.expectedOutcome ?? null,
            actionIndex: actionIndex + 1,
            action,
            thought: touchpoint.thought,
            experience,
            frictionType: touchpoint.frictionType,
            pain: touchpoint.pain,
            whyPainful: `${touchpoint.why} ${persona.name}'s context increases sensitivity to this touchpoint.`,
            potentialHarm: touchpoint.harm,
            frictionScore,
            unintuitive,
            lever,
            alternativeId:
              DESIGN_ALTERNATIVES.find((alternative) => alternative.lever === lever)?.id ?? '',
          }
        })
      }),
  )
  const frictionScores = traces.map((trace) => trace.frictionScore)
  return {
    design,
    scenarios,
    traces,
    metrics: {
      iteration: design.iteration,
      scenarioCount: scenarios.length,
      migrationScenarioCount: scenarios.filter(
        (scenario) => (scenario.source ?? 'migration-bdd') === 'migration-bdd',
      ).length,
      cliJourneyCount: scenarios.filter((scenario) => scenario.source === 'cli-journey').length,
      actionCount: traces.length,
      meanFriction: round(
        frictionScores.reduce((total, score) => total + score, 0) /
          Math.max(1, frictionScores.length),
      ),
      p95Friction: round(quantile(frictionScores, 0.95)),
      unintuitiveActions: traces.filter((trace) => trace.unintuitive).length,
      highHarmActions: traces.filter((trace) => trace.frictionScore >= 60).length,
      cucumberDurationMs: round(
        scenarios.reduce((total, scenario) => total + scenario.durationMs, 0),
      ),
    },
  }
}

function emptyTracesByLever(): Record<LeverName, ExperienceTrace[]> {
  return {
    statusVisibility: [],
    plainLanguage: [],
    recoveryGuidance: [],
    approvalContext: [],
    adaptiveDetail: [],
    confirmationClosure: [],
    commandDiscoverability: [],
    flagErgonomics: [],
    scopeRepetition: [],
    automationClarity: [],
    credentialSetup: [],
    errorPrevention: [],
  }
}

export function rankLevers(iteration: ExperimentIteration): ReadonlyArray<LeverRanking> {
  const tracesByLever = emptyTracesByLever()
  iteration.traces.forEach((trace) => tracesByLever[trace.lever].push(trace))
  return (Object.keys(iteration.design.levers) as LeverName[])
    .filter((lever) => iteration.design.levers[lever] < 1)
    .map((lever) => {
      const traces = tracesByLever[lever]
      const scores = traces.map((trace) => trace.frictionScore)
      const highHarm = traces.filter((trace) => trace.frictionScore >= 60).length
      const unintuitive = traces.filter((trace) => trace.unintuitive).length
      const mean = scores.reduce((total, score) => total + score, 0) / Math.max(1, scores.length)
      const p95 = quantile(scores, 0.95)
      const remainingGap = 1 - iteration.design.levers[lever]
      return {
        rank: 0,
        lever,
        traceCount: traces.length,
        meanFriction: round(mean),
        p95Friction: round(p95),
        remainingGap: round(remainingGap),
        observedOpportunity: round(
          (highHarm * 1000 + unintuitive * 10 + mean + p95) * remainingGap,
        ),
      }
    })
    .sort(
      (left, right) =>
        right.observedOpportunity - left.observedOpportunity ||
        left.lever.localeCompare(right.lever),
    )
    .map((ranking, index) => ({...ranking, rank: index + 1}))
}

export function optimizeDesign(
  iteration: ExperimentIteration,
  optimizationStep: number,
): {
  readonly design: DesignState
  readonly decision: OptimizationDecision | null
  readonly note: OptimizationNote | null
} {
  const candidate = rankLevers(iteration)[0]
  if (candidate === undefined) {
    return {
      design: {
        iteration: iteration.design.iteration + 1,
        levers: {...iteration.design.levers},
      },
      decision: null,
      note: {
        afterIteration: iteration.design.iteration,
        rationale:
          'All modeled design levers are fully implemented at 1.00; no further modeled optimization was available.',
      },
    }
  }
  const lever = candidate.lever
  const previousValue = iteration.design.levers[lever]
  const nextValue = Math.round(clamp(previousValue + optimizationStep) * 100) / 100
  return {
    design: {
      iteration: iteration.design.iteration + 1,
      levers: {...iteration.design.levers, [lever]: nextValue},
    },
    decision: {
      afterIteration: iteration.design.iteration,
      lever,
      previousValue,
      nextValue,
      observedFriction: candidate.observedOpportunity,
      rationale: `This lever had the largest remaining harm-first, pain-weighted opportunity after iteration ${iteration.design.iteration}.`,
    },
    note: null,
  }
}

export function runPersonaExperiment(config: ExperimentConfig) {
  return Effect.gen(function* () {
    const runner = yield* ScenarioRunnerTag
    const writer = yield* ExperimentArtifactWriterTag
    const iterations: ExperimentIteration[] = []
    const optimizationDecisions: OptimizationDecision[] = []
    const optimizationNotes: OptimizationNote[] = []
    const baseline = EXPERIMENT_BASELINES[config.baseline]
    let design = initialDesign(config.baseline)
    const cliCoverage = buildCliCoverageReport(
      CLI_JOURNEYS,
      PERSONAS.map((persona) => persona.id),
    )
    if (cliCoverage.failures.length > 0) {
      return yield* new ExperimentCoverageFailure({
        message: `CLI journey coverage is incomplete: ${cliCoverage.failures.join('; ')}`,
      })
    }

    for (let index = 0; index < config.iterations; index += 1) {
      const migrationScenarios = yield* runner.run(design.iteration)
      const scenarios: ReadonlyArray<ScenarioObservation> = [
        ...migrationScenarios.map((scenario) => ({
          ...scenario,
          source: scenario.source ?? ('migration-bdd' as const),
        })),
        ...cliJourneyObservations(),
      ]
      const iteration = evaluateIteration(design, PERSONAS, scenarios, config.painThreshold)
      iterations.push(iteration)
      if (index < config.iterations - 1) {
        const optimized = optimizeDesign(iteration, config.optimizationStep)
        if (optimized.decision) {
          optimizationDecisions.push(optimized.decision)
        }
        if (optimized.note) {
          optimizationNotes.push(optimized.note)
        }
        design = optimized.design
      }
    }

    const firstIteration = iterations[0]
    const lastIteration = iterations.at(-1)
    if (!firstIteration || !lastIteration) {
      return yield* new ExperimentConfigurationFailure({
        message: 'Experiment completed without any iterations',
      })
    }
    const initialLeverRanking = rankLevers(firstIteration)
    const finalLeverRanking = rankLevers(lastIteration)
    const completion: ExperimentCompletion = {
      requestedIterations: config.iterations,
      completedIterations: iterations.length,
      converged: finalLeverRanking.length === 0,
      reason:
        finalLeverRanking.length === 0
          ? 'converged-no-candidate'
          : 'iteration-bound-reached-with-candidates',
      remainingCandidateCount: finalLeverRanking.length,
    }
    const result: PersonaExperimentResult = {
      baseline,
      personas: PERSONAS,
      iterations,
      optimizationDecisions,
      optimizationNotes,
      finalDesign: design,
      alternatives: DESIGN_ALTERNATIVES,
      sources: RESEARCH_SOURCES,
      cliCoverage,
      initialLeverRanking,
      finalLeverRanking,
      completion,
    }
    yield* writer.write(result)
    return result
  })
}

function escapeCell(value: string | number | boolean): string {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

export function renderTraceJsonl(result: PersonaExperimentResult): string {
  return result.iterations
    .flatMap((iteration) => iteration.traces)
    .map((trace) =>
      JSON.stringify({
        baselineId: result.baseline.id,
        baselineSource: result.baseline.source,
        designContext: result.baseline.context,
        ...trace,
      }),
    )
    .join('\n')
}

export interface TraceJsonlValidation {
  readonly lineCount: number
  readonly validLineCount: number
  readonly malformedLineCount: number
  readonly failures: ReadonlyArray<string>
}

const TRACE_JSON_KEYS = [
  'action',
  'actionIndex',
  'alternativeId',
  'baselineId',
  'baselineSource',
  'command',
  'conflicts',
  'designContext',
  'entrypoint',
  'expectedOutcome',
  'experience',
  'feature',
  'flags',
  'frictionScore',
  'frictionType',
  'iteration',
  'journeyId',
  'pain',
  'persona',
  'personaId',
  'potentialHarm',
  'scenario',
  'scenarioDurationMs',
  'scenarioSource',
  'scenarioStatus',
  'thought',
  'unintuitive',
  'lever',
  'whyPainful',
] as const

const RenderedTraceLineSchema = Schema.Struct({
  baselineId: ExperimentBaselineIdSchema,
  baselineSource: Schema.String,
  designContext: Schema.String,
  iteration: Schema.Number,
  personaId: Schema.String,
  persona: Schema.String,
  feature: Schema.String,
  scenario: Schema.String,
  scenarioSource: Schema.Literal('migration-bdd', 'cli-journey'),
  scenarioStatus: Schema.String,
  scenarioDurationMs: Schema.Number,
  journeyId: Schema.NullOr(Schema.String),
  entrypoint: Schema.NullOr(Schema.String),
  command: Schema.NullOr(Schema.String),
  flags: Schema.Array(Schema.String),
  conflicts: Schema.Array(Schema.String),
  expectedOutcome: Schema.NullOr(Schema.String),
  actionIndex: Schema.Number,
  action: Schema.String,
  thought: Schema.String,
  experience: Schema.String,
  frictionType: Schema.String,
  pain: Schema.String,
  whyPainful: Schema.String,
  potentialHarm: Schema.String,
  frictionScore: Schema.Number,
  unintuitive: Schema.Boolean,
  lever: LeverNameSchema,
  alternativeId: Schema.String,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateTraceJsonl(jsonl: string): TraceJsonlValidation {
  const lines = jsonl.split(/\r?\n/).filter((line) => line.length > 0)
  const failures = lines.flatMap((line, index) => {
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed)) {
        return [`Line ${index + 1} is not a JSON object`]
      }
      const keys = Object.keys(parsed).sort()
      const expectedKeys = [...TRACE_JSON_KEYS].sort()
      if (
        keys.length !== expectedKeys.length ||
        keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])
      ) {
        return [`Line ${index + 1} does not match the exact trace key set`]
      }
      if (
        Either.isLeft(
          Schema.decodeUnknownEither(RenderedTraceLineSchema, {
            onExcessProperty: 'error',
          })(parsed),
        )
      ) {
        return [`Line ${index + 1} has malformed trace value types`]
      }
      return []
    } catch {
      return [`Line ${index + 1} is not valid JSON`]
    }
  })
  return {
    lineCount: lines.length,
    validLineCount: lines.length - failures.length,
    malformedLineCount: failures.length,
    failures,
  }
}

export function renderExperimentReport(result: PersonaExperimentResult): string {
  const baselineLeverRows = (Object.entries(result.baseline.levers) as [LeverName, number][])
    .map(([lever, value]) => `| ${lever} | ${value.toFixed(2)} |`)
    .join('\n')
  const implementedAlternatives = result.baseline.implementedAlternativeIds.length
    ? result.baseline.implementedAlternativeIds.join(', ')
    : 'None; this is an intentionally incomplete synthetic comparison.'
  const personaRows = result.personas
    .map(
      (persona) =>
        `| ${escapeCell(persona.name)} | ${escapeCell(persona.role)} | ${escapeCell(persona.goal)} | ${escapeCell(persona.context)} | ${escapeCell(persona.accessNeeds)} |`,
    )
    .join('\n')
  const metricRows = result.iterations
    .map(
      ({metrics}) =>
        `| ${metrics.iteration} | ${metrics.migrationScenarioCount} | ${metrics.cliJourneyCount} | ${metrics.actionCount} | ${metrics.meanFriction.toFixed(1)} | ${metrics.p95Friction.toFixed(1)} | ${metrics.unintuitiveActions} | ${metrics.highHarmActions} | ${metrics.cucumberDurationMs.toFixed(0)} ms |`,
    )
    .join('\n')
  const optimizationRows = result.optimizationDecisions
    .map(
      (decision) =>
        `| ${decision.afterIteration} | ${decision.lever} | ${decision.previousValue.toFixed(2)} | ${decision.nextValue.toFixed(2)} | ${decision.observedFriction.toFixed(1)} | ${escapeCell(decision.rationale)} |`,
    )
    .join('\n')
  const optimizationNoteRows = result.optimizationNotes
    .map((note) => `| ${note.afterIteration} | No lever change | ${escapeCell(note.rationale)} |`)
    .join('\n')
  const alternativeRows = result.alternatives
    .map(
      (alternative) =>
        `| ${alternative.lever} | ${escapeCell(alternative.title)} | ${escapeCell(alternative.implementation)} | ${escapeCell(alternative.expectedBenefit)} | ${escapeCell(alternative.evidence.join('; '))} |`,
    )
    .join('\n')
  const painRows = result.iterations
    .flatMap((iteration) => iteration.traces)
    .filter((trace) => trace.unintuitive)
    .map(
      (trace) =>
        `| ${trace.iteration} | ${escapeCell(trace.persona)} | ${trace.scenarioSource} | ${escapeCell(trace.journeyId ?? '-')} | ${escapeCell(trace.scenario)} | ${trace.actionIndex} | ${trace.lever} | ${trace.frictionScore.toFixed(1)} | ${escapeCell(trace.pain)} | ${escapeCell(trace.whyPainful)} | ${escapeCell(trace.potentialHarm)} | ${trace.alternativeId} |`,
    )
    .join('\n')
  const actionRows = result.iterations
    .flatMap((iteration) => iteration.traces)
    .map(
      (trace) =>
        `| ${trace.iteration} | ${escapeCell(trace.persona)} | ${trace.scenarioSource} | ${escapeCell(trace.journeyId ?? '-')} | ${escapeCell(trace.command ?? '-')} | ${escapeCell(trace.flags.join(', ') || '-')} | ${escapeCell(trace.scenario)} | ${trace.actionIndex} | ${trace.lever} | ${escapeCell(trace.action)} | ${escapeCell(trace.thought)} | ${escapeCell(trace.experience)} | ${trace.frictionScore.toFixed(1)} |`,
    )
    .join('\n')
  const sourceRows = result.sources
    .map((source) => `- [${source.label}](${source.url}) - ${source.finding}`)
    .join('\n')
  const commandCoverageRows = result.cliCoverage.commands
    .map(
      (command) =>
        `| ${command.command} | ${command.covered ? 'yes' : 'no'} | ${command.flags.filter((flag) => flag.covered).length}/${command.flags.length} | ${escapeCell(command.representedBy.join(', '))} |`,
    )
    .join('\n')
  const entrypointCoverageRows = result.cliCoverage.entrypoints
    .map(
      (entrypoint) =>
        `| ${entrypoint.id} | ${entrypoint.covered ? 'yes' : 'no'} | ${escapeCell(entrypoint.representedBy.join(', '))} |`,
    )
    .join('\n')
  const conflictCoverageRows = result.cliCoverage.conflicts
    .map(
      (conflict) =>
        `| ${conflict.id} | ${conflict.covered ? 'yes' : 'no'} | ${escapeCell(conflict.representedBy.join(', '))} |`,
    )
    .join('\n')
  const rankingRows = result.initialLeverRanking
    .map(
      (ranking) =>
        `| ${ranking.rank} | ${ranking.lever} | ${ranking.traceCount} | ${ranking.meanFriction.toFixed(1)} | ${ranking.p95Friction.toFixed(1)} | ${ranking.remainingGap.toFixed(1)} | ${ranking.observedOpportunity.toFixed(1)} |`,
    )
    .join('\n')

  return [
    '# Persona-centered migration experience experiment',
    '',
    '> This deterministic simulation generates testable design hypotheses; synthetic personas do not replace research with real migration operators. Validate the highest-impact findings with representative users before changing production behavior.',
    '',
    '## Baseline',
    '',
    `- Identity: \`${result.baseline.id}\` (${result.baseline.label})`,
    `- Source: ${result.baseline.source}`,
    `- Current design context: ${result.baseline.context}`,
    `- Implemented modeled alternatives: ${implementedAlternatives}`,
    '',
    '| Lever | Starting value |',
    '| --- | ---: |',
    baselineLeverRows,
    '',
    '## Personas',
    '',
    '| Persona | Role | Goal | Context | Access needs |',
    '| --- | --- | --- | --- | --- |',
    personaRows,
    '',
    '## CLI journey coverage',
    '',
    `- Commands: ${result.cliCoverage.coveredCommandCount}/${result.cliCoverage.commandCount}`,
    `- Declared flags: ${result.cliCoverage.coveredFlagCount}/${result.cliCoverage.flagCount}`,
    `- Entrypoint behaviors: ${result.cliCoverage.coveredEntrypointCount}/${result.cliCoverage.entrypointCount}`,
    `- Important conflicts: ${result.cliCoverage.coveredConflictCount}/${result.cliCoverage.conflictCount}`,
    `- Personas represented in CLI journeys: ${result.cliCoverage.coveredPersonaCount}/${result.cliCoverage.personaCount}`,
    `- Coverage failures: ${result.cliCoverage.failures.length}`,
    '',
    '| Command | Covered | Flags covered | Persona journeys |',
    '| --- | --- | ---: | --- |',
    commandCoverageRows,
    '',
    '| Entrypoint behavior | Covered | Persona journeys |',
    '| --- | --- | --- |',
    entrypointCoverageRows,
    '',
    '| Prevented conflict | Covered | Persona journeys |',
    '| --- | --- | --- |',
    conflictCoverageRows,
    '',
    '## Iteration measures',
    '',
    `- Requested iterations: ${result.completion.requestedIterations}`,
    `- Completed iterations: ${result.completion.completedIterations}`,
    `- Converged: ${result.completion.converged ? 'yes' : 'no'}`,
    `- Completion reason: \`${result.completion.reason}\``,
    `- Remaining optimization candidates: ${result.completion.remainingCandidateCount}`,
    '',
    '| Iteration | Migration BDD scenarios | CLI journeys | Persona actions | Mean friction | P95 friction | Unintuitive actions | High-harm actions | Suite duration |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    metricRows,
    '',
    'Friction is a 0-100 comparative index combining touchpoint difficulty, persona sensitivity, and design mitigation. A score at or above the configured threshold is logged as unintuitive; 60 or above is treated as a potential high-harm interruption. Cucumber duration is reported separately as harness health data and is not treated as user-facing latency.',
    '',
    '## Lever changes',
    '',
    '| After iteration | Lever | Before | After | Observed friction | Rationale |',
    '| ---: | --- | ---: | ---: | ---: | --- |',
    optimizationRows ||
      '| - | No lever changed | - | - | - | No modeled lever change was available or required |',
    '',
    '## Optimization limits',
    '',
    '| After iteration | Outcome | Rationale |',
    '| ---: | --- | --- |',
    optimizationNoteRows ||
      '| - | None | Every requested transition had a remaining modeled optimization candidate |',
    '',
    '## Initial friction lever ranking',
    '',
    '| Rank | Lever | Traces | Mean friction | P95 friction | Remaining gap | Observed opportunity |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: |',
    rankingRows || '| - | No remaining lever candidates | - | - | - | - | - |',
    '',
    '## Pain and friction inventory',
    '',
    '| Iteration | Persona | Source | Journey | Scenario | Action | Lever | Score | Pain | Why it is painful | Potential harm | Alternative |',
    '| ---: | --- | --- | --- | --- | ---: | --- | ---: | --- | --- | --- | --- |',
    painRows ||
      '| - | - | - | - | - | - | - | - | No action crossed the pain threshold | - | - | - |',
    '',
    '## Alternative implementations',
    '',
    '| Lever | Design | Implementation | Expected benefit | Research basis |',
    '| --- | --- | --- | --- | --- |',
    alternativeRows,
    '',
    '## Complete persona action and thought log',
    '',
    '| Iteration | Persona | Source | Journey | Command | Flags | Scenario | Action | Lever | Rendered step | Persona thought | Experience | Friction |',
    '| ---: | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- | ---: |',
    actionRows,
    '',
    '## Research sources',
    '',
    sourceRows,
    '',
  ].join('\n')
}
