-- ============================================================
-- Lançar insumo por unidade (ex: etiquetas, e não só rolos).
--
-- A Etiqueta 100x150mm vem em rolos de 200: 1 etiqueta = 0,005 rolo. Com 2
-- casas decimais um lançamento de 3 etiquetas viraria 0,02 rolo (4). Com 4
-- casas, qualquer quantidade de etiquetas fica exata. Lançamentos antigos
-- não mudam.
--
-- Cole no SQL Editor do Neon. Idempotente.
-- ============================================================

ALTER TABLE insumo_movimentacoes ALTER COLUMN quantidade TYPE NUMERIC(14,4);
