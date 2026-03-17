// socket.js
// Tous les événements temps réel entre le serveur et les clients

const {
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
} = require('./rooms')
const supabase = require('./lib/supabase')

// Durée de grâce avant suppression définitive (30 secondes)
const GRACE_PERIOD_MS = 30_000

// Timers de grâce en cours : Map<socketId, { timerId, roomId }>
const pendingDisconnects = new Map()

// Sauvegarde les scores d'une manche dans Supabase
async function saveScores(roomId, players, pointsAwarded) {
  try {
    const rows = players.map(player => ({
      room_id: roomId,
      player_name: player.name,
      points: pointsAwarded[player.id] || 0,
    }))
    const { error } = await supabase.from('scores').insert(rows)
    if (error) console.error('Erreur Supabase saveScores:', error)
  } catch (err) {
    console.error('Erreur inattendue saveScores:', err)
  }
}

// Récupère les scores cumulés d'une salle depuis Supabase
async function getTotalScores(roomId) {
  try {
    const { data, error } = await supabase
      .from('scores')
      .select('player_name, points')
      .eq('room_id', roomId)

    if (error) {
      console.error('Erreur Supabase getTotalScores:', error)
      return []
    }

    // Agrège les points par joueur
    const totals = {}
    for (const row of data) {
      totals[row.player_name] = (totals[row.player_name] || 0) + row.points
    }

    return Object.entries(totals)
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => b.total - a.total)
  } catch (err) {
    console.error('Erreur inattendue getTotalScores:', err)
    return []
  }
}

