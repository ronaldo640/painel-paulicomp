-- ============================================================
-- Checklist de início do dia da Fiorino (preenchido pelo motorista).
--
-- limpeza_checklists: um checklist por dia (data é única; a data é a de
--   Brasília no momento do envio). Guarda quem preencheu, o km do painel e os
--   itens como lista JSON: [{ "id": "oleo", "status": "ok" | "problema",
--   "fotos": ["https://...blob..."] }]. Item com problema exige foto; as fotos
--   ficam no Vercel Blob (pasta limpeza-veiculo/), aqui só os endereços.
--
-- Cole no SQL Editor do Neon. Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS limpeza_checklists (
  id         SERIAL PRIMARY KEY,
  data       DATE NOT NULL UNIQUE,
  motorista  TEXT NOT NULL DEFAULT '',
  km         INTEGER NOT NULL CHECK (km > 0),
  itens      JSONB NOT NULL,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);
