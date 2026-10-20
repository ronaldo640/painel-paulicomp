// Vercel Serverless Function — resumo por modelo de caixa para uma filial:
// estoque atual, consumo médio (7 e 30 dias), ponto de reposição (consumo
// x lead time + margem de segurança), cobertura em dias e status de
// urgência de compra. É o que alimenta os KPIs, o ranking, o gráfico e a
// tabela da aba "Controle de Caixas".

import { neon } from '@neondatabase/serverless';
import { calcularResumo } from '../lib/caixa-resumo-calculo.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  // Marca TODAS as pendências abertas de um SKU como resolvidas — o alerta
  // agrupa por SKU (não por nota), então dispensar precisa limpar todas as
  // ocorrências de uma vez, não só a que estava sendo exibida.
  if (req.method === 'POST') {
    try {
      const { sku, filial: filialBody } = req.body || {};
      if (!sku) return res.status(400).json({ error: 'Campo "sku" é obrigatório.' });
      const filialResolver = filialBody ? String(filialBody).toUpperCase() : 'SP';
      await sql`UPDATE caixa_auto_pendencias SET resolvida = true WHERE sku = ${sku} AND filial = ${filialResolver} AND resolvida = false`;
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error('Erro POST caixa-resumo (resolver pendência):', error);
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido.' });

  const filial = req.query.filial ? String(req.query.filial).toUpperCase() : 'SP';

  try {
    const resumo = await calcularResumo(sql, filial, req.query.limitePendencias);
    return res.status(200).json(resumo);
  } catch (error) {
    console.error('Erro GET caixa-resumo:', error);
    return res.status(500).json({ error: error.message });
  }
}
