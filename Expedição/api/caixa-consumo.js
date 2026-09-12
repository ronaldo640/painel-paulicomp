// Vercel Serverless Function — consumo de caixa, com dois modos (unidos
// num arquivo só pra não estourar o limite de funções serverless do
// plano Hobby da Vercel — 12 por deploy):
//
//   ?modo=modelos&dias=30|60|90   -> média diária de TODOS os modelos
//                                    nesse período. Alimenta "Consumo
//                                    por modelo de caixa".
//   ?modo=dia&data=YYYY-MM-DD     -> consumo de TODOS os modelos num dia
//                                    específico. Alimenta "Consumo do dia".

import { neon } from '@neondatabase/serverless';

async function responderModelos(sql, res, filial, req) {
  const diasPermitidos = [30, 60, 90];
  const dias = diasPermitidos.includes(Number(req.query.dias)) ? Number(req.query.dias) : 30;

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
}

async function responderDia(sql, res, filial, req) {
  const data = req.query.data; // YYYY-MM-DD
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return res.status(400).json({ error: 'Parâmetro "data" é obrigatório no formato YYYY-MM-DD.' });
  }

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
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido.' });

  const filial = req.query.filial ? String(req.query.filial).toUpperCase() : 'SP';
  const modo = req.query.modo;
  const sql = neon(process.env.DATABASE_URL);

  try {
    if (modo === 'dia') return await responderDia(sql, res, filial, req);
    if (modo === 'modelos') return await responderModelos(sql, res, filial, req);
    return res.status(400).json({ error: 'Parâmetro "modo" deve ser "modelos" ou "dia".' });
  } catch (error) {
    console.error('Erro caixa-consumo:', error);
    return res.status(500).json({ error: error.message });
  }
}
