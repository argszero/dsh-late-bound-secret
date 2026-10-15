/**
 * The book of declared secrets, and the two single-pass rewrites that read it.
 *
 * A *reference* is the text `{{secret:NAME}}`; a *value* is what NAME stands for.
 * The plugin's whole contract is that exactly one of the two is present at any
 * moment, and which one depends on nothing but the direction of travel:
 *
 * - **outbound** (a request leaving for a model provider) the value must be
 *   there, because the model is what has to use it;
 * - **inbound** (a row being written into the session log) the reference must be
 *   there, because the log outlives the turn and cannot be recalled.
 *
 * Both directions are one pass over the string. That is the property that makes
 * the pair safe to compose: `String.prototype.replace` with a global regular
 * expression never re-scans the text it inserted, so a value that happens to
 * contain the marker's own letters (`secret`) cannot be rewritten by the pass
 * that just wrote it, and a reference that happens to contain a value cannot be
 * bound twice.
 *
 * ## Why the length floor exists
 *
 * A masking pass that replaces every occurrence of a declared value will shred
 * ordinary output if a value is short: a 3-character secret makes half the log
 * unreadable and hides nothing worth hiding. `minLength` (8 by default) is the
 * operator's floor, and a value below it is **not** registered at all — it is
 * reported by name at mount and then ignored in both directions, which is loud
 * and inspectable rather than quietly half-applied.
 *
 * @module @argszero/dsh-late-bound-secret/secrets
 */

/** One declared secret, after validation. */
export interface SecretEntry {
  /** The reference name, as it appears between `{{secret:` and `}}`. */
  readonly name: string
  /** The value the name stands for. Never logged, never returned by `describe()`. */
  readonly value: string
}

/** The outcome of binding references to values in one string. */
export interface BindReport {
  /** The rewritten string. */
  readonly text: string
  /** The names that were actually bound, in order of appearance. */
  readonly bound: readonly string[]
}

/** The outcome of rewriting values back to references in one string. */
export interface UnbindReport {
  /** The rewritten string. */
  readonly text: string
  /** The names whose values were actually replaced, in order of appearance. */
  readonly masked: readonly string[]
}

/** Whether a raw string can name a reference; POSIX-shaped, matching the harness's own credential refs. */
export const REF_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A name that was declared but is not usable, and why. */
export interface RejectedSecret {
  /** The name as declared. */
  readonly name: string
  /** A sentence an operator can act on. */
  readonly reason: string
}

/**
 * The declared secrets, in the two indexes the rewrites need.
 *
 * Constructed once at mount; `entries` is a frozen copy so a caller that later
 * mutates the configuration object it passed cannot change what is being bound
 * mid-flight.
 */
export class SecretBook {
  readonly #entries: readonly SecretEntry[]

  readonly #values: readonly SecretEntry[]

  readonly #markerPrefix: string

  readonly #bindPattern: RegExp

  readonly #unbindPattern: RegExp | undefined

