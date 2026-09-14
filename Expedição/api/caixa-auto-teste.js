// Vercel Serverless Function — TESTE (somente leitura) da automação de
// consumo de caixas: busca as notas fiscais de UM dia no Tiny, pega os
// itens de cada nota, aplica as regras de embalagem (caixa_regras +
// fallback produto_caixa) e calcula quanto seria debitado de cada modelo
// de caixa. NÃO grava nada em caixa_movimentacoes — é só um relatório
// pra validar a lógica antes de ligar a baixa automática de verdade.
//
// GET /api/caixa-auto-teste?filial=SP&data=12/09/2026

import { neon } from '@neondatabase/serverless';

const TINY_BASE_URL = 'https://api.tiny.com.br/api2';
const TINY_FILIAIS = {
  SP: 'TINY_TOKEN_SP',
  SUL: 'TINY_TOKEN_SUL',
  TRADE: 'TINY_TOKEN_TRADE',
};
const MAX_NOTAS_POR_TESTE = 60; // trava de segurança pra não estourar cota da API num teste

function toBrDateHoje() {
  const d = new Date();
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}

async function buscarNotasDoDia(token, dataBr) {
  const notas = [];
  let pagina = 1;
  let totalPaginas = 1;
  do {
    const params = new URLSearchParams({
      token, formato: 'json', pagina: String(pagina),
      dataInicial: dataBr, dataFinal: dataBr,
    });
    const resp = await fetch(`${TINY_BASE_URL}/notas.fiscais.pesquisa.php?${params.toString()}`);
    const json = await resp.json();
    const retorno = json.retorno || {};
    if (retorno.status === 'Erro' || retorno.status === 'erro') {
      throw new Error((retorno.erros || []).map(e => e.erro).join('; ') || 'Erro na busca de notas.');
    }
    totalPaginas = Number(retorno.numero_paginas || 1);
    (retorno.notas_fiscais || []).forEach(item => {
      const nf = item.nota_fiscal || {};
      const situacao = (nf.descricao_situacao || '').toLowerCase();
      if (situacao.includes('cancelad')) return;
      if (nf.tipo !== 'S') return; // só saída (despacho), igual ao sync principal
      if (!nf.id) return;
      notas.push({ id: nf.id, numero: nf.numero, cliente: (nf.cliente || {}).nome || null });
    });
    pagina++;
  } while (pagina <= totalPaginas && notas.length < MAX_NOTAS_POR_TESTE);
  return notas.slice(0, MAX_NOTAS_POR_TESTE);
}

