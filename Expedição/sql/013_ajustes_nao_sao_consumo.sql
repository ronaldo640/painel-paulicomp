-- ============================================================
-- Controle de Caixas — ajustes de estoque (inventário) não são consumo.
--
-- Os ajustes lançados pelo "Estoque atual" do Cadastro de modelos entravam
-- como saída comum e inflavam consumo/dia, ponto de reposição e alertas
-- (ex: -146 na Caixa Quadrada Sul virava 4,9 caixas/dia). O código novo já
-- grava os ajustes como não-consumo; este script corrige os que já existem.
--
-- Só muda a marca conta_consumo; o estoque continua igual (a saída segue
-- baixando o saldo). Cole no SQL Editor do Neon e rode. Idempotente.
-- ============================================================

UPDATE caixa_movimentacoes
SET conta_consumo = false
WHERE tipo = 'saida'
  AND conta_consumo = true
  AND observacao ILIKE 'Ajuste de estoque%';
