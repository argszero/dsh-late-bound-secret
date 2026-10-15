/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is
 * SILENT — it proves nothing about the suite, and it is reported as a failure of
 * this harness rather than hidden.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm **emits** first: a
 * mutation that is never compiled is a mutation the suite cannot see, and a
 * mutation that does not compile is reported as TYPEFAIL, because it never
 * reached the suite either.
 *
 * Every arm below removes one distinction the plugin states in prose to its
 * users, so a SILENT arm is a promise the package makes that nothing checks.
 *
 * The arms this package would be *worthless* without are:
 *
 * - the **single-pass rewrite**, in both directions — the pass that writes
 *   `{{secret:NAME}}` must not then rewrite its own output, and the pass that
 *   writes a value must not be rewritten by itself either. A two-pass
 *   implementation gets this wrong exactly when a value contains the marker word,
 *   which is a real secret in a real deployment.
 * - **longest value first** — an alternation matches the earliest position and,
 *   among alternatives starting there, the first in the pattern. Sorting
 *   ascending makes a value that is a prefix of another shadow the longer one,
 *   which leaks the tail of the longer secret into the log.
 * - the **escaping of a value before it becomes a pattern** — a value is an
 *   operator's opaque string; unescaped, a `.` in a connection string matches any
 *   character and the guard masks text it never saw.
 * - the **length floor** — a short value shreds ordinary output instead of
 *   protecting anything, so the floor has to be a real refusal.
 * - the **read-back after the install** — a refusal to shadow is not always a
 *   throw, and a guard that believed it had installed would report success while
 *   rewriting nothing.
 * - the **identity guard on the re-dispatch** — the waterfall's `next` takes no
 *   argument, so binding means re-entering the waterfall; without the mark, that
 *   recursion never terminates.
 * - **fail-open in both directions** — a guard whose bug breaks a working model
 *   call, or drops a durable row, is worse than the failure it prevents.
 *
 * ```sh
 * node scripts/inject-defects.mjs                    # every arm
 * node scripts/inject-defects.mjs --filter=longest   # arms whose name matches
 * ```
 *
 * @module scripts/inject-defects
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc')

