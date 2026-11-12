// store/supabase.ts
// Choix du stockage selon la configuration.
// La "service key" a tous les droits — ne jamais l'exposer côté frontend.

import { createClient } from '@supabase/supabase-js'
import { FileStorage, MemoryStorage, SupabaseStorage, type Storage } from './storage'

export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): Storage {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, ROOMS_FILE } = env
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    return new SupabaseStorage(createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY))
  }
  if (ROOMS_FILE) {
    console.warn(`💾 Supabase non configuré : salles et scores dans ${ROOMS_FILE}`)
    return new FileStorage(ROOMS_FILE)
  }
  console.warn('⚠️  Supabase non configuré : salles et scores conservés en mémoire uniquement')
  return new MemoryStorage()
}
