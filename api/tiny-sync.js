// Vercel Serverless Function — sincroniza notas fiscais da API v2 do Tiny ERP
// (Olist) direto para o banco Neon (tabela dispatches).
//
// Os tokens NUNCA passam pelo navegador: ficam só como variáveis de ambiente
// do projeto na Vercel (TINY_TOKEN_SP, TINY_TOKEN_SUL, TINY_TOKEN_TRADE).
// Isso permite que qualquer pessoa com o link do painel dispare uma
// sincronização (botão "Sincronizar Tiny/Olist") ou que a Vercel chame esta
// função automaticamente via Cron Job — sem que ninguém precise inserir ou
// ver as chaves de API.

import { neon } from '@neondatabase/serverless';

const TINY_BASE_URL = "https://api.tiny.com.br/api2/notas.fiscais.pesquisa.php";
const MAX_PAGES = 60; // proteção contra loops longos / consumo excessivo de cota da API por filial
const LOOKBACK_DAYS = 60; // janela padrão quando dataInicial/dataFinal não são informadas

const TINY_FILIAIS = [
  { key: 'SP', nome: 'PAULICOMP SP', env: 'TINY_TOKEN_SP' },
  { key: 'SUL', nome: 'PAULICOMP SUL', env: 'TINY_TOKEN_SUL' },
  { key: 'TRADE', nome: 'COMP TRADE', env: 'TINY_TOKEN_TRADE' },
];

