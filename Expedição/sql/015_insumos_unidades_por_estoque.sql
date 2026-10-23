-- ============================================================
-- Controle de Insumos — conversão entre a unidade de consumo e a de estoque.
--
-- O estoque da etiqueta é contado em ROLOS, mas a baixa automática é em
-- ETIQUETAS (2 por embalagem). unidades_por_estoque diz quantas unidades de
-- consumo vêm em 1 unidade de estoque (ex: 500 etiquetas por rolo); a baixa
-- automática desconta consumo_por_embalagem / unidades_por_estoque do estoque.
-- Padrão 1: consumo e estoque na mesma unidade (comportamento anterior).
--
-- Cole no SQL Editor do Neon e rode. Idempotente.
-- ============================================================

ALTER TABLE insumos ADD COLUMN IF NOT EXISTS unidades_por_estoque NUMERIC(10,2) NOT NULL DEFAULT 1;
