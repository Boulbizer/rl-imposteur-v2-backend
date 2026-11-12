// Tests unitaires du moteur de jeu (aucun réseau).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as engine from '../src/game/engine'
import type { Room } from '../src/types'

const NOW = 1_000_000
// Aléa déterministe : le mélange garde l'ordre d'arrivée (imposteur = 1er joueur)
const first = (n: number) => n - 1

/** Salle « classique » : imposteur seul, sans débat (comportement de l'étape 2). */
function roomWith(names: string[], settings: Partial<Room['settings']> = {}): Room {
  const created = engine.createRoom('ABCD', 'key', 's0', names[0], NOW)
  assert.ok(created.ok)
  created.room.settings = { ...created.room.settings, jester: false, detective: false, debateSeconds: 0, ...settings }
  names.slice(1).forEach((n, i) => {
    const r = engine.join(created.room, `s${i + 1}`, n, undefined, NOW)
    assert.ok(r.ok, n)
  })
  return created.room
}
const id = (room: Room, name: string) => room.players.find(p => p.name === name)!.id

describe('transitions', () => {
  test('seules les transitions du cycle sont permises', () => {
    assert.ok(engine.canTransition('lobby', 'playing'))
    assert.ok(engine.canTransition('playing', 'voting'))
    assert.ok(engine.canTransition('playing', 'debate'))
    assert.ok(engine.canTransition('debate', 'voting'))
    assert.ok(!engine.canTransition('debate', 'reveal'))
    assert.ok(engine.canTransition('voting', 'reveal'))
    assert.ok(engine.canTransition('reveal', 'lobby'))
    assert.ok(!engine.canTransition('lobby', 'voting'))
    assert.ok(!engine.canTransition('playing', 'reveal'))
    assert.ok(!engine.canTransition('reveal', 'playing'))
  })

  test('actions hors phase refusées', () => {
    const room = roomWith(['A', 'B'])
    const host = id(room, 'A')
    assert.equal(engine.endMatch(room, host, NOW).ok, false)
    assert.equal(engine.vote(room, host, id(room, 'B'), NOW).ok, false)
    assert.equal(engine.nextRound(room, host, NOW).ok, false)
    assert.throws(() => engine.reveal(room, NOW), /Transition interdite/)
  })
})

describe('droits', () => {
  test("seul l'hôte lance, termine et passe la manche", () => {
    const room = roomWith(['A', 'B'])
    const [a, b] = [id(room, 'A'), id(room, 'B')]
    assert.match((engine.start(room, b, NOW) as { error: string }).error, /hôte/)
    assert.ok(engine.start(room, a, NOW, first).ok)
    assert.match((engine.endMatch(room, b, NOW) as { error: string }).error, /hôte/)
  })
})

describe('entrée en salle', () => {
  test('pseudo déjà pris (casse ignorée), vide ou trop long refusé', () => {
    const room = roomWith(['Alice'])
    assert.equal(engine.join(room, 'x', 'alice', undefined, NOW).ok, false)
    assert.equal(engine.join(room, 'x', '   ', undefined, NOW).ok, false)
    assert.equal(engine.join(room, 'x', 'x'.repeat(21), undefined, NOW).ok, false)
  })

  test('salle pleine à 10', () => {
    const room = roomWith(Array.from({ length: 10 }, (_, i) => `P${i}`))
    const r = engine.join(room, 'x', 'Onze', undefined, NOW)
    assert.ok(!r.ok && /pleine/.test(r.error))
  })

  test('le jeton reconnecte le même joueur, même en cours de partie', () => {
    const room = roomWith(['A', 'B'])
    engine.start(room, id(room, 'A'), NOW, first)
    const b = room.players[1]
    engine.markDisconnected(room, b.id, NOW)
    const r = engine.join(room, 'nouveau-socket', undefined, b.token, NOW)
    assert.ok(r.ok && r.reconnected && r.player.id === b.id)
    assert.equal(b.socketId, 'nouveau-socket')
    assert.equal(b.disconnected, false)
  })

  test('sans jeton, impossible de rejoindre une partie lancée', () => {
    const room = roomWith(['A', 'B'])
    engine.start(room, id(room, 'A'), NOW, first)
    assert.equal(engine.join(room, 'x', 'C', undefined, NOW).ok, false)
  })
})

