// Notas emitidas sem saldo de estoque (Sul e Trade).
//
// Responde em /api/saldo-insuficiente, que um rewrite do vercel.json manda para
// /api/tiny-sync?modulo=saldo (o plano Hobby só permite 12 funções).
//
// Como funciona
//   1. As vendas por nota (nota → SKU → quantidade) já estão no Neon, gravadas
//      todo dia pela rotina das Caixas (lib/vendas-itens.js).
//   2. Para cada SKU vendido no período, busca o saldo atual no Tiny e guarda
//      em saldo_produtos. Primeiro tenta a lista de atualizações de estoque
//      (uma chamada traz 100 produtos); se a conta não tiver esse serviço,
//      consulta SKU por SKU (produtos.pesquisa + produto.obter.estoque),
//      espaçado para não bloquear a API. O que não couber em uma chamada fica
//      para a próxima (a tela chama de novo enquanto houver "faltam").
//   3. SKU com saldo negativo: as notas mais recentes que somam esse negativo
//      são as que saíram sem estoque. Ex.: saldo -3 e as últimas vendas foram
//      2 un. ontem e 4 un. anteontem → a de ontem (2 un.) e 1 das 4 de
//      anteontem saíram sem saldo.
//
//   GET /api/saldo-insuficiente?filial=SUL|TRADE&ini=aaaa-mm-dd&fim=aaaa-mm-dd
//       (ou &dias=N para os últimos N dias; padrão 30, até 180)
//       atualiza os saldos que estiverem velhos (até ~40 s) e devolve as notas
//   GET ...&atualizar=0   só lê o que já está no Neon (sem acessar o Tiny)
//
// Só leitura no Tiny: nada é alterado lá.

import { neon } from '@neondatabase/serverless';
import { garantirTabelas } from './vendas-itens.js';

const TINY = 'https://api.tiny.com.br/api2';
const FILIAIS = { SUL: 'TINY_TOKEN_SUL', TRADE: 'TINY_TOKEN_TRADE' };
const VALIDADE_HORAS = 6;      // saldo lido há menos que isso não é buscado de novo
const LIMITE_MS = 40000;       // tempo de Tiny por chamada (função tem 60 s)
const PAUSA_MS = 1100;         // entre chamadas ao Tiny, mesmo ritmo do RMA
const MAX_DIAS = 180;          // período mais longo aceito (mesmo limite da tela)

export const esperar = ms => new Promise(r => setTimeout(r, ms));

let tabelaPronta = false;
async function garantirTabela(sql) {
  if (tabelaPronta) return;
  await sql`CREATE TABLE IF NOT EXISTS saldo_produtos (
    filial TEXT NOT NULL,
    sku TEXT NOT NULL,
    produto_id BIGINT,
    nome TEXT,
    saldo NUMERIC,
    nao_encontrado BOOLEAN NOT NULL DEFAULT false,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (filial, sku)
  )`;
  tabelaPronta = true;
}

function brDe(iso) {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}

export async function tiny(metodo, params) {
  const resp = await fetch(`${TINY}/${metodo}?${new URLSearchParams({ ...params, formato: 'json' })}`);
  const r = (await resp.json()).retorno || {};
  if (String(r.status).toLowerCase() === 'erro') {
    const erros = r.erros || [];
    const semRegistros = String(r.codigo_erro) === '20' ||
      erros.some(e => String(e.codigo_erro) === '20' || /n[ãa]o retornou registros/i.test(e.erro || ''));
    const e = new Error(erros.map(x => x.erro).join('; ') || `Erro no Tiny (${metodo}).`);
    e.semRegistros = semRegistros;
    throw e;
  }
  return r;
}

export const bloqueio = e => /bloquead|excedido|limite/i.test(e.message || '');

async function gravarSaldo(sql, filial, { sku, produtoId = null, nome = null, saldo = null, naoEncontrado = false }) {
  await sql`
    INSERT INTO saldo_produtos (filial, sku, produto_id, nome, saldo, nao_encontrado, atualizado_em)
    VALUES (${filial}, ${sku}, ${produtoId}, ${nome}, ${saldo}, ${naoEncontrado}, now())
    ON CONFLICT (filial, sku) DO UPDATE SET
      produto_id = COALESCE(EXCLUDED.produto_id, saldo_produtos.produto_id),
      nome = COALESCE(EXCLUDED.nome, saldo_produtos.nome),
      saldo = EXCLUDED.saldo,
      nao_encontrado = EXCLUDED.nao_encontrado,
      atualizado_em = now()`;
}

