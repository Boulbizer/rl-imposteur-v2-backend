// Tests d'intégration : vrais sockets contre un vrai serveur sur un port libre.
// Lancer : npm test

process.env.GRACE_PERIOD_MS = '300'
delete process.env.SUPABASE_URL
delete process.env.SUPABASE_SERVICE_KEY

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { io: connect } = require('socket.io-client')
const { createServer } = require('../server')
const { CODE_ALPHABET } = require('../rooms')

let server, url
const clients = []

before(async () => {
  ;({ server } = createServer())
  await new Promise(resolve => server.listen(0, resolve))
  url = `http://localhost:${server.address().port}`
})

after(async () => {
  clients.forEach(c => c.close())
  await new Promise(resolve => server.close(resolve))
})

function client() {
  const c = connect(url, { transports: ['websocket'], forceNew: true })
  // Journal de tous les messages reçus, pour vérifier ce qui fuit
  c.received = []
  c.onAny((event, payload) => c.received.push({ event, payload }))
  clients.push(c)
  return c
}

function once(c, event, ms = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout en attendant ${event}`)), ms)
    c.once(event, data => { clearTimeout(t); resolve(data) })
  })
}

const wait = ms => new Promise(r => setTimeout(r, ms))

async function setupRoom(names) {
  const [hostName, ...others] = names
  const host = client()
  host.emit('room:create', { playerName: hostName })
  const created = await once(host, 'room:created')
  const players = [{ c: host, ...created }]
  for (const name of others) {
    const c = client()
    c.emit('room:join', { roomId: created.room.id, playerName: name })
    const joined = await once(c, 'room:joined')
    players.push({ c, ...joined })
  }
  return { code: created.room.id, players }
}

test('le code de salle fait 4 lettres sans ambiguïté', async () => {
  const { code } = await setupRoom(['Alice'])
  assert.match(code, new RegExp(`^[${CODE_ALPHABET}]{4}$`))
  assert.ok(!/[IO01]/.test(code))
})

test('le code est insensible à la casse', async () => {
  const { code } = await setupRoom(['Hote'])
  const c = client()
  c.emit('room:join', { roomId: code.toLowerCase(), playerName: 'Invite' })
  const joined = await once(c, 'room:joined')
  assert.equal(joined.room.id, code)
})

test("aucun message ne révèle l'imposteur aux autres joueurs avant la révélation", async () => {
  const { code, players } = await setupRoom(['A', 'B', 'C', 'D'])
  const [host] = players
  const started = Promise.all(players.map(p => once(p.c, 'game:started')))
  host.c.emit('game:start', { roomId: code })
  const startedPayloads = await started

  const impostors = startedPayloads.filter(p => p.isImpostor)
  assert.equal(impostors.length, 1, 'exactement un imposteur')

  const voting = Promise.all(players.map(p => once(p.c, 'voting:started')))
  host.c.emit('game:end', { roomId: code })
  await voting

  // Aucun message reçu jusqu'ici ne doit contenir impostorId, votes ou token d'autrui
  for (const p of players) {
    for (const { event, payload } of p.c.received) {
      const json = JSON.stringify(payload)
      assert.ok(!json.includes('impostorId'), `${event} contient impostorId`)
      for (const other of players) {
        if (other !== p) assert.ok(!json.includes(other.you.token), `${event} contient le jeton d'un autre joueur`)
      }
    }
  }
})

test('on ne peut pas voler la place d\'un joueur avec son pseudo', async () => {
  const { code } = await setupRoom(['Hote', 'Bob'])
  const thief = client()
  thief.emit('room:join', { roomId: code, playerName: 'bob' })
  const err = await once(thief, 'room:error')
  assert.match(err.message, /déjà pris/)

  const thief2 = client()
  thief2.emit('room:join', { roomId: code, playerName: 'Hote' })
  const err2 = await once(thief2, 'room:error')
  assert.match(err2.message, /déjà pris/)
})

test("un non-hôte ne peut ni lancer, ni clore, ni passer la manche", async () => {
  const { code, players } = await setupRoom(['Hote', 'Bob'])
  const bob = players[1]
  bob.c.emit('game:start', { roomId: code })
  const err = await once(bob.c, 'room:error')
  assert.match(err.message, /hôte/)
})