describe('vue publique', () => {
  test("ne contient ni imposteur, ni votes, ni jetons", () => {
    const room = roomWith(['A', 'B', 'C'])
    engine.start(room, id(room, 'A'), NOW, first)
    engine.endMatch(room, id(room, 'A'), NOW)
    engine.vote(room, id(room, 'B'), id(room, 'C'), NOW)
    const json = JSON.stringify(engine.publicRoom(room))
    assert.ok(!json.includes('impostorId'))
    assert.ok(!json.includes('votes"'))
    for (const p of room.players) assert.ok(!json.includes(p.token))
    assert.equal(engine.publicRoom(room).votesCount, 1)
  })
})

describe('vote et révélation', () => {
  function votingRoom() {
    const room = roomWith(['A', 'B', 'C', 'D'])
    engine.start(room, id(room, 'A'), NOW, first) // imposteur = A
    engine.endMatch(room, id(room, 'A'), NOW)
    return room
  }

  test('votes invalides refusés', () => {
    const room = votingRoom()
    const b = id(room, 'B')
    assert.equal(engine.vote(room, b, b, NOW).ok, false)
    assert.equal(engine.vote(room, b, 'inconnu', NOW).ok, false)
    assert.equal(engine.vote(room, 'inconnu', b, NOW).ok, false)
    engine.markDisconnected(room, b, NOW)
    assert.equal(engine.vote(room, b, id(room, 'C'), NOW).ok, false)
  })

  test('seuls les connectés comptent pour clore le vote', () => {
    const room = votingRoom()
    engine.markDisconnected(room, id(room, 'D'), NOW)
    engine.vote(room, id(room, 'A'), id(room, 'B'), NOW)
    engine.vote(room, id(room, 'B'), id(room, 'A'), NOW)
    assert.equal(engine.allVoted(room), false)
    engine.vote(room, id(room, 'C'), id(room, 'A'), NOW)
    assert.equal(engine.allVoted(room), true)
  })

  test('imposteur démasqué : +2 aux bons votants, 0 à l’imposteur', () => {
    const room = votingRoom()
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map(n => id(room, n))
    engine.vote(room, a, b, NOW)
    engine.vote(room, b, a, NOW)
    engine.vote(room, c, a, NOW)
    engine.vote(room, d, b, NOW)
    const r = engine.reveal(room, NOW)
    assert.equal(r.impostorFound, true)
    assert.deepEqual(r.pointsAwarded, { [a]: 0, [b]: 2, [c]: 2, [d]: 0 })
    assert.equal(room.status, 'reveal')
  })

  test('égalité incluant l’imposteur : démasqué', () => {
    const room = votingRoom()
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map(n => id(room, n))
    engine.vote(room, a, b, NOW)
    engine.vote(room, b, a, NOW)
    engine.vote(room, c, b, NOW)
    engine.vote(room, d, a, NOW)
    assert.equal(engine.reveal(room, NOW).impostorFound, true)
  })

  test('imposteur non démasqué : +3', () => {
    const room = votingRoom()
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map(n => id(room, n))
    engine.vote(room, a, b, NOW)
    engine.vote(room, b, c, NOW)
    engine.vote(room, c, b, NOW)
    engine.vote(room, d, b, NOW)
    const r = engine.reveal(room, NOW)
    assert.equal(r.impostorFound, false)
    assert.equal(r.accusedId, b)
    assert.equal(r.pointsAwarded[a], 3)
  })

  test('manche suivante : retour au lobby, manche +1, rôles effacés', () => {
    const room = votingRoom()
    for (const p of room.players) {
      engine.vote(room, p.id, room.players.find(o => o.id !== p.id)!.id, NOW)
    }
    engine.reveal(room, NOW)
    assert.ok(engine.nextRound(room, id(room, 'A'), NOW).ok)
    assert.equal(room.status, 'lobby')
    assert.equal(room.round, 2)
    assert.equal(room.impostorId, null)
    assert.deepEqual(room.votes, {})
  })
})