// Caminho rápido: produtos com estoque alterado desde a data, 100 por página.
// Devolve false se a conta não tiver esse serviço (aí vai SKU por SKU).
async function viaAtualizacoes(sql, filial, token, desdeIso, precisa, inicio) {
  let pagina = 1;
  try {
    while (precisa.size && Date.now() - inicio < LIMITE_MS) {
      let r;
      try {
        r = await tiny('lista.atualizacoes.estoque.php', { token, dataAlteracao: `${brDe(desdeIso)} 00:00:00`, pagina: String(pagina) });
      } catch (e) {
        if (e.semRegistros) break;
        throw e;
      }
      const produtos = r.produtos || [];
      if (!produtos.length) break;
      for (const p of produtos) {
        const prod = p.produto || p;
        const sku = String(prod.codigo || '').trim();
        if (!sku || !precisa.has(sku)) continue;
        await gravarSaldo(sql, filial, { sku, produtoId: Number(prod.id) || null, nome: prod.nome || null, saldo: Number(prod.saldo) });
        precisa.delete(sku);
      }
      const total = Number(r.numero_paginas || 0);
      if ((total && pagina >= total) || produtos.length < 100) break;
      pagina++;
      await esperar(PAUSA_MS);
    }
    return true;
  } catch (e) {
    if (bloqueio(e)) throw e;
    console.warn(`lista.atualizacoes.estoque indisponível (${filial}): ${e.message}`);
    return false;
  }
}

// SKU por SKU: acha o id do produto (guardado para as próximas vezes) e lê o saldo.
async function viaProduto(sql, filial, token, sku, produtoId) {
  if (!produtoId) {
    let r;
    try {
      r = await tiny('produtos.pesquisa.php', { token, pesquisa: sku });
    } catch (e) {
      if (e.semRegistros) return gravarSaldo(sql, filial, { sku, naoEncontrado: true });
      throw e;
    }
    const achado = (r.produtos || []).map(p => p.produto || p).find(p => String(p.codigo || '').trim() === sku);
    if (!achado) return gravarSaldo(sql, filial, { sku, naoEncontrado: true });
    produtoId = Number(achado.id);
    await esperar(PAUSA_MS);
  }
  const r = await tiny('produto.obter.estoque.php', { token, id: String(produtoId) });
  const prod = r.produto || {};
  await gravarSaldo(sql, filial, { sku, produtoId, nome: prod.nome || null, saldo: Number(prod.saldo) });
}

async function atualizarSaldos(sql, filial, token, desdeIso, skus) {
  const inicio = Date.now();
  const linhas = await sql`
    SELECT sku, produto_id, atualizado_em > now() - make_interval(hours => ${VALIDADE_HORAS}) AS novo
    FROM saldo_produtos WHERE filial = ${filial} AND sku = ANY(${skus})`;
  const info = new Map(linhas.map(l => [l.sku, l]));
  const precisa = new Set(skus.filter(s => !info.get(s)?.novo));
  if (!precisa.size) return { faltam: 0, bloqueado: false, metodo: null };

  let metodo = 'atualizacoes', bloqueado = false;
  try {
    const ok = await viaAtualizacoes(sql, filial, token, desdeIso, precisa, inicio);
    if (!ok) metodo = 'produto';
  } catch (e) {
    bloqueado = bloqueio(e);
  }
  // O que a lista não trouxe (ou se ela não existe na conta) vai um a um.
  if (!bloqueado) {
    if (metodo === 'atualizacoes' && precisa.size) metodo = 'misto';
    for (const sku of [...precisa]) {
      if (Date.now() - inicio > LIMITE_MS) break;
      await esperar(PAUSA_MS);
      try {
        await viaProduto(sql, filial, token, sku, info.get(sku)?.produto_id ? Number(info.get(sku).produto_id) : null);
        precisa.delete(sku);
      } catch (e) {
        if (bloqueio(e)) { bloqueado = true; break; }
        console.warn(`Saldo de ${sku} (${filial}): ${e.message}`);
        precisa.delete(sku); // erro pontual: não trava a fila; tenta de novo na próxima validade
      }
    }
  }
  return { faltam: precisa.size, bloqueado, metodo };
}

// Distribui o saldo negativo de cada SKU pelas notas mais recentes.
export function notasSemSaldo(vendas, saldos) {
  const porSku = new Map();
  for (const v of vendas) {
    if (!porSku.has(v.sku)) porSku.set(v.sku, []);
    porSku.get(v.sku).push(v);
  }
  const notas = [], produtos = [];
  for (const [sku, s] of saldos) {
    if (s.saldo == null || !(Number(s.saldo) < 0)) continue;
    const negativo = -Number(s.saldo);
    let resta = negativo;
    const lista = (porSku.get(sku) || []).slice()
      .sort((a, b) => (b.data.localeCompare(a.data)) || (Number(b.nota_id) - Number(a.nota_id)));
    let qtdNotas = 0;
    for (const v of lista) {
      if (resta <= 0) break;
      const semSaldo = Math.min(Number(v.quantidade), resta);
      resta -= semSaldo;
      qtdNotas++;
      notas.push({ data: v.data, numero: v.numero, serie: v.serie, canal: v.canal, sku, produto: s.nome || '',
        quantidade: Number(v.quantidade), semSaldo, saldoAtual: Number(s.saldo) });
    }
    produtos.push({ sku, produto: s.nome || '', saldoAtual: Number(s.saldo), notas: qtdNotas,
      foraDoPeriodo: resta > 0 ? resta : 0, atualizadoEm: s.atualizado_em });
  }
  notas.sort((a, b) => b.data.localeCompare(a.data) || String(b.numero).localeCompare(String(a.numero), 'pt-BR', { numeric: true }));
  produtos.sort((a, b) => a.saldoAtual - b.saldoAtual);
  return { notas, produtos };
}

