// lib/supabase.js
// Connexion à Supabase depuis le backend
// La "service key" a tous les droits — ne jamais l'exposer côté frontend
// Sans configuration, exporte null : les scores restent alors en mémoire.

const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env

let supabase = null
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
} else {
  console.warn('⚠️  Supabase non configuré : scores conservés en mémoire uniquement')
}

module.exports = supabase