describe('départs', () => {
  test("l'hôte qui part transmet son rôle au premier connecté", () => {
    const room = roomWith(['A', 'B', 'C'])
    engine.markDisconnected(room, id(room, 'B'), NOW)
    const r = engine.removePlayer(room, id(room, 'A'), NOW)
    assert.ok(r.wasHost)
    assert.equal(room.hostName, 'C')
  })

  test('les votes visant un joueur retiré sont annulés', () => {
    const room = roomWith(['A', 'B', 'C'])
    engine.start(room, id(room, 'A'), NOW, first)
    engine.endMatch(room, id(room, 'A'), NOW)
    engine.vote(room, id(room, 'B'), id(room, 'C'), NOW)
    engine.removePlayer(room, id(room, 'C'), NOW)
    assert.deepEqual(room.votes, {})
  })

  test('dernier joueur parti : salle vide', () => {
    const room = roomWith(['A'])
    assert.ok(engine.removePlayer(room, id(room, 'A'), NOW).empty)
  })
})

test('code de salle : 4 lettres sans I ni O', () => {
  for (let i = 0; i < 200; i++) assert.match(engine.randomCode(), /^[A-HJ-NP-Z]{4}$/)
})

describe('rôles', () => {
  test('distribution selon le nombre de joueurs et les réglages', () => {
    const all = { ...engine.DEFAULT_SETTINGS, jester: true, detective: true }
    assert.deepEqual(engine.rolesFor(3, all), ['impostor', 'teammate', 'teammate'])
    assert.deepEqual(engine.rolesFor(4, all), ['impostor', 'jester', 'teammate', 'teammate'])
    assert.deepEqual(engine.rolesFor(5, all).slice(0, 3), ['impostor', 'jester', 'detective'])
    assert.deepEqual(engine.rolesFor(5, { ...all, jester: false }).slice(0, 2), ['impostor', 'detective'])
  })

  test('un seul imposteur, rôles secrets, indice du Détective vrai', () => {
    for (let i = 0; i < 50; i++) {
      const room = roomWith(['A', 'B', 'C', 'D', 'E', 'F'], { jester: true, detective: true })
      engine.start(room, id(room, 'A'), NOW)
      const roles = Object.values(room.roles)
      assert.equal(roles.filter(r => r === 'impostor').length, 1)
      assert.equal(roles.filter(r => r === 'jester').length, 1)
      assert.equal(roles.filter(r => r === 'detective').length, 1)
      const detective = Object.keys(room.roles).find(k => room.roles[k] === 'detective')!
      const clue = room.clues[detective]
      const innocent = room.players.find(p => clue.startsWith(p.name + ' '))!
      assert.notEqual(room.roles[innocent.id], 'impostor')
      assert.notEqual(innocent.id, detective)
      // Vue publique sans rôle ni mission ni indice
      const json = JSON.stringify(engine.publicRoom(room))
      assert.ok(!/:"(impostor|jester|detective|teammate)"/.test(json), 'aucun rôle en valeur')
      assert.ok(!json.includes(clue))
    }
  })

  test('vue privée : chacun ne voit que son rôle, sa mission, son indice', () => {
    const room = roomWith(['A', 'B', 'C'])
    engine.start(room, id(room, 'A'), NOW, first)
    engine.assignMissions(room, { [id(room, 'A')]: 'Saboter', [id(room, 'B')]: 'Observer' }, NOW)
    const a = engine.privateView(room, room.players[0])
    const b = engine.privateView(room, room.players[1])
    assert.equal(a.role, 'impostor')
    assert.equal(a.mission, 'Saboter')
    assert.equal(b.role, 'teammate')
    assert.equal(b.mission, 'Observer')
    assert.equal(b.clue, null)
  })
})

