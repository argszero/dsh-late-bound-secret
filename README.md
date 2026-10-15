# @argszero/dsh-late-bound-secret

Keeps a declared secret's **value** out of the durable session log, while the
model still receives something it can use.

A message, a command line or a tool argument carries only a reference —
`{{secret:GH_TOKEN}}`. The plugin rewrites in exactly two places, in opposite
directions:

| direction | seam | what it does |
|---|---|---|
| outbound | the `llm/stream` waterfall | binds `{{secret:NAME}}` to its value, so the request reaching the provider carries something the model can use |
| inbound | a shadowed `Session.append` | rewrites the value back to `{{secret:NAME}}` on its way into the log, so no durable row holds it |

Both halves are needed, and the rule they produce together is the one the suite
asserts: **after a full turn, the value appears in the outbound request and in no
durable row.**

## The gap

Getting a credential into a session has two bad options today:

- **paste the value into the message** — it becomes durable. It enters the
  session log, the model context, and everything that later reads the log, and a
  durable row cannot be recalled;
- **keep it in a `.env` in the project directory** — a new leak surface: one
  `git add` away from the repository, one sync away from somewhere it should not
  be.

The result in practice is "either unsafe, or not used".

This plugin is **not** the environment-variable module a settings page would
build: that module injects a value into a child process's environment, so the
model writes `$NAME` and never needs the value at all. This plugin covers the
case that module does not reach — a value that has to appear **literally**, in a
command argument, an `Authorization` header, a connection string. There the model
itself has to receive the value, and what can be protected is not the request but
the **record**.

## Install

```sh
npm install @argszero/dsh-late-bound-secret
```

The package ships a bundle patch, so a profile that mounts it gets the listener
and the shadow with it:

```yaml
- insert:
    - id: late-bound-secret
      name: '@argszero/dsh-late-bound-secret'
      config:
        secrets:
          GH_TOKEN: '<the value, in a harness-managed profile or an overlay — never a tracked file>'
```

## Configuration

| key | default | meaning |
|---|---|---|
| `secrets` | `{}` | name → value, declared inline |
| `refs` | `[]` | names read from the process environment **at mount** |
| `marker` | `secret` | the word between `{{` and `:NAME}}` |
| `minLength` | `8` | the shortest value that may be bound or masked |
| `mode` | `guard` | `guard`, `observe`, or `off` |
| `report` | `true` | one log line per rewrite at `debug`, the mount summary at `info` |

- **`observe`** decides and counts exactly as `guard` would and changes nothing.
  It is how an operator finds out whether their declared values actually appear
  in a log before trusting the rewrite with them.
- **`off`** installs neither the listener nor the shadow.
- A value shorter than `minLength` is **refused by name** rather than
  half-applied: masking with a short value damages more ordinary text than it
  protects. The refusal is logged and reported by `snapshot()`.
- A name outside `/^[A-Za-z_][A-Za-z0-9_]*$/`, a duplicate name, and an empty
  value are refused the same way.

## Reading it back

```js
ctx.lateBoundSecret.snapshot()
```

Returns the resolved mode, the declared **names** (never a value), the names that
were refused and why, the counters, and the plugin's own blind spots.

## What it does not do

Every one of these is reported by `snapshot().blindSpots` on every read, rather
than left for an operator to discover:

- **The live UI still renders what the model emits in the moment.** A value the
  model echoes on screen is on screen; only the durable copy is rewritten.
- **Tool execution is not covered.** The plugin binds at the model request, so a
  tool that receives a bound value runs it.
- **A secret rotated while the process runs is bound at its mount-time value
  until restart.** Rewriting in front of a durable write is synchronous — any
  promise there would reorder the log — so the book is the one resolved at mount.
- **A reference typed inside a system-prompt section template is not this
  plugin's.** The harness's own strict `{{name}}` interpolator runs there first
  and rejects a colon outright. Keep references in messages, commands and tool
  arguments.
- **It is preventive, not curative.** A value already in a log is already
  durable; this plugin does not rewrite history.

## How it is verified

```sh
npm test         # 59 assertions across 4 suites; imports lib/, so it builds first
npm run test:inject   # 37 mutation arms
```

The suite drives the **real** seams rather than stand-ins:

- the **real** cordis `Context`, the **real** `LlmRuntime`, and the **real**
  `llm/stream` waterfall, dispatched through the registry exactly as
  `streamWithRegistration` does. A probe standing in for the adapter terminates
  the chain, so "the value reached the provider" is measured at the point a
  provider would have read it. Because the plugin registers with `prepend: true`,
  the probe never sees a request that still carries a reference — that is the
  assertion, and it is made on real dispatch.
- the **real** event bus and the **real** `session/created` dispatch for the
  inbound seam. Its subject is a session stand-in whose `append` is a **prototype**
  method — the same prototype-versus-own-property relationship the real class has,
  which is what the shadow depends on. Building a real `Session` needs a
  persistence backend, and this plugin's entire contract with one is that it
  shadows one property of whatever object the announcement hands it.

`test:inject` mutates the source one distinction at a time, rebuilds, and requires
the suite to catch it. An arm whose mutation leaves the suite green is reported as
`SILENT` and fails the script — a rule the package states to its users that
nothing checks. The arms include the ones this package would be worthless
without: the single-pass rewrite in both directions, longest-value-first, the
escaping of a value before it becomes a pattern, the length floor, the read-back
after the shadow assignment, the identity mark on the re-dispatch, and fail-open in
both directions.

## License

MIT