function registerSocketEvents(io) {
  io.on('connection', (socket) => {
    console.log(`✅ Connecté : ${socket.id}`)

    // ─── CRÉER UNE SALLE ───────────────────────────────────────────
    socket.on('room:create', ({ playerName }) => {
      if (!playerName?.trim()) return

      const room = createRoom(socket.id, playerName.trim())
      socket.join(room.id)
      socket.emit('room:created', { room })
      console.log(`🏠 Salle créée : ${room.id} par ${playerName}`)
    })

    // ─── REJOINDRE UNE SALLE ───────────────────────────────────────
    socket.on('room:join', ({ roomId, playerName }) => {
      if (!playerName?.trim() || !roomId) return

      const result = joinRoom(roomId, socket.id, playerName.trim())
      if (result.error) {
        socket.emit('room:error', { message: result.error })
        return
      }

      socket.join(roomId)
      socket.emit('room:joined', { room: result.room })
      socket.to(roomId).emit('room:updated', { room: result.room })
      console.log(`👤 ${playerName} a rejoint la salle ${roomId}`)
    })

    // ─── RECONNEXION (grâce period) ─────────────────────────────────
    socket.on('room:rejoin', ({ roomId, playerName }) => {
      if (!playerName?.trim() || !roomId) return

      const result = rejoinPlayer(roomId, socket.id, playerName.trim())
      if (result.error) {
        // Si rejoin échoue et qu'on est en lobby, tenter un join normal
        const room = getRoom(roomId)
        if (room && room.status === 'lobby') {
          const joinResult = joinRoom(roomId, socket.id, playerName.trim())
          if (joinResult.error) {
            socket.emit('room:error', { message: joinResult.error })
            return
          }
          socket.join(roomId)
          socket.emit('room:joined', { room: joinResult.room })
          socket.to(roomId).emit('room:updated', { room: joinResult.room })
          return
        }
        socket.emit('room:error', { message: result.error })
        return
      }

      // Annule le timer de grâce s'il existe pour cet ancien socket
      for (const [oldSocketId, pending] of pendingDisconnects.entries()) {
        if (pending.roomId === roomId && pending.playerName === playerName) {
          clearTimeout(pending.timerId)
          pendingDisconnects.delete(oldSocketId)
          console.log(`🔄 Timer de grâce annulé pour ${playerName} (ancien: ${oldSocketId}, nouveau: ${socket.id})`)
          break
        }
      }

      socket.join(roomId)
      socket.emit('room:rejoined', {
        room: result.room,
        isImpostor: result.isImpostor,
      })
      socket.to(roomId).emit('room:updated', { room: result.room })
      console.log(`🔄 ${playerName} reconnecté dans la salle ${roomId} (nouveau socket: ${socket.id})`)
    })

    // ─── LANCER LA PARTIE ──────────────────────────────────────────
    socket.on('game:start', ({ roomId }) => {
      const room = getRoom(roomId)
      if (!room) return
      if (room.hostId !== socket.id) {
        socket.emit('room:error', { message: "Seul l'hôte peut lancer la partie" })
        return
      }
      if (room.players.length < 2) {
        socket.emit('room:error', { message: 'Il faut au moins 2 joueurs' })
        return
      }

      const updatedRoom = assignImpostor(roomId)

      for (const player of updatedRoom.players) {
        const playerSocket = io.sockets.sockets.get(player.id)
        if (playerSocket) {
          playerSocket.emit('game:started', {
            room: updatedRoom,
            isImpostor: player.id === updatedRoom.impostorId,
          })
        }
      }
      console.log(`🚀 Partie lancée dans la salle ${roomId} | Imposteur : ${updatedRoom.impostorId}`)
    })

    // ─── FIN DE PARTIE RL (bouton hôte) ───────────────────────────
    socket.on('game:end', ({ roomId }) => {
      const room = getRoom(roomId)
      if (!room) return
      if (room.hostId !== socket.id) return

      room.status = 'voting'
      io.to(roomId).emit('voting:started', { room })
      console.log(`🗳️  Vote démarré dans la salle ${roomId}`)
    })

    // ─── VOTER ─────────────────────────────────────────────────────
    socket.on('vote:cast', async ({ roomId, targetId }) => {
      const room = castVote(roomId, socket.id, targetId)
      if (!room) return

      const votesCount = Object.keys(room.votes).length
      // Seuls les joueurs connectés doivent voter
      const connectedPlayers = room.players.filter(p => !p.disconnected)
      const totalPlayers = connectedPlayers.length

      io.to(roomId).emit('vote:registered', { votesCount, totalPlayers })

      if (votesCount >= totalPlayers) {
        const results = computeResults(roomId)
        await saveScores(roomId, results.players, results.pointsAwarded)
        io.to(roomId).emit('reveal:result', { results })
        console.log(`📊 Résultats calculés pour la salle ${roomId}`)
      }
    })

    // ─── VOIR LES SCORES CUMULÉS ───────────────────────────────────
    socket.on('scores:request', async ({ roomId }) => {
      const scores = await getTotalScores(roomId)
      const room = getRoom(roomId)
      socket.emit('scores:data', { scores, room })
      console.log(`📋 Scores demandés pour la salle ${roomId}`)
    })

    // ─── MANCHE SUIVANTE ───────────────────────────────────────────
    // Sécurisé : vérification uniquement par socket.id
    socket.on('round:next', ({ roomId }) => {
      const room = getRoom(roomId)
      if (!room) return
      if (room.hostId !== socket.id) {
        console.log(`⛔ round:next refusé — socket: ${socket.id}, hostId attendu: ${room.hostId}`)
        return
      }

      const updatedRoom = nextRound(roomId)
      io.to(roomId).emit('round:next', { room: updatedRoom })
      console.log(`🔄 Manche ${updatedRoom.round} dans la salle ${roomId}`)
    })

    // ─── DÉCONNEXION ───────────────────────────────────────────────
    // Période de grâce : le joueur est marqué déconnecté pendant 30s
    // avant d'être définitivement retiré
    socket.on('disconnect', () => {
      const info = disconnectPlayer(socket.id)
      if (!info) {
        console.log(`❌ Déconnecté (hors salle) : ${socket.id}`)
        return
      }

      const { roomId, room, playerName } = info

      // Notifie les autres joueurs du statut déconnecté
      io.to(roomId).emit('room:updated', { room })
      console.log(`⏳ ${playerName} déconnecté — grâce de ${GRACE_PERIOD_MS / 1000}s (salle ${roomId})`)

      // Lance le timer de grâce
      const timerId = setTimeout(() => {
        pendingDisconnects.delete(socket.id)

        // Vérifie que le joueur est toujours marqué déconnecté
        const currentRoom = getRoom(roomId)
        if (!currentRoom) return
        const player = currentRoom.players.find(p => p.id === socket.id)
        if (!player || !player.disconnected) return

        // Suppression définitive
        const result = leaveRoom(socket.id)
        if (result?.roomId && result.room) {
          io.to(result.roomId).emit('room:updated', { room: result.room })
          if (result.wasHost) {
            io.to(result.roomId).emit('host:changed', { newHostId: result.room.hostId })
          }
          console.log(`❌ ${playerName} définitivement retiré après grâce (salle ${roomId})`)
        } else if (result?.roomId && !result.room) {
          console.log(`🗑️ Salle ${roomId} supprimée (vide après départ de ${playerName})`)
        }
      }, GRACE_PERIOD_MS)

      pendingDisconnects.set(socket.id, { timerId, roomId, playerName })
    })
  })
}

module.exports = { registerSocketEvents }
