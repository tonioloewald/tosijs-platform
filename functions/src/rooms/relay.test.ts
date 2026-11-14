/**
 * The relay's rules (D26), with fake connections and a fake clock: who gets
 * in, who hears what, and the limits.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bun:test types intermittently available
import { describe, test, expect } from 'bun:test'
import { createRelay, effectiveLimits, CLOSE, HOST_LIMITS, type AuthorizeJoin } from './relay'

// A token is the uid; "ROOM" admits ada, bob and cy.
const members: AuthorizeJoin = async (room, token) =>
  room === 'ROOM' && ['ada', 'bob', 'cy'].includes(token) ? { ok: true, uid: token } : { ok: false, reason: 'not a member of this room' }

function setup(authorizeJoin: AuthorizeJoin = members) {
  let clock = 0
  const timers: Array<() => void> = []
  const relay = createRelay({
    authorizeJoin,
    now: () => clock,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => undefined,
  })
  const connect = () => {
    const sent: Array<Record<string, unknown>> = []
    const closes: Array<[number, string]> = []
    const handle = relay.connect({
      send: (text) => sent.push(JSON.parse(text)),
      close: (code, reason) => {
        closes.push([code, reason])
        handle.closed()
      },
    })
    return { sent, closes, handle, say: (m: unknown) => handle.receive(JSON.stringify(m)) }
  }
  const join = async (token: string, room = 'ROOM') => {
    const c = connect()
    c.say({ type: 'join', room, token })
    await Promise.resolve()
    await Promise.resolve()
    return c
  }
  return { relay, connect, join, tick: (ms: number) => (clock += ms), fireTimers: () => timers.forEach((t) => t()) }
}

describe('joining', () => {
  test('a member joins and is told who is there; the others hear they arrived', async () => {
    const { join } = setup()
    const ada = await join('ada')
    const bob = await join('bob')
    expect(ada.sent).toEqual([
      { type: 'joined', room: 'ROOM', you: 'ada', members: ['ada'] },
      { type: 'presence', joined: 'bob' },
    ])
    expect(bob.sent).toEqual([{ type: 'joined', room: 'ROOM', you: 'bob', members: ['ada', 'bob'] }])
  })

  test('anyone not on the list is refused and disconnected', async () => {
    const { join, relay } = setup()
    const eve = await join('eve')
    expect(eve.sent).toEqual([{ type: 'refused', reason: 'not a member of this room' }])
    expect(eve.closes).toEqual([[CLOSE.refused, 'not a member of this room']])
    expect(relay.members('ROOM')).toEqual([])
  })

  test('a membership check that fails refuses; it never lets the caller in', async () => {
    const { join } = setup(async () => {
      throw new Error('datastore down')
    })
    const ada = await join('ada')
    expect(ada.closes[0][0]).toBe(CLOSE.refused)
  })

  test('the first message must be a join', () => {
    const { connect } = setup()
    const c = connect()
    c.say({ type: 'send', data: 'hi' })
    expect(c.closes).toEqual([[CLOSE.protocol, 'the first message is a join']])
  })

  test('a connection that never joins is closed', () => {
    const { connect, fireTimers } = setup()
    const c = connect()
    fireTimers()
    expect(c.closes).toEqual([[CLOSE.joinTimeout, 'join timed out']])
  })
})

describe('relaying', () => {
  test('a message reaches every other member, not the sender, and not other rooms', async () => {
    const { join } = setup(async (room, token) => ({ ok: true, uid: token }))
    const ada = await join('ada')
    const bob = await join('bob')
    const cy = await join('cy', 'OTHER')
    ada.say({ type: 'send', data: { x: 1, y: 2 } })
    expect(bob.sent.at(-1)).toEqual({ type: 'message', from: 'ada', data: { x: 1, y: 2 } })
    expect(ada.sent.filter((m) => m.type === 'message')).toEqual([])
    expect(cy.sent.filter((m) => m.type === 'message')).toEqual([])
  })

  test('the sender is who joined, whatever the message claims', async () => {
    const { join } = setup()
    const ada = await join('ada')
    const bob = await join('bob')
    ada.say({ type: 'send', from: 'bob', data: 'forged' })
    expect(bob.sent.at(-1)).toEqual({ type: 'message', from: 'ada', data: 'forged' })
  })

  test('leaving is announced; a second connection of the same member is not a second arrival', async () => {
    const { join } = setup()
    const ada = await join('ada')
    const bob1 = await join('bob')
    const bob2 = await join('bob')
    expect(ada.sent.filter((m) => m.type === 'presence')).toEqual([{ type: 'presence', joined: 'bob' }])
    bob1.handle.closed()
    expect(ada.sent.at(-1)).toEqual({ type: 'presence', joined: 'bob' })
    bob2.handle.closed()
    expect(ada.sent.at(-1)).toEqual({ type: 'presence', left: 'bob' })
  })

  test('a removed member is out at once: their next message reaches no one', async () => {
    const { join, relay } = setup()
    const ada = await join('ada')
    const bob = await join('bob')
    // A transport whose close is slow: the socket is still open after revoke.
    const slow = bob.handle
    relay.revoke('ROOM', 'bob')
    expect(bob.closes).toEqual([[CLOSE.revoked, 'removed from the room']])
    expect(ada.sent.at(-1)).toEqual({ type: 'presence', left: 'bob' })
    slow.receive(JSON.stringify({ type: 'send', data: 'still here?' }))
    expect(ada.sent.filter((m) => m.type === 'message')).toEqual([])
    expect(relay.members('ROOM')).toEqual(['ada'])
  })
})

describe('limits', () => {
  test('a room may lower the host limits, never raise them', () => {
    expect(effectiveLimits({ messageBytes: 100, perSecond: 1e6 }, HOST_LIMITS)).toEqual({ messageBytes: 100, perSecond: HOST_LIMITS.perSecond })
    expect(effectiveLimits({ messageBytes: -1, perSecond: NaN }, HOST_LIMITS)).toEqual(HOST_LIMITS)
    expect(effectiveLimits(undefined, HOST_LIMITS)).toEqual(HOST_LIMITS)
  })

  test('an oversized message closes the connection', async () => {
    const { join } = setup(async (room, token) => ({ ok: true, uid: token, limits: { messageBytes: 64 } }))
    const ada = await join('ada')
    const bob = await join('bob')
    ada.say({ type: 'send', data: 'x'.repeat(100) })
    expect(ada.closes).toEqual([[CLOSE.tooBig, 'messages are limited to 64 bytes']])
    expect(bob.sent.filter((m) => m.type === 'message')).toEqual([])
  })

  test('past the rate, messages are dropped and the sender told; the rate refills', async () => {
    const { join, tick } = setup(async (room, token) => ({ ok: true, uid: token, limits: { perSecond: 5 } }))
    const ada = await join('ada')
    const bob = await join('bob')
    for (let i = 0; i < 8; i++) ada.say({ type: 'send', data: i })
    expect(bob.sent.filter((m) => m.type === 'message').map((m) => m.data)).toEqual([0, 1, 2, 3, 4])
    expect(ada.sent.filter((m) => m.type === 'limited')).toHaveLength(3)
    tick(400) // two messages' worth at 5 a second
    for (let i = 8; i < 11; i++) ada.say({ type: 'send', data: i })
    expect(bob.sent.filter((m) => m.type === 'message').map((m) => m.data)).toEqual([0, 1, 2, 3, 4, 8, 9])
  })
})
