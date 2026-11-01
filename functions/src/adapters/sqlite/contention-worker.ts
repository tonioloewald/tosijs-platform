/**
 * A separate PROCESS on a shared database file, for store-contention.test.ts.
 * Run as `bun contention-worker.ts <file> <role> [n]`; prints one JSON line.
 *
 * - `count n`: n transactions incrementing `counter/c`, then a create race on
 *   `race/only`. Reports how many creates it won.
 * - `hold n`:  takes the write lock in a transaction, says `locked`, holds it
 *   for n ms, commits.
 * - `wait`:    writes while another process holds the lock, and reports how
 *   long that took, how often its event loop ticked meanwhile, and how long a
 *   read took during the wait.
 */
import { createDocument } from '../../collections/store'
import { SqliteStore } from './store'

const [file, role, arg] = process.argv.slice(2)
const n = Number(arg ?? 0)
const store = new SqliteStore(file)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main(): Promise<Record<string, unknown>> {
  if (role === 'count') {
    for (let i = 0; i < n; i++) {
      await store.transaction(async (tx) => {
        const { data } = await tx.get('counter/c')
        tx.set('counter/c', { n: ((data.n as number) ?? 0) + 1 })
      })
    }
    let won = 0
    try {
      await createDocument(store, 'race/only', { by: process.pid })
      won = 1
    } catch {
      // lost the race: the document already existed
    }
    return { won }
  }
  if (role === 'hold') {
    await store.transaction(async (tx) => {
      await tx.get('held/x')
      console.log('locked')
      await sleep(n)
      tx.set('held/x', { at: Date.now() })
    })
    return { held: n }
  }
  if (role === 'wait') {
    let ticks = 0
    const timer = setInterval(() => ticks++, 5)
    const started = Date.now()
    const write = store.set('waited/y', { at: started })
    await sleep(20)
    const readStarted = Date.now()
    await store.get('held/x')
    const readMs = Date.now() - readStarted
    await write
    clearInterval(timer)
    return { waitedMs: Date.now() - started, ticks, readMs }
  }
  throw new Error(`unknown role ${role}`)
}

main().then(
  (result) => {
    console.log(JSON.stringify(result))
    store.close()
  },
  (e) => {
    console.log(JSON.stringify({ error: String(e) }))
    store.close()
    process.exitCode = 1
  }
)
