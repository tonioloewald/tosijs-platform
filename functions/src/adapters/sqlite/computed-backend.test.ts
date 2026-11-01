/**
 * The render cache's contract (render/computed.suite.ts) on SQLite: each
 * backend on its own in-memory database, beside a SqliteStore.
 */
import { computedConformance } from '../../render/computed.suite'
import { sqliteComputedBackend } from './computed-backend'
import { SqliteStore } from './store'

computedConformance('SQLite', (now) => sqliteComputedBackend(new SqliteStore(':memory:'), 'system:render-test', 'system:render-log-test', now))
