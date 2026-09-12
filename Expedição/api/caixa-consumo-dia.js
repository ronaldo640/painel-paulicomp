// Vercel Serverless Function — consumo de TODOS os modelos de caixa num
// dia específico. Alimenta o gráfico "Consumo do dia" (substitui o antigo
// gráfico de tendência de 30 dias por modelo).

import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido.' });

  const filial = req.query.filial ? String(req.query.filial).toUpperCase() : 'SP';
  const data = req.query.data; // YYYY-MM-DD
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return res.status(400).json({ error: 'Parâmetro "data" é obrigatório no formato YYYY-MM-DD.' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    const rows = await sql`
      WITH consumo AS (
        SELECT modelo_id, SUM(quantidade)::int AS quantidade
        FROM caixa_movimentacoes
        WHERE filial = ${filial} AND tipo = 'saida' AND data = ${data}
        GROUP BY modelo_id
      )
      SELECT cm.id AS modelo_id, cm.nome AS modelo_nome, COALESCE(c.quantidade, 0)::int AS quantidade
      FROM caixa_modelos cm
      LEFT JOIN consumo c ON c.modelo_id = cm.id
      WHERE cm.ativo = true
      ORDER BY quantidade DESC
    `;
    const total = rows.reduce((acc, r) => acc + r.quantidade, 0);
    return res.status(200).json({ filial, data, total, modelos: rows });
  } catch (error) {
    console.error('Erro caixa-consumo-dia:', error);
    return res.status(500).json({ error: error.message });
  }
}