async function buscarItensDaNota(token, notaId) {
  const params = new URLSearchParams({ token, id: String(notaId), formato: 'json' });
  const resp = await fetch(`${TINY_BASE_URL}/nota.fiscal.obter.php?${params.toString()}`);
  const json = await resp.json();
  const retorno = json.retorno || {};
  if (retorno.status === 'Erro' || retorno.status === 'erro') {
    throw new Error((retorno.erros || []).map(e => e.erro).join('; ') || `Erro ao obter nota ${notaId}.`);
  }
  const nf = retorno.nota_fiscal || {};
  return (nf.itens || []).map(i => i.item || i).map(it => ({
    sku: String(it.codigo || '').trim(),
    quantidade: Number(it.quantidade || 0),
    descricao: it.descricao || '',
  })).filter(it => it.sku && it.quantidade > 0);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido.' });

  const filial = req.query.filial ? String(req.query.filial).toUpperCase() : 'SP';
  const dataBr = req.query.data ? String(req.query.data) : toBrDateHoje();
  const tokenEnv = TINY_FILIAIS[filial];
  if (!tokenEnv || !process.env[tokenEnv]) {
    return res.status(400).json({ error: `Token do Tiny não configurado para a filial "${filial}".` });
  }
  const token = process.env[tokenEnv];

  const sql = neon(process.env.DATABASE_URL);

  try {
    const notas = await buscarNotasDoDia(token, dataBr);

    // Carrega o mapeamento produto->caixa e as regras uma vez só (não por item)
    const produtoCaixaRows = await sql`SELECT sku, modelo_id FROM produto_caixa`;
    const produtoCaixaMap = new Map(produtoCaixaRows.map(r => [r.sku, r.modelo_id]));

    const regraRows = await sql`
      SELECT r.id, r.qtd_min, r.qtd_max, r.modelo_id, r.qtd_caixas, r.cliente, rp.sku,
             (SELECT count(*) FROM caixa_regra_produtos rp2 WHERE rp2.regra_id = r.id) AS total_skus_na_regra
      FROM caixa_regras r
      JOIN caixa_regra_produtos rp ON rp.regra_id = r.id
      WHERE r.ativa = true
    `;
    const regrasPorSku = new Map();
    for (const r of regraRows) {
      if (Number(r.total_skus_na_regra) > 1) continue; // regra de combinação de produtos — não suportado neste teste ainda
      if (!regrasPorSku.has(r.sku)) regrasPorSku.set(r.sku, []);
      regrasPorSku.get(r.sku).push(r);
    }

    const modelosRows = await sql`SELECT id, nome FROM caixa_modelos`;
    const modeloNomeMap = new Map(modelosRows.map(m => [m.id, m.nome]));

    // Retorna um de três formatos:
    //  - { modelo_id, qtd_caixas, regra_id, origem: 'regra' } — uma regra cobre essa quantidade
    //  - { fora_da_faixa: true } — o SKU tem regra(s), mas nenhuma cobre essa quantidade
    //  - { modelo_id, qtd_caixas, regra_id: null, origem: 'padrao_sem_regra' } — sem regra
    //    nenhuma pra esse SKU, caiu no mapeamento simples (1 caixa por unidade, não validado)
    //  - null — SKU nem tem mapeamento padrão, totalmente desconhecido
    function resolverCaixa(sku, qtd) {
      const candidatas = regrasPorSku.get(sku) || [];
      if (candidatas.length > 0) {
        const match = candidatas.find(r =>
          (r.qtd_min === null || qtd >= r.qtd_min) &&
          (r.qtd_max === null || qtd <= r.qtd_max)
        );
        if (match) return { modelo_id: match.modelo_id, qtd_caixas: match.qtd_caixas, regra_id: match.id, origem: 'regra' };
        return { fora_da_faixa: true };
      }

      const modeloPadrao = produtoCaixaMap.get(sku);
      if (modeloPadrao) return { modelo_id: modeloPadrao, qtd_caixas: qtd, regra_id: null, origem: 'padrao_sem_regra' };

      return null; // sem mapeamento nenhum
    }

    const consumoPorModelo = new Map();
    const itensSemMapeamento = [];
    const itensForaDaFaixa = [];
    let itensProcessados = 0;
    const detalhePorNota = [];

    for (const nota of notas) {
      let itens;
      try {
        itens = await buscarItensDaNota(token, nota.id);
      } catch (err) {
        detalhePorNota.push({ nota: nota.numero, erro: err.message });
        continue;
      }
      const linhasNota = [];
      for (const item of itens) {
        itensProcessados++;
        const resolucao = resolverCaixa(item.sku, item.quantidade);
        if (!resolucao) {
          itensSemMapeamento.push({ sku: item.sku, descricao: item.descricao, quantidade: item.quantidade, nota: nota.numero });
          continue;
        }
        if (resolucao.fora_da_faixa) {
          itensForaDaFaixa.push({ sku: item.sku, descricao: item.descricao, quantidade: item.quantidade, nota: nota.numero });
          continue;
        }
        const atual = consumoPorModelo.get(resolucao.modelo_id) || 0;
        consumoPorModelo.set(resolucao.modelo_id, atual + resolucao.qtd_caixas);
        linhasNota.push({ sku: item.sku, quantidade: item.quantidade, modelo_id: resolucao.modelo_id, modelo_nome: modeloNomeMap.get(resolucao.modelo_id), qtd_caixas: resolucao.qtd_caixas, origem: resolucao.origem });
      }
      detalhePorNota.push({ nota: nota.numero, cliente: nota.cliente, itens: linhasNota });
    }

    const resumo = [...consumoPorModelo.entries()].map(([modelo_id, total]) => ({
      modelo_id, modelo_nome: modeloNomeMap.get(modelo_id), total_caixas: total,
    })).sort((a, b) => b.total_caixas - a.total_caixas);

    return res.status(200).json({
      dry_run: true,
      filial, data: dataBr,
      notas_encontradas: notas.length,
      itens_processados: itensProcessados,
      consumo_estimado_por_modelo: resumo,
      itens_sem_mapeamento: itensSemMapeamento,
      itens_fora_da_faixa: itensForaDaFaixa,
      detalhe_por_nota: detalhePorNota,
    });
  } catch (error) {
    console.error('Erro caixa-auto-teste:', error);
    return res.status(500).json({ error: error.message });
  }
}
