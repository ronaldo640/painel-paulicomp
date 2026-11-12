-- ============================================================
-- Controle de Caixas — corrige o lançamento do Envelope2 de 30/10/2026.
--
-- Os ~750 envelopes foram lançados como saída de USO (consumo), mas o certo
-- era inventário: a contagem física mostrou que o estoque inicial lançado
-- estava maior que o real. Como uso, esse lançamento entrava em consumo/dia,
-- tendência, ponto de reposição e cobertura, e distorcia o consumo.
--
-- O que muda: o lançamento passa a ser "ajuste de estoque" (inventário):
-- conta_consumo = false e a observação começa com "Ajuste de estoque", que é
-- como o painel reconhece ajuste (mesmo padrão da migração 013).
-- O que NÃO muda: quantidade, data, tipo (saída) e saldo — a saída continua
-- baixando o estoque, então o saldo atual do Envelope2 fica igual ao de hoje.
--
-- Como usar (Neon > SQL Editor, um bloco por vez):
--   1) rode o PASSO 1 e confira se aparece só o lançamento de ~748;
--   2) rode o PASSO 2 (UPDATE) — ele devolve a linha corrigida;
--   3) rode o PASSO 1 de novo pra conferir (conta_consumo = false).
-- Idempotente: se já foi corrigido, o PASSO 2 não encontra nada pra mudar.
-- ============================================================

-- PASSO 1 — conferência (só lê)
SELECT m.id, cm.nome AS modelo, m.filial, m.tipo, m.quantidade, m.data,
       m.conta_consumo, m.envio_fulfillment, m.conta_estoque, m.observacao
FROM caixa_movimentacoes m
JOIN caixa_modelos cm ON cm.id = m.modelo_id
WHERE m.modelo_id = 17          -- Envelope2
  AND m.filial = 'SP'
  AND m.data = DATE '2026-10-30'
  AND m.tipo = 'saida'
ORDER BY m.id;

-- PASSO 2 — corrige (só mexe no lançamento grande de uso do dia 30/10)
UPDATE caixa_movimentacoes
SET conta_consumo = false,
    observacao = 'Ajuste de estoque — inventário de 30/10 (corrigido de uso para ajuste)'
WHERE modelo_id = 17
  AND filial = 'SP'
  AND data = DATE '2026-10-30'
  AND tipo = 'saida'
  AND conta_consumo = true
  AND envio_fulfillment = false
  AND quantidade >= 100
RETURNING id, quantidade, data, conta_consumo, observacao;

-- Para desfazer (volta a contar como uso), se precisar:
-- UPDATE caixa_movimentacoes SET conta_consumo = true
-- WHERE modelo_id = 17 AND filial = 'SP' AND data = DATE '2026-10-30'
--   AND tipo = 'saida' AND quantidade >= 100;
