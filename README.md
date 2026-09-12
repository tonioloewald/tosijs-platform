# service-compris

*Service compris* — service included. Also, **understood**, which is the reading that matters: this
is the part of a backend that **decides** things, small enough to read and pure enough to test
without a cloud.

```
npm install service-compris
```

## What 0.1.0 actually is

**The decision kernel of a backend, not a server.** It does not talk to a database, serve HTTP, or
authenticate anyone. Given a principal, a collection config, and a proposed write, it tells you what
should happen — and nothing else.

That is a deliberately narrow first release. It is the part that was worth extracting first because
it is pure, dependency-injected, and has no vendor in it: the same code runs in a unit test, in a
Firebase function, or in front of Postgres, because it does no I/O at all.

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
// → { status: 'write', data: { title: 'hello', _created: …, _modified: … } }
```

`outcome.status` is `'write'`, `'noop'`, or `'rejected'`. **The caller commits** — this library never
writes anything.

## What it gives you

- **A write pipeline** — existence guards, `PUT`-replaces vs `PATCH`-merges, provenance stamping
  through an **injected clock**, envelope stripping, a no-op check (an unchanged body neither writes
  nor re-stamps), and uniqueness through an **injected privileged read**.
- **An access model** — role resolution across a collection's access map, field-map straining, and
  opaque denials so a protected resource does not confirm its own existence.
- **Roles** — the role vocabulary and the `UserRoles` shape.

Every dependency is injected, which is the whole point: the decisions are the part you want to be
able to reason about, and reasoning about them should not require standing anything up.

## What it does *not* give you

No storage, no HTTP, no auth, no realtime. Those belong to the deployable platform, which is not
published yet. If you want a backend, this is not it *yet* — it is the piece of one that can be
audited on its own.

## Stability

**0.1.x — pin exactly.** The shape is settled and under test; the surface will move. Several design
decisions are recorded and unimplemented, and each will change this API when it lands:
capability-based access, schema-valued field permissions, and `isWriteAllowed` (which the
monotonicity property depends on).

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
