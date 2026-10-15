/**
 * Seam B: a value on its way into the session log becomes its reference again.
 *
 * The subject is a `StubSession` whose `append` is a **prototype** method — the
 * same prototype-versus-own-property relationship the real class has, which is
 * what the shadow depends on. Everything around it is real: the event bus, the
 * `session/created` dispatch, and the install/read-back/restore path.
 *
 * @module test/durable.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { StubSession, world } from './harness.mjs'

const VALUE = 'tok_live_9f3a2b7c1d'
const REF = '{{secret:GH_TOKEN}}'
const CONFIG = { secrets: { GH_TOKEN: VALUE } }

/** A tool result that echoed the value, as a `curl -v` or a header log would. */
const ECHOED = () => ({ callId: 'c1', content: [{ type: 'text', text: `Authorization: Bearer ${VALUE}` }] })

describe('durable rewriting', () => {
  it('control: without the plugin the value is written verbatim', async () => {
    const h = await world({ plugin: false })
    const session = h.session()
    session.append('tool/result', ECHOED())
    assert.equal(session.rows[0].data.content[0].text, `Authorization: Bearer ${VALUE}`)
  })

  it('with the plugin the row carries the reference', async () => {
    const h = await world({ config: CONFIG })
    const session = h.session()
    session.append('tool/result', ECHOED())
    assert.equal(session.rows[0].data.content[0].text, `Authorization: Bearer ${REF}`)
    assert.equal(h.snapshot().rowsRewritten, 1)
    assert.equal(h.snapshot().valuesMasked, 1)
  })

  it('rewrites a value wherever it sits in the payload', async () => {
    const h = await world({ config: CONFIG })
    const session = h.session()
    session.append('turn/end', {
      turn: 1,
      nested: { list: [VALUE, 'safe', { deep: `x ${VALUE} y` }] },
    })
    const row = session.rows[0].data
    // The container stays the container it was: a walk that handled arrays as
    // plain objects would still answer to `list[0]` through string coercion and
    // would have silently turned the row into an object.
    assert.ok(Array.isArray(row.nested.list))
    assert.equal(row.nested.list.length, 3)
    assert.equal(row.nested.list[0], REF)
    assert.equal(row.nested.list[1], 'safe')
    assert.equal(row.nested.list[2].deep, `x ${REF} y`)
  })

  it('leaves a payload that carries no value by identity', async () => {
    const h = await world({ config: CONFIG })
    const session = h.session()
    const data = { callId: 'c1', content: [{ type: 'text', text: 'nothing secret here' }] }
    session.append('tool/result', data)
    assert.equal(session.rows[0].data, data)
    assert.equal(h.snapshot().rowsRewritten, 0)
  })

  it('observe counts the rewrite it would have made and writes the value', async () => {
    const h = await world({ config: { ...CONFIG, mode: 'observe' } })
    const session = h.session()
    session.append('tool/result', ECHOED())
    assert.equal(session.rows[0].data.content[0].text, `Authorization: Bearer ${VALUE}`)
    assert.equal(h.snapshot().rowsRewritten, 1)
  })

  it('does nothing at all at mode off', async () => {
    const h = await world({ config: { ...CONFIG, mode: 'off' } })
    const session = h.session()
    session.append('tool/result', ECHOED())
    assert.equal(session.rows[0].data.content[0].text, `Authorization: Bearer ${VALUE}`)
    assert.equal(h.snapshot().rowsRewritten, 0)
  })

  it('restores the prototype method when the session is disposed', async () => {
    const h = await world({ config: CONFIG })
    const session = h.session()
    assert.equal(Object.prototype.hasOwnProperty.call(session, 'append'), true)
    h.disposeSession(session)
    assert.equal(Object.prototype.hasOwnProperty.call(session, 'append'), false)
    session.append('tool/result', ECHOED())
    // The shadow is gone, so nothing rewrites any more — and that is the point:
    // a guard that outlived its session would be rewriting a later object's rows.
    assert.equal(session.rows[0].data.content[0].text, `Authorization: Bearer ${VALUE}`)
  })

  it('restores rather than deletes when the session already owned append', async () => {
    const h = await world({ config: CONFIG })
    const session = new StubSession()
    const own = session.append
    session.append = (...args) => own.apply(session, args)
    h.ctx.emit('session/created', session)
    assert.notEqual(session.append, own)
    h.ctx.emit('session/disposed', session)
    assert.equal(typeof session.append, 'function')
    assert.equal(Object.prototype.hasOwnProperty.call(session, 'append'), true)
  })

  it('reports a frozen session as not writable and writes its rows verbatim', async () => {
    const h = await world({ config: CONFIG })
    // Frozen, so the shadow cannot install — and the stub records outside
    // itself, because a frozen object could not record into its own fields.
    const rows = []
    const session = Object.freeze({
      append(type, data) { rows.push({ type, data }) },
    })
    h.ctx.emit('session/created', session)
    session.append('tool/result', ECHOED())
    assert.equal(rows[0].data.content[0].text, `Authorization: Bearer ${VALUE}`)
    assert.equal(h.snapshot().installFailures, 1)
    assert.equal(h.snapshot().sessionsShadowed, 0)
  })

  it('masks a second row after a first one, on the same session', async () => {
    const h = await world({ config: CONFIG })
    const session = h.session()
    session.append('tool/result', ECHOED())
    session.append('tool/result', { callId: 'c2', content: [{ type: 'text', text: VALUE }] })
    assert.equal(session.rows[0].data.content[0].text, `Authorization: Bearer ${REF}`)
    assert.equal(session.rows[1].data.content[0].text, REF)
    assert.equal(h.snapshot().rowsRewritten, 2)
    assert.equal(h.snapshot().valuesMasked, 2)
  })

  it('refuses a value below minLength and says why', async () => {
    const h = await world({ config: { secrets: { PIN: 'ab12' } } })
    const session = h.session()
    session.append('tool/result', { callId: 'c1', content: [{ type: 'text', text: 'pin is ab12' }] })
    assert.equal(session.rows[0].data.content[0].text, 'pin is ab12')
    const snapshot = h.snapshot()
    assert.deepEqual(snapshot.names, [])
    assert.equal(snapshot.rejected.length, 1)
    assert.equal(snapshot.rejected[0].name, 'PIN')
    assert.match(snapshot.rejected[0].reason, /minLength/)
  })

  it('accepts a short value when the operator lowers the floor', async () => {
    const h = await world({ config: { secrets: { PIN: 'ab12' }, minLength: 4 } })
    const session = h.session()
    session.append('tool/result', { callId: 'c1', content: [{ type: 'text', text: 'pin is ab12' }] })
    assert.equal(session.rows[0].data.content[0].text, 'pin is {{secret:PIN}}')
  })

  it('fails open when the payload cannot be walked, and still appends it', async () => {
    const h = await world({ config: CONFIG })
    const session = h.session()
    const hostile = { callId: 'c1', get bad() { throw new Error('hostile accessor') } }
    assert.doesNotThrow(() => session.append('tool/result', hostile))
    assert.equal(session.rows[0].data, hostile)
    assert.equal(h.snapshot().errors, 1)
  })

  it('treats a value as a literal, not as a pattern', async () => {
    // A value is an operator's opaque secret and may contain any character. An
    // unescaped pattern would make `.` match anything and mask text it never saw.
    const url = 'postgres://svc.a1b2:pw@db.internal:5432/app'
    const h = await world({ config: { secrets: { DB_URL: url } } })
    const session = h.session()
    session.append('tool/result', { callId: 'c1', content: [{ type: 'text', text: `connecting to ${url}` }] })
    session.append('tool/result', { callId: 'c2', content: [{ type: 'text', text: 'postgres://svcXa1b2:pw@dbYinternal:5432/app' }] })
    assert.equal(session.rows[0].data.content[0].text, 'connecting to {{secret:DB_URL}}')
    assert.equal(session.rows[1].data.content[0].text, 'postgres://svcXa1b2:pw@dbYinternal:5432/app')
  })

  it('does not let an unescaped value swallow the text it was never meant to match', async () => {
    // A value is opaque. If it is turned into a pattern as-is, its pattern
    // characters match text the operator never declared — and because a match
    // whose text is not exactly a declared value yields no substitution, the
    // scanner moves past the region and the *real* secret inside it is never
    // looked at. That is the leak: one unescaped `.` and a value is skipped.
    const h = await world({ config: { secrets: { OUTER: 'aaaa.SECRET_INNER_9999.bbbb', INNER: 'SECRET_INNER_9999' } } })
    const session = h.session()
    session.append('tool/result', { callId: 'c1', content: [{ type: 'text', text: 'aaaaXSECRET_INNER_9999Ybbbb' }] })
    assert.equal(session.rows[0].data.content[0].text, 'aaaaX{{secret:INNER}}Ybbbb')
  })

  it('rewrites a subtree that is referenced twice at both occurrences', async () => {
    // Not a cycle: the same object appears in two places. A walk that remembered
    // every container it had ever seen would rewrite the first occurrence and
    // hand the original back for the second — a guard that leaks through its own
    // bookkeeping.
    const h = await world({ config: CONFIG })
    const session = h.session()
    const shared = { text: `token ${VALUE}` }
    session.append('tool/result', { callId: 'c1', first: shared, second: shared })
    assert.equal(session.rows[0].data.first.text, `token ${REF}`)
    assert.equal(session.rows[0].data.second.text, `token ${REF}`)
  })

  it('does not hang on a payload that refers to itself', async () => {
    const h = await world({ config: CONFIG })
    const session = h.session()
    const cyclic = { callId: 'c1', content: [{ type: 'text', text: VALUE }] }
    cyclic.self = cyclic
    assert.doesNotThrow(() => session.append('tool/result', cyclic))
    assert.equal(session.rows[0].data.content[0].text, REF)
  })

  it('reports a subject with no append at all', async () => {
    const h = await world({ config: CONFIG })
    h.ctx.emit('session/created', { id: 'no-append' })
    assert.equal(h.snapshot().installFailures, 1)
    assert.equal(h.snapshot().sessionsShadowed, 0)
  })

  it('writes back with the configured marker word', async () => {
    const h = await world({ config: { ...CONFIG, marker: 'vault' } })
    const session = h.session()
    session.append('tool/result', ECHOED())
    assert.equal(session.rows[0].data.content[0].text, 'Authorization: Bearer {{vault:GH_TOKEN}}')
  })

  it('reports an assignment that silently did not take', async () => {
    // A refusal is not always a throw: a proxy that accepts a write and stores it
    // nowhere is exactly the case the read-back exists for, and a guard that
    // believed the assignment would report success while rewriting nothing.
    const h = await world({ config: CONFIG })
    const rows = []
    const target = { append: (type, data) => void rows.push({ type, data }) }
    const session = new Proxy(target, { set: () => true })
    h.ctx.emit('session/created', session)
    session.append('tool/result', ECHOED())
    assert.equal(rows[0].data.content[0].text, `Authorization: Bearer ${VALUE}`)
    assert.equal(h.snapshot().installFailures, 1)
  })

  it('does not clobber a shadow that is no longer its own', async () => {
    const h = await world({ config: CONFIG })
    const session = h.session()
    const foreign = () => {}
    session.append = foreign
    h.disposeSession(session)
    // Unwinding a third party's shadow would be this plugin writing state it does
    // not own.
    assert.equal(session.append, foreign)
  })

  it('a session announced before the mount is simply not covered', async () => {
    const h = await world({ plugin: false })
    const session = h.session()
    await h.mount()
    session.append('tool/result', ECHOED())
    // Nothing retroactive is claimed: the shadow was installed when the mount
    // happened, and a session that existed before it is not rewritten.
    assert.equal(session.rows[0].data.content[0].text, `Authorization: Bearer ${VALUE}`)
    assert.equal(h.snapshot().sessionsShadowed, 0)
  })
})
