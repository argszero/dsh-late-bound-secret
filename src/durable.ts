/**
 * Seam B: rewriting values back to references on their way into the session log.
 *
 * ## The seam
 *
 * `Session.append` is the single acceptance boundary of the durable log — every
 * row, whatever produced it, passes through it:
 *
 * ```ts
 * // packages/core/session/src/index.ts
 * append(type, data, ...opts) {
 *   const dataSnapshot = snapshotJsonValue(data)
 *   ...
 *   this.commit(event, entry)
 * }
 * ```
 *
 * A plugin cannot wrap that function, but it can shadow it on the instance:
 * `append` is a prototype method, and an own-property assignment in front of it
 * intercepts every call made through the object — including the loop's. The
 * install is confirmed by reading the property back, because a refusal to write
 * is not always a throw: assigning to a frozen object in sloppy mode silently
 * does nothing, and a guard that believed it had installed would be a guard that
 * rewrites nothing while reporting success.
 *
 * That pattern is not invented here; it is the one this task's own
 * `@argszero/dsh-cancel-cause-guard` ships for the same reason, on the same
 * method.
 *
 * ## Why both directions are needed
 *
 * Seam A keeps the log clean for text the *request* carried. It cannot keep it
 * clean for text that arrives from somewhere else: a tool whose output echoes
 * the value (a `curl -v`, a header log, a stack trace with a connection string)
 * is an ordinary `tool/result` event, and the value in it would become durable.
 * Rewriting at `append` is what covers that, and it covers it for every row type
 * at once rather than for the tool rows one had thought of.
 *
 * ## The boundary this seam cannot cross
 *
 * The rewrite is **synchronous** — `append` is — and it is deliberately so: any
 * promise in front of a durable write would reorder the log. The book it reads is
 * therefore the one resolved at mount, not a value fetched from a credentials
 * service per call. A secret rotated while a process is running is a secret this
 * plugin binds the old value of until the process restarts, and it says so in
 * `snapshot()`.
 *
 * @module @argszero/dsh-late-bound-secret/durable
 */

import type { SecretBook } from './secrets.ts'

/** What one row rewrite did. */
export interface DurableReport {
  /** The replacement data, or undefined when the row carried no value. */
  readonly data: unknown
  /** The names whose values were replaced, in order of appearance. */
  readonly masked: readonly string[]
}

/**
 * Rewrite every declared value in one event payload back to its reference.
 *
 * The walk is JSON-shaped on purpose: `append` is the point at which the payload
 * is required to be losslessly JSON-serializable, so a payload that is not is
 * about to be rejected anyway. What JSON does not forbid is a payload that
 * **refers to itself**, and the walk carries the path it is on so that a cycle
 * ends rather than recursing until the stack runs out.
 *
 * The set is the *path*, not a record of everything ever seen: a value added on
 * the way down is removed on the way up. Keeping every visited container instead
 * would return the **original** object the second time a payload referenced the
 * same subtree, and that copy still holds the secret — a leak that looks like a
 * working guard. A reference cycle is cut because the ancestor is on the path; a
 * subtree merely referenced twice is walked twice, and rewritten both times.
 *
 * A container that needed no change is returned **by identity**, so the common
 * row (nothing to mask) allocates only its own path down and nothing else.
 * @param data - the payload the caller passed to `append`.
 * @param book - the declared secrets.
 * @returns the replacement payload, or undefined when nothing changed.
 */
export function rewriteRow(data: unknown, book: SecretBook): DurableReport {
  const names: string[] = []
  let changed = false
  const walk = (value: unknown, path: WeakSet<object>): unknown => {
    if (typeof value === 'string') {
      const report = book.unbind(value)
      if (report.text === value) return value
      changed = true
      names.push(...report.masked)
      return report.text
    }
    if (value === null || typeof value !== 'object') return value
    if (path.has(value)) return value
    path.add(value)
    try {
      if (Array.isArray(value)) {
        let touched = false
        const next = value.map((item: unknown) => {
          const rewritten = walk(item, path)
          if (rewritten !== item) touched = true
          return rewritten
        })
        return touched ? next : value
      }
      let touched = false
      const next: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const rewritten = walk(item, path)
        if (rewritten !== item) touched = true
        next[key] = rewritten
      }
      return touched ? next : value
    } finally {
      // The way up: a container that is merely referenced twice is still walked
      // twice, and only an ancestor still on the path cuts the recursion.
      path.delete(value)
    }
  }
  const rewritten = walk(data, new WeakSet())
  return changed ? { data: rewritten, masked: names } : { data: undefined, masked: [] }
}

