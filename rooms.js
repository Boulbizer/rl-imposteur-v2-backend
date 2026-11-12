// rooms.js
// Gestion des salles en mémoire (pendant la durée de vie du serveur)
// Supabase sert uniquement à persister les SCORES entre les manches
//
// Identité : chaque joueur a un `id` stable (jamais lié au socket) et un
// `token` secret connu seulement de son navigateur. Le pseudo n'est qu'un
// affichage : il ne permet ni de se reconnecter ni de prendre une place.
//
// Structure d'une salle :
// {
//   id: "KBRT",              ← code court à 4 lettres (dictable en vocal)
//   scoreKey: "m3k9x2ab",    ← identifiant unique pour Supabase (le code peut être réutilisé)
//   hostId: "player-id",
//   hostName: "Pseudo",
//   players: [{ id, token, socketId, name, disconnected }],
//   status: "lobby" | "playing" | "voting" | "reveal",
//   impostorId: null,        ← JAMAIS envoyé aux clients avant la révélation
//   votes: {},               ← { voterId: targetId } — idem
//   round: 1,
// }

const crypto = require('crypto')

const rooms = new Map()

const MAX_PLAYERS = 10
// Pas de I ni de O : évite la confusion avec 1 et 0 à l'oral comme à l'écrit
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const CODE_LENGTH = 4

function randomCode() {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
  }
  return code
}

function generateRoomCode() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const code = randomCode()
    if (!rooms.has(code)) return code
  }
  throw new Error('Impossible de générer un code de salle libre')
}

// Clé unique pour Supabase : préfixe temporel + aléatoire
function generateScoreKey() {
  return Date.now().toString(36) + crypto.randomBytes(3).toString('hex')
}

function normalizeCode(roomId) {
  return typeof roomId === 'string' ? roomId.trim().toUpperCase() : ''
}

function newPlayer(socketId, name) {
  return {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(24).toString('base64url'),
    socketId,
    name,
    disconnected: false,
  }
}

// Vue publique d'une salle : ce que TOUS les joueurs ont le droit de voir.
// Ni imposteur, ni votes nominatifs, ni jetons.
function publicRoom(room) {
  if (!room) return null
  const connected = room.players.filter(p => !p.disconnected)
  return {
    id: room.id,
    hostId: room.hostId,
    hostName: room.hostName,
    status: room.status,
    round: room.round,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      disconnected: p.disconnected,
      hasVoted: room.status === 'voting' ? room.votes[p.id] !== undefined : false,
    })),
    votesCount: connected.filter(p => room.votes[p.id] !== undefined).length,
  }
}

// Informations privées d'un joueur (envoyées uniquement à lui)
function privateView(room, player) {
  return {
    you: { playerId: player.id, token: player.token, name: player.name },
    isImpostor: room.status !== 'lobby' && room.impostorId === player.id,
  }
}

function createRoom(socketId, hostName) {
  const host = newPlayer(socketId, hostName)
  const room = {
    id: generateRoomCode(),
    scoreKey: generateScoreKey(),
    hostId: host.id,
    hostName,
    players: [host],
    status: 'lobby',
    impostorId: null,
    votes: {},
    round: 1,
  }
  rooms.set(room.id, room)
  return { room, player: host }
}

// Rejoint une salle. Avec un jeton valide → reconnexion du même joueur.
// Sans jeton → nouveau joueur, seulement en lobby et si le pseudo est libre.
function joinRoom(roomId, socketId, playerName, token) {
  const room = rooms.get(normalizeCode(roomId))
  if (!room) return { error: 'Salle introuvable' }

  if (token) {
    const player = room.players.find(p => p.token === token)
    if (player) {
      player.socketId = socketId
      player.disconnected = false
      return { room, player, reconnected: true }
    }
  }

  const name = typeof playerName === 'string' ? playerName.trim() : ''
  if (!name) return { error: 'Pseudo requis' }
  if (name.length > 20) return { error: 'Pseudo trop long (20 caractères max)' }
  if (room.status !== 'lobby') return { error: 'La partie a déjà commencé' }
  if (room.players.length >= MAX_PLAYERS) return { error: `Salle pleine (${MAX_PLAYERS} joueurs max)` }
  if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    return { error: 'Ce pseudo est déjà pris dans cette salle' }
  }

  const player = newPlayer(socketId, name)
  room.players.push(player)
  return { room, player, reconnected: false }
}

// Retrouve le joueur associé à un socket
function findBySocket(socketId) {
  for (const room of rooms.values()) {
    const player = room.players.find(p => p.socketId === socketId)
    if (player) return { room, player }
  }
  return null
}

// Marque un joueur comme déconnecté (sans le retirer)
function disconnectSocket(socketId) {
  const found = findBySocket(socketId)
  if (!found) return null
  found.player.disconnected = true
  found.player.socketId = null
  return found
}