/** Each arm names the one distinction it removes, and the file it lives in. */
const MUTATIONS = [
  {
    // An unknown reference bound to nothing hides itself: the model receives an
    // empty string where a credential should be, and nothing says why.
    name: 'bind: an unknown reference is replaced with an empty string',
    file: 'src/secrets.ts',
    edits: [['      if (value === undefined) return match', "      if (value === undefined) return ''"]],
  },
  {
    // The pass writes the value and then keeps going over text it just wrote.
    name: 'bind: the pass re-enters the text it wrote',
    file: 'src/secrets.ts',
    edits: [['    return { text: rewritten, bound }', '    return { text: this.bind(rewritten).text, bound }']],
  },
  {
    // Longest-first is what stops a value that is a prefix of another from
    // shadowing it, and the tail of the longer secret then stays in the log.
    name: 'unbind: values are tried shortest first',
    file: 'src/secrets.ts',
    edits: [['      [...entries].sort((left, right) => right.value.length - left.value.length',
      '      [...entries].sort((left, right) => left.value.length - right.value.length']],
  },
  {
    // An unescaped value is a pattern: `.` matches anything and the guard masks
    // text it never saw.
    name: 'unbind: a value is used as a pattern without escaping',
    file: 'src/secrets.ts',
    edits: [['      : new RegExp(this.#values.map(entry => escapeRegExp(entry.value)).join(\'|\'), \'g\')',
      "      : new RegExp(this.#values.map(entry => entry.value).join('|'), 'g')"]],
  },
  {
    // The floor has to be a refusal, not a preference.
    name: 'select: a value below minLength is accepted anyway',
    file: 'src/secrets.ts',
    edits: [['    if (value.length < minLength) {', '    if (false) {']],
  },
  {
    // An empty value becomes an empty alternative in the pattern, which matches
    // at every position.
    name: 'select: an empty value is accepted',
    file: 'src/secrets.ts',
    edits: [['    if (value.length === 0) {', '    if (false) {']],
  },
  {
    // A name outside the grammar cannot be typed as a reference, so accepting it
    // registers a secret nothing can ever name.
    name: 'select: a name outside the reference grammar is accepted',
    file: 'src/secrets.ts',
    edits: [['    if (!REF_NAME_PATTERN.test(name)) {', '    if (false) {']],
  },
  {
    // Two declarations of one name must be reported, not silently resolved.
    name: 'select: a duplicate name is accepted',
    file: 'src/secrets.ts',
    edits: [['    if (seen.has(name)) {', '    if (false) {']],
  },
  {
    // A hardcoded marker ignores the operator's own spelling.
    name: 'book: the marker word is hardcoded',
    file: 'src/secrets.ts',
    edits: [['    return `{{${this.#markerPrefix}:${name}}}`', "    return `{{secret:${name}}}`"]],
  },
  {
    // A reasoning block is provider-visible text like any other.
    name: 'request: a reasoning block is not bound',
    file: 'src/request.ts',
    edits: [["  return block.type === 'text' || block.type === 'reasoning'", "  return block.type === 'text'"]],
  },
  {
    // A user input may carry its content as a bare string.
    name: 'request: a bare-string message content is not bound',
    file: 'src/request.ts',
    edits: [["    if (typeof content === 'string') {", "    if (typeof content === 'string' && content.length < 0) {"]],
  },
  {
    // A block rewrite that does not mark the request as changed is a rewrite the
    // caller never dispatches.
    name: 'request: a rewritten block does not mark the request changed',
    file: 'src/request.ts',
    edits: [['    if (!touched) return message\n    changed = true', '    if (!touched) return message']],
  },
  {
    // The one-shot system string is provider-visible text too.
    name: 'request: the system string is not bound',
    file: 'src/request.ts',
    edits: [["  if (typeof system === 'string') {", "  if (typeof system === 'string' && system.length < 0) {"]],
  },
  {
    // Handing over a replacement for a request that needed none is what the
    // identity passthrough exists to prevent.
    name: 'request: a replacement is built even when nothing changed',
    file: 'src/request.ts',
    edits: [["  if (!changed) return { options: undefined, bound: [], blocks: 0 }", '  if (false) return { options: undefined, bound: [], blocks: 0 }']],
  },
  {
    // Re-entering the waterfall with no mark on the replacement is an unbounded
    // recursion.
    name: 'outbound: the identity guard is not consulted',
    file: 'src/outbound.ts',
    edits: [['      if (dispatched.has(options)) return next()', '      if (false) return next()']],
  },
  {
    // …and marking nothing is the same defect from the other side.
    name: 'outbound: the replacement is not marked',
    file: 'src/outbound.ts',
    edits: [['      dispatched.add(replacement)', '      dispatched.has(replacement)']],
  },
  {
    // Position is what keeps another listener from forwarding a request that
    // still holds a reference.
    name: 'outbound: the listener is not prepended',
    file: 'src/outbound.ts',
    edits: [['  }, { global: true, prepend: true })', '  }, { global: true, prepend: false })']],
  },
  {
    // `observe` is the only way to measure before trusting the rewrite.
    name: 'outbound: observe binds the request anyway',
    file: 'src/outbound.ts',
    edits: [['      if (policy.observe) {', '      if (false) {']],
  },
  {
    // A guard whose bug breaks a working model call is worse than the failure it
    // prevents.
    name: 'outbound: a failed bind is rethrown instead of failing open',
    file: 'src/outbound.ts',
    edits: [['      policy.onFailure(error)\n      return next()', '      policy.onFailure(error)\n      throw error']],
  },
  {
    // Array members are where a list payload keeps its text.
    name: 'durable: array members are not walked',
    file: 'src/durable.ts',
    edits: [['      if (Array.isArray(value)) {', '      if (Array.isArray(value) && value.length > 1e9) {']],
  },
  {
    // A payload that refers to itself must not be followed forever.
    name: 'durable: a cycle is not detected',
    file: 'src/durable.ts',
    edits: [['    if (path.has(value)) return value', '    if (false) return value']],
  },
  {
    // Returning a fresh container for a payload that needed nothing breaks the
    // identity the caller relies on.
    name: 'durable: a changed array member is recorded as unchanged',
    file: 'src/durable.ts',
    edits: [['          if (rewritten !== item) touched = true', '          if (rewritten === item) touched = true']],
  },
  {
    // …and the same defect one level up.
    name: 'durable: a rewrite is reported for a payload that changed nothing',
    file: 'src/durable.ts',
    edits: [['  return changed ? { data: rewritten, masked: names } : { data: undefined, masked: [] }',
      '  return { data: rewritten, masked: names }']],
  },
  {
    // `observe` must decide without acting.
    name: 'durable: observe rewrites the row anyway',
    file: 'src/durable.ts',
    edits: [['        if (!policy.observe) {', '        if (true) {']],
  },
  {
    // Fail-open, or a guard's bug drops a durable row the harness would have kept.
    name: 'durable: a failed rewrite is rethrown into the caller',
    file: 'src/durable.ts',
    edits: [['      policy.onFailure(error)\n      forwarded = args', '      policy.onFailure(error)\n      throw error']],
  },
  {
    // A refusal to shadow is not always a throw; believing the assignment is how
    // a guard reports success while rewriting nothing.
    name: 'install: the read-back after the assignment is skipped',
    file: 'src/durable.ts',
    edits: [["  if (holder.append !== wrapper) return { outcome: 'not-writable', restore: () => {} }", '  if (false) return { outcome: \'not-writable\', restore: () => {} }']],
  },
  {
    // A subject with nothing to shadow must not be reported as guarded.
    name: 'install: a subject with no append is reported as patched',
    file: 'src/durable.ts',
    edits: [["  if (typeof original !== 'function') return { outcome: 'not-writable', restore: () => {} }", '  if (false) return { outcome: \'not-writable\', restore: () => {} }']],
  },
  {
    // Unwinding must delete a shadow it added, not leave one behind.
    name: 'install: the shadow is left on the session after the restore',
    file: 'src/durable.ts',
    edits: [['      else delete holder.append', '      else holder.append = original']],
  },
  {
    // …and must not clobber a shadow that is no longer its own.
    name: 'install: a third party\'s shadow is clobbered by the restore',
    file: 'src/durable.ts',
    edits: [['      if (holder.append !== wrapper) return', '      if (false) return']],
  },
  {
    // The counted names are the whole evidence an operator has.
    name: 'inbound: the masked names are dropped from the report',
    file: 'src/inbound.ts',
    edits: [['        onRewrite: record => void policy.onRewrite(record.masked),', '        onRewrite: () => void policy.onRewrite([]),']],
  },
  {
    // A shadow that outlives its session is a shadow rewriting a later object.
    name: 'inbound: the shadow is never restored on disposal',
    file: 'src/inbound.ts',
    edits: [["      if (installed.outcome === 'patched') handles.set(session, installed.restore)", '      if (false) handles.set(session, installed.restore)']],
  },
  {
    // A configuration typo must not silently turn the rewrite on.
    name: 'config: an unrecognised mode resolves to guard instead of observe',
    file: 'src/config.ts',
    edits: [["      : config.mode === undefined ? defaultConfig.mode : 'observe',", '      : defaultConfig.mode,']],
  },
  {
    // The marker is interpolated into a pattern and into typed text.
    name: 'config: the marker word is accepted whatever it is',
    file: 'src/config.ts',
    edits: [["  return typeof value === 'string' && /^[a-z][a-z0-9]*$/.test(value) ? value : defaultConfig.marker",
      "  return typeof value === 'string' && value.length > 0 ? value : defaultConfig.marker"]],
  },
  {
    // A `refs` name is read once, at mount, from the environment.
    name: 'config: a ref is read as its own name rather than from the environment',
    file: 'src/config.ts',
    edits: [["    declared.push([ref, env[ref] ?? ''])", '    declared.push([ref, ref])']],
  },
  {
    // The floor reaches the selector; a hardcoded zero is a floor nobody set.
    name: 'plugin: the configured length floor is not passed on',
    file: 'src/index.ts',
    edits: [['  const { entries, rejected } = selectSecrets(settings.declared, settings.minLength)',
      '  const { entries, rejected } = selectSecrets(settings.declared, 0)']],
  },
  {
    // The service is still provided when the plugin is off — a mount that
    // answered nothing at all would be indistinguishable from a failed one.
    name: 'plugin: mode off provides no service',
    file: 'src/index.ts',
    edits: [["    say('info', 'mode is off: neither listener nor shadow is installed')\n    ctx.provide(SERVICE, service)",
      "    say('info', 'mode is off: neither listener nor shadow is installed')"]],
  },
  {
    // The blind spots are the half of the contract an operator has to read.
    name: 'plugin: the blind spots are reported as empty',
    file: 'src/index.ts',
    edits: [['    blindSpots: BLIND_SPOTS,', '    blindSpots: [],']],
  },
]