/** The outcome of trying to shadow one session's `append`. */
export type InstallOutcome = 'patched' | 'not-writable' | 'already-patched'

/** The handle an installed shadow returns. */
export interface Installed {
  /** What happened. */
  readonly outcome: InstallOutcome
  /** Undo the shadow, if this call installed it and it is still ours. */
  restore(): void
}

/** The marker an installed wrapper carries, so a second install can recognise one. */
const SHADOW_MARK = Symbol.for('@argszero/dsh-late-bound-secret/shadow')

/** One call the shadow decided to rewrite, for the report. */
export interface RewriteRecord {
  /** The event type being appended. */
  readonly type: unknown
  /** The names whose values were replaced. */
  readonly masked: readonly string[]
}

/** How the shadow reports what it did, and what it refused to do. */
export interface ShadowPolicy {
  /** Whether the two directions are applied or only counted. */
  readonly observe: boolean
  /** Called once per rewritten row. */
  readonly onRewrite: (record: RewriteRecord) => void
  /** Called when the shadow failed and the row was forwarded unchanged. */
  readonly onFailure: (error: unknown) => void
}

/**
 * Shadow one session's `append`.
 *
 * Mirrors the install/read-back/restore discipline of this task's published
 * `@argszero/dsh-cancel-cause-guard`: the assignment is attempted, the property
 * is read back to confirm it took, and `restore` only unwinds a shadow that is
 * still ours — a later guard, or the session itself, may have replaced it, and
 * undoing that would be this plugin writing a third party's state.
 * @param session - the session to shadow.
 * @param book - the declared secrets.
 * @param policy - whether to apply or only count, and where to report.
 * @returns the install outcome and the restore handle.
 */
export function shadowAppend(session: object, book: SecretBook, policy: ShadowPolicy): Installed {
  const holder = session as { append?: unknown }
  const original = holder.append
  if (typeof original !== 'function') return { outcome: 'not-writable', restore: () => {} }
  const hadOwn = Object.prototype.hasOwnProperty.call(session, 'append')
  if ((original as unknown as Record<symbol, unknown>)[SHADOW_MARK] === true) {
    return { outcome: 'already-patched', restore: () => {} }
  }

  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    let forwarded = args
    try {
      const rewritten = rewriteRow(args[1], book)
      if (rewritten.data !== undefined) {
        policy.onRewrite({ type: args[0], masked: rewritten.masked })
        if (!policy.observe) {
          forwarded = args.slice()
          forwarded[1] = rewritten.data
        }
      }
    } catch (error) {
      // Fail open, and say so: the row is forwarded exactly as the caller wrote
      // it. A guard whose bug dropped a write would lose history the harness
      // would have kept.
      policy.onFailure(error)
      forwarded = args
    }
    return Reflect.apply(original as (...rest: unknown[]) => unknown, this, forwarded)
  } as ((...args: unknown[]) => unknown) & Record<symbol, unknown>
  wrapper[SHADOW_MARK] = true

  try {
    holder.append = wrapper
  } catch {
    // A sealed session, or an `append` defined without a setter.
    return { outcome: 'not-writable', restore: () => {} }
  }
  // A refusal to write is not always a throw — a frozen object in sloppy mode
  // would simply ignore it — so the install is confirmed by reading it back.
  if (holder.append !== wrapper) return { outcome: 'not-writable', restore: () => {} }

  let installed = true
  return {
    outcome: 'patched',
    restore: (): void => {
      if (!installed) return
      installed = false
      if (holder.append !== wrapper) return
      if (hadOwn) holder.append = original
      else delete holder.append
    },
  }
}
