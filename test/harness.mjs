/**
 * The integration harness: a REAL cordis context, the REAL `LlmRuntime`, and the
 * REAL `llm/stream` waterfall.
 *
 * Nothing about the outbound seam is simulated. The plugin listens on
 * `llm/stream`, and this harness dispatches **that** waterfall — `ctx.waterfall(ctx.llm,
 * 'llm/stream', options, () => source)` — with the registry instance as the
 * listener `this`, exactly as `LlmRuntime.streamWithRegistration` does:
 *
 * ```ts
 * // packages/llm/llm/src/index.ts
 * stream(options) { return this.streamWithRegistration(options) }
 * streamWithRegistration(options) { return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options)) }
 * ```
 *
 * So what is measured is Cordis' own dispatch — the same listener list, the same
 * `prepend` placement, the same `next()` composition, the same `global` filter
 * bypass — plus the plugin's own re-dispatch through `ctx.llm.stream()`, which is
 * the real public entry point and therefore re-enters the real waterfall.
 *
 * ## The adapter double, and why it sits where it does
 *
 * `llm/stream`'s `next` is the adapter. This harness registers a **probe**
 * listener that records the request it is handed and returns a fabricated chunk
 * stream *without* calling `next()` — the adapter's job, done by the test. Because
 * the plugin registers with `prepend: true`, the probe never sees a request that
 * still carries a reference: the plugin re-dispatches before calling `next`, so
 * the request the probe records is the one an adapter would have received. That is
 * the assertion, and it is made on real dispatch rather than on the plugin's
 * return value.
 *
 * ## Seam B's subject
 *
 * `Session` is not constructed here. Building a real one needs a persistence
 * backend, and what the plugin does with it is exactly one thing: it shadows the
 * `append` own-property slot of whatever object `session/created` announces. A
 * `StubSession` with a **prototype** `append` is therefore the faithful subject
 * for that mechanism — same prototype-vs-own-property relationship the real class
 * has — and it is labelled as a stand-in wherever it is reported. Everything
 * around it is real: the real event bus, the real `ctx.on('session/created')`
 * dispatch, the real install/read-back/restore path.
 *
 * @module test/harness
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'

/** A stream of chunks, as the adapter would have yielded them. */
export async function* streamOf(chunks) {
  for (const chunk of chunks) yield chunk
}

/** Drain an async iterable into an array. */
export async function collect(iterable) {
  const out = []
  for await (const value of iterable) out.push(value)
  return out
}

/** One finished chunk, the smallest thing a consumer needs to end a stream. */
export const FINISH = { type: 'finish', reason: { kind: 'stop' } }

/**
 * A session stand-in whose `append` is a **prototype** method, like the real one.
 *
 * It records the arguments it was called with, so a test can read what actually
 * reached the durable boundary rather than what the plugin says it rewrote.
 */
export class StubSession {
  /** Every `(type, data)` pair that reached `append`, in call order. */
  rows = []

  /** The sequence number the next row would be given. */
  seq = 0

  /**
   * The acceptance boundary, as a prototype method.
   * @param type - the event type.
   * @param data - the payload.
   * @returns the event that was accepted.
   */
  append(type, data) {
    this.rows.push({ type, data })
    return { type, seq: this.seq++, time: 0, data }
  }
}

/** A message with one text block, as a request carries them. */
export function message(text, role = 'user') {
  return {
    id: `m${text.length}`,
    role,
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

/** A minimal request: the plugin reads messages and the system string, nothing else. */
export function request(options = {}) {
  return {
    provider: options.provider ?? 'target',
    model: options.model ?? 'model-1',
    messages: options.messages ?? [],
    ...options.system === undefined ? {} : { system: options.system },
  }
}

/**
 * Mount a real context with the real LLM registry, a probe standing in for the
 * adapter, and this plugin.
 *
 * `plugin: false` mounts everything except the plugin — the control arm, which is
 * what turns "the request carried the value" into "the plugin put it there".
 * @param spec - `plugin` (false, 'default' or undefined), `config`.
 * @returns the context, the captured log, and the handles a spec drives it with.
 */
export async function world(spec = {}) {
  const ctx = new Context({})
  const logged = []
  ctx.logger.exporter({ levels: { default: 3 }, export: message => { logged.push(message) } })
  await ctx.plugin(LlmRuntime)

  const harness = {
    ctx,
    logged,
    /** Every request the probe was handed, oldest first. */
    seen: [],
    /** Sessions announced through `session/created`. */
    sessions: [],
    fork: undefined,
    /**
     * Dispatch the real `llm/stream` waterfall and drain what the consumer
     * receives. The probe terminates the chain, so no adapter is needed.
     * @param options - the request.
     * @returns the chunks the consumer saw.
     */
    async stream(options) {
      return collect(ctx.waterfall(ctx.llm, 'llm/stream', options, () => streamOf([FINISH])))
    },
    /**
     * Announce a session and hand back the object the plugin shadowed.
     * @returns the session stand-in.
     */
    session() {
      const session = new StubSession()
      harness.sessions.push(session)
      ctx.emit('session/created', session)
      return session
    },
    /** Retire an announced session. */
    disposeSession(session) {
      ctx.emit('session/disposed', session)
    },
    /** The plugin's own read-only view, or undefined when it did not provide one. */
    snapshot() {
      const service = ctx.get('lateBoundSecret')
      return service?.snapshot()
    },
    async mount() {
      harness.fork = await ctx.plugin(spec.plugin === 'default' ? plugin.default : plugin, spec.config ?? {})
      return harness
    },
    async dispose() {
      await harness.fork?.dispose()
      harness.fork = undefined
    },
  }

  // The probe is the adapter. It records and terminates — it never calls `next`,
  // because there is nothing behind it to call.
  ctx.on('llm/stream', options => {
    harness.seen.push(options)
    return streamOf([FINISH])
  })

  if (spec.plugin !== false) await harness.mount()
  return harness
}
