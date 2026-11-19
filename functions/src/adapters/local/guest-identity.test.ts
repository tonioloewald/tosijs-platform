import { describe, test, expect } from 'bun:test'
import { randomBytes } from 'crypto'
import { guestIdentities, GUEST_LIFETIME_MS, GUEST_TOKEN_PREFIX, type Guest } from './guest-identity'

const secret = randomBytes(32)

describe('guest identities', () => {
  test('a guest token verifies as its guest, with no claims', async () => {
    const { provider, issue } = guestIdentities(secret)
    const guest = issue('Agent Smith') as Guest
    expect(guest.uid).toMatch(/^guest-[A-Za-z0-9_-]{16}$/)
    expect(guest.token.startsWith(GUEST_TOKEN_PREFIX)).toBe(true)
    expect(await provider.verifyIdToken(guest.token)).toEqual({ uid: guest.uid, name: 'Agent Smith', guest: true })
    expect(await provider.customClaims(guest.uid)).toEqual({})
    await expect(provider.setCustomClaims(guest.uid, { roles: ['admin'] })).rejects.toThrow('no claims')
  })

  test('each guest is new, and unnamed guests get a default name', () => {
    const { issue } = guestIdentities(secret)
    const [a, b] = [issue() as Guest, issue() as Guest]
    expect(a.uid).not.toBe(b.uid)
    expect(a.name).toBe(`Guest ${a.uid.slice(6, 10)}`)
  })

  test('names are short and plain', () => {
    const { issue } = guestIdentities(secret)
    for (const bad of ['', ' lead', 'x'.repeat(33), '<script>', 42, null]) {
      expect(issue(bad)).toBeInstanceOf(Error)
    }
    expect((issue("Zoë O'Neil-2") as Guest).name).toBe("Zoë O'Neil-2")
  })

  test('a changed payload, a changed signature or another host secret is refused', async () => {
    const { provider, issue } = guestIdentities(secret)
    const { token } = issue('a') as Guest
    const [payload, mac] = token.slice(GUEST_TOKEN_PREFIX.length).split('.')
    const forged = Buffer.from(JSON.stringify({ uid: 'guest-admin', name: 'a', exp: Date.now() + 1000 })).toString('base64url')
    await expect(provider.verifyIdToken(`${GUEST_TOKEN_PREFIX}${forged}.${mac}`)).rejects.toThrow('signature')
    await expect(provider.verifyIdToken(`${GUEST_TOKEN_PREFIX}${payload}.${mac.slice(1)}x`)).rejects.toThrow('signature')
    await expect(guestIdentities(randomBytes(32)).provider.verifyIdToken(token)).rejects.toThrow('signature')
    await expect(provider.verifyIdToken(`${token}.more`)).rejects.toThrow('malformed')
    await expect(provider.verifyIdToken('dev.e30')).rejects.toThrow('not a guest token')
  })

  test('a guest token expires after its lifetime', async () => {
    let now = 1_000_000
    const { provider, issue } = guestIdentities(secret, () => now)
    const guest = issue() as Guest
    expect(guest.expires).toBe(new Date(1_000_000 + GUEST_LIFETIME_MS).toISOString())
    now += GUEST_LIFETIME_MS - 1
    expect((await provider.verifyIdToken(guest.token)).uid).toBe(guest.uid)
    now += 1
    await expect(provider.verifyIdToken(guest.token)).rejects.toThrow('expired')
  })

  test('a short secret is refused', () => {
    expect(() => guestIdentities(randomBytes(16))).toThrow('32 bytes')
  })
})
