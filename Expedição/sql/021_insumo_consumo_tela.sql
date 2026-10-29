-- ============================================================
-- Consumo de insumo por embalagem de TELA.
--
-- Telas gastam mais etiquetas que os demais produtos: 4 por embalagem em vez
-- de 2. "Tela" é o produto (nome começa com Tela), não o modelo de caixa: a
-- Caixa tela também leva carcaça e base com teclado, que seguem em 2.
--
--  * caixa_movimentacoes.qtd_tela: quantas das embalagens da saída são de
--    produto tela (gravado pela baixa automática a partir de agora).
--  * insumos.consumo_por_embalagem_tela: consumo por embalagem de tela;
--    vazio = igual ao consumo_por_embalagem normal.
--
-- Vale daqui para frente: as saídas já gravadas ficam com qtd_tela = 0 e
-- continuam descontando 2 por embalagem.
--
-- Cole no SQL Editor do Neon. Idempotente.
-- ============================================================

ALTER TABLE caixa_movimentacoes ADD COLUMN IF NOT EXISTS qtd_tela INTEGER NOT NULL DEFAULT 0;
ALTER TABLE insumos ADD COLUMN IF NOT EXISTS consumo_por_embalagem_tela NUMERIC;

-- Etiqueta térmica 100x150mm (o insumo com baixa automática): 4 por embalagem de tela.
UPDATE insumos
SET consumo_por_embalagem_tela = 4
WHERE nome ILIKE '%100x150%'
  AND consumo_por_embalagem IS NOT NULL
  AND consumo_por_embalagem_tela IS NULL;
