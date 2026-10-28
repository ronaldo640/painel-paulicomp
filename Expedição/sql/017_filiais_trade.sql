-- ============================================================
-- Controle de Caixas e Insumos — filial Comp Trade.
--
-- A Comp Trade passa a ter o próprio controle (contagem semanal, com
-- lançamentos manuais). A Paulicomp Sul não entra: o estoque dela é o
-- mesmo da Trade.
--
-- O catálogo de modelos de caixa e de insumos continua único (mesmos
-- nomes, medidas, prazo de entrega e margem de segurança). O que muda é
-- em quais filiais cada item é controlado:
--
--   caixa_modelos.filiais / insumos.filiais: lista de filiais ('SP', 'TRADE').
--
-- Tudo o que já existe continua só na SP. Os itens da Comp Trade são
-- marcados no painel (botão "Itens da filial"), não aqui.
--
-- Cole no SQL Editor do Neon e rode. Idempotente.
-- ============================================================

ALTER TABLE caixa_modelos ADD COLUMN IF NOT EXISTS filiais TEXT[] NOT NULL DEFAULT ARRAY['SP']::text[];
ALTER TABLE insumos       ADD COLUMN IF NOT EXISTS filiais TEXT[] NOT NULL DEFAULT ARRAY['SP']::text[];
