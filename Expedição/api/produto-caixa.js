// Vercel Serverless Function — lista o mapeamento produto (SKU) -> modelo
// de caixa. Usado pra alimentar a busca de SKU na tela de Regras de
// Embalagem (autocomplete client-side sobre os ~474 produtos).

import { neon } from '@neondatabase/serverless';

// ============================================================
// TEMPORÁRIO — corrige retroativamente movimentos automáticos gravados
// como estoque real que na verdade eram de notas Fulfillment (série 2),
// de antes da separação conta_estoque existir. REMOVER depois de usar.
// ============================================================
async function fixFulfillment(req, res) {
  const filial = req.query.filial ? String(req.query.filial).toUpperCase() : 'SP';
  const numeros = String(req.query.notas || '').split(',').map(s => s.trim()).filter(Boolean);
  if (numeros.length === 0) return res.status(400).json({ error: 'Parâmetro "notas" (números separados por vírgula) é obrigatório.' });

  const sql = neon(process.env.DATABASE_URL);
  const observacoesAlvo = numeros.map(n => `Auto — NF ${n}`);

  const rows = await sql`
    UPDATE caixa_movimentacoes
    SET conta_estoque = false,
        observacao = REPLACE(observacao, 'Auto — NF', 'Auto (Fulfillment, informativo) — NF')
    WHERE filial = ${filial} AND automatica = true AND observacao = ANY(${observacoesAlvo})
    RETURNING id, modelo_id, quantidade, data, observacao, conta_estoque
  `;
  return res.status(200).json({ filial, notas_alvo: numeros, corrigidos: rows });
}
// ============================================================ fim do bloco temporário

// ============================================================
// TEMPORÁRIO — checa a série das notas de um dia específico, pra ver
// se alguma das já processadas antes da separação do Fulfillment (2026-
// 09-12) era série 2. REMOVER depois de usar.
// ============================================================
const TINY_FILIAIS_DEBUG = { SP: 'TINY_TOKEN_SP', SUL: 'TINY_TOKEN_SUL', TRADE: 'TINY_TOKEN_TRADE' };
async function debugSerie(req, res) {
  const filial = req.query.filial ? String(req.query.filial).toUpperCase() : 'SP';
  const data = req.query.data; // DD/MM/AAAA
  const tokenEnv = TINY_FILIAIS_DEBUG[filial];
  if (!tokenEnv || !process.env[tokenEnv]) return res.status(400).json({ error: 'token' });
  const token = process.env[tokenEnv];
  const notas = [];
  let pagina = 1, totalPaginas = 1;
  do {
    const params = new URLSearchParams({ token, formato: 'json', pagina: String(pagina), dataInicial: data, dataFinal: data });
    const resp = await fetch(`https://api.tiny.com.br/api2/notas.fiscais.pesquisa.php?${params.toString()}`);
    const json = await resp.json();
    const retorno = json.retorno || {};
    if (retorno.status === 'Erro' || retorno.status === 'erro') return res.status(500).json({ error: (retorno.erros || []).map(e => e.erro).join('; ') });
    totalPaginas = Number(retorno.numero_paginas || 1);
    (retorno.notas_fiscais || []).forEach(item => {
      const nf = item.nota_fiscal || {};
      if (nf.tipo !== 'S') return;
      if ((nf.descricao_situacao || '').toLowerCase().includes('cancelad')) return;
      notas.push({ numero: nf.numero, serie: nf.serie, isFulfillment: String(nf.serie) === '2' });
    });
    pagina++;
  } while (pagina <= totalPaginas);
  return res.status(200).json({ filial, data, notas });
}
// ============================================================ fim do bloco temporário

export default async function handler(req, res) {
  if (req.query.debugSerie) return debugSerie(req, res); // TEMPORÁRIO — remover depois
  if (req.query.fixFulfillment) return fixFulfillment(req, res); // TEMPORÁRIO — remover depois
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido.' });

  const sql = neon(process.env.DATABASE_URL);

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
