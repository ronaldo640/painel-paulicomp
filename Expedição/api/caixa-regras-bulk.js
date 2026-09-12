// Vercel Serverless Function — importação em lote de regras de embalagem.
// Recebe um array de regras (cada uma com 1+ SKUs) e insere tudo numa só
// invocação, evitando centenas de chamadas HTTP separadas quando o usuário
// mapeia um lote grande de exceções de uma vez (ex: planilha exportada).
//
// POST body: { regras: [{ skus: string[], qtd_min, qtd_max, modelo_id,
//              qtd_caixas, cliente, observacao }, ...] }

import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const { regras } = req.body || {};
  if (!Array.isArray(regras) || regras.length === 0) {
    return res.status(400).json({ error: 'Campo "regras" precisa ser um array não vazio.' });
  }

  const sql = neon(process.env.DATABASE_URL);

  async function processarRegra(r, index) {
    const skuList = Array.isArray(r.skus) ? r.skus.filter(Boolean) : [];
    try {
      if (skuList.length === 0) throw new Error('sem SKU');
      if (!r.modelo_id) throw new Error('sem modelo_id');

      const [regra] = await sql`
        INSERT INTO caixa_regras (descricao, qtd_min, qtd_max, modelo_id, qtd_caixas, cliente, observacao)
        VALUES (
          ${r.descricao ? String(r.descricao).trim() : null},
          ${r.qtd_min ?? null},
          ${r.qtd_max ?? null},
          ${r.modelo_id},
          ${r.qtd_caixas ?? 1},
          ${r.cliente || null},
          ${r.observacao || null}
        )
        RETURNING id
      `;
      await Promise.all(skuList.map(sku => sql`
        INSERT INTO caixa_regra_produtos (regra_id, sku) VALUES (${regra.id}, ${sku})
      `));
      return { index, id: regra.id, ok: true };
    } catch (error) {
      return { index, ok: false, error: error.message, skus: skuList };
    }
  }

  // Processa em lotes concorrentes (não uma regra de cada vez) — com
  // centenas de linhas, sequencial estouraria o tempo máximo da função.
  const CHUNK_SIZE = 20;
  const resultados = [];
  for (let i = 0; i < regras.length; i += CHUNK_SIZE) {
    const chunk = regras.slice(i, i + CHUNK_SIZE);
    const chunkResults = await Promise.all(chunk.map((r, j) => processarRegra(r, i + j)));
    resultados.push(...chunkResults);
  }

  const inseridas = resultados.filter(r => r.ok).length;
  return res.status(200).json({ total: regras.length, inseridas, resultados });
}
