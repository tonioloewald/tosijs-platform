/**
 * The logger port: a sink installed AFTER a module captured `log` still gets
 * its lines (index.ts installs Cloud Logging once every module has loaded).
 *
 * Run: cd functions && bun test src/log.test.ts
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { log, setLogSink, type Logger } from './log'

const captured = log // as a module holds it from import time

afterEach(() => setLogSink(console))

describe('log', () => {
  test('forwards every level, with all its arguments, to the sink installed later', () => {
    const lines: unknown[][] = []
    const sink: Logger = {
      info: (...a) => lines.push(['info', ...a]),
      warn: (...a) => lines.push(['warn', ...a]),
      error: (...a) => lines.push(['error', ...a]),
    }
    setLogSink(sink)
    const e = new Error('boom')
    captured.info('a')
    captured.warn('b')
    captured.error('c', e)
    expect(lines).toEqual([['info', 'a'], ['warn', 'b'], ['error', 'c', e]])
  })
})
