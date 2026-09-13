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

  // Diagnóstico pontual: semear pendências de teste pra validar visualmente
  // o alerta em caixas.html. Uso único, remover depois. ?seedPendencia=1
  if (req.query.seedPendencia === '1') {
    const rows = await sql`
      INSERT INTO caixa_auto_pendencias (filial, nota_id, nota_numero, sku, descricao, quantidade, motivo, data)
      VALUES
        ('SP', 999901, '999901', 'SX10TESTE001', 'Produto de teste (sem mapeamento)', 5, 'sem_mapeamento', current_date),
        ('SP', 999902, '999902', 'SH40R82941', 'Teclado Lenovo KUS0866 USB (fora da faixa de teste)', 12, 'fora_da_faixa', current_date)
      RETURNING id
    `;
    return res.status(200).json({ seeded: rows });
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