function toIsoDate(brDate) {
  // "dd/mm/yyyy" -> "yyyy-mm-dd"
  if (!brDate || typeof brDate !== "string" || !brDate.includes("/")) return null;
  const [d, m, y] = brDate.split("/");
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function toBrDate(date) {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${d}/${m}/${date.getFullYear()}`;
}

const ufToRegion = {
  SP: 'Sudeste', RJ: 'Sudeste', MG: 'Sudeste', ES: 'Sudeste',
  PR: 'Sul', SC: 'Sul', RS: 'Sul',
  BA: 'Nordeste', PE: 'Nordeste', CE: 'Nordeste', RN: 'Nordeste',
  PB: 'Nordeste', MA: 'Nordeste', AL: 'Nordeste', SE: 'Nordeste', PI: 'Nordeste',
  DF: 'Centro-Oeste', GO: 'Centro-Oeste', MT: 'Centro-Oeste', MS: 'Centro-Oeste',
  PA: 'Norte', AM: 'Norte', RO: 'Norte', TO: 'Norte', AC: 'Norte', AP: 'Norte', RR: 'Norte',
};
const ptDays = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];

function mapNota(nf, filial) {
  const cliente = nf.cliente || {};
  const entrega = nf.endereco_entrega || {};
  const transportador = nf.transportador || {};

  const situacaoTexto = (nf.descricao_situacao || "").toLowerCase();
  if (situacaoTexto.includes("cancelad")) return null;

  const dataIso = toIsoDate(nf.data_emissao);
  if (!dataIso) return null;

  const docLimpo = String(entrega.cpf_cnpj || cliente.cpf_cnpj || "").replace(/[^0-9]/g, "");
  const tipoPessoa = entrega.tipo_pessoa || cliente.tipo_pessoa;
  const tipo = tipoPessoa === "F" || (tipoPessoa !== "J" && docLimpo.length > 0 && docLimpo.length <= 11)
    ? "B2C (CPF)"
    : "B2B (CNPJ)";

  const uf = String(entrega.uf || cliente.uf || "SP").toUpperCase().trim();
  const dObj = new Date(dataIso + 'T12:00:00');

  return {
    filial,
    data: dataIso,
    data_fmt: nf.data_emissao,
    nf: String(nf.numero || nf.id || "-"),
    cliente: entrega.nome_destinatario || cliente.nome || nf.nome || "-",
    tipo,
    canal: (transportador.nome && transportador.nome.trim()) || "Mercado Envios",
    uf,
    cidade: entrega.cidade || cliente.cidade || "-",
    regiao: ufToRegion[uf] || 'Outros',
    dia_semana: ptDays[dObj.getDay()] || 'Segunda-feira',
  };
}

async function fetchFilial(token, filialNome, dataInicial, dataFinal) {
  const rows = [];
  let pagina = 1;
  let totalPaginas = 1;

  do {
    const params = new URLSearchParams({ token, formato: "json", pagina: String(pagina) });
    if (dataInicial) params.set("dataInicial", dataInicial);
    if (dataFinal) params.set("dataFinal", dataFinal);

    const resp = await fetch(`${TINY_BASE_URL}?${params.toString()}`);
    const json = await resp.json();
    const retorno = json.retorno || {};

    if (retorno.status === "Erro" || retorno.status === "erro") {
      const msg = (retorno.erros || []).map(e => e.erro).join("; ") || "Erro desconhecido na API do Tiny.";
      throw new Error(msg);
    }

    totalPaginas = Number(retorno.numero_paginas || 1);
    (retorno.notas_fiscais || []).forEach(item => {
      const mapped = mapNota(item.nota_fiscal || {}, filialNome);
      if (mapped) rows.push(mapped);
    });

    pagina++;
  } while (pagina <= totalPaginas && pagina <= MAX_PAGES);

  return rows;
}

const INSERT_CHUNK_SIZE = 500; // registros por INSERT em lote (via UNNEST), não 1 query por linha

async function insertRows(sql, rows) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
    const result = await sql`
      INSERT INTO dispatches (filial, data, data_fmt, nf, cliente, tipo, canal, uf, cidade, regiao, dia_semana)
      SELECT * FROM UNNEST(
        ${chunk.map(r => r.filial)}::text[],
        ${chunk.map(r => r.data)}::date[],
        ${chunk.map(r => r.data_fmt)}::text[],
        ${chunk.map(r => r.nf)}::text[],
        ${chunk.map(r => r.cliente)}::text[],
        ${chunk.map(r => r.tipo)}::text[],
        ${chunk.map(r => r.canal)}::text[],
        ${chunk.map(r => r.uf)}::text[],
        ${chunk.map(r => r.cidade)}::text[],
        ${chunk.map(r => r.regiao)}::text[],
        ${chunk.map(r => r.dia_semana)}::text[]
      )
      ON CONFLICT (filial, nf, data) DO NOTHING
      RETURNING id;
    `;
    inserted += result.length;
  }
  return inserted;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  }

  const query = req.method === 'GET' ? req.query : (req.body || {});
  let dataInicial = query.dataInicial || null;
  let dataFinal = query.dataFinal || null;
  if (!dataInicial || !dataFinal) {
    const hoje = new Date();
    const inicio = new Date(hoje.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    dataFinal = dataFinal || toBrDate(hoje);
    dataInicial = dataInicial || toBrDate(inicio);
  }

  // Opcional: restringe a sincronização a uma única filial (SP/SUL/TRADE) — útil
  // para preencher histórico aos poucos, sem estourar o tempo máximo da função.
  const filialFiltro = query.filial ? String(query.filial).toUpperCase() : null;
  const filiaisAtivas = TINY_FILIAIS.filter(f => process.env[f.env] && (!filialFiltro || f.key === filialFiltro));
  if (filiaisAtivas.length === 0) {
    return res.status(200).json({
      ok: true,
      results: [],
      insertedTotal: 0,
      warning: filialFiltro
        ? `Token não configurado para a filial "${filialFiltro}".`
        : 'Nenhum token do Tiny configurado nas variáveis de ambiente da Vercel (TINY_TOKEN_SP / TINY_TOKEN_SUL / TINY_TOKEN_TRADE).',
    });
  }

  const sql = neon(process.env.DATABASE_URL);

  // Busca e grava as filiais em paralelo — a busca na API do Tiny é o gargalo,
  // não a escrita no banco (já feita em lote), então isso reduz bastante o tempo total.
  const results = await Promise.all(filiaisAtivas.map(async f => {
    try {
      const rows = await fetchFilial(process.env[f.env], f.nome, dataInicial, dataFinal);
      const inserted = await insertRows(sql, rows);
      return { filial: f.nome, lidos: rows.length, inseridos: inserted };
    } catch (err) {
      return { filial: f.nome, error: err.message };
    }
  }));

  const insertedTotal = results.reduce((sum, r) => sum + (r.inseridos || 0), 0);
  res.status(200).json({ ok: true, dataInicial, dataFinal, results, insertedTotal });
}
