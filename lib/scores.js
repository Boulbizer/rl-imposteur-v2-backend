// lib/scores.js
// Persistance des scores. Utilise Supabase si configuré, sinon une mémoire
// locale (développement et tests sans base de données).

const supabase = require('./supabase')

const memory = [] // { room_id, player_name, points }

async function saveScores(scoreKey, players, pointsAwarded) {
  const rows = players.map(player => ({
    room_id: scoreKey,
    player_name: player.name,
    points: pointsAwarded[player.id] || 0,
  }))

  if (!supabase) {
    memory.push(...rows)
    return
  }
  try {
    const { error } = await supabase.from('scores').insert(rows)
    if (error) console.error('Erreur Supabase saveScores:', error)
  } catch (err) {
    console.error('Erreur inattendue saveScores:', err)
  }
}

async function getTotalScores(scoreKey) {
  let data = []
  if (!supabase) {
    data = memory.filter(r => r.room_id === scoreKey)
  } else {
    try {
      const res = await supabase
        .from('scores')
        .select('player_name, points')
        .eq('room_id', scoreKey)
      if (res.error) {
        console.error('Erreur Supabase getTotalScores:', res.error)
        return []
      }
      data = res.data
    } catch (err) {
      console.error('Erreur inattendue getTotalScores:', err)
      return []
    }
  }

  const totals = {}
  for (const row of data) {
    totals[row.player_name] = (totals[row.player_name] || 0) + row.points
  }
  return Object.entries(totals)
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total)
}

module.exports = { saveScores, getTotalScores }
