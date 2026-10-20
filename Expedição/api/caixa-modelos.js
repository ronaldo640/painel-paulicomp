// Vercel Serverless Function — cadastro de modelos de caixa (catálogo
// compartilhado entre filiais: nome, medida, lead time, % de estoque de
// segurança). GET lista tudo, PUT atualiza lead time / % de um modelo,
// POST cria um modelo novo (ex: quando surgir uma 16ª embalagem).

import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT id, nome, medida_mm, lead_time_dias, estoque_seguranca_pct, ativo
        FROM caixa_modelos
        ORDER BY nome
      `;
      // controla_estoque em query separada: tolerante à migração 008 pendente
      let semControle = new Set();
      try {
        const flags = await sql`SELECT id FROM caixa_modelos WHERE controla_estoque = false`;
        semControle = new Set(flags.map(f => f.id));
      } catch (err) {
        console.error('Coluna controla_estoque indisponível (migração 008 pendente?):', err.message);
      }
      // cobertura desejada / ponto de reposição manual (migração 009), idem
      const extras = new Map();
      try {
        const ex = await sql`SELECT id, cobertura_desejada_dias, ponto_reposicao_manual FROM caixa_modelos`;
        ex.forEach(e => extras.set(e.id, e));
      } catch (err) {
        console.error('Colunas de planejamento indisponíveis (migração 009 pendente?):', err.message);
      }
      return res.status(200).json(rows.map(r => ({
        ...r,
        controla_estoque: !semControle.has(r.id),
        cobertura_desejada_dias: extras.get(r.id)?.cobertura_desejada_dias ?? null,
        ponto_reposicao_manual: extras.get(r.id)?.ponto_reposicao_manual ?? null,
      })));
    } catch (error) {
      console.error('Erro GET caixa_modelos:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const { nome, medida_mm, lead_time_dias, estoque_seguranca_pct } = req.body || {};
      if (!nome || !String(nome).trim()) {
        return res.status(400).json({ error: 'Campo "nome" é obrigatório.' });
      }
      const rows = await sql`
        INSERT INTO caixa_modelos (nome, medida_mm, lead_time_dias, estoque_seguranca_pct)
        VALUES (
          ${String(nome).trim()},
          ${medida_mm || null},
          ${lead_time_dias ?? null},
          ${estoque_seguranca_pct ?? 0.20}
        )
        RETURNING id, nome, medida_mm, lead_time_dias, estoque_seguranca_pct, ativo
      `;
      return res.status(201).json(rows[0]);
    } catch (error) {
      console.error('Erro POST caixa_modelos:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'PUT') {
    try {
      const { id, lead_time_dias, estoque_seguranca_pct, medida_mm, ativo, controla_estoque } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Campo "id" é obrigatório.' });

      // Estes dois aceitam null (limpar o campo), então o COALESCE usado
      // abaixo não serve: só são gravados se a chave veio no corpo.
      const body = req.body || {};
      if ('cobertura_desejada_dias' in body || 'ponto_reposicao_manual' in body) {
        const num = v => (v === null || v === '' || v === undefined ? null : Number(v));
        const cob = num(body.cobertura_desejada_dias);
        const man = num(body.ponto_reposicao_manual);
        for (const v of [cob, man]) {
          if (v !== null && (!Number.isInteger(v) || v < 0)) {
            return res.status(400).json({ error: 'Cobertura desejada e ponto de reposição manual devem ser inteiros maiores ou iguais a zero.' });
          }
        }
        try {
          if ('cobertura_desejada_dias' in body) await sql`UPDATE caixa_modelos SET cobertura_desejada_dias = ${cob} WHERE id = ${id}`;
          if ('ponto_reposicao_manual' in body) await sql`UPDATE caixa_modelos SET ponto_reposicao_manual = ${man} WHERE id = ${id}`;
        } catch (err) {
          if (/cobertura_desejada|ponto_reposicao_manual/.test(err.message)) {
            return res.status(400).json({ error: 'Migração 009 pendente: rode sql/009_caixa_compras.sql no Neon antes de alterar cobertura/ponto de reposição.' });
          }
          throw err;
        }
      }

      if (typeof controla_estoque === 'boolean') {
        try {
          await sql`UPDATE caixa_modelos SET controla_estoque = ${controla_estoque} WHERE id = ${id}`;
        } catch (err) {
          if (/controla_estoque/.test(err.message)) {
            return res.status(400).json({ error: 'Migração 008 pendente: rode sql/008_caixa_modelos_controla_estoque.sql no Neon antes de alterar "Controla estoque".' });
          }
          throw err;
        }
      }

      const rows = await sql`
        UPDATE caixa_modelos SET
          lead_time_dias = COALESCE(${lead_time_dias ?? null}, lead_time_dias),
          estoque_seguranca_pct = COALESCE(${estoque_seguranca_pct ?? null}, estoque_seguranca_pct),
          medida_mm = COALESCE(${medida_mm ?? null}, medida_mm),
          ativo = COALESCE(${ativo ?? null}, ativo)
        WHERE id = ${id}
        RETURNING id, nome, medida_mm, lead_time_dias, estoque_seguranca_pct, ativo
      `;
      if (rows.length === 0) return res.status(404).json({ error: 'Modelo não encontrado.' });
      return res.status(200).json(rows[0]);
    } catch (error) {
      console.error('Erro PUT caixa_modelos:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Método não permitido.' });
}
