-- ============================================================
-- Limpeza do veículo (Fiorino): agenda mensal/quinzenal no lava-rápido,
-- registro de cada limpeza com no mínimo 3 fotos e custo.
--
-- limpeza_config: uma linha só (id = 1) com o ritmo, a data da primeira
--   limpeza e a placa.
-- limpezas: uma linha por limpeza feita. As fotos ficam no Vercel Blob; aqui
--   só guardamos os endereços (lista JSON de URLs).
--
-- Cole no SQL Editor do Neon. Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS limpeza_config (
  id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  frequencia  TEXT NOT NULL DEFAULT 'mensal' CHECK (frequencia IN ('mensal', 'quinzenal')),
  inicio      DATE NOT NULL DEFAULT DATE '2026-11-06',
  placa       TEXT NOT NULL DEFAULT ''
);

INSERT INTO limpeza_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS limpezas (
  id           SERIAL PRIMARY KEY,
  data         DATE NOT NULL,
  tipo         TEXT NOT NULL CHECK (tipo IN ('completa', 'simples')),
  custo        NUMERIC(10,2) NOT NULL DEFAULT 0,
  responsavel  TEXT NOT NULL DEFAULT '',
  obs          TEXT NOT NULL DEFAULT '',
  fotos        JSONB NOT NULL DEFAULT '[]'::jsonb,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS limpezas_data_idx ON limpezas (data DESC, id DESC);
