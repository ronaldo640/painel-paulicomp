-- ============================================================
-- Manutenção básica da Fiorino: óleo, filtro de óleo, filtro de ar, filtro de
-- combustível (a cada 10.000 km) e filtro de cabine (a cada 20.000 km).
--
-- limpeza_manutencoes: uma linha por visita à oficina (data, km do painel, valor,
--   observação e a lista dos itens trocados: ["oleo","filtro_oleo",...]). A última
--   troca de cada item é a visita mais recente que o inclui. Uma visita pode ter
--   a lista de itens vazia: serve para anotar outra manutenção só como descrição
--   (ex.: troca da correia dentada), escrita na observação.
-- limpeza_config ganha: os intervalos de cada item (km e meses; vale o que vier
--   primeiro), os limites do aviso e o estado do último e-mail (para avisar só
--   quando a situação muda e repetir a cada 7 dias).
-- A próxima troca é estimada com a média de km por dia, que sai dos km dos
-- checklists de início do dia.
--
-- Cole no SQL Editor do Neon. Idempotente (exige a migração 020).
-- ============================================================

CREATE TABLE IF NOT EXISTS limpeza_manutencoes (
  id         SERIAL PRIMARY KEY,
  data       DATE NOT NULL,
  km         INTEGER NOT NULL CHECK (km > 0),
  itens      JSONB NOT NULL DEFAULT '[]'::jsonb,
  custo      NUMERIC(10,2) NOT NULL DEFAULT 0,
  obs        TEXT NOT NULL DEFAULT '',
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS limpeza_manutencoes_data_idx ON limpeza_manutencoes (data DESC, id DESC);

ALTER TABLE limpeza_config ADD COLUMN IF NOT EXISTS manut_intervalos JSONB NOT NULL DEFAULT '{
  "oleo":          { "km": 10000, "meses": 12 },
  "filtro_oleo":   { "km": 10000, "meses": 12 },
  "filtro_ar":     { "km": 10000, "meses": 12 },
  "filtro_comb":   { "km": 10000, "meses": 12 },
  "filtro_cabine": { "km": 20000, "meses": 24 }
}'::jsonb;
ALTER TABLE limpeza_config ADD COLUMN IF NOT EXISTS manut_aviso_km     INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE limpeza_config ADD COLUMN IF NOT EXISTS manut_aviso_dias   INTEGER NOT NULL DEFAULT 15;
ALTER TABLE limpeza_config ADD COLUMN IF NOT EXISTS manut_aviso_estado JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE limpeza_config ADD COLUMN IF NOT EXISTS manut_aviso_em     DATE;
