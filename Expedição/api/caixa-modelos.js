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
      return res.status(200).json(rows);
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
      const { id, lead_time_dias, estoque_seguranca_pct, medida_mm, ativo } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Campo "id" é obrigatório.' });

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
