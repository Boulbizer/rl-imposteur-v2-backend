// Tests du générateur de missions (sans appel réseau).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OfflineMissionProvider, withFallback, type MissionProvider } from '../src/game/missions'

test('banque locale : une mission par rôle, toutes différentes', async () => {
  const roles = ['impostor', 'jester', 'detective', 'teammate', 'teammate', 'teammate'] as const
  const missions = await new OfflineMissionProvider().generate({ mode: '3v3', roles: [...roles] })
  assert.equal(missions.length, roles.length)
  assert.equal(new Set(missions).size, roles.length)
  missions.forEach(m => assert.ok(m.length > 10))
})

test('repli : erreur du fournisseur principal → banque locale', async () => {
  const broken: MissionProvider = { name: 'cassé', generate: async () => { throw new Error('API indisponible') } }
  const p = withFallback(broken, new OfflineMissionProvider())
  const out = await p.generate({ mode: '2v2', roles: ['impostor', 'teammate'] })
  assert.equal(out.length, 2)
})

test('repli : fournisseur principal trop lent → banque locale', async () => {
  const slow: MissionProvider = { name: 'lent', generate: () => new Promise(r => setTimeout(() => r(['x', 'y']), 1000)) }
  const started = Date.now()
  const out = await withFallback(slow, new OfflineMissionProvider(), 50).generate({ mode: '2v2', roles: ['impostor', 'teammate'] })
  assert.ok(Date.now() - started < 500)
  assert.notDeepEqual(out, ['x', 'y'])
})

test('fournisseur principal qui répond : ses missions sont utilisées', async () => {
  const ok: MissionProvider = { name: 'ok', generate: async () => ['m1', 'm2'] }
  assert.deepEqual(await withFallback(ok, new OfflineMissionProvider()).generate({ mode: '1v1', roles: ['impostor', 'teammate'] }), ['m1', 'm2'])
})
