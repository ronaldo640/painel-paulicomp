-- ============================================================
-- Controle de Insumos (fita, plástico, bobinas, etiquetas...) — filial SP.
--
-- insumos: cadastro de cada insumo, com prazo de entrega, margem de
-- segurança e estoque mínimo (opcional). Se consumo_por_embalagem estiver
-- preenchido, o insumo também tem BAIXA AUTOMÁTICA: a cada embalagem
-- expedida (saída de caixa que baixa o estoque) desconta essa quantidade,
-- contando só a partir de auto_desde (a data da contagem).
--
-- insumo_movimentacoes: entradas e saídas lançadas à mão. conta_consumo =
-- false marca ajustes de contagem (acertam o saldo, mas não são consumo).
-- O estoque nunca é guardado: é sempre entradas - saídas (- baixa automática).
--
-- A carga inicial lança a contagem de 23/10/2026 como entrada ("Contagem
-- inicial"), só se o insumo ainda não tiver nenhum lançamento.
--
-- Cole no SQL Editor do Neon e rode. Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS insumos (
  id                      SERIAL PRIMARY KEY,
  nome                    TEXT NOT NULL UNIQUE,
  unidade                 TEXT NOT NULL DEFAULT 'un',
  lead_time_dias          INTEGER,
  estoque_seguranca_pct   NUMERIC(5,2) NOT NULL DEFAULT 0.20,
  estoque_minimo          INTEGER,
  consumo_por_embalagem   NUMERIC(8,3),
  auto_desde              DATE,
  auto_inclui_fulfillment BOOLEAN NOT NULL DEFAULT FALSE,
  ativo                   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS insumo_movimentacoes (
  id             SERIAL PRIMARY KEY,
  insumo_id      INTEGER NOT NULL REFERENCES insumos(id),
  filial         TEXT NOT NULL DEFAULT 'SP',
  tipo           TEXT NOT NULL CHECK (tipo IN ('entrada','saida')),
  quantidade     NUMERIC(12,2) NOT NULL CHECK (quantidade > 0),
  data           DATE NOT NULL,
  observacao     TEXT,
  conta_consumo  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insumo_mov_insumo_data ON insumo_movimentacoes (insumo_id, data);

INSERT INTO insumos (nome, unidade) VALUES
  ('Fita marrom', 'rolo'),
  ('Fita transparente', 'rolo'),
  ('Plástico stretch', 'bobina'),
  ('Bobina plástico bolha', 'bobina'),
  ('Bobina bolha máquina', 'bobina'),
  ('Etiqueta térmica 25x50mm', 'rolo'),
  ('Etiqueta térmica 100x150mm', 'rolo')
ON CONFLICT (nome) DO NOTHING;

-- A baixa automática da etiqueta 100x150mm (2 etiquetas por embalagem) NÃO é configurada aqui:
-- o estoque é em rolos e a baixa é em etiquetas, então depende da conversão da
-- migração 015 (etiquetas por rolo). Ela é ligada depois, no cadastro do insumo.

INSERT INTO insumo_movimentacoes (insumo_id, filial, tipo, quantidade, data, observacao, conta_consumo)
SELECT i.id, 'SP', 'entrada', c.qtd, DATE '2026-10-23', 'Contagem inicial', false
FROM (VALUES
  ('Fita marrom', 77),
  ('Fita transparente', 23),
  ('Plástico stretch', 5),
  ('Bobina plástico bolha', 4),
  ('Bobina bolha máquina', 10),
  ('Etiqueta térmica 25x50mm', 9),
  ('Etiqueta térmica 100x150mm', 24)
) AS c(nome, qtd)
JOIN insumos i ON i.nome = c.nome
WHERE NOT EXISTS (SELECT 1 FROM insumo_movimentacoes m WHERE m.insumo_id = i.id);
