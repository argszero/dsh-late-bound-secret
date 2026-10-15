/**
 * The subscription that shadows every published session's `append`.
 *
 * `session/created` is a cordis runtime signal — not a durable event — and it is
 * how a plugin learns that a session exists; it is announced inside the creation
 * transaction, before any turn can write a row. Shadowing there therefore covers
 * every row of every session from its first one, including a resumed session's
 * inherited history (which is seeded into the log before the announcement and is
 * rewritten by the same `append` when it is adopted).
 *
 * `session/disposed` is the paired teardown, so the shadow and its counter go
 * away with the session rather than accumulating on dead objects.
 *
 * @module @argszero/dsh-late-bound-secret/inbound
 */

import type { Context } from '@deepseek-ai/cordis'
import { shadowAppend } from './durable.ts'
import type { InstallOutcome } from './durable.ts'
import type { SecretBook } from './secrets.ts'

/** How the subscription reports what it did. */
export interface InboundPolicy {
  /** When true, rows are counted and appended unchanged. */
  readonly observe: boolean
  /** Called once per rewritten row, with the names whose values were replaced. */
  readonly onRewrite: (names: readonly string[]) => void
  /** Called once per session, with the install outcome. */
  readonly onInstall: (outcome: InstallOutcome) => void
  /** Called when a row could not be rewritten and was appended unchanged. */
  readonly onFailure: (error: unknown) => void
}

/** The session shape this subscription needs; nothing else about a session is touched. */
interface AppendableSession {
  append?: unknown
}

/**
 * Subscribe to session creation and shadow each session's `append`.
 * @param ctx - the context to register on.
 * @param book - the declared secrets.
 * @param policy - where to report.
 */
export function installDurable(ctx: Context, book: SecretBook, policy: InboundPolicy): void {
  const handles = new Map<object, () => void>()
  ctx.on('session/created', (session: object): void => {
    try {
      const installed = shadowAppend(session as AppendableSession, book, {
        observe: policy.observe,
        onRewrite: record => void policy.onRewrite(record.masked),
        onFailure: policy.onFailure,
      })
      policy.onInstall(installed.outcome)
      if (installed.outcome === 'patched') handles.set(session, installed.restore)
    } catch (error) {
      // Fail open: a session whose `append` could not be shadowed is a session
      // this plugin does not guard, not a session that cannot be created.
      policy.onFailure(error)
    }
  })
  ctx.on('session/disposed', (session: object): void => {
    const restore = handles.get(session)
    if (restore === undefined) return
    handles.delete(session)
    restore()
  })
}