export async function saldoHandler(req, res) {
  try {
    const filial = String(req.query.filial || 'SUL').toUpperCase();
    if (!FILIAIS[filial]) return res.status(400).json({ ok: false, error: 'Filial deve ser SUL ou TRADE.' });
    // Período: ini/fim (aaaa-mm-dd), como o filtro da tela; ou ?dias=N (últimos N dias).
    // Dia de hoje em Brasília (UTC-3).
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    const hojeIso = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
    const isoMais = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
    const minimo = isoMais(hojeIso, -(MAX_DIAS - 1));
    let ini = String(req.query.ini || ''), fim = String(req.query.fim || '');
    if (!iso.test(ini) || !iso.test(fim)) {
      const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), MAX_DIAS);
      ini = isoMais(hojeIso, -(dias - 1)); fim = hojeIso;
    }
    if (ini > fim) [ini, fim] = [fim, ini];
    if (ini < minimo) ini = minimo;
    if (fim > hojeIso) fim = hojeIso;

    const sql = neon(process.env.DATABASE_URL);
    await garantirTabelas(sql);
    await garantirTabela(sql);

    // Vendas do início do período até HOJE (não só até o fim): o negativo de
    // hoje cai primeiro nas notas mais recentes, então as notas depois do fim
    // entram na conta e só depois a lista é recortada no período.
    const vendas = await sql`
      SELECT n.nota_id, n.numero, n.serie, n.canal, to_char(n.data, 'YYYY-MM-DD') AS data, i.sku, i.quantidade::float AS quantidade
      FROM venda_itens i JOIN venda_notas n ON n.nota_id = i.nota_id
      WHERE n.filial = ${filial} AND n.data >= ${ini}::date`;
    const skus = [...new Set(vendas.map(v => v.sku))];
    const desde = ini;

    let atualizacao = { faltam: 0, bloqueado: false, metodo: null };
    const token = process.env[FILIAIS[filial]];
    if (req.query.atualizar !== '0' && skus.length) {
      if (!token) return res.status(200).json({ ok: false, error: `${FILIAIS[filial]} não configurado na Vercel.` });
      atualizacao = await atualizarSaldos(sql, filial, token, desde, skus);
    }

    const linhas = skus.length ? await sql`
      SELECT sku, nome, saldo::float AS saldo, nao_encontrado, atualizado_em
      FROM saldo_produtos WHERE filial = ${filial} AND sku = ANY(${skus})` : [];
    const saldos = new Map(linhas.map(l => [l.sku, l]));
    const todas = notasSemSaldo(vendas, saldos);
    const notas = todas.notas.filter(n => n.data <= fim);
    // Produto entra se tem nota sem saldo no período, ou (período até hoje) se o
    // negativo vem de antes do início.
    const noPeriodo = new Map();
    for (const n of notas) noPeriodo.set(n.sku, (noPeriodo.get(n.sku) || 0) + 1);
    const produtos = todas.produtos
      .map(p => ({ ...p, notas: noPeriodo.get(p.sku) || 0 }))
      .filter(p => p.notas > 0 || (fim === hojeIso && p.foraDoPeriodo > 0));
    const vendidosNoPeriodo = new Set(vendas.filter(v => v.data <= fim).map(v => v.sku));
    const [ult] = await sql`SELECT to_char(MAX(data), 'YYYY-MM-DD') AS dia FROM venda_notas WHERE filial = ${filial}`;

    return res.status(200).json({
      ok: true, filial, ini, fim,
      ultimaVenda: ult?.dia || null,
      skusVendidos: vendidosNoPeriodo.size,
      skusComSaldo: linhas.filter(l => l.saldo != null && vendidosNoPeriodo.has(l.sku)).length,
      naoEncontrados: linhas.filter(l => l.nao_encontrado).map(l => l.sku),
      ...atualizacao,
      notas, produtos,
    });
  } catch (error) {
    console.error('Erro no saldo insuficiente:', error);
    return res.status(200).json({ ok: false, error: error.message });
  }
}
