-- ============================================================
-- RMA — itens vendidos por nota, para comparar devolução × venda por SKU e canal.
--
-- Não precisa rodar à mão: lib/vendas-itens.js cria as tabelas sozinho na
-- primeira gravação (CREATE TABLE IF NOT EXISTS). Fica aqui como registro.
--
-- Quem grava:
--   - a rotina diária das Caixas (api/caixa-auto-executar.js), com os itens que
--     ela já lê de cada nota de venda;
--   - a carga do histórico: /api/caixa-auto-executar?vendas=historico&data=AAAA-MM-DD
-- Canal: FULL (série 2), ML, LOJA NUVEM, AMAZON, SHOPEE ou OUTROS, nos mesmos
-- nomes da coluna "Empresa" da planilha de devoluções.
-- ============================================================

CREATE TABLE IF NOT EXISTS venda_notas (
  nota_id BIGINT PRIMARY KEY,
  filial TEXT NOT NULL,
  numero TEXT,
  serie TEXT,
  data DATE NOT NULL,
  canal TEXT NOT NULL,
  lido_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS venda_itens (
  nota_id BIGINT NOT NULL REFERENCES venda_notas(nota_id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  quantidade NUMERIC NOT NULL,
  PRIMARY KEY (nota_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_venda_notas_filial_data ON venda_notas (filial, data);
