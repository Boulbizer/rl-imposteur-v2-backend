// rooms.js
// Gestion des salles en mémoire (pendant la durée de vie du serveur)
// Supabase sert uniquement à persister les SCORES entre les manches

// Structure d'une salle :
// {
//   id: "t1710abc12",        ← préfixe temporel + aléatoire (anti-collision)
//   hostId: "socket-id",     ← socket.id de l'hôte
//   hostName: "Pseudo",
//   players: [
//     { id: "socket-id", name: "Pseudo", disconnected: false }
//   ],
//   status: "lobby" | "playing" | "voting" | "reveal",
//   impostorId: null,
//   votes: {},               ← { voterId: targetId }
//   round: 1,
// }

const rooms = new Map()

// Génère un ID unique avec préfixe temporel pour éviter les collisions Supabase
function generateRoomId() {
  const timestamp = Date.now().toString(36) // base36 compact
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let rand = ''
  for (let i = 0; i < 4; i++) {
    rand += chars[Math.floor(Math.random() * chars.length)]
  }
  const id = `${timestamp}${rand}`
  if (rooms.has(id)) return generateRoomId()
  return id
}

// Crée une nouvelle salle
function createRoom(hostId, hostName) {
  const roomId = generateRoomId()
  const room = {
    id: roomId,
    hostId,
    hostName,
    players: [{ id: hostId, name: hostName, disconnected: false }],
    status: 'lobby',
    impostorId: null,
    votes: {},
    round: 1,
  }
  rooms.set(roomId, room)
  return room
}

// Ajoute un joueur à une salle existante
function joinRoom(roomId, playerId, playerName) {
  const room = rooms.get(roomId)
  if (!room) return { error: 'Salle introuvable' }
  if (room.status !== 'lobby') return { error: 'La partie a déjà commencé' }
  if (room.players.length >= 10) return { error: 'Salle pleine (10 joueurs max)' }

  // Vérifie l'unicité du pseudo dans la salle
  const nameTaken = room.players.find(
    p => p.name.toLowerCase() === playerName.toLowerCase() && p.id !== playerId
  )
  if (nameTaken) return { error: 'Ce pseudo est déjà pris dans cette salle' }

  // Évite les doublons (reconnexion au lobby)
  const exists = room.players.find(p => p.id === playerId)
  if (!exists) {
    room.players.push({ id: playerId, name: playerName, disconnected: false })
  }
  return { room }
}

// Marque un joueur comme déconnecté (sans le retirer)
// Retourne les infos nécessaires pour gérer le timer de grâce
function disconnectPlayer(playerId) {
  for (const [roomId, room] of rooms.entries()) {
    const player = room.players.find(p => p.id === playerId)
    if (player) {
      player.disconnected = true
      return { roomId, room, playerName: player.name }
    }
  }
  return null
}

// Reconnecte un joueur déconnecté (met à jour son socket.id)
function rejoinPlayer(roomId, newSocketId, playerName) {
  const room = rooms.get(roomId)
  if (!room) return { error: 'Salle introuvable' }

  const player = room.players.find(
    p => p.name === playerName && p.disconnected
  )
  if (!player) return { error: 'Joueur non trouvé ou déjà connecté' }

  const oldId = player.id
  player.id = newSocketId
  player.disconnected = false

  // Met à jour hostId si ce joueur est l'hôte
  if (room.hostId === oldId) {
    room.hostId = newSocketId
  }

  // Met à jour impostorId si ce joueur est l'imposteur
  if (room.impostorId === oldId) {
    room.impostorId = newSocketId
  }

  // Met à jour les votes (clés = voterId)
  if (room.votes[oldId] !== undefined) {
    room.votes[newSocketId] = room.votes[oldId]
    delete room.votes[oldId]
  }
  // Met à jour les votes (valeurs = targetId)
  for (const [voterId, targetId] of Object.entries(room.votes)) {
    if (targetId === oldId) {
      room.votes[voterId] = newSocketId
    }
  }

  return { room, isImpostor: room.impostorId === newSocketId }
}

