/**
 * The one rule the plugin exists to keep, stated once end to end.
 *
 * Everything else in the suite measures a seam; this measures the invariant the
 * two seams are there to produce, over a whole turn: a request leaves carrying
 * the value, and after that turn no durable row holds it.
 *
 * @module test/invariant.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SecretBook } from '../lib/index.js'
import { message, request, world } from './harness.mjs'

const VALUE = 'tok_live_9f3a2b7c1d'
const REF = '{{secret:GH_TOKEN}}'
const CONFIG = { secrets: { GH_TOKEN: VALUE } }

/** Every string anywhere inside a value, for a search that cannot miss a leaf. */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) strings(item, out)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) strings(item, out)
  return out
}

describe('the invariant, over one turn', () => {
  it('the value reaches the adapter and no durable row holds it', async () => {
    const h = await world({ config: CONFIG })
    const session = h.session()

    // 1. The turn's request carries a reference, as the operator wrote it.
    const turn = request({ messages: [message(`deploy with ${REF} now`)] })
    assert.equal(turn.messages[0].content[0].text, `deploy with ${REF} now`)

    // 2. What the provider's adapter receives carries the value.
    await h.stream(turn)
    assert.equal(h.seen[0].messages[0].content[0].text, `deploy with ${VALUE} now`)

    // 3. The rows the turn writes are the durable record, and none of them may
    //    hold it — including a tool result that echoed it back.
    session.append('user/message', { content: [{ type: 'text', text: turn.messages[0].content[0].text }] })
    session.append('tool/result', { callId: 'c1', content: [{ type: 'text', text: `HTTP 401 for token ${VALUE}` }] })
    session.append('assistant/message', { content: [{ type: 'text', text: `I used ${VALUE} as you asked` }] })

    for (const row of session.rows) {
      const found = strings(row.data).filter(text => text.includes(VALUE))
      assert.deepEqual(found, [], `a durable row of type ${row.type} holds the value`)
    }
    assert.equal(session.rows[1].data.content[0].text, 'HTTP 401 for token {{secret:GH_TOKEN}}')
    assert.equal(h.snapshot().valuesMasked, 2)
  })

  it('the unrepaired turn is what the rows would have held', async () => {
    // The control arm is the same turn with no plugin, and it is what turns "the
    // rows are clean" into "the plugin cleaned them".
    const h = await world({ plugin: false })
    const session = h.session()
    session.append('tool/result', { callId: 'c1', content: [{ type: 'text', text: `HTTP 401 for token ${VALUE}` }] })
    const echoed = strings(session.rows[0].data).filter(text => text.includes(VALUE))
    assert.equal(echoed.length, 1)
  })

  it('the replays of both directions compose in one pass each', async () => {
    // Giving the book a value that contains the marker word is the case a
    // two-pass implementation gets wrong: the pass that writes `{{secret:X}}`
    // must not then rewrite its own output.
    const book2 = new SecretBook([{ name: 'WORD', value: 'the word secret in a longer value' }], 'secret')
    assert.equal(book2.bind('x {{secret:WORD}} y').text, 'x the word secret in a longer value y')
    assert.equal(book2.unbind('x the word secret in a longer value y').text, 'x {{secret:WORD}} y')
    assert.equal(book2.bind(book2.unbind('v the word secret in a longer value w').text).text,
      'v the word secret in a longer value w')
  })

  it('the longest value wins when one is a prefix of another', async () => {
    const h = await world({ config: { secrets: { SHORT: 'abcdefgh', LONG: 'abcdefghijkl' } } })
    const session = h.session()
    session.append('x', { text: 'abcdefghijkl' })
    assert.equal(session.rows[0].data.text, '{{secret:LONG}}')
    assert.deepEqual([...h.snapshot().names].sort(), ['LONG', 'SHORT'])
  })

  it('a request with nothing to bind still reaches the adapter, unchanged', async () => {
    const h = await world({ config: CONFIG })
    const plain = request({ messages: [message('no reference here')] })
    await h.stream(plain)
    // The probe is the adapter and it terminates the chain, so what comes back is
    // its own stream — appended to by nothing, because there was nothing to bind.
    assert.equal(h.seen.length, 1)
    assert.equal(h.seen[0], plain)
    assert.deepEqual(h.snapshot().requestsBound, 0)
  })
})
