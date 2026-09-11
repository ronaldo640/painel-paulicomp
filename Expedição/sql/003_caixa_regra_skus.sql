-- ============================================================
-- Controle de Caixas — regras de embalagem passam a referenciar
-- SKUs reais (produto_caixa) em vez de uma descrição livre.
-- Cole no SQL Editor do Neon e rode.
-- ============================================================

-- Descrição vira opcional (a lista de produtos passa a ser a
-- identificação principal da regra).
ALTER TABLE caixa_regras ALTER COLUMN descricao DROP NOT NULL;

-- Um ou mais SKUs por regra (cobre tanto "faixa de quantidade do mesmo
-- produto" quanto "combinação de produtos diferentes").
CREATE TABLE IF NOT EXISTS caixa_regra_produtos (
  regra_id  INTEGER NOT NULL REFERENCES caixa_regras(id) ON DELETE CASCADE,
  sku       TEXT NOT NULL REFERENCES produto_caixa(sku),
  PRIMARY KEY (regra_id, sku)
);
