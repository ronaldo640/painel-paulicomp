// Vercel Serverless Function — regras de embalagem (casos especiais de
// quantidade/combinação que usam uma caixa diferente da padrão, ex:
// "até 3 telas desmontadas cabem na caixa de 1 tela"). GET lista, POST
// cria, DELETE remove. É só um repositório por enquanto — não calcula
// nada sozinho, alimenta a automação de consumo mais pra frente.

import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT r.id, r.descricao, r.qtd_min, r.qtd_max, r.modelo_id, cm.nome AS modelo_nome,
               r.cliente, r.observacao, r.ativa
        FROM caixa_regras r
        JOIN caixa_modelos cm ON cm.id = r.modelo_id
        ORDER BY r.created_at DESC
      `;
      return res.status(200).json(rows);
    } catch (error) {
      console.error('Erro GET caixa_regras:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const { descricao, qtd_min, qtd_max, modelo_id, cliente, observacao } = req.body || {};
      if (!descricao || !String(descricao).trim()) {
        return res.status(400).json({ error: 'Campo "descricao" é obrigatório.' });
      }
      if (!modelo_id) return res.status(400).json({ error: 'Campo "modelo_id" é obrigatório.' });

      const rows = await sql`
        INSERT INTO caixa_regras (descricao, qtd_min, qtd_max, modelo_id, cliente, observacao)
        VALUES (
          ${String(descricao).trim()},
          ${qtd_min ?? null},
          ${qtd_max ?? null},
          ${modelo_id},
          ${cliente || null},
          ${observacao || null}
        )
        RETURNING id, descricao, qtd_min, qtd_max, modelo_id, cliente, observacao, ativa
      `;
      return res.status(201).json(rows[0]);
    } catch (error) {
      console.error('Erro POST caixa_regras:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const id = req.query.id || (req.body && req.body.id);
      if (!id) return res.status(400).json({ error: 'Parâmetro "id" é obrigatório.' });
      await sql`DELETE FROM caixa_regras WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error('Erro DELETE caixa_regras:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Método não permitido.' });
}
