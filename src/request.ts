/**
 * Seam A: binding references to values on the outbound model request.
 *
 * ## Why this seam re-dispatches instead of rewriting
 *
 * A loop-built request arrives at `llm/stream` **deep frozen** — the waterfall's
 * own documentation is that its content is a pure function of the session log, so
 * listeners read it and never rewrite it. A listener therefore cannot mutate the
 * request it is handed, and the waterfall's `next` takes no argument: the only
 * way to hand the adapter a *different* request is to ask the runtime for a
 * stream of that request, which is `ctx.llm.stream(replacement)`:
 *
 * ```ts
 * // packages/llm/llm/src/index.ts
 * stream(options) { return this.streamWithRegistration(options) }
 * streamWithRegistration(options) { return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options)) }
 * ```
 *
 * The re-dispatch re-enters the same waterfall, so this listener is called again
 * with the replacement. Identity is what stops that from recursing: every object
 * this module builds is recorded, and a request already recorded is passed
 * through to `next()` untouched. A `WeakSet` rather than a flag, because two
 * concurrent streams of the same session must not be able to mistake one
 * another's object for their own.
 *
 * ## What is bound, and what is not
 *
 * Only text that a provider reads: `text` and `reasoning` blocks of the request
 * messages, and the one-shot `system` string. Nothing else in `GenerateOptions`
 * can carry a reference — `tools`, `toolHistory` and the routing fields are
 * declarations and identifiers, not prose.
 *
 * @module @argszero/dsh-late-bound-secret/request
 */

import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { SecretBook } from './secrets.ts'

/** What one request rewrite did. */
export interface RequestReport {
  /** The replacement request, or undefined when the original needed nothing. */
  readonly options: GenerateOptions | undefined
  /** The names bound, in order of first appearance. */
  readonly bound: readonly string[]
  /** How many message blocks were rewritten. */
  readonly blocks: number
}

/** Whether a value is one of the two content blocks whose text a provider reads. */
function isTextBearing(block: ContentBlock): block is Extract<ContentBlock, { text: string }> {
  return block.type === 'text' || block.type === 'reasoning'
}

/**
 * Bind every known reference in one request, returning a replacement rather than
 * mutating.
 *
 * A message, block or request that needs no change is returned **by identity**,
 * so the replacement shares everything it legitimately can with the original.
 * When nothing at all changed the whole rewrite is `undefined`, which is what
 * keeps an ordinary request off the re-dispatch path entirely.
 * @param options - the request the waterfall handed in.
 * @param book - the declared secrets.
 * @returns what changed, if anything.
 */
export function rebind(options: GenerateOptions, book: SecretBook): RequestReport {
  const bound: string[] = []
  let blocks = 0
  let changed = false

  const messages = options.messages.map((message: RequestMessage): RequestMessage => {
    const content: unknown = message.content
    if (typeof content === 'string') {
      const report = book.bind(content)
      if (report.text === content) return message
      changed = true
      bound.push(...report.bound)
      return { ...message, content: report.text } as unknown as RequestMessage
    }
    if (!Array.isArray(content)) return message
    let touched = false
    const rewritten = (content as readonly ContentBlock[]).map((block: ContentBlock): ContentBlock => {
      if (!isTextBearing(block)) return block
      const report = book.bind(block.text)
      if (report.text === block.text) return block
      touched = true
      blocks += 1
      bound.push(...report.bound)
      return { ...block, text: report.text }
    })
    if (!touched) return message
    changed = true
    return { ...message, content: rewritten } as RequestMessage
  })

  let system = options.system
  let systemChanged = false
  if (typeof system === 'string') {
    const report = book.bind(system)
    if (report.text !== system) {
      changed = true
      systemChanged = true
      bound.push(...report.bound)
      system = report.text
    }
  }

  if (!changed) return { options: undefined, bound: [], blocks: 0 }
  const replacement: GenerateOptions = systemChanged && typeof system === 'string'
    ? { ...options, messages, system }
    : { ...options, messages }
  return { options: replacement, bound, blocks }
}
