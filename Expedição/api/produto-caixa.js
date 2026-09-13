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

  // Correção pontual: notas série 2 (Fulfillment) processadas antes do split
  // conta_estoque existir, gravadas como baixa real. Uso único, remover
  // depois de rodar. ?fixFulfillment=1&notas=024333,024335,024347
  if (req.query.fixFulfillment === '1') {
    const numeros = String(req.query.notas || '').split(',').map(s => s.trim()).filter(Boolean);
    if (numeros.length === 0) return res.status(400).json({ error: 'Parâmetro "notas" é obrigatório.' });
    const rows = await sql`
      UPDATE caixa_movimentacoes
      SET conta_estoque = false,
          observacao = REPLACE(observacao, 'Auto — NF', 'Auto (Fulfillment, informativo) — NF')
      WHERE observacao ~ ('NF (' || ${numeros.join('|')} || ')$')
      RETURNING id, modelo_id, data, observacao, conta_estoque
    `;
    return res.status(200).json({ corrigidas: rows });
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
