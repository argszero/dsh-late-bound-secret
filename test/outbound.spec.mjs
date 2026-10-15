/**
 * Seam A: the request that leaves for the provider carries the value, and the
 * request the caller assembled does not.
 *
 * Every arm except the control drives a REAL `llm/stream` waterfall, and the
 * probe standing in for the adapter is what is asserted on — so "the value
 * reached the provider" is measured at the point a provider would have read it,
 * not at the plugin's return value.
 *
 * @module test/outbound.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collect, message, request, streamOf, world } from './harness.mjs'

const VALUE = 'tok_live_9f3a2b7c1d'
const REF = '{{secret:GH_TOKEN}}'
const CONFIG = { secrets: { GH_TOKEN: VALUE } }
const REQUEST = () => request({ messages: [message(`deploy with ${REF} now`)] })

/** The text of the first message block of a recorded request. */
function firstText(req) {
  return req.messages[0].content[0].text
}

describe('outbound binding', () => {
  it('control: without the plugin the reference reaches the adapter', async () => {
    const h = await world({ plugin: false })
    await h.stream(REQUEST())
    assert.equal(h.seen.length, 1)
    assert.equal(firstText(h.seen[0]), `deploy with ${REF} now`)
  })

  it('with the plugin the adapter receives the value, not the reference', async () => {
    const h = await world({ config: CONFIG })
    await h.stream(REQUEST())
    assert.equal(h.seen.length, 1)
    assert.equal(firstText(h.seen[0]), `deploy with ${VALUE} now`)
  })

  it('the request the caller assembled is left exactly as it was', async () => {
    const h = await world({ config: CONFIG })
    const original = REQUEST()
    await h.stream(original)
    // The replacement is a different object: the frozen request is never
    // rewritten, which is what makes the caller's copy — and therefore the
    // session log's copy — still hold the reference.
    assert.notEqual(h.seen[0], original)
    assert.equal(firstText(original), `deploy with ${REF} now`)
  })

  it('a request with no reference is handed straight through, by identity', async () => {
    const h = await world({ config: CONFIG })
    const plain = request({ messages: [message('nothing to bind here')] })
    await h.stream(plain)
    assert.equal(h.seen[0], plain)
  })

  it('the re-dispatch does not recurse: the adapter sees one request', async () => {
    const h = await world({ config: CONFIG })
    await h.stream(REQUEST())
    assert.equal(h.seen.length, 1)
  })

  it('two structurally identical requests are both bound', async () => {
    const h = await world({ config: CONFIG })
    await h.stream(REQUEST())
    await h.stream(REQUEST())
    assert.equal(h.seen.length, 2)
    assert.equal(firstText(h.seen[0]), `deploy with ${VALUE} now`)
    assert.equal(firstText(h.seen[1]), `deploy with ${VALUE} now`)
  })

  it('binds the one-shot system string as well as the messages', async () => {
    const h = await world({ config: CONFIG })
    await h.stream(request({ messages: [], system: `you may use ${REF}` }))
    assert.equal(h.seen[0].system, `you may use ${VALUE}`)
  })

  it('leaves an unknown reference exactly as written', async () => {
    const h = await world({ config: CONFIG })
    await h.stream(request({ messages: [message('try {{secret:NOT_DECLARED}} here')] }))
    // Fail closed: an unbound reference is visible in the request, where the
    // model and the provider can both report it, rather than becoming an empty
    // string that hides itself.
    assert.equal(firstText(h.seen[0]), 'try {{secret:NOT_DECLARED}} here')
  })

  it('does nothing at all at mode off', async () => {
    const h = await world({ config: { ...CONFIG, mode: 'off' } })
    await h.stream(REQUEST())
    assert.equal(firstText(h.seen[0]), `deploy with ${REF} now`)
  })

  it('observe counts the bind it would have made and changes nothing', async () => {
    const h = await world({ config: { ...CONFIG, mode: 'observe' } })
    await h.stream(REQUEST())
    assert.equal(firstText(h.seen[0]), `deploy with ${REF} now`)
    const snapshot = h.snapshot()
    assert.equal(snapshot.requestsBound, 1)
    assert.equal(snapshot.blocksBound, 1)
    assert.deepEqual(snapshot.names, ['GH_TOKEN'])
  })

  it('reports what it bound, by name', async () => {
    const h = await world({ config: CONFIG })
    await h.stream(REQUEST())
    assert.equal(h.snapshot().requestsBound, 1)
    assert.equal(h.snapshot().blocksBound, 1)
  })

  it('fails open when the re-dispatch itself throws', async () => {
    const h = await world({ config: CONFIG })
    const llm = h.ctx.get('llm')
    const original = llm.stream
    let threw = false
    llm.stream = () => { threw = true; throw new Error('dispatch unavailable') }
    try {
      await h.stream(REQUEST())
    } finally {
      llm.stream = original
    }
    assert.equal(threw, true)
    // The caller's request went to the adapter unchanged, and the failure is
    // counted rather than swallowed.
    assert.equal(firstText(h.seen[0]), `deploy with ${REF} now`)
    assert.equal(h.snapshot().errors, 1)
  })

  it('binds a reasoning block as well as a text block', async () => {
    const h = await world({ config: CONFIG })
    await h.stream(request({ messages: [{ id: 'm1', role: 'assistant', source: { kind: 'user' }, content: [
      { type: 'reasoning', text: `I need ${REF}` },
      { type: 'text', text: 'done' },
    ] }] }))
    assert.equal(h.seen[0].messages[0].content[0].text, `I need ${VALUE}`)
    assert.equal(h.seen[0].messages[0].content[1].text, 'done')
  })

  it('binds a message whose content is a bare string', async () => {
    const h = await world({ config: CONFIG })
    await h.stream(request({ messages: [{ role: 'user', content: `send ${REF}` }] }))
    assert.equal(h.seen[0].messages[0].content, `send ${VALUE}`)
  })

  it('honours a custom marker word', async () => {
    const h = await world({ config: { ...CONFIG, marker: 'vault' } })
    await h.stream(request({ messages: [message('use {{secret:GH_TOKEN}} and {{vault:GH_TOKEN}}')] }))
    // Only the configured spelling is a reference; the other is ordinary text.
    assert.equal(firstText(h.seen[0]), `use {{secret:GH_TOKEN}} and ${VALUE}`)
  })

  it('binds a layered reference exactly once', async () => {
    // A value that is itself a reference is legal — layered configuration is how
    // an operator composes one — and it is the case that makes the identity mark
    // load-bearing rather than defensive: without it the listener would bind the
    // replacement again, and again.
    const h = await world({ config: { secrets: { OUTER: '{{secret:INNER}}', INNER: 'inner_value_9f3a' } } })
    await h.stream(request({ messages: [message('take {{secret:OUTER}}')] }))
    assert.equal(h.seen.length, 1)
    assert.equal(firstText(h.seen[0]), 'take {{secret:INNER}}')
  })

  it('the chunk stream the consumer receives is the adapter stream', async () => {
    const h = await world({ config: CONFIG })
    const chunks = await collect(h.ctx.waterfall(h.ctx.llm, 'llm/stream', REQUEST(), () => streamOf([])))
    assert.deepEqual(chunks, [{ type: 'finish', reason: { kind: 'stop' } }])
  })
})
