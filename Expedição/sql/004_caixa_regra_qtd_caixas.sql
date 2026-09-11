-- ============================================================
-- Controle de Caixas — regras de embalagem passam a registrar
-- QUANTAS caixas são usadas, não só qual modelo.
-- Ex: "de 3 a 5 unidades do SKU X usa 2 caixas do modelo Caixa tela".
-- Cole no SQL Editor do Neon e rode.
-- ============================================================

ALTER TABLE caixa_regras ADD COLUMN IF NOT EXISTS qtd_caixas INTEGER NOT NULL DEFAULT 1;