  /**
   * @param entries - the usable secrets, already validated.
   * @param markerPrefix - the word between `{{` and `:NAME}}`.
   */
  constructor(entries: readonly SecretEntry[], markerPrefix: string) {
    this.#entries = Object.freeze([...entries])
    // Longest value first: an alternation matches at the earliest position, and
    // among two alternatives that start at the same position the first one in
    // the pattern wins. Sorting by descending length makes that the *longer*
    // value, so a value that is a prefix of another can never shadow it.
    this.#values = Object.freeze(
      [...entries].sort((left, right) => right.value.length - left.value.length
        || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
    )
    this.#markerPrefix = markerPrefix
    this.#bindPattern = new RegExp(`\\{\\{${markerPrefix}:([A-Za-z_][A-Za-z0-9_]*)\\}\\}`, 'g')
    this.#unbindPattern = this.#values.length === 0
      ? undefined
      : new RegExp(this.#values.map(entry => escapeRegExp(entry.value)).join('|'), 'g')
  }

  /** How many secrets are usable. */
  get size(): number {
    return this.#entries.length
  }

  /** The reference text for a name — what a caller writes where the value should go. */
  marker(name: string): string {
    return `{{${this.#markerPrefix}:${name}}}`
  }

  /** The usable secrets, values included. Never written to a log. */
  get entries(): readonly SecretEntry[] {
    return this.#entries
  }

  /**
   * Replace every known reference in `text` with its value.
   *
   * An unknown reference is left exactly as written. This is the fail-closed
   * direction of the pair: a typo in a name produces a request the provider
   * will refuse or the model will report, and never a silently empty value —
   * which is the failure mode that would hide itself.
   * @param text - the text to bind.
   * @returns the rewritten text and the names bound.
   */
  bind(text: string): BindReport {
    if (text.length === 0 || text.indexOf('{{') < 0) return { text, bound: [] }
    const byName = new Map(this.#entries.map(entry => [entry.name, entry.value]))
    const bound: string[] = []
    const rewritten = text.replace(this.#bindPattern, (match, name: string) => {
      const value = byName.get(name)
      if (value === undefined) return match
      bound.push(name)
      return value
    })
    return { text: rewritten, bound }
  }

  /**
   * Replace every occurrence of a value in `text` with its reference.
   *
   * This is what runs on the way into the session log. Unmatched text passes
   * through untouched, and the pass is a single `replace`, so nothing it writes
   * can be rewritten by it.
   * @param text - the text to rewrite.
   * @returns the rewritten text and the names whose values were replaced.
   */
  unbind(text: string): UnbindReport {
    const pattern = this.#unbindPattern
    if (pattern === undefined || text.length === 0) return { text, masked: [] }
    // Rebuilt per call: a global regex carries `lastIndex` across calls and this
    // one is shared by every caller on this book.
    pattern.lastIndex = 0
    const masked: string[] = []
    const rewritten = text.replace(pattern, match => {
      const entry = this.#values.find(candidate => candidate.value === match)
      if (entry === undefined) return match
      masked.push(entry.name)
      return this.marker(entry.name)
    })
    return { text: rewritten, masked }
  }
}

/**
 * Sort the declared names into what can be used and what cannot.
 *
 * A value shorter than `minLength` is rejected rather than clamped: masking with
 * it would damage more text than it protects, and binding it would put a secret
 * one substring match away from every unrelated string in the log.
 * @param declared - the raw name/value pairs an operator declared.
 * @param minLength - the shortest value the operator is willing to mask.
 * @returns the usable entries and the rejections, both in declaration order.
 */
export function selectSecrets(
  declared: Iterable<readonly [string, string]>,
  minLength: number,
): { entries: SecretEntry[]; rejected: RejectedSecret[] } {
  const entries: SecretEntry[] = []
  const rejected: RejectedSecret[] = []
  const seen = new Set<string>()
  for (const [rawName, rawValue] of declared) {
    const name = typeof rawName === 'string' ? rawName.trim() : ''
    const value = typeof rawValue === 'string' ? rawValue : ''
    if (!REF_NAME_PATTERN.test(name)) {
      rejected.push({ name: rawName, reason: 'a reference name must match /^[A-Za-z_][A-Za-z0-9_]*$/' })
      continue
    }
    if (seen.has(name)) {
      rejected.push({ name, reason: 'declared twice' })
      continue
    }
    if (value.length === 0) {
      rejected.push({ name, reason: 'has an empty value, so there is nothing to bind' })
      continue
    }
    if (value.length < minLength) {
      rejected.push({
        name,
        reason: `value is ${value.length} characters, below the configured minLength of ${minLength}; `
          + 'a short value would mask unrelated text instead of protecting this one',
      })
      continue
    }
    seen.add(name)
    entries.push({ name, value })
  }
  return { entries, rejected }
}

/** Quote a string so it can stand as a literal alternative in a regular expression. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
