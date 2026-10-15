/**
 * One rule stated twice: a declared secret's **value** exists on the outbound
 * path and nowhere else.
 *
 * ## The gap
 *
 * A session needs a credential (an API token, a password, a connection string).
 * Today there are two ways to get one into a command, and neither is safe:
 *
 * - **paste the value into the message** — the value becomes durable. It enters
 *   the session log, the model context and anything that reads the log, and a
 *   durable row cannot be recalled afterwards;
 * - **keep it in a `.env` in the project directory** — a new leak surface: one
 *   `git add` away from the repository, one sync away from a backup service.
 *
 * The result in practice is "either unsafe, or not used at all".
 *
 * ## What this plugin does about it
 *
 * It splits the value from the text that names it. The operator declares secrets;
 * the text that travels — a message, a command line, a tool argument — carries
 * only the reference `{{secret:NAME}}`. The plugin then rewrites in exactly two
 * places, in opposite directions:
 *
 * | direction | seam | what it does |
 * |---|---|---|
 * | outbound | the `llm/stream` waterfall | binds `{{secret:NAME}}` to the value, so the model receives something it can use |
 * | inbound | a shadowed `Session.append` | rewrites the value back to `{{secret:NAME}}`, so the durable log never holds it |
 *
 * Both halves are needed. Binding alone leaves the value reaching durability
 * through every path the request seam does not own — a tool whose output echoes
 * it, a `curl -v`, a header log. Masking alone leaves the model with a reference
 * it cannot use. Together the invariant is testable and is what the suite
 * asserts: **after a full turn, the value appears in the outbound request and in
 * no durable row.**
 *
 * ## What it does not claim
 *
 * - The **live UI still renders what the model emits in the moment** — a value
 *   the model echoes on screen is on screen. Only the durable copy is rewritten.
 * - The **tool-execution face is not covered**: this plugin binds at the model
 *   request, so a tool that runs the bound value still runs it. Binding at
 *   subprocess launch instead would be a different plugin.
 * - A secret **rotated while a process is running** is bound at its old value
 *   until restart: the rewrite in front of a durable write is synchronous, so the
 *   book is the one resolved at mount. `snapshot()` says so on every read.
 *
 * Every one of those is reported by `snapshot()` rather than left for an operator
 * to discover.
 *
 * @module @argszero/dsh-late-bound-secret
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import { defaultConfig, normalizeConfig } from './config.ts'
import type { Config, GuardMode, Settings } from './config.ts'
import { installOutbound } from './outbound.ts'
import { installDurable } from './inbound.ts'
import { SecretBook, selectSecrets } from './secrets.ts'
import type { RejectedSecret, SecretEntry } from './secrets.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'late-bound-secret'

/**
 * The service this plugin is about.
 *
 * Both seams need it: the outbound one re-dispatches through `ctx.llm.stream`,
 * and a composition with no models has no request for this plugin to bind.
 */
export const inject = ['llm']

/** The name under which the read-only view is provided. */
export const SERVICE = 'lateBoundSecret'

/** What an operator may read back, and what the plugin will not do. */
export interface Snapshot {
  /** The resolved mode. */
  readonly mode: GuardMode
  /** The marker word in use. */
  readonly marker: string
  /** The declared reference names — **names only, never values**. */
  readonly names: readonly string[]
  /** The declared names that could not be used, and why. */
  readonly rejected: readonly RejectedSecret[]
  /** The shortest value the operator allowed to be bound or masked. */
  readonly minLength: number
  /** Requests whose references were bound before dispatch. */
  readonly requestsBound: number
  /** Message blocks rewritten across those requests. */
  readonly blocksBound: number
  /** Durable rows whose values were rewritten back to references. */
  readonly rowsRewritten: number
  /** Values replaced across those rows. */
  readonly valuesMasked: number
  /** Sessions whose `append` this plugin currently shadows. */
  readonly sessionsShadowed: number
  /** Sessions whose `append` refused the shadow. */
  readonly installFailures: number
  /** Internal failures that were failed open. */
  readonly errors: number
  /** The properties this plugin does not have, stated where an operator will read them. */
  readonly blindSpots: readonly string[]
}

/** The read-only view this plugin provides. */
export interface LateBoundSecretService {
  /** A point-in-time copy of the counters and the declared names. */
  snapshot(): Snapshot
}

