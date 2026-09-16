// Vercel Serverless Function — lista o mapeamento produto (SKU) -> modelo
// de caixa. Usado pra alimentar a busca de SKU na tela de Regras de
// Embalagem (autocomplete client-side sobre os ~474 produtos).

import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido.' });

  const sql = neon(process.env.DATABASE_URL);

  // Diagnóstico pontual: estoque real (conta_estoque=true) de um modelo
  // antes/depois de um id de movimentação específico. Uso único, remover
  // depois. ?diagEstoque=1&modeloId=3&filial=SP&antesDe=1019
  if (req.query.diagEstoque === '1') {
    const modeloId = Number(req.query.modeloId);
    const filial = String(req.query.filial || 'SP').toUpperCase();
    const antesDe = Number(req.query.antesDe);
    const [{ total: antes }] = await sql`
      SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade ELSE -quantidade END),0)::int AS total
      FROM caixa_movimentacoes
      WHERE modelo_id=${modeloId} AND filial=${filial} AND conta_estoque=true AND id < ${antesDe}
    `;
    const [{ total: depois }] = await sql`
      SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade ELSE -quantidade END),0)::int AS total
      FROM caixa_movimentacoes
      WHERE modelo_id=${modeloId} AND filial=${filial} AND conta_estoque=true
    `;
    const linha = await sql`SELECT id, tipo, quantidade, conta_estoque, data, observacao FROM caixa_movimentacoes WHERE id = ${antesDe}`;
    const todasEntradas = await sql`
      SELECT id, tipo, quantidade, conta_estoque, TO_CHAR(data,'YYYY-MM-DD') AS data, observacao
      FROM caixa_movimentacoes
      WHERE modelo_id=${modeloId} AND filial=${filial} AND tipo='entrada'
      ORDER BY id
    `;
    return res.status(200).json({ antes, depois, linha: linha[0] || null, todasEntradas });
  }

  try {
    const rows = await sql`
      SELECT p.sku, p.produto, p.modelo_id, cm.nome AS modelo_nome
      FROM produto_caixa p
      LEFT JOIN caixa_modelos cm ON cm.id = p.modelo_id
      ORDER BY p.produto
    `;
    return res.status(200).json(rows);
  } catch (error) {
    console.error('Erro GET produto-caixa:', error);
    return res.status(500).json({ error: error.message });
  }
}
