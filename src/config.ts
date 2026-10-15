/**
 * Configuration, normalized once at mount.
 *
 * The knobs are the four questions an operator asks about a plugin that moves a
 * secret between two representations: *where does the value come from*
 * (`secrets`, `refs`), *how does a reference look* (`marker`), *how short may a
 * value be before masking does more harm than good* (`minLength`), and *how much
 * should it do* (`mode`).
 *
 * Deliberately **not** exported as the plugin's `Config`: cordis validates a
 * mounted plugin's `Config` through `Config['~standard'].validate`, and a plain
 * defaults object has no `~standard`. Exporting one is how this repository's
 * plugins have died at mount with `Cannot read properties of undefined (reading
 * 'validate')`; the entry point therefore exports `{ name, inject, apply }` with
 * no `Config` at all, and these defaults arrive through `apply(ctx, config = {})`.
 *
 * @module @argszero/dsh-late-bound-secret/config
 */

/**
 * What the plugin does with the two directions it can rewrite.
 *
 * - `guard` (the default) binds references outbound and rewrites values back to
 *   references inbound.
 * - `observe` counts and reports exactly what `guard` would do, and changes
 *   nothing in either direction. This is how an operator finds out whether their
 *   declared values actually appear in a log before trusting the rewrite with
 *   them.
 * - `off` installs neither listener nor shadow.
 */
export type GuardMode = 'guard' | 'observe' | 'off'

/** The plugin configuration as a user writes it. */
export interface Config {
  /**
   * Secrets declared inline, as a name-to-value map. The value is a secret, so
   * this belongs in a harness-managed profile or an overlay — never in a file
   * the repository tracks.
   */
  readonly secrets?: Readonly<Record<string, string>>
  /**
   * Names to read out of the process environment at mount. Every name is looked
   * up once, here, rather than per request: a value that changed under a running
   * process would make the two directions disagree about what the reference
   * means.
   */
  readonly refs?: readonly string[]
  /** The word between `{{` and `:NAME}}`. Defaults to `secret`. */
  readonly marker?: string
  /** The shortest value that may be bound or masked. Defaults to 8. */
  readonly minLength?: number
  /** Whether the plugin guards, only observes, or is off. */
  readonly mode?: GuardMode
  /** Log one line per rewritten string at `debug`, and the mount summary at `info`. */
  readonly report?: boolean
}

/** The configuration with every default resolved. */
export interface Settings {
  /**
   * Every declared name and value, inline ones first and then the `refs` read
   * out of the environment, in the order the operator wrote them.
   *
   * A list rather than a map on purpose: two declarations of one name are a
   * configuration mistake an operator has to be told about, and a map would
   * silently keep the last one.
   */
  readonly declared: readonly (readonly [string, string])[]
  readonly refs: readonly string[]
  readonly marker: string
  readonly minLength: number
  readonly mode: GuardMode
  readonly report: boolean
}

/** The reference defaults, also the fallbacks used per field. */
export const defaultConfig: Required<Config> = {
  secrets: {},
  refs: [],
  marker: 'secret',
  minLength: 8,
  mode: 'guard',
  report: true,
}

/** Every mode, in the order documentation lists them. */
export const MODES: readonly GuardMode[] = ['guard', 'observe', 'off']

/**
 * Read a boolean, falling back for anything else.
 * @param value - the configured value.
 * @param fallback - the default.
 * @returns the value or the default.
 */
function flag(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Read a bounded non-negative integer, falling back for anything else.
 * @param value - the configured value.
 * @param fallback - the default.
 * @param ceiling - the largest accepted value.
 * @returns the value or the default.
 */
function count(value: number | undefined, fallback: number, ceiling: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? Math.min(value, ceiling)
    : fallback
}

/**
 * Read the marker word.
 *
 * It is interpolated into a regular expression and into the text users type, so
 * it is narrowed to the same character class a reference name uses. An empty or
 * exotic word falls back rather than throwing: a configuration typo must not be
 * the reason a secret ends up unguarded.
 * @param value - the configured marker.
 * @returns the marker word.
 */
function marker(value: string | undefined): string {
  return typeof value === 'string' && /^[a-z][a-z0-9]*$/.test(value) ? value : defaultConfig.marker
}

/**
 * Resolve the configuration.
 *
 * An **unrecognised** `mode` resolves to `observe`, not to `guard`: the failure
 * mode of a typo has to be the one that changes nothing. That rule is about the
 * spelling, not about the absent value, which takes the default.
 * @param config - what the operator wrote.
 * @param env - the environment the `refs` names are read from.
 * @returns the resolved settings.
 */
export function normalizeConfig(config: Config = {}, env: NodeJS.ProcessEnv = process.env): Settings {
  const declared: Array<readonly [string, string]> = Object.entries(config.secrets ?? {})
  for (const ref of config.refs ?? []) {
    if (typeof ref !== 'string') continue
    declared.push([ref, env[ref] ?? ''])
  }
  return {
    declared: Object.freeze(declared),
    refs: Object.freeze((config.refs ?? []).filter(ref => typeof ref === 'string')),
    marker: marker(config.marker),
    minLength: count(config.minLength, defaultConfig.minLength, 4096),
    mode: config.mode !== undefined && MODES.includes(config.mode) ? config.mode
      : config.mode === undefined ? defaultConfig.mode : 'observe',
    report: flag(config.report, defaultConfig.report),
  }
}
