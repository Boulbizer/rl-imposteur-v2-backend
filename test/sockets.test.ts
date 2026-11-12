// Tests d'intégration : vrais sockets contre un vrai serveur sur un port libre.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { io as connect, type Socket } from 'socket.io-client'
import { createServer } from '../src/server'
import { FileStorage, MemoryStorage } from '../src/store/storage'
import type { ClientToServerEvents, PrivateView, PublicRoom, ServerToClientEvents } from '../src/types'

type Client = Socket<ServerToClientEvents, ClientToServerEvents> & { received: { event: string; payload: unknown }[] }
type Joined = { room: PublicRoom } & PrivateView

const clients: Client[] = []

async function startServer(storage = new MemoryStorage(), restartGraceMs = 5_000) {
  const srv = await createServer({ storage, graceMs: 300, restartGraceMs })
  await new Promise<void>(r => srv.server.listen(0, r))
  const url = `http://localhost:${(srv.server.address() as AddressInfo).port}`
  return { ...srv, url, storage }
}

function client(url: string): Client {
  const c = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false }) as Client
  c.received = []
  c.onAny((event, payload) => c.received.push({ event, payload }))
  clients.push(c)
  return c
}

function once<T = any>(c: Client, event: keyof ServerToClientEvents, ms = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout en attendant ${event}`)), ms)
    ;(c as any).once(event, (data: T) => { clearTimeout(t); resolve(data) })
  })
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

async function setupRoom(url: string, names: string[]) {
  const [hostName, ...others] = names
  const host = client(url)
  host.emit('room:create', { playerName: hostName })
  const created = await once<Joined>(host, 'room:created')
  const players = [{ c: host, ...created }]
  for (const name of others) {
    const c = client(url)
    c.emit('room:join', { roomId: created.room.id, playerName: name })
    players.push({ c, ...(await once<Joined>(c, 'room:joined')) })
  }
  return { code: created.room.id, players }
}

async function startAndVote(code: string, players: Awaited<ReturnType<typeof setupRoom>>['players']) {
  const started = Promise.all(players.map(p => once<{ isImpostor: boolean }>(p.c, 'game:started')))
  players[0].c.emit('game:start', { roomId: code })
  const roles = await started
  const voting = Promise.all(players.map(p => once(p.c, 'voting:started')))
  players[0].c.emit('game:end', { roomId: code })
  await voting
  return roles
}

describe('serveur', () => {
  let srv: Awaited<ReturnType<typeof startServer>>
  before(async () => { srv = await startServer() })
  after(async () => {
    clients.forEach(c => c.close())
    await srv.close()
    await new Promise(r => srv.server.close(r))
  })

  test('code à 4 lettres, insensible à la casse', async () => {
    const { code } = await setupRoom(srv.url, ['Hote'])
    assert.match(code, /^[A-HJ-NP-Z]{4}$/)
    const c = client(srv.url)
    c.emit('room:join', { roomId: code.toLowerCase(), playerName: 'Invite' })
    assert.equal((await once<Joined>(c, 'room:joined')).room.id, code)
  })

  test("aucun message ne révèle l'imposteur ni les jetons d'autrui avant la révélation", async () => {
    const { code, players } = await setupRoom(srv.url, ['A', 'B', 'C', 'D'])
    const roles = await startAndVote(code, players)
    assert.equal(roles.filter(r => r.isImpostor).length, 1)
    for (const p of players) {
      for (const { event, payload } of p.c.received) {
        const json = JSON.stringify(payload)
        assert.ok(!json.includes('impostorId'), `${event} contient impostorId`)
        for (const other of players) {
          if (other !== p) assert.ok(!json.includes(other.you.token), `${event} contient un jeton`)
        }
      }
    }
  })

  test("on ne peut pas prendre la place d'un joueur avec son pseudo", async () => {
    const { code } = await setupRoom(srv.url, ['Hote', 'Bob'])
    for (const name of ['bob', 'Hote']) {
      const thief = client(srv.url)
      thief.emit('room:join', { roomId: code, playerName: name })
      assert.match((await once(thief, 'room:error')).message, /déjà pris/)
    }
  })

  test('un non-hôte ne peut pas lancer la partie', async () => {
    const { code, players } = await setupRoom(srv.url, ['Hote', 'Bob'])
    players[1].c.emit('game:start', { roomId: code })
    assert.match((await once(players[1].c, 'room:error')).message, /hôte/)
  })

  test('votes invalides refusés, socket hors salle ignoré', async () => {
    const { code, players } = await setupRoom(srv.url, ['H', 'X', 'Y'])
    await startAndVote(code, players)
    const x = players[1]
    x.c.emit('vote:cast', { roomId: code, targetId: x.you.playerId })
    assert.match((await once(x.c, 'room:error')).message, /toi-même/)
    x.c.emit('vote:cast', { roomId: code, targetId: 'inconnu' })
    assert.match((await once(x.c, 'room:error')).message, /introuvable/)
    const outsider = client(srv.url)
    await once(outsider, 'connect' as any)
    outsider.emit('vote:cast', { roomId: code, targetId: players[0].you.playerId })
    await wait(150)
    assert.ok(!players[0].c.received.some(m => m.event === 'vote:registered'))
  })

  test('partie complète : révélation, scores, manche suivante', async () => {
    const { code, players } = await setupRoom(srv.url, ['P1', 'P2', 'P3'])
    const roles = await startAndVote(code, players)
    const iImp = roles.findIndex(r => r.isImpostor)
    const impostorId = players[iImp].you.playerId
    const reveal = Promise.all(players.map(p => once(p.c, 'reveal:result')))
    players.forEach((p, i) => p.c.emit('vote:cast', {
      roomId: code,
      targetId: i === iImp ? players[(i + 1) % 3].you.playerId : impostorId,
    }))
    const [{ results }] = await reveal
    assert.equal(results.impostorId, impostorId)
    assert.equal(results.impostorFound, true)
    assert.equal(results.cumulativeScores.reduce((s: number, r: { total: number }) => s + r.total, 0), 4)

    const next = once(players[1].c, 'round:next')
    players[0].c.emit('round:next', { roomId: code })
    const { room } = await next
    assert.equal(room.round, 2)
    assert.equal(room.status, 'lobby')
  })

  test('reconnexion par jeton : même joueur, même rôle ; faux jeton refusé', async () => {
    const { code, players } = await setupRoom(srv.url, ['Hote', 'Zed'])
    const started = Promise.all(players.map(p => once<{ isImpostor: boolean }>(p.c, 'game:started')))
    players[0].c.emit('game:start', { roomId: code })
    const roles = await started
    players[1].c.close()
    await wait(50)
    const back = client(srv.url)
    back.emit('room:rejoin', { roomId: code, token: players[1].you.token })
    const rejoined = await once<Joined>(back, 'room:rejoined')
    assert.equal(rejoined.you.playerId, players[1].you.playerId)
    assert.equal(rejoined.isImpostor, roles[1].isImpostor)
    const fake = client(srv.url)
    fake.emit('room:rejoin', { roomId: code, token: 'faux' })
    await once(fake, 'room:session-lost')
  })

  test("l'hôte parti définitivement transmet son rôle", async () => {
    const { players } = await setupRoom(srv.url, ['Hote', 'Suivant'])
    const changed = once(players[1].c, 'host:changed')
    players[0].c.close()
    assert.equal((await changed).newHostId, players[1].you.playerId)
  })
})

describe('redémarrage du serveur', () => {
  test('la partie survit : les joueurs reviennent avec leur jeton et leur rôle', async () => {
    const storage = new MemoryStorage()
    const first = await startServer(storage)
    const { code, players } = await setupRoom(first.url, ['Hote', 'Bob', 'Chloe'])
    const roles = await startAndVote(code, players)
    players[1].c.emit('vote:cast', { roomId: code, targetId: players[2].you.playerId })
    await once(players[1].c, 'vote:registered')

    // Arrêt brutal du premier serveur, puis démarrage d'un second sur le même stockage
    players.forEach(p => p.c.close())
    await first.close()
    await new Promise(r => first.server.close(r))
    const second = await startServer(storage)

    const back = []
    for (const p of players) {
      const c = client(second.url)
      c.emit('room:rejoin', { roomId: code, token: p.you.token })
      back.push({ c, data: await once<Joined>(c, 'room:rejoined') })
    }
    back.forEach((b, i) => {
      assert.equal(b.data.you.playerId, players[i].you.playerId)
      assert.equal(b.data.isImpostor, roles[i].isImpostor)
      assert.equal(b.data.room.status, 'voting')
    })
    // Le vote de Bob a été conservé
    const bobView = back[2].data.room.players.find(p => p.name === 'Bob')
    assert.equal(bobView?.hasVoted, true)

    // La manche se termine normalement sur le nouveau serveur
    const reveal = once(back[0].c, 'reveal:result')
    back[0].c.emit('vote:cast', { roomId: code, targetId: players[1].you.playerId })
    back[2].c.emit('vote:cast', { roomId: code, targetId: players[0].you.playerId })
    const { results } = await reveal
    assert.equal(Object.keys(results.votes).length, 3)

    back.forEach(b => b.c.close())
    await second.close()
    await new Promise(r => second.server.close(r))
  })

  test('les salles trop anciennes ne sont pas restaurées', async () => {
    const storage = new MemoryStorage()
    await storage.saveRoom({
      id: 'VIEU', scoreKey: 'k', hostId: 'h', hostName: 'H', players: [], status: 'lobby',
      impostorId: null, votes: {}, round: 1, updatedAt: Date.now() - 13 * 3600_000,
    })
    const srv = await createServer({ storage })
    assert.equal(srv.registry.get('VIEU'), undefined)
    assert.equal((await storage.loadRooms()).length, 0)
    await srv.close()
  })
})

describe('stockage fichier', () => {
  test('une salle sauvegardée est relue par une nouvelle instance', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'rl-')), 'rooms.json')
    const a = new FileStorage(file)
    await a.saveRoom({
      id: 'FICH', scoreKey: 'k', hostId: 'h', hostName: 'H', players: [], status: 'lobby',
      impostorId: null, votes: {}, round: 3, updatedAt: Date.now(),
    })
    await a.addScores([{ room_id: 'k', player_name: 'H', points: 2 }])
    const b = new FileStorage(file)
    assert.equal((await b.loadRooms())[0].round, 3)
    assert.deepEqual(await b.totalScores('k'), [{ name: 'H', total: 2 }])
  })
})

describe('résilience', () => {
  test('une panne du stockage des scores ne bloque pas la révélation', async () => {
    const storage = new MemoryStorage()
    storage.addScores = async () => { throw new Error('base indisponible') }
    const srv = await startServer(storage)
    const { code, players } = await setupRoom(srv.url, ['A', 'B'])
    await startAndVote(code, players)
    const reveal = once(players[0].c, 'reveal:result')
    players[0].c.emit('vote:cast', { roomId: code, targetId: players[1].you.playerId })
    players[1].c.emit('vote:cast', { roomId: code, targetId: players[0].you.playerId })
    const { results } = await reveal
    assert.equal(results.cumulativeScores, undefined)
    players.forEach(p => p.c.close())
    await srv.close()
    await new Promise(r => srv.server.close(r))
  })

  test('stockage fichier : écritures simultanées sans erreur', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'rl-')), 'rooms.json')
    const fs = new FileStorage(file)
    const base = { scoreKey: 'k', hostId: 'h', hostName: 'H', players: [], status: 'lobby' as const,
      impostorId: null, votes: {}, round: 1, updatedAt: Date.now() }
    await Promise.all(Array.from({ length: 20 }, (_, i) => fs.saveRoom({ ...base, id: `R${i}` })))
    assert.equal((await new FileStorage(file).loadRooms()).length, 20)
  })
})
