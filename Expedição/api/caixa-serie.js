// Vercel Serverless Function — série diária de consumo (saída) de um
// modelo de caixa específico, últimos N dias, com zero preenchido nos
// dias sem lançamento. Alimenta o gráfico "Consumo diário por modelo de
// caixa" quando o usuário escolhe um modelo no seletor.

import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido.' });

  const modeloId = Number(req.query.modelo_id);
  if (!modeloId) return res.status(400).json({ error: 'Parâmetro "modelo_id" é obrigatório.' });

  const filial = req.query.filial ? String(req.query.filial).toUpperCase() : 'SP';
  const dias = Math.min(Number(req.query.dias) || 30, 90);

  const sql = neon(process.env.DATABASE_URL);

  try {
    const rows = await sql`
      WITH dias_serie AS (
        SELECT generate_series(
          current_date - (${dias - 1} * interval '1 day'),
          current_date,
          interval '1 day'
        )::date AS data
      ),
      saidas AS (
        SELECT data, SUM(quantidade) AS total
        FROM caixa_movimentacoes
        WHERE modelo_id = ${modeloId} AND filial = ${filial} AND tipo = 'saida'
          AND data >= current_date - (${dias - 1} * interval '1 day')
        GROUP BY data
      )
      SELECT TO_CHAR(d.data, 'YYYY-MM-DD') AS data, COALESCE(s.total, 0)::int AS quantidade
      FROM dias_serie d
      LEFT JOIN saidas s ON s.data = d.data
      ORDER BY d.data
    `;
    return res.status(200).json(rows);
  } catch (error) {
    console.error('Erro GET caixa-serie:', error);
    return res.status(500).json({ error: error.message });
  }
}
