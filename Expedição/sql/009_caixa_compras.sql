-- ============================================================
-- Controle de Caixas — planejamento de compras.
--
-- caixa_compras: cotações de fornecedores e pedidos de compra, com o
-- ciclo Cotação -> Solicitado -> Em trânsito -> Recebido (ou Cancelado).
-- O recebimento NÃO mexe no estoque: a entrada continua sendo lançada
-- manualmente em "Registrar movimentação" (entrada_lancada só controla
-- o lembrete de que falta lançar).
--
-- caixa_modelos.cobertura_desejada_dias: quantos dias de consumo se quer
-- ter em estoque; alimenta a "sugestão de compra".
-- caixa_modelos.ponto_reposicao_manual: se preenchido, substitui o ponto
-- de reposição calculado (consumo x lead time + segurança).
--
-- Cole no SQL Editor do Neon e rode. Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS caixa_compras (
  id                SERIAL PRIMARY KEY,
  filial            TEXT NOT NULL DEFAULT 'SP',
  modelo_id         INTEGER NOT NULL REFERENCES caixa_modelos(id),
  status            TEXT NOT NULL DEFAULT 'cotacao'
                    CHECK (status IN ('cotacao','solicitado','em_transito','recebido','cancelado')),
  fornecedor        TEXT NOT NULL,
  quantidade        INTEGER NOT NULL CHECK (quantidade > 0),
  preco_unitario    NUMERIC(12,4) NOT NULL CHECK (preco_unitario >= 0),
  frete             NUMERIC(12,2) NOT NULL DEFAULT 0,
  prazo_dias        INTEGER,
  data_cotacao      DATE NOT NULL DEFAULT CURRENT_DATE,
  data_pedido       DATE,
  previsao_chegada  DATE,
  data_recebimento  DATE,
  qtd_recebida      INTEGER,
  entrada_lancada   BOOLEAN NOT NULL DEFAULT FALSE,
  observacao        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_caixa_compras_filial_status ON caixa_compras (filial, status);

ALTER TABLE caixa_modelos ADD COLUMN IF NOT EXISTS cobertura_desejada_dias INTEGER;
ALTER TABLE caixa_modelos ADD COLUMN IF NOT EXISTS ponto_reposicao_manual INTEGER;