const filterArg = process.argv.find(argument => argument.startsWith('--filter='))
const filter = filterArg === undefined ? undefined : filterArg.slice('--filter='.length)

/**
 * Run a command, reporting whether it succeeded.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns whether it exited zero, and its combined output when it did not.
 */
function run(command, args) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
    return { ok: true, output: '' }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** Emit the compiled artifact the suite actually imports. */
function build() {
  return run(process.execPath, [TSC])
}

/** Run every spec in the suite. */
function test() {
  return run(process.execPath, ['--test', 'test/*.spec.mjs'])
}

const results = []
for (const mutation of MUTATIONS) {
  if (filter !== undefined && !mutation.name.includes(filter)) continue
  // A malformed arm is worse than a missing one: `for (const [from, to] of
  // 'ab')` destructures a *string* into its characters, so the edit becomes a
  // search for two single characters and a rewrite that changes nothing — and
  // the arm then reports SILENT, blaming the suite for a harness bug.
  const malformed = mutation.edits.some(edit =>
    !Array.isArray(edit) || edit.length !== 2 || edit.some(part => typeof part !== 'string'))
  if (malformed) {
    results.push({ name: mutation.name, outcome: 'MALFORMED', detail: 'an edit is not a [from, to] pair of strings' })
    continue
  }
  const path = resolve(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let applied = true
  for (const [from, to] of mutation.edits) {
    if (!mutated.includes(from)) {
      applied = false
      break
    }
    mutated = mutated.replace(from, to)
  }
  if (!applied) {
    results.push({ name: mutation.name, outcome: 'NO-OP', detail: 'the source no longer contains the text this arm mutates' })
    continue
  }
  try {
    writeFileSync(path, mutated)
    const built = build()
    if (!built.ok) {
      results.push({ name: mutation.name, outcome: 'TYPEFAIL', detail: 'the mutation does not compile, so the suite never ran' })
      continue
    }
    const tested = test()
    results.push(tested.ok
      ? { name: mutation.name, outcome: 'SILENT', detail: 'the suite stayed green — this arm proves nothing' }
      : { name: mutation.name, outcome: 'CAUGHT', detail: '' })
  } finally {
    writeFileSync(path, original)
  }
}

// Put `lib/` back. The last arm left its mutation COMPILED there — the source is
// restored in the `finally` above, but the build output is not, and a checkout
// that runs this script and then publishes would ship the last mutant.
const restored = build()
if (!restored.ok) {
  process.stdout.write('\nWARNING: the rebuild after restoring the sources failed — lib/ may hold a mutant\n')
}

const caught = results.filter(result => result.outcome === 'CAUGHT').length
const declaredEquivalents = new Set(
  MUTATIONS.filter(mutation => mutation.equivalent !== undefined).map(mutation => mutation.name),
)
const equivalents = results.filter(result => result.outcome === 'SILENT' && declaredEquivalents.has(result.name))
const silent = results.filter(result => result.outcome === 'SILENT' && !declaredEquivalents.has(result.name))
const other = results.filter(result => result.outcome !== 'CAUGHT' && result.outcome !== 'SILENT')

for (const result of results) {
  const label = result.outcome === 'SILENT' && declaredEquivalents.has(result.name) ? 'EQUIVALENT' : result.outcome
  process.stdout.write(`${label.padEnd(10)} ${result.name}${result.detail === '' ? '' : `\n           ${result.detail}`}\n`)
}
process.stdout.write(`\n${caught}/${results.length} caught`)
process.stdout.write(silent.length === 0
  ? ` — no arm is silent (${equivalents.length} declared equivalent)\n`
  : `, ${silent.length} SILENT\n`)
if (other.length > 0) {
  process.stdout.write(`${other.length} arm(s) could not be evaluated: `
    + `${other.map(result => `${result.outcome} ${result.name}`).join(', ')}\n`)
}
process.exitCode = silent.length === 0 && other.length === 0 ? 0 : 1