// Retire définitivement un joueur (après expiration du timer de grâce)
function removePlayer(roomId, playerId) {
  const room = rooms.get(roomId)
  if (!room) return null
  const index = room.players.findIndex(p => p.id === playerId)
  if (index === -1) return null

  room.players.splice(index, 1)
  delete room.votes[playerId]
  for (const [voterId, targetId] of Object.entries(room.votes)) {
    if (targetId === playerId) delete room.votes[voterId]
  }

  if (room.players.length === 0) {
    rooms.delete(roomId)
    return { room: null, wasHost: false }
  }

  const wasHost = room.hostId === playerId
  if (wasHost) {
    const nextHost = room.players.find(p => !p.disconnected) || room.players[0]
    room.hostId = nextHost.id
    room.hostName = nextHost.name
  }
  return { room, wasHost }
}

function isHost(room, player) {
  return !!room && !!player && room.hostId === player.id
}

// Désigne aléatoirement l'imposteur parmi les joueurs connectés
function assignImpostor(room) {
  const connected = room.players.filter(p => !p.disconnected)
  if (connected.length < 2) return { error: 'Il faut au moins 2 joueurs connectés' }
  room.impostorId = connected[crypto.randomInt(connected.length)].id
  room.votes = {}
  room.status = 'playing'
  return { room }
}

function startVoting(room) {
  if (room.status !== 'playing') return { error: "La partie n'est pas en cours" }
  room.status = 'voting'
  room.votes = {}
  return { room }
}

// Enregistre un vote après validation complète
function castVote(room, voter, targetId) {
  if (room.status !== 'voting') return { error: "Le vote n'est pas ouvert" }
  if (voter.disconnected) return { error: 'Joueur déconnecté' }
  if (targetId === voter.id) return { error: 'Tu ne peux pas voter pour toi-même' }
  if (!room.players.some(p => p.id === targetId)) return { error: 'Joueur ciblé introuvable' }
  room.votes[voter.id] = targetId
  return { room }
}

// Tous les joueurs connectés ont-ils voté ?
function allVoted(room) {
  if (room.status !== 'voting') return false
  const connected = room.players.filter(p => !p.disconnected)
  return connected.length > 0 && connected.every(p => room.votes[p.id] !== undefined)
}

// Calcule les résultats des votes
function computeResults(room) {
  const tally = {}
  for (const targetId of Object.values(room.votes)) {
    tally[targetId] = (tally[targetId] || 0) + 1
  }

  let maxVotes = 0
  let accusedId = null
  for (const [playerId, count] of Object.entries(tally)) {
    if (count > maxVotes) {
      maxVotes = count
      accusedId = playerId
    }
  }

  // En cas d'égalité, l'imposteur est considéré trouvé s'il fait partie des ex-aequo
  const tiedPlayers = Object.entries(tally)
    .filter(([, count]) => count === maxVotes)
    .map(([id]) => id)
  if (tiedPlayers.includes(room.impostorId)) accusedId = room.impostorId

  const impostorFound = accusedId === room.impostorId
  const impostor = room.players.find(p => p.id === room.impostorId)
  const accused = room.players.find(p => p.id === accusedId)

  // Barème :
  // - Imposteur non découvert : +3 pts
  // - Joueur ayant voté correctement : +2 pts
  const pointsAwarded = {}
  for (const player of room.players) {
    if (player.id === room.impostorId) {
      pointsAwarded[player.id] = impostorFound ? 0 : 3
    } else {
      pointsAwarded[player.id] = room.votes[player.id] === room.impostorId ? 2 : 0
    }
  }

  room.status = 'reveal'

  return {
    impostorFound,
    impostorId: room.impostorId,
    impostorName: impostor?.name,
    accusedId,
    accusedName: accused?.name,
    tally,
    pointsAwarded,
    players: publicRoom(room).players,
    votes: { ...room.votes },
  }
}

// Prépare la manche suivante
function nextRound(room) {
  room.votes = {}
  room.impostorId = null
  room.status = 'lobby'
  room.round += 1
  return room
}

function getRoom(roomId) {
  return rooms.get(normalizeCode(roomId)) || null
}

// Utilisé par les tests uniquement
function _reset() {
  rooms.clear()
}

module.exports = {
  CODE_ALPHABET,
  CODE_LENGTH,
  MAX_PLAYERS,
  publicRoom,
  privateView,
  createRoom,
  joinRoom,
  findBySocket,
  disconnectSocket,
  removePlayer,
  isHost,
  assignImpostor,
  startVoting,
  castVote,
  allVoted,
  computeResults,
  nextRound,
  getRoom,
  normalizeCode,
  _reset,
}
