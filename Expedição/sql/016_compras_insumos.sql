-- ============================================================
-- Compras: cotações e pedidos também para INSUMOS (fita, plástico, bobinas,
-- etiquetas), além das embalagens.
--
-- caixa_compras passa a ter insumo_id (opcional). Cada compra é de UM item:
-- ou um modelo de embalagem (modelo_id) ou um insumo (insumo_id).
--
-- Cole no SQL Editor do Neon e rode. Idempotente. Depende da migração 014
-- (tabela insumos). Não muda nada nas compras de embalagens que já existem.
-- ============================================================

ALTER TABLE caixa_compras ALTER COLUMN modelo_id DROP NOT NULL;
ALTER TABLE caixa_compras ADD COLUMN IF NOT EXISTS insumo_id INTEGER REFERENCES insumos(id);

ALTER TABLE caixa_compras DROP CONSTRAINT IF EXISTS caixa_compras_item_check;
ALTER TABLE caixa_compras ADD CONSTRAINT caixa_compras_item_check CHECK (num_nonnulls(modelo_id, insumo_id) = 1);
