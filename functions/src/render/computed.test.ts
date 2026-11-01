/**
 * The render cache's contract (computed.suite.ts) on MemoryBackend.
 */
import { MemoryBackend } from './computed'
import { computedConformance } from './computed.suite'

computedConformance('MemoryBackend', (now) => new MemoryBackend(now))
