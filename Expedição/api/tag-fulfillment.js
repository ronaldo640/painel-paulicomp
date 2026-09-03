// Vercel Serverless Function — identifica notas fiscais que na verdade são
// envios "Mercado Envios Fulfillment" (Full) e corrige o campo `canal` na
// tabela dispatches, que hoje as classifica genericamente como "Mercado
// Envios" (a busca de notas fiscais não distingue Full de envio normal).
//
// Roda como um processo SEPARADO da sincronização principal (tiny-sync.js)
// de propósito: descobrir se um pedido é Fulfillment exige 1 chamada extra
// por pedido (pedido.obter.php) — o mesmo padrão pesado que já vimos causar
// bloqueio de acesso da API do Tiny quando feito em volume alto. Fazer isso
// aqui, num job à parte com janela pequena, evita deixar a sincronização
// principal (rápida, por página) mais lenta.
//
// Como funciona: para cada nota fiscal já sincronizada com canal genérico
// "Mercado Envios", busca o pedido correspondente pelo número do e-commerce
// (guardado em dispatches.numero_ecommerce) e confere se o pedido tem
// ecommerce.nomeEcommerce contendo "Fulfillment" ou deposito começando com
// "Full". Se sim, atualiza o canal dessa nota para "Mercado Envios Fulfillment".

import { neon } from '@neondatabase/serverless';
import { ensureDispatchesColumns } from './tiny-sync.js';

const TINY_PEDIDOS_URL = 'https://api.tiny.com.br/api2/pedidos.pesquisa.php';
const TINY_PEDIDO_DETALHE_URL = 'https://api.tiny.com.br/api2/pedido.obter.php';
const LOOKBACK_DAYS = 14; // janela padrão da rotina — histórico maior via dataInicial/dataFinal manual
const MAX_CANDIDATOS_POR_FILIAL = 150;
const STAGGER_MS = 300;
const MAX_RETRIES = 3;
const CANAL_FULFILLMENT = 'Mercado Envios Fulfillment';

const TINY_FILIAIS = [
  { key: 'SP', nome: 'PAULICOMP SP', env: 'TINY_TOKEN_SP' },
  { key: 'SUL', nome: 'PAULICOMP SUL', env: 'TINY_TOKEN_SUL' },
  { key: 'TRADE', nome: 'COMP TRADE', env: 'TINY_TOKEN_TRADE' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isFulfillment(pedido) {
  if (!pedido) return false;
  const nomeEcommerce = (pedido.ecommerce && pedido.ecommerce.nomeEcommerce) || '';
  const deposito = pedido.deposito || '';
  return /fulfillment/i.test(nomeEcommerce) || /^full\b/i.test(deposito);
}

async function buscarPedidoIdPorEcommerce(token, numeroEcommerce) {
  const params = new URLSearchParams({ token, formato: 'json', numeroEcommerce });
  const resp = await fetch(`${TINY_PEDIDOS_URL}?${params.toString()}`);
  const json = await resp.json();
  const retorno = json.retorno || {};
  if (retorno.status === 'Erro' || retorno.status === 'erro') {
    throw new Error((retorno.erros || []).map(e => e.erro).join('; ') || 'Erro ao buscar pedido.');
  }
  const pedidos = retorno.pedidos || [];
  return pedidos.length > 0 ? pedidos[0].pedido.id : null;
}

async function obterPedidoUmaVez(token, id) {
  const params = new URLSearchParams({ token, formato: 'json', id: String(id) });
  const resp = await fetch(`${TINY_PEDIDO_DETALHE_URL}?${params.toString()}`);
  const json = await resp.json();
  const retorno = json.retorno || {};
  if (retorno.status === 'Erro' || retorno.status === 'erro') {
    throw new Error((retorno.erros || []).map(e => e.erro).join('; ') || 'Erro ao obter pedido.');
  }
  return retorno.pedido;
}

async function comRetry(fn, tentativa = 1) {
  try {
    return await fn();
  } catch (err) {
    const bloqueado = /bloqueada|excedido/i.test(err.message || '');
    if (bloqueado && tentativa <= MAX_RETRIES) {
      await sleep(800 * tentativa);
      return comRetry(fn, tentativa + 1);
    }
    throw err;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  }

  const deadline = Date.now() + 45000;
  const query = req.method === 'GET' ? req.query : (req.body || {});

  let dataInicial = query.dataInicial || null;
  let dataFinal = query.dataFinal || null;
  if (!dataInicial || !dataFinal) {
    const hoje = new Date();
    const inicio = new Date(hoje.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    dataFinal = dataFinal || hoje.toISOString().substring(0, 10);
    dataInicial = dataInicial || inicio.toISOString().substring(0, 10);
  }

  const filialFiltro = query.filial ? String(query.filial).toUpperCase() : null;
  const filiaisAtivas = TINY_FILIAIS.filter(f => process.env[f.env] && (!filialFiltro || f.key === filialFiltro));
  if (filiaisAtivas.length === 0) {
    return res.status(200).json({ ok: true, results: [], warning: 'Nenhum token do Tiny configurado.' });
  }

  const sql = neon(process.env.DATABASE_URL);
  await ensureDispatchesColumns(sql);

  const results = await Promise.all(filiaisAtivas.map(async f => {
    const token = process.env[f.env];
    try {
      // numero_ecommerce só existe em pedidos de marketplace (Mercado Livre etc.), então já
      // restringe bem por si só — o canal de um envio Mercado Livre normal pode vir como
      // "Mercado Envios" (nosso padrão) ou como o nome do transportador informado pelo Tiny
      // (ex: "EBAZAR.COM.BR LTDA", a razão social do Mercado Livre), então checamos qualquer
      // nota ainda não marcada como Fulfillment, não só a que caiu no rótulo genérico.
      const candidatos = await sql`
        SELECT nf, TO_CHAR(data, 'YYYY-MM-DD') AS data, numero_ecommerce
        FROM dispatches
        WHERE filial = ${f.nome}
          AND canal NOT ILIKE '%fulfillment%'
          AND numero_ecommerce IS NOT NULL
          AND data BETWEEN ${dataInicial} AND ${dataFinal}
        ORDER BY data DESC
        LIMIT ${MAX_CANDIDATOS_POR_FILIAL};
      `;

      let verificados = 0, marcados = 0, falhas = 0, ultimoErro = null, cortadoPorTempo = false;

      for (const c of candidatos) {
        if (Date.now() >= deadline) { cortadoPorTempo = true; break; }
        if (verificados > 0) await sleep(STAGGER_MS);
        verificados++;
        try {
          const pedidoId = await comRetry(() => buscarPedidoIdPorEcommerce(token, c.numero_ecommerce));
          if (!pedidoId) continue;
          await sleep(STAGGER_MS);
          const pedido = await comRetry(() => obterPedidoUmaVez(token, pedidoId));
          if (isFulfillment(pedido)) {
            await sql`
              UPDATE dispatches SET canal = ${CANAL_FULFILLMENT}
              WHERE filial = ${f.nome} AND nf = ${c.nf} AND data = ${c.data};
            `;
            marcados++;
          }
        } catch (err) {
          falhas++;
          ultimoErro = err.message;
        }
      }

      return {
        filial: f.nome,
        candidatos: candidatos.length,
        verificados,
        marcadosFulfillment: marcados,
        falhas,
        erro: falhas > 0 ? ultimoErro : undefined,
        cortadoPorTempo,
      };
    } catch (err) {
      return { filial: f.nome, error: err.message };
    }
  }));

  res.status(200).json({ ok: true, dataInicial, dataFinal, results });
}
