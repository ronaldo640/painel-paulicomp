-- ============================================================
-- Controle de Caixas — separa consumo de Fulfillment do estoque real.
--
-- Motivo: o empacotamento físico do Fulfillment acontece em lote, no
-- envio pro depósito do Ebazar (Mercado Livre) — evento que não
-- conseguimos identificar em nenhuma nota/pedido do Tiny ainda. A nota
-- série 2 só aparece bem depois, uma por venda individual já feita
-- pelo Mercado Livre. Contar a série 2 como baixa de estoque de
-- verdade fica sempre defasado (a caixa já foi usada há tempos).
--
-- Solução por enquanto: continuar registrando o consumo de Fulfillment
-- (pra ter visibilidade), mas com conta_estoque = false, então ele NÃO
-- entra no estoque atual nem no cálculo de ponto de reposição — vira
-- só um número informativo separado, até acharmos (ou lançarmos à mão)
-- o evento certo do envio em lote.
--
-- Cole no SQL Editor do Neon e rode.
-- ============================================================

ALTER TABLE caixa_movimentacoes ADD COLUMN IF NOT EXISTS conta_estoque BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_caixa_mov_conta_estoque ON caixa_movimentacoes (conta_estoque);
