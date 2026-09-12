// Vercel Serverless Function — baixa automática REAL de estoque de caixa.
// Busca as notas fiscais de UM dia no Tiny, pega os itens de cada nota,
// resolve a caixa (caixa_regras, com fallback pro mapeamento padrão em
// produto_caixa) e GRAVA a saída em caixa_movimentacoes — uma vez só por
// nota, mesmo que o job rode de novo (caixa_auto_log garante isso).
//
// Sem retroativo: só processa a data pedida (padrão: ontem, pensado pra
// rodar 1x por dia via cron cobrindo o dia anterior inteiro). Escopo
// inicial: filial SP.
//
// GET /api/caixa-auto-executar?filial=SP&data=12/09/2026

import { neon } from '@neondatabase/serverless';

const TINY_BASE_URL = 'https://api.tiny.com.br/api2';
const TINY_FILIAIS = {
  SP: 'TINY_TOKEN_SP',
  SUL: 'TINY_TOKEN_SUL',
  TRADE: 'TINY_TOKEN_TRADE',
};
const MAX_NOTAS_POR_EXECUCAO = 200; // trava de segurança pra não estourar cota da API do Tiny

function toBrDate(d) {
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}
function toIsoDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
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
      if (nf.tipo !== 'S') return;
      if (!nf.id) return;
      notas.push({ id: nf.id, numero: nf.numero, cliente: (nf.cliente || {}).nome || null });
    });
    pagina++;
  } while (pagina <= totalPaginas && notas.length < MAX_NOTAS_POR_EXECUCAO);
  return notas.slice(0, MAX_NOTAS_POR_EXECUCAO);
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

  // Padrão: ontem (dia anterior completo) — pensado pra rodar de madrugada
  // cobrindo o dia que acabou de fechar. Aceita ?data=AAAA-MM-DD (ISO, igual
  // ao <input type="date"> do caixas.html) pra rodar manualmente num dia
  // específico (ex: hoje, ou quando o caixas.html chama isso sozinho).
  let dataAlvo;
  if (req.query.data) {
    const [yyyy, mm, dd] = String(req.query.data).split('-').map(Number);
    dataAlvo = new Date(yyyy, mm - 1, dd, 12, 0, 0);
  } else {
    dataAlvo = new Date();
    dataAlvo.setDate(dataAlvo.getDate() - 1);
  }
  const dataBr = toBrDate(dataAlvo);
  const dataIso = toIsoDate(dataAlvo);

  const tokenEnv = TINY_FILIAIS[filial];
  if (!tokenEnv || !process.env[tokenEnv]) {
    return res.status(400).json({ error: `Token do Tiny não configurado para a filial "${filial}".` });
  }
  const token = process.env[tokenEnv];

  const sql = neon(process.env.DATABASE_URL);

  try {
    const notas = await buscarNotasDoDia(token, dataBr);

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
      if (Number(r.total_skus_na_regra) > 1) continue;
      if (!regrasPorSku.has(r.sku)) regrasPorSku.set(r.sku, []);
      regrasPorSku.get(r.sku).push(r);
    }

    function resolverCaixa(sku, qtd, clienteNota) {
      const candidatas = regrasPorSku.get(sku) || [];
      if (candidatas.length > 0) {
        const emFaixa = candidatas.filter(r =>
          (r.qtd_min === null || qtd >= r.qtd_min) &&
          (r.qtd_max === null || qtd <= r.qtd_max)
        );
        if (emFaixa.length === 0) return { fora_da_faixa: true };
        // prioriza regra especifica do cliente sobre a geral, se ambas baterem
        const doCliente = clienteNota && emFaixa.find(r => r.cliente && r.cliente.toLowerCase() === clienteNota.toLowerCase());
        const match = doCliente || emFaixa.find(r => !r.cliente) || emFaixa[0];
        return { modelo_id: match.modelo_id, qtd_caixas: match.qtd_caixas, regra_id: match.id, origem: 'regra' };
      }
      const modeloPadrao = produtoCaixaMap.get(sku);
      if (modeloPadrao) return { modelo_id: modeloPadrao, qtd_caixas: qtd, regra_id: null, origem: 'padrao_sem_regra' };
      return null;
    }

    let notasNovas = 0, notasJaProcessadas = 0, notasComPendencia = 0;
    const movimentosGravados = [];
    const pendencias = [];

    for (const nota of notas) {
      const jaProcessada = await sql`SELECT id FROM caixa_auto_log WHERE nota_id = ${nota.id}`;
      if (jaProcessada.length > 0) { notasJaProcessadas++; continue; }

      let itens;
      try {
        itens = await buscarItensDaNota(token, nota.id);
      } catch (err) {
        pendencias.push({ nota: nota.numero, motivo: 'erro_ao_obter_nota', detalhe: err.message });
        continue;
      }

      const consumoDaNota = new Map(); // modelo_id -> qtd_caixas
      let algumaPendencia = false;

      for (const item of itens) {
        const resolucao = resolverCaixa(item.sku, item.quantidade, nota.cliente);
        if (!resolucao || resolucao.fora_da_faixa) {
          algumaPendencia = true;
          pendencias.push({
            nota: nota.numero, sku: item.sku, descricao: item.descricao, quantidade: item.quantidade,
            motivo: resolucao?.fora_da_faixa ? 'fora_da_faixa' : 'sem_mapeamento',
          });
          continue;
        }
        consumoDaNota.set(resolucao.modelo_id, (consumoDaNota.get(resolucao.modelo_id) || 0) + resolucao.qtd_caixas);
      }

      for (const [modeloId, qtdCaixas] of consumoDaNota) {
        const [mov] = await sql`
          INSERT INTO caixa_movimentacoes (modelo_id, filial, tipo, quantidade, data, observacao, automatica)
          VALUES (${modeloId}, ${filial}, 'saida', ${qtdCaixas}, ${dataIso}, ${'Auto — NF ' + nota.numero}, true)
          RETURNING id
        `;
        movimentosGravados.push({ id: mov.id, nota: nota.numero, modelo_id: modeloId, qtd_caixas: qtdCaixas });
      }

      await sql`
        INSERT INTO caixa_auto_log (nota_id, nota_numero, filial, status)
        VALUES (${nota.id}, ${nota.numero}, ${filial}, ${algumaPendencia ? 'parcial' : 'ok'})
      `;
      notasNovas++;
      if (algumaPendencia) notasComPendencia++;
    }

    return res.status(200).json({
      filial, data: dataBr,
      notas_encontradas: notas.length,
      notas_novas_processadas: notasNovas,
      notas_ja_processadas_antes: notasJaProcessadas,
      notas_com_pendencia: notasComPendencia,
      movimentos_gravados: movimentosGravados,
      pendencias,
    });
  } catch (error) {
    console.error('Erro caixa-auto-executar:', error);
    return res.status(500).json({ error: error.message });
  }
}
