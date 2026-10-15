/**
 * The mount surface: what a loader entry finds, and what an operator may read
 * back.
 *
 * @module test/mount.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { world } from './harness.mjs'
import * as plugin from '../lib/index.js'

const VALUE = 'tok_live_9f3a2b7c1d'
const CONFIG = { secrets: { GH_TOKEN: VALUE } }

describe('mount surface', () => {
  it('the default export is what a loader entry mounts', () => {
    assert.equal(typeof plugin.default, 'object')
    assert.equal(plugin.default.name, 'late-bound-secret')
    assert.deepEqual(plugin.default.inject, ['llm'])
    assert.equal(typeof plugin.default.apply, 'function')
  })

  it('exports no Config, which is what keeps the mount from dying', () => {
    // cordis validates a mounted plugin's `Config` through
    // `Config['~standard'].validate`; a plain defaults object has no `~standard`
    // and every mount of a package exporting one dies before `apply` runs. The
    // convention is a real schema or no `Config` at all.
    assert.equal(plugin.Config, undefined)
    assert.equal(plugin.default.Config, undefined)
  })

  it('mounts through the default export, as the loader does', async () => {
    const h = await world({ plugin: 'default', config: CONFIG })
    assert.equal(h.snapshot().mode, 'guard')
    assert.deepEqual(h.snapshot().names, ['GH_TOKEN'])
  })

  it('provides nothing when it is not mounted', async () => {
    const h = await world({ plugin: false })
    assert.equal(h.snapshot(), undefined)
  })

  it('never reports a value, only names', async () => {
    const h = await world({ config: CONFIG })
    const snapshot = h.snapshot()
    assert.deepEqual(snapshot.names, ['GH_TOKEN'])
    assert.equal(JSON.stringify(snapshot).includes(VALUE), false)
  })

  it('states its blind spots on every read', async () => {
    const h = await world({ config: CONFIG })
    const snapshot = h.snapshot()
    assert.ok(snapshot.blindSpots.length >= 4)
    assert.ok(snapshot.blindSpots.some(line => line.includes('Tool execution')))
  })

  it('reads a value out of the environment, not the name', async () => {
    process.env.LATE_BOUND_TEST_REF = VALUE
    try {
      const h = await world({ config: { refs: ['LATE_BOUND_TEST_REF'] } })
      assert.deepEqual(h.snapshot().names, ['LATE_BOUND_TEST_REF'])
      const session = h.session()
      session.append('tool/result', { callId: 'c1', content: [{ type: 'text', text: `using ${VALUE}` }] })
      assert.equal(session.rows[0].data.content[0].text, 'using {{secret:LATE_BOUND_TEST_REF}}')
    } finally {
      delete process.env.LATE_BOUND_TEST_REF
    }
  })

  it('resolves an unrecognised mode to observe, not to guard', async () => {
    const h = await world({ config: { ...CONFIG, mode: 'gurd' } })
    assert.equal(h.snapshot().mode, 'observe')
  })

  it('falls back for a marker that could not be interpolated safely', async () => {
    const h = await world({ config: { ...CONFIG, marker: 'not a word!' } })
    assert.equal(h.snapshot().marker, 'secret')
  })

  it('rejects a name that is not a reference name', async () => {
    const h = await world({ config: { secrets: { 'bad-name': VALUE } } })
    assert.deepEqual(h.snapshot().names, [])
    assert.equal(h.snapshot().rejected.length, 1)
    assert.match(h.snapshot().rejected[0].reason, /A-Za-z_/)
  })

  it('rejects an empty value', async () => {
    const h = await world({ config: { secrets: { GH_TOKEN: '' } } })
    assert.equal(h.snapshot().rejected.length, 1)
    assert.match(h.snapshot().rejected[0].reason, /empty value/)
  })

  it('rejects a name declared twice', async () => {
    const h = await world({ config: {} })
    // `Object.entries` cannot express a duplicate, so the duplicate arrives the
    // way a real profile produces one: the same name inline and in `refs`.
    const h2 = await world({ config: { secrets: { GH_TOKEN: VALUE }, refs: ['GH_TOKEN'] } })
    const snapshot = h2.snapshot()
    assert.deepEqual(snapshot.names, ['GH_TOKEN'])
    assert.equal(snapshot.rejected.length, 1)
    assert.equal(snapshot.rejected[0].reason, 'declared twice')
    assert.equal(h.snapshot().names.length, 0)
  })

  it('mounts with no configuration at all', async () => {
    const h = await world({})
    const snapshot = h.snapshot()
    assert.equal(snapshot.mode, 'guard')
    assert.deepEqual(snapshot.names, [])
    assert.equal(snapshot.rejected.length, 0)
  })

  it('reports the mount in the log', async () => {
    const h = await world({ config: CONFIG })
    // The exporter hands over a structured record whose `args` carry the line.
    const lines = h.logged.flatMap(message => Array.isArray(message?.args) ? message.args.map(String) : [String(message)])
    assert.ok(lines.some(line => line.includes('late-bound-secret: mounted in guard mode')))
  })

  it('names a rejected secret in the log, so an operator hears about it', async () => {
    const h = await world({ config: { secrets: { PIN: 'ab12' } } })
    const lines = h.logged.flatMap(message => Array.isArray(message?.args) ? message.args.map(String) : [String(message)])
    assert.ok(lines.some(line => line.includes('PIN') && line.includes('minLength')))
  })
})
