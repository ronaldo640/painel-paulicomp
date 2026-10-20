-- ============================================================
-- Controle de Caixas — separar "saiu do estoque" de "foi consumido".
--
-- Motivo: uma saída manual de 400 caixas pra Comp Trade (transferência
-- entre filiais) baixa o estoque da SP, mas NÃO é consumo — e estava
-- inflando consumo/dia, ponto de reposição e cobertura.
--
-- conta_consumo = false: a movimentação continua baixando o estoque
-- normalmente, mas fica fora de consumo/dia, tendência, gráficos de
-- consumo e "última saída".
--
-- Cole no SQL Editor do Neon e rode. Idempotente. Não muda nada no
-- painel até o código novo ser publicado (DEFAULT TRUE mantém tudo igual).
-- ============================================================

ALTER TABLE caixa_movimentacoes ADD COLUMN IF NOT EXISTS conta_consumo BOOLEAN NOT NULL DEFAULT TRUE;

-- A transferência de 400 caixas da 202010 pra Comp Trade (16/10).
UPDATE caixa_movimentacoes
SET conta_consumo = false
WHERE id = 2074
  AND tipo = 'saida'
  AND quantidade = 400
  AND observacao ILIKE 'Envio para Comp Trade%';
