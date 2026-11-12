// Tests unitaires du moteur de jeu (aucun réseau).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as engine from '../src/game/engine'
import type { Room } from '../src/types'

const NOW = 1_000_000
const first = () => 0 // aléa déterministe : toujours le premier

function roomWith(names: string[]): Room {
  const created = engine.createRoom('ABCD', 'key', 's0', names[0], NOW)
  assert.ok(created.ok)
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
