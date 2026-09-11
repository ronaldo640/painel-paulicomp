// Vercel Serverless Function — regras de embalagem (casos especiais de
// quantidade/combinação que usam uma caixa diferente da padrão, ex:
// "até 3 telas desmontadas do mesmo SKU cabem na caixa de 1 tela").
// Cada regra referencia um ou mais SKUs reais (produto_caixa), não uma
// descrição livre. GET lista, POST cria, PUT edita (substitui a lista de
// SKUs inteira), DELETE remove. É só um repositório por enquanto — não
// calcula nada sozinho, alimenta a automação de consumo mais pra frente.

import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  if (req.method === 'GET') {
    try {
      const regras = await sql`
        SELECT r.id, r.descricao, r.qtd_min, r.qtd_max, r.modelo_id, cm.nome AS modelo_nome,
               r.cliente, r.observacao, r.ativa
        FROM caixa_regras r
        JOIN caixa_modelos cm ON cm.id = r.modelo_id
        ORDER BY r.created_at DESC
      `;
      const produtos = await sql`
        SELECT rp.regra_id, rp.sku, pc.produto
        FROM caixa_regra_produtos rp
        JOIN produto_caixa pc ON pc.sku = rp.sku
      `;
      const produtosPorRegra = new Map();
      for (const p of produtos) {
        if (!produtosPorRegra.has(p.regra_id)) produtosPorRegra.set(p.regra_id, []);
        produtosPorRegra.get(p.regra_id).push({ sku: p.sku, produto: p.produto });
      }
      const result = regras.map(r => ({ ...r, produtos: produtosPorRegra.get(r.id) || [] }));
      return res.status(200).json(result);
    } catch (error) {
      console.error('Erro GET caixa_regras:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const { skus, qtd_min, qtd_max, modelo_id, cliente, observacao, descricao } = req.body || {};
      const skuList = Array.isArray(skus) ? skus.filter(Boolean) : [];
      if (skuList.length === 0) {
        return res.status(400).json({ error: 'Selecione pelo menos um SKU.' });
      }
      if (!modelo_id) return res.status(400).json({ error: 'Campo "modelo_id" é obrigatório.' });

      const [regra] = await sql`
        INSERT INTO caixa_regras (descricao, qtd_min, qtd_max, modelo_id, cliente, observacao)
        VALUES (
          ${descricao ? String(descricao).trim() : null},
          ${qtd_min ?? null},
          ${qtd_max ?? null},
          ${modelo_id},
          ${cliente || null},
          ${observacao || null}
        )
        RETURNING id
      `;

      await Promise.all(skuList.map(sku => sql`
        INSERT INTO caixa_regra_produtos (regra_id, sku) VALUES (${regra.id}, ${sku})
      `));

      return res.status(201).json({ id: regra.id, skus: skuList });
    } catch (error) {
      console.error('Erro POST caixa_regras:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'PUT') {
    try {
      const { id, skus, qtd_min, qtd_max, modelo_id, cliente, observacao, descricao } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Campo "id" é obrigatório.' });
      const skuList = Array.isArray(skus) ? skus.filter(Boolean) : [];
      if (skuList.length === 0) {
        return res.status(400).json({ error: 'Selecione pelo menos um SKU.' });
      }
      if (!modelo_id) return res.status(400).json({ error: 'Campo "modelo_id" é obrigatório.' });

      const rows = await sql`
        UPDATE caixa_regras SET
          descricao = ${descricao ? String(descricao).trim() : null},
          qtd_min = ${qtd_min ?? null},
          qtd_max = ${qtd_max ?? null},
          modelo_id = ${modelo_id},
          cliente = ${cliente || null},
          observacao = ${observacao || null}
        WHERE id = ${id}
        RETURNING id
      `;
      if (rows.length === 0) return res.status(404).json({ error: 'Regra não encontrada.' });

      // Substitui a lista de SKUs inteira (mais simples e previsível do que
      // calcular um diff de quais entraram/saíram).
      await sql`DELETE FROM caixa_regra_produtos WHERE regra_id = ${id}`;
      await Promise.all(skuList.map(sku => sql`
        INSERT INTO caixa_regra_produtos (regra_id, sku) VALUES (${id}, ${sku})
      `));

      return res.status(200).json({ id, skus: skuList });
    } catch (error) {
      console.error('Erro PUT caixa_regras:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const id = req.query.id || (req.body && req.body.id);
      if (!id) return res.status(400).json({ error: 'Parâmetro "id" é obrigatório.' });
      await sql`DELETE FROM caixa_regras WHERE id = ${id}`; // cascata remove caixa_regra_produtos junto
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error('Erro DELETE caixa_regras:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Método não permitido.' });
}
