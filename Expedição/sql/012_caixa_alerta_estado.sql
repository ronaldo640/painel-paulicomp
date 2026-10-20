-- ============================================================
-- Controle de Caixas — estado dos avisos por e-mail.
--
-- Guarda, por modelo, em que situação ele estava quando o último aviso
-- foi enviado (crit = Comprar agora, warn = Atenção) e quando. Serve pra
-- só avisar quando o modelo MUDA de situação, e repetir 1x por semana se
-- continuar igual. Linhas com modelo_id <= 0 são controles internos:
--   0 = aviso de dados de consumo desatualizados
--  -1 = e-mail de teste (limita a 1 a cada 5 minutos)
--  -2 = aviso de falha da baixa automática (1 por dia)
--
-- Cole no SQL Editor do Neon e rode. Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS caixa_alerta_estado (
  filial         TEXT NOT NULL,
  modelo_id      INTEGER NOT NULL,
  status         TEXT NOT NULL,
  notificado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (filial, modelo_id)
);
