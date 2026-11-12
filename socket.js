// socket.js
// Tous les événements temps réel entre le serveur et les clients
//
// Règle de sécurité : on n'envoie JAMAIS l'objet salle brut. Tout le monde
// reçoit `publicRoom(room)` ; le rôle de chacun part dans un message privé.

const {
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
} = require('./rooms')
const { saveScores, getTotalScores } = require('./lib/scores')

// Durée de grâce avant suppression définitive (30 secondes par défaut)
const GRACE_PERIOD_MS = Number(process.env.GRACE_PERIOD_MS) || 30_000

function registerSocketEvents(io) {
  // Timers de grâce en cours : Map<playerId, timerId>
  const pendingRemovals = new Map()

  const broadcastRoom = (room) => {
    io.to(room.id).emit('room:updated', { room: publicRoom(room) })
  }

  const cancelRemoval = (playerId) => {
    const timer = pendingRemovals.get(playerId)
    if (timer) {
      clearTimeout(timer)
      pendingRemovals.delete(playerId)
    }
  }

  // Clôture le vote si tous les joueurs connectés ont voté
  const finishVoteIfComplete = async (room) => {
    if (!allVoted(room)) return
    const results = computeResults(room)
    await saveScores(room.scoreKey, room.players, results.pointsAwarded)
    results.cumulativeScores = await getTotalScores(room.scoreKey)
    io.to(room.id).emit('reveal:result', { results, room: publicRoom(room) })
    console.log(`📊 Résultats calculés pour la salle ${room.id}`)
  }

  // Le socket courant est-il l'hôte de cette salle ?
  const hostContext = (socket, roomId) => {
    const room = getRoom(roomId)
    const found = findBySocket(socket.id)
    if (!room || !found || found.room !== room) return { room: null }
    return { room, player: found.player, isHost: isHost(room, found.player) }
  }

  const sendJoin = (socket, event, room, player) => {
    socket.join(room.id)
    socket.emit(event, { room: publicRoom(room), ...privateView(room, player) })
    socket.to(room.id).emit('room:updated', { room: publicRoom(room) })
  }

  io.on('connection', (socket) => {
    console.log(`✅ Connecté : ${socket.id}`)

    // Un socket n'appartient qu'à une salle : on le détache de l'ancienne
    const leavePreviousRoom = () => {
      const previous = findBySocket(socket.id)
      if (previous) {
        socket.leave(previous.room.id)
        disconnectSocket(socket.id)
        broadcastRoom(previous.room)
      }
    }

    // ─── CRÉER UNE SALLE ───────────────────────────────────────────
    socket.on('room:create', ({ playerName } = {}) => {
      const name = typeof playerName === 'string' ? playerName.trim().slice(0, 20) : ''
      if (!name) return socket.emit('room:error', { message: 'Pseudo requis' })

      leavePreviousRoom()
      const { room, player } = createRoom(socket.id, name)
      socket.join(room.id)
      socket.emit('room:created', { room: publicRoom(room), ...privateView(room, player) })
      console.log(`🏠 Salle créée : ${room.id} par ${name}`)
    })

    // ─── REJOINDRE UNE SALLE (ou s'y reconnecter avec son jeton) ──
    socket.on('room:join', ({ roomId, playerName, token } = {}) => {
      const current = findBySocket(socket.id)
      const result = joinRoom(roomId, socket.id, playerName, token)
      if (result.error) {
        socket.emit('room:error', { message: result.error })
        return
      }
      if (current && current.room !== result.room) {
        socket.leave(current.room.id)
        current.player.disconnected = true
        current.player.socketId = null
        broadcastRoom(current.room)
      }
      cancelRemoval(result.player.id)
      sendJoin(socket, result.reconnected ? 'room:rejoined' : 'room:joined', result.room, result.player)
      console.log(`👤 ${result.player.name} ${result.reconnected ? 'reconnecté à' : 'a rejoint'} la salle ${result.room.id}`)
    })

    // ─── RECONNEXION AUTOMATIQUE (jeton obligatoire) ───────────────
    socket.on('room:rejoin', ({ roomId, token } = {}) => {
      if (!token) return socket.emit('room:error', { message: 'Session expirée' })
      const result = joinRoom(roomId, socket.id, null, token)
      if (result.error || !result.reconnected) {
        socket.emit('room:session-lost', { message: result.error || 'Session expirée' })
        return
      }
      cancelRemoval(result.player.id)
      sendJoin(socket, 'room:rejoined', result.room, result.player)
      console.log(`🔄 ${result.player.name} reconnecté dans la salle ${result.room.id}`)
    })

    // ─── LANCER LA PARTIE ──────────────────────────────────────────
    socket.on('game:start', ({ roomId } = {}) => {
      const ctx = hostContext(socket, roomId)
      if (!ctx.room) return
      if (!ctx.isHost) {
        socket.emit('room:error', { message: "Seul l'hôte peut lancer la partie" })
        return
      }
      if (ctx.room.status !== 'lobby') return
      const result = assignImpostor(ctx.room)
      if (result.error) {
        socket.emit('room:error', { message: result.error })
        return
      }

      const room = result.room
      const pub = publicRoom(room)
      for (const player of room.players) {
        if (!player.socketId) continue
        io.to(player.socketId).emit('game:started', {
          room: pub,
          isImpostor: player.id === room.impostorId,
        })
      }
      console.log(`🚀 Partie lancée dans la salle ${room.id}`)
    })

    // ─── FIN DE PARTIE RL (bouton hôte) ───────────────────────────
    socket.on('game:end', ({ roomId } = {}) => {
      const ctx = hostContext(socket, roomId)
      if (!ctx.room || !ctx.isHost) return
      const result = startVoting(ctx.room)
      if (result.error) return
      io.to(ctx.room.id).emit('voting:started', { room: publicRoom(ctx.room) })
      console.log(`🗳️  Vote démarré dans la salle ${ctx.room.id}`)
    })

    // ─── VOTER ─────────────────────────────────────────────────────
    socket.on('vote:cast', async ({ roomId, targetId } = {}) => {
      const room = getRoom(roomId)
      const found = findBySocket(socket.id)
      if (!room || !found || found.room !== room) return

      const result = castVote(room, found.player, targetId)
      if (result.error) {
        socket.emit('room:error', { message: result.error })
        return
      }

      const pub = publicRoom(room)
      const totalPlayers = pub.players.filter(p => !p.disconnected).length
      io.to(room.id).emit('vote:registered', { votesCount: pub.votesCount, totalPlayers })
      broadcastRoom(room)
      await finishVoteIfComplete(room)
    })

    // ─── VOIR LES SCORES CUMULÉS ───────────────────────────────────
    socket.on('scores:request', async ({ roomId } = {}) => {
      const room = getRoom(roomId)
      const found = findBySocket(socket.id)
      if (!room || !found || found.room !== room) return
      const scores = await getTotalScores(room.scoreKey)
      socket.emit('scores:data', { scores, room: publicRoom(room) })
    })

    // ─── MANCHE SUIVANTE ───────────────────────────────────────────
    socket.on('round:next', ({ roomId } = {}) => {
      const ctx = hostContext(socket, roomId)
      if (!ctx.room || !ctx.isHost || ctx.room.status !== 'reveal') return
      nextRound(ctx.room)
      io.to(ctx.room.id).emit('round:next', { room: publicRoom(ctx.room) })
      console.log(`🔄 Manche ${ctx.room.round} dans la salle ${ctx.room.id}`)
    })

    // ─── DÉCONNEXION ───────────────────────────────────────────────
    // Période de grâce : le joueur reste dans la salle, marqué déconnecté
    socket.on('disconnect', () => {
      const found = disconnectSocket(socket.id)
      if (!found) return
      const { room, player } = found
      broadcastRoom(room)
      // Un vote peut se terminer si le dernier votant manquant part
      finishVoteIfComplete(room)
      console.log(`⏳ ${player.name} déconnecté — grâce de ${GRACE_PERIOD_MS / 1000}s (salle ${room.id})`)

      cancelRemoval(player.id)
      const timer = setTimeout(() => {
        pendingRemovals.delete(player.id)
        if (!player.disconnected) return
        const result = removePlayer(room.id, player.id)
        if (!result) return
        if (!result.room) {
          console.log(`🗑️ Salle ${room.id} supprimée (vide)`)
          return
        }
        broadcastRoom(result.room)
        if (result.wasHost) {
          io.to(room.id).emit('host:changed', { newHostId: result.room.hostId })
        }
        finishVoteIfComplete(result.room)
        console.log(`❌ ${player.name} retiré après grâce (salle ${room.id})`)
      }, GRACE_PERIOD_MS)
      pendingRemovals.set(player.id, timer)
    })
  })
}

module.exports = { registerSocketEvents }