describe('réglages', () => {
  test("hôte uniquement, en salon uniquement, valeurs bornées", () => {
    const room = roomWith(['A', 'B'])
    const [a, b] = [id(room, 'A'), id(room, 'B')]
    assert.equal(engine.updateSettings(room, b, { jester: true }, NOW).ok, false)
    assert.ok(engine.updateSettings(room, a, { mode: 'hoops', debateSeconds: 9999, voteSeconds: -5 }, NOW).ok)
    assert.equal(room.settings.mode, 'hoops')
    assert.equal(room.settings.debateSeconds, 300)
    assert.equal(room.settings.voteSeconds, 0)
    assert.equal(engine.updateSettings(room, a, { mode: 'football' }, NOW).ok, false)
    engine.start(room, a, NOW, first)
    assert.equal(engine.updateSettings(room, a, { jester: false }, NOW).ok, false)
  })
})

describe('débat', () => {
  function debateRoom() {
    const room = roomWith(['A', 'B', 'C'], { debateSeconds: 45, voteSeconds: 30 })
    engine.start(room, id(room, 'A'), NOW, first)
    const r = engine.endMatch(room, id(room, 'A'), NOW)
    assert.ok(r.ok && r.next === 'debate')
    return room
  }

  test('fin du match → débat chronométré', () => {
    const room = debateRoom()
    assert.equal(room.status, 'debate')
    assert.equal(room.phaseEndsAt, NOW + 45_000)
  })

  test('accusations : publiques, une par joueur, raison obligatoire et bornée', () => {
    const room = debateRoom()
    const [a, b, c] = ['A', 'B', 'C'].map(n => id(room, n))
    assert.equal(engine.accuse(room, b, b, 'moi', NOW).ok, false)
    assert.equal(engine.accuse(room, b, a, '   ', NOW).ok, false)
    assert.ok(engine.accuse(room, b, a, 'Il a raté 3 dégagements', NOW).ok)
    assert.ok(engine.accuse(room, b, c, 'x'.repeat(200), NOW).ok)
    assert.equal(room.accusations.length, 1, 'remplacée, pas ajoutée')
    assert.equal(room.accusations[0].targetId, c)
    assert.equal(room.accusations[0].reason.length, engine.MAX_REASON_LENGTH)
    assert.equal(engine.publicRoom(room).accusations.length, 1)
  })

  test("passage au vote : chrono (null) ou hôte, pas un autre joueur", () => {
    const room = debateRoom()
    assert.equal(engine.startVoting(room, id(room, 'B'), NOW).ok, false)
    assert.ok(engine.startVoting(room, null, NOW + 45_000).ok)
    assert.equal(room.status, 'voting')
    assert.equal(room.phaseEndsAt, NOW + 45_000 + 30_000)
    assert.equal(engine.accuse(room, id(room, 'B'), id(room, 'A'), 'trop tard', NOW).ok, false)
  })

  test('débat désactivé : vote direct', () => {
    const room = roomWith(['A', 'B'], { debateSeconds: 0, voteSeconds: 0 })
    engine.start(room, id(room, 'A'), NOW, first)
    const r = engine.endMatch(room, id(room, 'A'), NOW)
    assert.ok(r.ok && r.next === 'voting')
    assert.equal(room.phaseEndsAt, null)
  })
})

