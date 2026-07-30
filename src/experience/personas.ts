export type PersonaLever =
  | 'statusVisibility'
  | 'plainLanguage'
  | 'recoveryGuidance'
  | 'approvalContext'
  | 'adaptiveDetail'
  | 'confirmationClosure'
  | 'commandDiscoverability'
  | 'flagErgonomics'
  | 'scopeRepetition'
  | 'automationClarity'
  | 'credentialSetup'
  | 'errorPrevention'

export interface PersonaDefinition {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly goal: string
  readonly context: string
  readonly accessNeeds: string
  readonly sensitivities: Readonly<Record<PersonaLever, number>>
}

export const PERSONA_DEFINITIONS = [
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
  {
    id: 'advanced-agentic-tui-operator',
    name: 'Avery',
    role: 'Staff platform engineer operating migrations from advanced agentic terminals',
    goal: 'Track concurrent migration state at a glance without losing flow or terminal context.',
    context:
      'Avery uses Claude Code CLI and Grok Build daily and expects dense, animated terminal interfaces to remain stable during live updates and resize.',
    accessNeeds:
      'Needs responsive information hierarchy, restrained motion, jitter-free redraw, elapsed progress, explicit shortcuts, and a predictable plain-output escape hatch.',
    sensitivities: {
      statusVisibility: 1.65,
      plainLanguage: 0.9,
      recoveryGuidance: 1.35,
      approvalContext: 1.2,
      adaptiveDetail: 1.6,
      confirmationClosure: 1.25,
      commandDiscoverability: 1.2,
      flagErgonomics: 1.4,
      scopeRepetition: 1.3,
      automationClarity: 1.35,
      credentialSetup: 0.95,
      errorPrevention: 1.4,
    },
  },
  {
    id: 'enterprise-tui-designer',
    name: 'Priya',
    role: 'Enterprise product designer reviewing terminal operations experiences',
    goal: 'Ensure dense operational state remains calm, legible, trustworthy, and responsive.',
    context:
      'Priya evaluates terminal workflows alongside Claude Code CLI and Grok Build patterns, testing wide, standard, narrow, reduced-motion, failure, and blocked states.',
    accessNeeds:
      'Needs clear hierarchy, semantic color with textual redundancy, consistent spacing, bounded animation, responsive density, and evidence from real rendered frames.',
    sensitivities: {
      statusVisibility: 1.5,
      plainLanguage: 1.2,
      recoveryGuidance: 1.25,
      approvalContext: 1.45,
      adaptiveDetail: 1.7,
      confirmationClosure: 1.4,
      commandDiscoverability: 1.25,
      flagErgonomics: 1.3,
      scopeRepetition: 1.05,
      automationClarity: 1.0,
      credentialSetup: 0.9,
      errorPrevention: 1.4,
    },
  },
  {
    id: 'cli-contributor-engineer',
    name: 'Theo',
    role: 'Contributor engineer building, testing, and debugging the CLI itself',
    goal: 'Go from a fresh clone to a passing local change with fast, honest feedback before pushing.',
    context:
      'Theo contributes source, test, and tooling changes to this repository rather than running migrations against a live Azure DevOps or GitHub tenant, and iterates through install, build, lint, type-check, test, and git-hook feedback many times per session.',
    accessNeeds:
      'Needs a short, obvious install-to-first-change path; a discoverable command surface across dozens of pnpm scripts; enforced (not silently skipped) git hooks; consolidated, non-conflicting tooling configuration; and clear architecture and debugging documentation.',
    // Sensitivities are reasoned from measured repository evidence (30 root pnpm scripts and
    // enforced lefthook git hooks at authoring time), not arbitrary numbers. One line of rationale
    // per lever:
    sensitivities: {
      // Needs clear pass/fail state across build, lint, type-check, and test steps rather than
      // inferring health from silence.
      statusVisibility: 1.3,
      // Comfortable with technical terms, but expects tool errors in plain English rather than raw
      // stack traces from oclif/vitest internals.
      plainLanguage: 1.05,
      // Needs the next concrete command after a failed script, hook, or test, not just a failure
      // notice.
      recoveryGuidance: 1.3,
      // Rarely performs destructive migration writes personally, so approval-flow sensitivity is
      // lower than the operator personas.
      approvalContext: 0.85,
      // Needs compact default output during iteration with optional verbose/stack-trace detail on
      // demand, not mandatory verbosity.
      adaptiveDetail: 1.2,
      // A merged pull request or a green local gate is the closure moment, not a migration receipt.
      confirmationClosure: 1.0,
      // Highest lever alongside errorPrevention: 30 root pnpm scripts make finding the
      // right dev command the single largest measured friction point without a grouped reference.
      commandDiscoverability: 1.6,
      // Cares about ergonomic dev-facing flags (--sandbox, --list-sandbox-scenarios, --no-tui) as
      // much as migration flags.
      flagErgonomics: 1.35,
      // Re-runs the same validation loop (format, lint, type-check, test) many times per session;
      // repetition cost compounds quickly during iteration.
      scopeRepetition: 1.5,
      // Needs CI and git-hook feedback to be enforced and legible, not silently skipped. Lefthook
      // is now pinned and installed so pre-commit and pre-push actually run.
      automationClarity: 1.45,
      // Needs a fast, Varlock-validated local `.env.local` setup for sandbox and test runs without
      // real credentials.
      credentialSetup: 1.15,
      // Tied for highest: catching mistakes locally via enforced hooks and fast feedback before push
      // is this persona's core value.
      errorPrevention: 1.55,
    },
  },
] as const satisfies ReadonlyArray<PersonaDefinition>
