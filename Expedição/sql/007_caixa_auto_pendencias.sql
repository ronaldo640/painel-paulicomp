-- ============================================================
-- Controle de Caixas — registra pendências da baixa automática.
--
-- Motivo: quando a automação encontra um item de nota sem regra de
-- embalagem cadastrada (nem mapeamento padrão em produto_caixa, ou com
-- mapeamento mas fora da faixa de quantidade das regras existentes),
-- esse item não é debitado de caixa nenhuma. Até agora essa informação
-- só aparecia na resposta JSON da chamada (efêmera) — se ninguém
-- estivesse olhando na hora, a situação passava batido.
--
-- Solução: gravar cada pendência aqui, pra caixas.html mostrar um
-- alerta persistente convidando a criar a regra que falta.
--
-- Cole no SQL Editor do Neon e rode.
-- ============================================================

CREATE TABLE IF NOT EXISTS caixa_auto_pendencias (
  id SERIAL PRIMARY KEY,
  filial TEXT NOT NULL,
  nota_id BIGINT NOT NULL,
  nota_numero TEXT,
  sku TEXT NOT NULL,
  descricao TEXT,
  quantidade INT,
  motivo TEXT NOT NULL, -- 'sem_mapeamento' | 'fora_da_faixa'
  data DATE NOT NULL,
  resolvida BOOLEAN NOT NULL DEFAULT FALSE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_caixa_auto_pendencias_aberta ON caixa_auto_pendencias (filial, resolvida);
