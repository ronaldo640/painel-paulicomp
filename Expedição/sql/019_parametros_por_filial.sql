-- ============================================================
-- Parâmetros de reposição por filial (Comp Trade com valores próprios).
--
-- O catálogo de modelos e de insumos continua único (nome, medida, unidade),
-- mas prazo de entrega, margem de segurança, cobertura desejada, quantidade
-- por pedido (caixas) e estoque mínimo (insumos) passam a poder ser
-- diferentes na Trade. A SP continua lendo as colunas de sempre.
--
-- Regra: se existe linha da filial nestas tabelas, ela vale por inteiro
-- (campo vazio = não definido). Sem linha, a Trade usa prazo e margem do
-- catálogo e fica sem estoque mínimo.
--
-- A carga abaixo copia para a Trade os valores atuais da SP (mesmo padrão),
-- MENOS o estoque mínimo fixo dos insumos: na Trade a reposição vem do
-- consumo apurado nas contagens (consumo x prazo + segurança).
--
-- Rode DEPOIS da 017/018. Cole no SQL Editor do Neon. Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS caixa_modelo_filial (
  modelo_id               INTEGER NOT NULL REFERENCES caixa_modelos(id),
  filial                  TEXT NOT NULL,
  lead_time_dias          INTEGER,
  estoque_seguranca_pct   NUMERIC(5,2),
  cobertura_desejada_dias INTEGER,
  ponto_reposicao_manual  INTEGER,   -- quantidade padrão de cada pedido
  PRIMARY KEY (modelo_id, filial)
);

CREATE TABLE IF NOT EXISTS insumo_filial (
  insumo_id             INTEGER NOT NULL REFERENCES insumos(id),
  filial                TEXT NOT NULL,
  lead_time_dias        INTEGER,
  estoque_seguranca_pct NUMERIC(5,2),
  estoque_minimo        INTEGER,
  PRIMARY KEY (insumo_id, filial)
);

INSERT INTO caixa_modelo_filial (modelo_id, filial, lead_time_dias, estoque_seguranca_pct, cobertura_desejada_dias, ponto_reposicao_manual)
SELECT id, 'TRADE', lead_time_dias, estoque_seguranca_pct, cobertura_desejada_dias, ponto_reposicao_manual
FROM caixa_modelos
WHERE 'TRADE' = ANY(filiais)
ON CONFLICT (modelo_id, filial) DO NOTHING;

INSERT INTO insumo_filial (insumo_id, filial, lead_time_dias, estoque_seguranca_pct, estoque_minimo)
SELECT id, 'TRADE', lead_time_dias, estoque_seguranca_pct, NULL
FROM insumos
WHERE 'TRADE' = ANY(filiais)
ON CONFLICT (insumo_id, filial) DO NOTHING;
