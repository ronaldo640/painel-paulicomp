-- ============================================================
-- Controle de Caixas — infraestrutura pra baixa automática real
-- (a partir de hoje, sem retroativo). Cole no SQL Editor do Neon.
-- ============================================================

-- Marca quais notas fiscais já tiveram o consumo de caixa calculado e
-- gravado, pra nunca processar a mesma nota duas vezes (idempotência
-- mesmo que o job rode de novo ou seja disparado manualmente por engano).
CREATE TABLE IF NOT EXISTS caixa_auto_log (
  id              SERIAL PRIMARY KEY,
  nota_id         BIGINT NOT NULL UNIQUE,
  nota_numero     TEXT,
  filial          TEXT NOT NULL,
  status          TEXT NOT NULL, -- 'ok' (tudo resolvido) ou 'parcial' (algum item sem mapeamento/fora da faixa)
  processado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Diferencia lançamentos gerados pela automação dos lançamentos manuais.
ALTER TABLE caixa_movimentacoes ADD COLUMN IF NOT EXISTS automatica BOOLEAN NOT NULL DEFAULT FALSE;
