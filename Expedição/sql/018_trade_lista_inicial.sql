-- ============================================================
-- Comp Trade — lista inicial de embalagens e insumos, com a contagem
-- de 28/10/2026 como estoque inicial.
--
-- Rode DEPOIS da 017 (que cria a coluna filiais).
--
-- 1) Cria o que ainda não existe no catálogo: Caixa Bandeja, Caixa 424235
--    (sem medida; preencha no Cadastro de modelos) e o insumo Ribbon ZM400.
-- 2) Marca esses itens como controlados na filial TRADE (sem tirar da SP,
--    se já estiverem lá).
-- 3) Lança a contagem como entrada ("Contagem inicial"), só se o item ainda
--    não tiver nenhum lançamento na Trade.
--
-- Prazo de entrega, margem e quantidade por pedido são do catálogo
-- (compartilhados com a SP): sem prazo, o item aparece como "Configurar
-- lead time" e não gera aviso de compra.
--
-- Cole no SQL Editor do Neon e rode. Idempotente.
-- ============================================================

INSERT INTO caixa_modelos (nome) VALUES ('Caixa Bandeja'), ('Caixa 424235')
ON CONFLICT (nome) DO NOTHING;

INSERT INTO insumos (nome, unidade) VALUES ('Ribbon ZM400', 'rolo')
ON CONFLICT (nome) DO NOTHING;

-- Modelos novos nascem só na Trade; os que já existiam ganham a Trade além da SP.
UPDATE caixa_modelos SET filiais = ARRAY['TRADE']::text[] WHERE nome IN ('Caixa Bandeja', 'Caixa 424235') AND filiais = ARRAY['SP']::text[]
  AND NOT EXISTS (SELECT 1 FROM caixa_movimentacoes m WHERE m.modelo_id = caixa_modelos.id);
UPDATE caixa_modelos SET filiais = (SELECT ARRAY(SELECT DISTINCT unnest(filiais || ARRAY['TRADE']::text[])))
WHERE LOWER(nome) IN ('caixa padrão', 'caixa tela', 'caixa cut tape', 'caixa 202010', 'caixa teclado', 'caixa quadrada sul');

UPDATE insumos SET filiais = ARRAY['TRADE']::text[] WHERE nome = 'Ribbon ZM400' AND filiais = ARRAY['SP']::text[]
  AND NOT EXISTS (SELECT 1 FROM insumo_movimentacoes m WHERE m.insumo_id = insumos.id);
UPDATE insumos SET filiais = (SELECT ARRAY(SELECT DISTINCT unnest(filiais || ARRAY['TRADE']::text[])))
WHERE nome IN ('Fita marrom', 'Fita transparente', 'Bobina plástico bolha', 'Etiqueta térmica 100x150mm', 'Etiqueta térmica 25x50mm');

-- Contagem inicial das embalagens
INSERT INTO caixa_movimentacoes (modelo_id, filial, tipo, quantidade, data, observacao)
SELECT m.id, 'TRADE', 'entrada', c.qtd, DATE '2026-10-28', 'Contagem semanal — contagem inicial'
FROM (VALUES
  ('caixa padrão', 30), ('caixa bandeja', 475), ('caixa tela', 134), ('caixa cut tape', 100),
  ('caixa 202010', 300), ('caixa teclado', 100), ('caixa 424235', 70), ('caixa quadrada sul', 100)
) AS c(nome, qtd)
JOIN caixa_modelos m ON LOWER(m.nome) = c.nome
WHERE NOT EXISTS (SELECT 1 FROM caixa_movimentacoes x WHERE x.modelo_id = m.id AND x.filial = 'TRADE');

-- Contagem inicial dos insumos (não conta como consumo)
INSERT INTO insumo_movimentacoes (insumo_id, filial, tipo, quantidade, data, observacao, conta_consumo)
SELECT i.id, 'TRADE', 'entrada', c.qtd, DATE '2026-10-28', 'Contagem inicial', false
FROM (VALUES
  ('Fita marrom', 24), ('Fita transparente', 32), ('Ribbon ZM400', 5),
  ('Etiqueta térmica 100x150mm', 6), ('Etiqueta térmica 25x50mm', 2), ('Bobina plástico bolha', 18)
) AS c(nome, qtd)
JOIN insumos i ON i.nome = c.nome
WHERE NOT EXISTS (SELECT 1 FROM insumo_movimentacoes x WHERE x.insumo_id = i.id AND x.filial = 'TRADE');
