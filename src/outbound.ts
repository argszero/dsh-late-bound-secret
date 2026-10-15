/**
 * The listener that binds references on the outbound request.
 *
 * ## Why it re-dispatches
 *
 * A loop-built request arrives deep frozen — the waterfall's contract is that its
 * content is a pure function of the session log, so listeners read it and never
 * rewrite it — and the waterfall's `next` takes no argument. The only way to give
 * the adapter a different request is to ask the runtime for a stream of that
 * request:
 *
 * ```ts
 * // packages/llm/llm/src/index.ts
 * stream(options) { return this.streamWithRegistration(options) }
 * ```
 *
 * The re-dispatch re-enters this same waterfall, so this listener is called again
 * with the replacement. Identity is what stops the recursion: every request this
 * plugin builds is recorded in a `WeakSet`, and an already-recorded request is
 * passed to `next()` untouched.
 *
 * ## The cost, stated
 *
 * Re-dispatching means dispatch preparation runs twice for a request that carried
 * a reference. That is the price of a frozen request and an argument-less `next`
 * and it is paid only on requests that actually contain one: a request with no
 * reference is handed straight to `next()` and never leaves the ordinary path.
 *
 * @module @argszero/dsh-late-bound-secret/outbound
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { rebind } from './request.ts'
import type { SecretBook } from './secrets.ts'

/** How the listener reports what it did. */
export interface OutboundPolicy {
  /** When true, the request is counted and dispatched unchanged. */
  readonly observe: boolean
  /** Called once per request that carried at least one reference. */
  readonly onBind: (blocks: number, names: readonly string[]) => void
  /** Called when binding failed and the original request was dispatched. */
  readonly onFailure: (error: unknown) => void
}

/**
 * Install the outbound listener on an `llm/stream` waterfall.
 *
 * `global` because the stream is dispatched with the registry instance as the
 * listener's `this`, so a mount scoped to a profile must still cover it; `prepend`
 * so this is the first listener to see the request, which is what keeps another
 * listener from forwarding a request that still holds a reference.
 * @param ctx - the context to register on.
 * @param book - the declared secrets.
 * @param policy - where to report.
 */
export function installOutbound(ctx: Context, book: SecretBook, policy: OutboundPolicy): void {
  const dispatched = new WeakSet<object>()
  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> => {
    try {
      if (dispatched.has(options)) return next()
      const report = rebind(options, book)
      const replacement = report.options
      if (replacement === undefined) return next()
      if (policy.observe) {
        policy.onBind(report.blocks, report.bound)
        return next()
      }
      dispatched.add(replacement)
      policy.onBind(report.blocks, report.bound)
      return ctx.llm.stream(replacement)
    } catch (error) {
      // Fail open, and say so: a request that cannot be bound is dispatched
      // exactly as the caller assembled it. A guard that dropped a working model
      // call would be a worse failure than the one it prevents.
      policy.onFailure(error)
      return next()
    }
  }, { global: true, prepend: true })
}
