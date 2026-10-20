-- ============================================================
-- Controle de Caixas — modelos que NÃO têm estoque controlado.
--
-- Motivo: alguns "modelos" não são embalagem comprada e estocada pela
-- empresa — são embalagens originais do produto ou embalagens
-- reaproveitadas (ex: "Padrão 1"). O consumo delas precisa aparecer nos
-- gráficos, mas estoque, ponto de reposição e alerta de compra não fazem
-- sentido pra elas.
--
-- controla_estoque = false: o painel mostra o consumo normalmente e
-- deixa de calcular estoque / reposição / status de compra pro modelo.
--
-- Cole no SQL Editor do Neon e rode.
-- ============================================================

ALTER TABLE caixa_modelos ADD COLUMN IF NOT EXISTS controla_estoque BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE caixa_modelos SET controla_estoque = false WHERE nome ILIKE 'Padr_o 1';
