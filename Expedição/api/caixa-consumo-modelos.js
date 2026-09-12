// Vercel Serverless Function — média de consumo diário de TODOS os modelos
// de caixa num período (30/60/90 dias). Alimenta o gráfico "Consumo por
// modelo de caixa" (substitui o antigo ranking fixo de 30 dias / top 10).

import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido.' });

  const filial = req.query.filial ? String(req.query.filial).toUpperCase() : 'SP';
  const diasPermitidos = [30, 60, 90];
  const dias = diasPermitidos.includes(Number(req.query.dias)) ? Number(req.query.dias) : 30;

  const sql = neon(process.env.DATABASE_URL);

  try {
    const rows = await sql`
      WITH consumo AS (
        SELECT modelo_id, SUM(quantidade)::numeric / ${dias} AS media_diaria
        FROM caixa_movimentacoes
        WHERE filial = ${filial} AND tipo = 'saida' AND data >= current_date - (${dias - 1} * interval '1 day')
        GROUP BY modelo_id
      )
      SELECT cm.id AS modelo_id, cm.nome AS modelo_nome, COALESCE(c.media_diaria, 0)::float AS media_diaria
      FROM caixa_modelos cm
      LEFT JOIN consumo c ON c.modelo_id = cm.id
      WHERE cm.ativo = true
      ORDER BY media_diaria DESC
    `;
    return res.status(200).json({ filial, dias, modelos: rows });
  } catch (error) {
    console.error('Erro caixa-consumo-modelos:', error);
    return res.status(500).json({ error: error.message });
  }
}
