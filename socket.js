// socket.js
// Tous les événements temps réel entre le serveur et les clients

const {
  createRoom,
  joinRoom,
  leaveRoom,
  assignImpostor,
  castVote,
  computeResults,
  nextRound,
  getRoom,
} = require('./rooms')
const supabase = require('./lib/supabase')

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
    // Émis par : l'hôte depuis la page d'accueil
    // Reçoit   : { playerName }
    // Émet     : 'room:created' → { room } (à l'hôte uniquement)
    socket.on('room:create', ({ playerName }) => {
      if (!playerName?.trim()) return

      const room = createRoom(socket.id, playerName.trim())
      socket.join(room.id)
      socket.emit('room:created', { room })
      console.log(`🏠 Salle créée : ${room.id} par ${playerName}`)
    })

    // ─── REJOINDRE UNE SALLE ───────────────────────────────────────
    // Émis par : un joueur qui clique sur le lien d'invitation
    // Reçoit   : { roomId, playerName }
    // Émet     : 'room:joined'   → { room } (au joueur uniquement)
    //            'room:updated'  → { room } (à toute la salle)
    socket.on('room:join', ({ roomId, playerName }) => {
      if (!playerName?.trim() || !roomId) return

      const result = joinRoom(roomId, socket.id, playerName.trim())
      if (result.error) {
        socket.emit('room:error', { message: result.error })
        return
      }

      socket.join(roomId)
      socket.emit('room:joined', { room: result.room })
      // Notifie tous les autres joueurs de la salle
      socket.to(roomId).emit('room:updated', { room: result.room })
      console.log(`👤 ${playerName} a rejoint la salle ${roomId}`)
    })

    // ─── LANCER LA PARTIE ──────────────────────────────────────────
    // Émis par : l'hôte uniquement
    // Reçoit   : { roomId }
    // Émet     : 'game:started' → { room, isImpostor } (individuellement à chaque joueur)
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

      // Envoie à chaque joueur son rôle individuellement (secret !)
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
    // Émis par : l'hôte quand la partie RL est terminée
    // Reçoit   : { roomId }
    // Émet     : 'voting:started' → { room } (à toute la salle)
    socket.on('game:end', ({ roomId }) => {
      const room = getRoom(roomId)
      if (!room) return
      if (room.hostId !== socket.id) return

      room.status = 'voting'
      io.to(roomId).emit('voting:started', { room })
      console.log(`🗳️  Vote démarré dans la salle ${roomId}`)
    })

    // ─── VOTER ─────────────────────────────────────────────────────
    // Émis par : chaque joueur pendant la phase de vote
    // Reçoit   : { roomId, targetId }
    // Émet     : 'vote:registered' → { votesCount, totalPlayers } (à toute la salle)
    //            'reveal:result'   → résultats complets (quand tout le monde a voté)
    socket.on('vote:cast', async ({ roomId, targetId }) => {
      const room = castVote(roomId, socket.id, targetId)
      if (!room) return

      const votesCount = Object.keys(room.votes).length
      const totalPlayers = room.players.length

      io.to(roomId).emit('vote:registered', { votesCount, totalPlayers })

      // Tout le monde a voté → on calcule les résultats
      if (votesCount >= totalPlayers) {
        const results = computeResults(roomId)

        // Sauvegarde les scores dans Supabase
        await saveScores(roomId, results.players, results.pointsAwarded)

        io.to(roomId).emit('reveal:result', { results })
        console.log(`📊 Résultats calculés pour la salle ${roomId}`)
      }
    })

    // ─── VOIR LES SCORES CUMULÉS ───────────────────────────────────
    // Émis par : n'importe quel client après la révélation
    // Reçoit   : { roomId }
    // Émet     : 'scores:data' → { scores } (au demandeur)
    socket.on('scores:request', async ({ roomId }) => {
      const scores = await getTotalScores(roomId)
      socket.emit('scores:data', { scores })
    })

    // ─── MANCHE SUIVANTE ───────────────────────────────────────────
    // Émis par : l'hôte depuis l'écran des scores
    // Reçoit   : { roomId }
    // Émet     : 'round:next' → { room } (à toute la salle)
    socket.on('round:next', ({ roomId }) => {
      const room = getRoom(roomId)
      if (!room) return
      if (room.hostId !== socket.id) return

      const updatedRoom = nextRound(roomId)
      io.to(roomId).emit('round:next', { room: updatedRoom })
      console.log(`🔄 Manche ${updatedRoom.round} dans la salle ${roomId}`)
    })

    // ─── DÉCONNEXION ───────────────────────────────────────────────
    socket.on('disconnect', () => {
      const result = leaveRoom(socket.id)
      if (result?.roomId && result.room) {
        io.to(result.roomId).emit('room:updated', { room: result.room })
        if (result.wasHost) {
          io.to(result.roomId).emit('host:changed', { newHostId: result.room.hostId })
        }
      }
      console.log(`❌ Déconnecté : ${socket.id}`)
    })
  })
}

module.exports = { registerSocketEvents }
