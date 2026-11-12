-- Salles persistées : une ligne par salle active, état complet en JSON.
-- Permet à une partie de survivre à un redémarrage du serveur.
-- Contient les jetons de session : accès réservé à la service key.

create table if not exists public.rooms (
  code        text primary key,
  state       jsonb not null,
  updated_at  timestamptz not null default now()
);

create index if not exists rooms_updated_at_idx on public.rooms (updated_at);

-- RLS activée sans aucune policy : les clés anon/authenticated n'ont aucun
-- accès. Seul le backend (service key, qui contourne RLS) lit et écrit.
alter table public.rooms enable row level security;