/** The properties this plugin is honest about not having. */
export const BLIND_SPOTS: readonly string[] = [
  'The live UI still renders whatever the model emits in the moment; only the durable copy of a value is rewritten.',
  'Tool execution is not covered: a tool that receives a bound value runs it.',
  'A secret rotated while the process runs is bound at its mount-time value until restart, because the rewrite in front of a durable write is synchronous.',
  'A reference typed inside a system-prompt section template is consumed by the harness\'s own strict `{{name}}` interpolator first, which rejects a colon; keep references in messages, commands and tool arguments.',
]

/** The mutable state behind the read-only view. */
interface Counters {
  requestsBound: number
  blocksBound: number
  rowsRewritten: number
  valuesMasked: number
  sessionsShadowed: number
  installFailures: number
  errors: number
}

/**
 * Mount the plugin.
 *
 * `apply` is where a loader entry lands, and the configuration reaches it as the
 * second argument — never through an exported `Config`, which cordis would try to
 * validate through a `~standard` key a plain defaults object does not have.
 * @param ctx - the context this plugin is mounted on.
 * @param config - what the operator wrote.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings: Settings = normalizeConfig(config)
  const { entries, rejected } = selectSecrets(settings.declared, settings.minLength)
  const book = new SecretBook(entries, settings.marker)
  const counters: Counters = {
    requestsBound: 0,
    blocksBound: 0,
    rowsRewritten: 0,
    valuesMasked: 0,
    sessionsShadowed: 0,
    installFailures: 0,
    errors: 0,
  }

  const say = (level: 'info' | 'debug' | 'warn', message: string): void => {
    if (!settings.report) return
    if (level === 'warn') ctx.logger.warn(`late-bound-secret: ${message}`)
    else if (level === 'info') ctx.logger.info(`late-bound-secret: ${message}`)
    else ctx.logger.debug(`late-bound-secret: ${message}`)
  }

  const snapshot = (): Snapshot => ({
    mode: settings.mode,
    marker: settings.marker,
    names: entries.map((entry: SecretEntry) => entry.name),
    rejected,
    minLength: settings.minLength,
    ...counters,
    blindSpots: BLIND_SPOTS,
  })

  const service: LateBoundSecretService = { snapshot }

  if (settings.mode === 'off') {
    say('info', 'mode is off: neither listener nor shadow is installed')
    ctx.provide(SERVICE, service)
    return
  }

  const observe = settings.mode === 'observe'
  if (rejected.length > 0) {
    say('warn', `${rejected.length} declared secret(s) cannot be used: `
      + rejected.map(entry => `${entry.name} (${entry.reason})`).join('; '))
  }

  installOutbound(ctx, book, {
    observe,
    onBind: (bound: number, names: readonly string[]) => {
      counters.requestsBound += 1
      counters.blocksBound += bound
      say('debug', `bound ${names.length} reference(s) in ${bound} block(s) for one request: ${names.join(', ')}`)
    },
    onFailure: (error: unknown) => {
      counters.errors += 1
      say('warn', `failed to bind one request and dispatched it unchanged: ${String(error)}`)
    },
  })

  installDurable(ctx, book, {
    observe,
    onRewrite: (names: readonly string[]) => {
      counters.rowsRewritten += 1
      counters.valuesMasked += names.length
      say('debug', `rewrote ${names.length} value occurrence(s) in one durable row: ${names.join(', ')}`)
    },
    onInstall: (outcome: string) => {
      if (outcome === 'patched') counters.sessionsShadowed += 1
      else counters.installFailures += 1
    },
    onFailure: (error: unknown) => {
      counters.errors += 1
      say('warn', `failed to rewrite one durable row and appended it unchanged: ${String(error)}`)
    },
  })

  say('info', `mounted in ${settings.mode} mode with ${book.size} secret(s) `
    + `(outbound: llm/stream; inbound: Session.append)`)
  ctx.provide(SERVICE, service)
}

export type { Config, GuardMode, Settings } from './config.ts'
export { defaultConfig, MODES, normalizeConfig } from './config.ts'
export { SecretBook, REF_NAME_PATTERN, escapeRegExp, selectSecrets } from './secrets.ts'
export type { BindReport, RejectedSecret, SecretEntry, UnbindReport } from './secrets.ts'
export { rebind } from './request.ts'
export type { RequestReport } from './request.ts'
export { rewriteRow, shadowAppend } from './durable.ts'
export type { DurableReport, InstallOutcome, Installed } from './durable.ts'

/**
 * The object a loader entry mounts: the loader normalises a plugin module with
 * `exports.default ?? exports` and hands this to `ctx.plugin`.
 *
 * Deliberately no `Config` key — see the note in `config.ts`: a plain defaults
 * object has no `~standard` and every mount of a package that exports one as
 * `Config` dies before `apply` runs.
 */
export default { name, inject, apply }
