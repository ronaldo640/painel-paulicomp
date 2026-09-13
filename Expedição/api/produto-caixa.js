// Vercel Serverless Function — lista o mapeamento produto (SKU) -> modelo
// de caixa. Usado pra alimentar a busca de SKU na tela de Regras de
// Embalagem (autocomplete client-side sobre os ~474 produtos).

import { neon } from '@neondatabase/serverless';

// ============================================================
// TEMPORÁRIO — diagnóstico pra achar como o envio em lote pro Ebazar
// (depósito Fulfillment do Mercado Livre) aparece no Tiny. Reaproveita
// este arquivo (em vez de criar um novo) pra não estourar o limite de
// 12 funções serverless do plano Hobby da Vercel. REMOVER esta função e
// a chamada dela assim que o diagnóstico terminar.
// ============================================================
const TINY_BASE_URL = 'https://api.tiny.com.br/api2';
const TINY_FILIAIS_DEBUG = { SP: 'TINY_TOKEN_SP', SUL: 'TINY_TOKEN_SUL', TRADE: 'TINY_TOKEN_TRADE' };

function toBrDateDebug(d) {
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}

async function debugEbazar(req, res) {
  const filial = req.query.filial ? String(req.query.filial).toUpperCase() : 'SP';
  const dias = Number(req.query.dias) || 90;
  const tokenEnv = TINY_FILIAIS_DEBUG[filial];
  if (!tokenEnv || !process.env[tokenEnv]) return res.status(400).json({ error: `Token não configurado para "${filial}".` });
  const token = process.env[tokenEnv];

  const hoje = new Date();
  const inicio = new Date(hoje.getTime() - dias * 24 * 60 * 60 * 1000);
  const dataInicial = toBrDateDebug(inicio);
  const dataFinal = toBrDateDebug(hoje);

  async function buscarNotasAmplo() {
    const encontradas = [];
    let pagina = 1, totalPaginas = 1;
    do {
      const params = new URLSearchParams({ token, formato: 'json', pagina: String(pagina), dataInicial, dataFinal });
      const resp = await fetch(`${TINY_BASE_URL}/notas.fiscais.pesquisa.php?${params.toString()}`);
      const json = await resp.json();
      const retorno = json.retorno || {};
      if (retorno.status === 'Erro' || retorno.status === 'erro') return { erro: (retorno.erros || []).map(e => e.erro).join('; ') };
      totalPaginas = Number(retorno.numero_paginas || 1);
      (retorno.notas_fiscais || []).forEach(item => {
        const nf = item.nota_fiscal || {};
        const nomes = [(nf.cliente || {}).nome, (nf.endereco_entrega || {}).nome_destinatario, nf.nome].filter(Boolean).join(' | ').toLowerCase();
        if (nomes.includes('ebazar') || nomes.includes('mercado livre') || nomes.includes('meli')) {
          encontradas.push({
            numero: nf.numero, serie: nf.serie, tipo: nf.tipo, situacao: nf.descricao_situacao,
            data: nf.data_emissao, cliente: (nf.cliente || {}).nome, destinatario: (nf.endereco_entrega || {}).nome_destinatario,
            natureza_operacao: nf.natureza_operacao || nf.nome_natureza_operacao || null,
          });
        }
      });
      pagina++;
    } while (pagina <= totalPaginas && pagina <= 20);
    return { encontradas, totalPaginas };
  }

  async function buscarPedidosAmplo() {
    const encontrados = [];
    let pagina = 1, totalPaginas = 1;
    do {
      const params = new URLSearchParams({ token, formato: 'json', pagina: String(pagina), dataInicial, dataFinal });
      const resp = await fetch(`${TINY_BASE_URL}/pedidos.pesquisa.php?${params.toString()}`);
      const json = await resp.json();
      const retorno = json.retorno || {};
      if (retorno.status === 'Erro' || retorno.status === 'erro') return { erro: (retorno.erros || []).map(e => e.erro).join('; ') };
      totalPaginas = Number(retorno.numero_paginas || 1);
      (retorno.pedidos || []).forEach(item => {
        const p = item.pedido || {};
        const nomes = [(p.cliente || {}).nome, p.nome].filter(Boolean).join(' | ').toLowerCase();
        if (nomes.includes('ebazar') || nomes.includes('mercado livre') || nomes.includes('meli')) {
          encontrados.push({
            numero: p.numero, situacao: p.situacao, data_pedido: p.data_pedido,
            cliente: (p.cliente || {}).nome, numero_ecommerce: p.numero_ecommerce, nome_ecommerce: p.nome_ecommerce,
          });
        }
      });
      pagina++;
    } while (pagina <= totalPaginas && pagina <= 20);
    return { encontrados, totalPaginas };
  }

  try {
    const [notas, pedidos] = await Promise.all([buscarNotasAmplo(), buscarPedidosAmplo()]);
    return res.status(200).json({ filial, janela: `${dataInicial} a ${dataFinal}`, notas_fiscais: notas, pedidos });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
// ============================================================ fim do bloco temporário

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.query.debugEbazar) return debugEbazar(req, res); // TEMPORÁRIO — remover depois
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
