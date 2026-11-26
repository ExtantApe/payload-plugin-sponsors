import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, handleEndpoints, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { publicSponsors, sponsorsPlugin } from '../src/index.js'

// The public REST read, GET /api/sponsors, through Payload's own endpoint handler (no mocks).
let payload: Payload
let mongo: MongoMemoryReplSet
let config: Awaited<ReturnType<typeof buildConfig>>
let memberToken: string
let adminToken: string
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const get = async (query = '', token?: string) => {
  const res = await handleEndpoints({
    config,
    request: new Request(`https://example.org/api/sponsors${query}`, { headers: token ? { Authorization: `JWT ${token}` } : {} }),
  })
  return { status: res.status, body: (await res.json()) as Doc }
}
const names = (b: Doc) => (b.docs as Doc[]).map((d) => d.name).sort()

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  config = await buildConfig({
    secret: 'test-secret-not-for-production',
    telemetry: false,
    serverURL: 'https://example.org',
    typescript: { autoGenerate: false },
    editor: lexicalEditor(),
    db: mongooseAdapter({ url: mongo.getUri('publicread'), ensureIndexes: true }),
    collections: [
      { slug: 'users', auth: true, fields: [{ name: 'role', type: 'text' }] },
      { slug: 'media', upload: true, fields: [] },
    ],
    admin: { user: 'users' },
    plugins: [
      sponsorsPlugin({
        canManage: ({ req }) => (req.user as { role?: string } | null)?.role === 'admin',
        sendEmail: async () => undefined,
        // A host that nests the plugin's public filter inside its own, as the platform does.
        overrides: {
          sponsors: (c) => ({
            ...c,
            fields: [...c.fields, { name: 'site', type: 'text' }],
          }),
        },
      }),
    ],
  })
  payload = await getPayload({ config })
  for (const [email, role] of [['member@example.org', 'member'], ['admin@example.org', 'admin']] as const) {
    await payload.create({ collection: 'users', data: { email, password: 'long-made-up-password', role } as never })
  }
  memberToken = (await payload.login({ collection: 'users', data: { email: 'member@example.org', password: 'long-made-up-password' } })).token!
  adminToken = (await payload.login({ collection: 'users', data: { email: 'admin@example.org', password: 'long-made-up-password' } })).token!
  const gold = await payload.create({ collection: 'sponsor-tiers' as never, data: { name: 'Gold' } as never })
  const make = (data: Doc) => payload.create({ collection: 'sponsors' as never, data: data as never })
  await make({ name: 'Listed One', listed: true, tier: gold.id, contacts: [{ email: 'one@made-up.example' }] })
  await make({ name: 'Listed Two', listed: true, contacts: [{ email: 'two@made-up.example' }] })
  await make({ name: 'Unlisted', listed: false, contacts: [{ email: 'hidden@made-up.example' }] })
  const old = await make({ name: 'Archived', listed: true, contacts: [{ email: 'old@made-up.example' }] })
  await payload.update({ collection: 'sponsors' as never, id: old.id, data: { archivedAt: new Date().toISOString() } as never })
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

describe('GET /api/sponsors', () => {
  it('gives a visitor the listed, current sponsors, with no contacts and no hidden sponsor', async () => {
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(names(body)).toEqual(['Listed One', 'Listed Two'])
    expect(JSON.stringify(body)).not.toMatch(/@|Unlisted|Archived/)
  })

  it('keeps hidden sponsors hidden however a visitor asks', async () => {
    for (const q of ['?where[name][equals]=Unlisted', '?where[listed][equals]=false', '?where[archivedAt][exists]=true', '?where[or][0][listed][equals]=false', '?depth=2&limit=0', '?select[contacts]=true']) {
      const { status, body } = await get(q)
      expect(status, q).toBe(200)
      expect(JSON.stringify(body), q).not.toMatch(/@|Unlisted|Archived/)
    }
    expect(names((await get('?where[listed][equals]=false')).body)).toEqual([])
  })

  it('refuses a visitor who queries or sorts by the private contacts', async () => {
    for (const q of ['?where[contacts.email][like]=hidden', '?sort=contacts.email']) expect((await get(q)).status, q).toBe(400)
  })

  it('answers a signed-in user who is not staff exactly as it answers a visitor', async () => {
    const { status, body } = await get('', memberToken)
    expect(status).toBe(200)
    expect(names(body)).toEqual(['Listed One', 'Listed Two'])
    expect(JSON.stringify(body)).not.toMatch(/@|Unlisted|Archived/)
  })

  it('shows staff every sponsor, archived and unlisted too, with contacts', async () => {
    const { status, body } = await get('?limit=0', adminToken)
    expect(status).toBe(200)
    expect(names(body)).toEqual(['Archived', 'Listed One', 'Listed Two', 'Unlisted'])
    expect(JSON.stringify(body)).toContain('hidden@made-up.example')
  })

  it('still answers 200 when a host nests the public filter in its own, and leaves the filter untouched', async () => {
    const before = JSON.stringify(publicSponsors)
    for (let i = 0; i < 3; i++) expect((await get()).status).toBe(200)
    expect(JSON.stringify(publicSponsors)).toBe(before)
  })
})
