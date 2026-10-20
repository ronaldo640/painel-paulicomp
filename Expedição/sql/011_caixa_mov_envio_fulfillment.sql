-- ============================================================
-- Controle de Caixas — envio de lote ao Fulfillment (baixa manual).
--
-- O Fulfillment da série 2 é só informativo (não baixa estoque). A baixa
-- real acontece quando o lote é enviado, lançada à mão em "Registrar
-- movimentação" como saída do tipo "Envio ao Fulfillment".
--
-- envio_fulfillment = true: a saída baixa o estoque, fica fora do
-- "consumo real" (Mercado Envios e outros) e entra no consumo usado pro
-- planejamento de compra (ponto de reposição, cobertura, sugestão), numa
-- janela de 60 dias.
--
-- Cole no SQL Editor do Neon e rode. Idempotente. Não muda nada nos
-- números atuais (DEFAULT FALSE).
-- ============================================================

ALTER TABLE caixa_movimentacoes ADD COLUMN IF NOT EXISTS envio_fulfillment BOOLEAN NOT NULL DEFAULT FALSE;