describe('barème étendu', () => {
  /** 5 joueurs, rôles imposés : A imposteur, B bouffon, C détective, D et E équipiers. */
  function fullRoom() {
    const room = roomWith(['A', 'B', 'C', 'D', 'E'], { jester: true, detective: true })
    engine.start(room, id(room, 'A'), NOW, first)
    assert.deepEqual(['A', 'B', 'C', 'D', 'E'].map(n => room.roles[id(room, n)]),
      ['impostor', 'jester', 'detective', 'teammate', 'teammate'])
    engine.endMatch(room, id(room, 'A'), NOW)
    return room
  }

  test('Bouffon désigné : +4 pour lui, +3 pour l’imposteur non démasqué', () => {
    const room = fullRoom()
    const [a, b, c, d, e] = ['A', 'B', 'C', 'D', 'E'].map(n => id(room, n))
    engine.vote(room, a, b, NOW); engine.vote(room, b, c, NOW); engine.vote(room, c, b, NOW)
    engine.vote(room, d, b, NOW); engine.vote(room, e, a, NOW)
    const r = engine.reveal(room, NOW)
    assert.equal(r.jesterWon, true)
    assert.equal(r.impostorFound, false)
    assert.deepEqual(r.pointsAwarded, { [a]: 3, [b]: 4, [c]: 0, [d]: 0, [e]: 2 })
    assert.equal(r.roles[b], 'jester')
  })

  test('Détective qui vote juste : +3', () => {
    const room = fullRoom()
    const [a, b, c, d, e] = ['A', 'B', 'C', 'D', 'E'].map(n => id(room, n))
    engine.vote(room, a, d, NOW); engine.vote(room, b, a, NOW); engine.vote(room, c, a, NOW)
    engine.vote(room, d, a, NOW); engine.vote(room, e, c, NOW)
    const r = engine.reveal(room, NOW)
    assert.equal(r.impostorFound, true)
    assert.deepEqual(r.pointsAwarded, { [a]: 0, [b]: 0, [c]: 3, [d]: 2, [e]: 0 })
  })

  test('égalité imposteur / bouffon : l’imposteur est démasqué', () => {
    const room = fullRoom()
    const [a, b, c, d, e] = ['A', 'B', 'C', 'D', 'E'].map(n => id(room, n))
    engine.vote(room, c, a, NOW); engine.vote(room, d, b, NOW)
    engine.vote(room, e, a, NOW); engine.vote(room, a, b, NOW)
    const r = engine.reveal(room, NOW)
    assert.equal(r.impostorFound, true)
    assert.equal(r.jesterWon, false)
  })

  test('vote clos par le chrono sans aucun vote : imposteur non démasqué', () => {
    const room = fullRoom()
    const r = engine.reveal(room, NOW)
    assert.equal(r.accusedId, null)
    assert.equal(r.impostorFound, false)
    assert.equal(r.pointsAwarded[id(room, 'A')], 3)
  })

  test('manche suivante : rôles, missions, indices et accusations effacés', () => {
    const room = fullRoom()
    engine.reveal(room, NOW)
    engine.nextRound(room, id(room, 'A'), NOW)
    assert.deepEqual(room.roles, {})
    assert.deepEqual(room.missions, {})
    assert.deepEqual(room.clues, {})
    assert.deepEqual(room.accusations, [])
  })
})

test("salle sauvegardée par l'étape 2 : complétée au chargement", () => {
  const old = {
    id: 'VIEU', scoreKey: 'k', hostId: 'h', hostName: 'H',
    players: [{ id: 'h', token: 't', socketId: null, name: 'H', disconnected: true },
              { id: 'x', token: 'u', socketId: null, name: 'X', disconnected: true }],
    status: 'voting', impostorId: 'x', votes: {}, round: 2, updatedAt: NOW,
  } as unknown as Room
  const room = engine.upgradeRoom(old)
  assert.equal(room.settings.mode, '3v3')
  assert.equal(room.roles.x, 'impostor')
  assert.equal(room.roles.h, 'teammate')
  assert.deepEqual(room.accusations, [])
})