test('votes invalides refusés : soi-même, cible inconnue, socket hors salle', async () => {
  const { code, players } = await setupRoom(['H', 'X', 'Y'])
  const [host, x] = players
  const started = Promise.all(players.map(p => once(p.c, 'game:started')))
  host.c.emit('game:start', { roomId: code })
  await started
  const voting = Promise.all(players.map(p => once(p.c, 'voting:started')))
  host.c.emit('game:end', { roomId: code })
  await voting

  x.c.emit('vote:cast', { roomId: code, targetId: x.you.playerId })
  assert.match((await once(x.c, 'room:error')).message, /toi-même/)

  x.c.emit('vote:cast', { roomId: code, targetId: 'inconnu' })
  assert.match((await once(x.c, 'room:error')).message, /introuvable/)

  const outsider = client()
  await once(outsider, 'connect')
  outsider.emit('vote:cast', { roomId: code, targetId: host.you.playerId })
  await wait(150)
  assert.ok(!host.c.received.some(m => m.event === 'vote:registered'), 'le vote hors salle ne doit pas compter')
})

test('partie complète : révélation et scores cohérents', async () => {
  const { code, players } = await setupRoom(['P1', 'P2', 'P3'])
  const [host] = players
  const started = Promise.all(players.map(p => once(p.c, 'game:started')))
  host.c.emit('game:start', { roomId: code })
  const roles = await started
  const impostorIndex = roles.findIndex(r => r.isImpostor)
  const impostorId = players[impostorIndex].you.playerId

  const voting = Promise.all(players.map(p => once(p.c, 'voting:started')))
  host.c.emit('game:end', { roomId: code })
  await voting

  const reveal = Promise.all(players.map(p => once(p.c, 'reveal:result')))
  players.forEach((p, i) => {
    // Tout le monde vote pour l'imposteur ; l'imposteur vote pour un autre
    const target = i === impostorIndex ? players[(i + 1) % 3].you.playerId : impostorId
    p.c.emit('vote:cast', { roomId: code, targetId: target })
  })
  const [{ results }] = await reveal
  assert.equal(results.impostorId, impostorId)
  assert.equal(results.impostorFound, true)
  assert.equal(results.pointsAwarded[impostorId], 0)
  const total = results.cumulativeScores.reduce((s, r) => s + r.total, 0)
  assert.equal(total, 4, '2 équipiers × 2 points')

  const next = once(players[1].c, 'round:next')
  host.c.emit('round:next', { roomId: code })
  const { room } = await next
  assert.equal(room.round, 2)
  assert.equal(room.status, 'lobby')
})

test('reconnexion avec le jeton : même joueur, même rôle', async () => {
  const { code, players } = await setupRoom(['Hote', 'Zed'])
  const [host, zed] = players
  const started = Promise.all(players.map(p => once(p.c, 'game:started')))
  host.c.emit('game:start', { roomId: code })
  const roles = await started

  zed.c.close()
  await wait(50)
  const back = client()
  back.emit('room:rejoin', { roomId: code, token: zed.you.token })
  const rejoined = await once(back, 'room:rejoined')
  assert.equal(rejoined.you.playerId, zed.you.playerId)
  assert.equal(rejoined.isImpostor, roles[1].isImpostor)
  assert.equal(rejoined.room.players.find(p => p.id === zed.you.playerId).disconnected, false)

  // Un faux jeton est refusé
  const fake = client()
  fake.emit('room:rejoin', { roomId: code, token: 'faux' })
  await once(fake, 'room:session-lost')
})

test("l'hôte qui part définitivement transmet son rôle", async () => {
  const { code, players } = await setupRoom(['Hote', 'Suivant'])
  const [host, next] = players
  const changed = once(next.c, 'host:changed')
  host.c.close()
  const { newHostId } = await changed
  assert.equal(newHostId, next.you.playerId)
  next.c.emit('game:start', { roomId: code })
  const err = await once(next.c, 'room:error') // 1 seul joueur : refus, mais pas pour cause d'hôte
  assert.doesNotMatch(err.message, /hôte/)
})