// Retire définitivement un joueur (appelé après expiration du timer de grâce)
function leaveRoom(playerId) {
  for (const [roomId, room] of rooms.entries()) {
    const index = room.players.findIndex(p => p.id === playerId)
    if (index !== -1) {
      room.players.splice(index, 1)

      // Si la salle est vide, on la supprime
      if (room.players.length === 0) {
        rooms.delete(roomId)
        return { roomId, room: null, wasHost: false }
      }

      // Si l'hôte part, on passe le rôle au prochain joueur connecté
      const wasHost = room.hostId === playerId
      if (wasHost && room.players.length > 0) {
        const nextHost = room.players.find(p => !p.disconnected) || room.players[0]
        room.hostId = nextHost.id
        room.hostName = nextHost.name
      }

      return { roomId, room, wasHost }
    }
  }
  return null
}

// Désigne aléatoirement l'imposteur parmi les joueurs connectés
function assignImpostor(roomId) {
  const room = rooms.get(roomId)
  if (!room || room.players.length < 2) return null

  const connected = room.players.filter(p => !p.disconnected)
  if (connected.length < 2) return null

  const randomIndex = Math.floor(Math.random() * connected.length)
  room.impostorId = connected[randomIndex].id
  room.status = 'playing'
  return room
}

// Enregistre un vote
function castVote(roomId, voterId, targetId) {
  const room = rooms.get(roomId)
  if (!room || room.status !== 'voting') return null

  room.votes[voterId] = targetId
  return room
}

// Calcule les résultats des votes
function computeResults(roomId) {
  const room = rooms.get(roomId)
  if (!room) return null

  // Compte les votes par joueur ciblé
  const tally = {}
  for (const targetId of Object.values(room.votes)) {
    tally[targetId] = (tally[targetId] || 0) + 1
  }

  // Trouve le joueur le plus voté (en cas d'égalité, l'imposteur est considéré trouvé)
  let maxVotes = 0
  let accusedId = null
  for (const [playerId, count] of Object.entries(tally)) {
    if (count > maxVotes) {
      maxVotes = count
      accusedId = playerId
    }
  }

  // En cas d'égalité, vérifie si l'imposteur fait partie des ex-aequo
  const tiedPlayers = Object.entries(tally)
    .filter(([, count]) => count === maxVotes)
    .map(([id]) => id)
  const impostorInTie = tiedPlayers.includes(room.impostorId)
  if (impostorInTie) accusedId = room.impostorId

  const impostorFound = accusedId === room.impostorId
  const impostor = room.players.find(p => p.id === room.impostorId)
  const accused = room.players.find(p => p.id === accusedId)

  // Calcul des points :
  // - Imposteur non découvert : +3 pts
  // - Joueur ayant voté correctement : +2 pts
  // - Joueur ayant voté incorrectement : 0 pt
  const pointsAwarded = {}
  for (const player of room.players) {
    let pts = 0
    if (player.id === room.impostorId) {
      pts = impostorFound ? 0 : 3
    } else {
      pts = room.votes[player.id] === room.impostorId ? 2 : 0
    }
    pointsAwarded[player.id] = pts
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
    players: room.players,
  }
}

// Prépare la manche suivante (remet votes + imposteur à zéro)
function nextRound(roomId) {
  const room = rooms.get(roomId)
  if (!room) return null
  room.votes = {}
  room.impostorId = null
  room.status = 'lobby'
  room.round += 1
  return room
}

function getRoom(roomId) {
  return rooms.get(roomId) || null
}

module.exports = {
  createRoom,
  joinRoom,
  leaveRoom,
  disconnectPlayer,
  rejoinPlayer,
  assignImpostor,
  castVote,
  computeResults,
  nextRound,
  getRoom,
}
