-- ============================================================
-- Controle de Caixas — regras de embalagem (casos especiais)
-- Cole no SQL Editor do Neon e rode. Só cria a tabela; não depende
-- de nada além do que já foi criado em 001_caixas.sql.
-- ============================================================

-- Captura casos onde uma faixa de quantidade (e opcionalmente um cliente
-- específico) usa uma caixa diferente da caixa padrão de 1 unidade —
-- ex: "até 3 telas desmontadas do mesmo modelo cabem na caixa de 1 tela".
-- Por enquanto é só um repositório de regras (não calcula nada sozinho);
-- vira insumo pra automação futura de consumo a partir dos pedidos.
CREATE TABLE IF NOT EXISTS caixa_regras (
  id            SERIAL PRIMARY KEY,
  descricao     TEXT NOT NULL,
  qtd_min       INTEGER,
  qtd_max       INTEGER,
  modelo_id     INTEGER NOT NULL REFERENCES caixa_modelos(id),
  cliente       TEXT,
  observacao    TEXT,
  ativa         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_caixa_regras_modelo ON caixa_regras (modelo_id);
