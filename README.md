# service-compris

*Service compris* — service included. Also, **understood**, which is the reading that matters: this
is the part of a backend that **decides** things, small enough to read and pure enough to test
without a cloud.

```
npm install service-compris
```

> **0.2.0, 2026-09-26.** Two things live here. The **npm package** is the pure decision kernel:
> RBAC, a write pipeline and role resolution, with no I/O and no vendor. The **repository** is a
> host you can deploy onto a blank Firebase project, claim without anyone handing you a secret,
> install a library onto from a JSON manifest, and give an agent its own scoped identity. Two
> production hosts run it: tosijs-virta's and loewald.com. Start at **[BETA.md](BETA.md)** (the
> host walkthrough, including what is deliberately not ready yet). Upgrading from 0.1.0: see the
> [CHANGELOG](CHANGELOG.md). Orientation for agents: [llms.txt](llms.txt).

## What the npm package actually is

**The decision kernel of a backend, not a server.** It does not talk to a database, serve HTTP, or
authenticate anyone. Given a principal, a collection config, and a proposed write, it tells you what
should happen — and nothing else.

It is pure, dependency-injected, and has no vendor in it: the same code runs in a unit test, in a
Firebase function, or in front of Postgres, because it does no I/O at all. This repository's own
host runs its writes and access decisions through exactly this package.

```ts
import { runWritePipeline, getMethodAccess, ROLES, ALL, type CollectionMap } from 'service-compris'

const collections: CollectionMap = {
  note: {
    access: {
      [ROLES.public]: { read: ALL },
      [ROLES.author]: { write: ALL },
    },
  },
}

const author = { name: 'ada', contacts: [], roles: [ROLES.author], userIds: ['u1'] }

// An authorization decision — no I/O.
getMethodAccess(collections, 'note', 'PUT', author, false) // → ALL

// A write decision — no database, no ambient clock.
const outcome = await runWritePipeline(
  { method: 'POST', body: { title: 'hello' }, existing: null, config: collections.note, userRoles: author },
  { now: () => new Date().toISOString(), isUnique: async (field, value) => true }
)
// → { status: 'write', data: { title: 'hello', _created: …, _modified: …, _by: { uid: 'u1', name: 'ada' } } }
```

`outcome.status` is `'write'`, `'noop'`, or `'rejected'`. **The caller commits** — this library never
writes anything. Provenance (`_by`) is stamped from `userRoles`, never taken from the body.

## What it gives you

- **A write pipeline** — existence guards, `PUT`-replaces vs `PATCH`-merges, provenance stamping
  through an **injected clock**, envelope stripping, a no-op check (an unchanged body neither writes
  nor re-stamps), and uniqueness through an **injected privileged read**.
- **An access model** — grants across a collection's access map **joined as a lattice** (holding
  more roles never grants less, and key order is irrelevant), field-map straining, capability-token
  caveats that narrow every grant (methods use REST names, with `LIST` distinct from `GET`), and
  opaque denials so a protected resource does not confirm its own existence.
- **Roles** — the role vocabulary and the `UserRoles` shape.

Every dependency is injected, which is the whole point: the decisions are the part you want to be
able to reason about, and reasoning about them should not require standing anything up.

## What it does *not* give you

No storage, no HTTP, no auth, no realtime. Those belong to the deployable platform in this
repository (not published to npm): clone it and follow [BETA.md](BETA.md) to stand up a host. The
npm package is the piece of that backend that can be audited on its own.

## Stability

**0.2.x.** Settled, and changed within 0.2.x only to fix bugs: the exports, the `WriteOutcome`
shape and its rejection reasons, the lattice-join semantics of `getMethodAccess`, and the role
vocabulary. A new rejection reason ships in a minor release and is announced, because it breaks an
exhaustive `switch`. Still provisional, and each will change the API when it lands: `isWriteAllowed`
(the monotonicity property depends on it) and schema-valued field permissions.

**Upgrading from 0.1.0** changes authorization results: the access map is now a lattice join (0.1.0
let the last matching role win), token caveats deny, and `WriteOutcome` has new reasons. 0.1.0 also
could not be imported under Node ESM at all. The CHANGELOG's 0.2.0 entry lists every change.

One current limitation worth knowing: a `write` permission that is not `ALL` is **denied**, not
strained. The write path cannot yet enforce a field-level write restriction, and refusing is the
honest answer — silently dropping fields an author submitted is data loss wearing a permission's
clothes. Schema-valued write permissions replace this.

## Design

The reasoning behind this is written down rather than folklore — see [`DECISIONS.md`](DECISIONS.md),
a dated, append-only ledger, including the mistakes and retractions. [`PLATFORM.md`](PLATFORM.md) is
the wider vision this is the first piece of, and [`SOVEREIGN.md`](SOVEREIGN.md) is what it would take
to run the whole thing on a commodity server.

This repository also runs [loewald.com](https://loewald.com), which is where the code gets its
bruises.

## License

MIT
