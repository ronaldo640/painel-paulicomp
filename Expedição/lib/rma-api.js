// Endpoint do indicador de devoluções (RMA). Responde em /api/rma, que um
// rewrite do vercel.json manda para /api/tiny-sync?modulo=rma: o plano Hobby
// da Vercel só permite 12 funções e o projeto já usa todas.
//
//   GET /api/rma                     planilha de devoluções lida e classificada
//   GET /api/rma?parte=tiny&ini=&fim=  notas de ENTRADA do Tiny SP no período
//                                    (para conferir com a planilha)
//
// Só leitura: nada é gravado na planilha nem no Tiny.

import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { lerXlsx } from './xlsx-ler.js';
import { lerRegistrosRma, GRUPOS, CATEGORIAS } from './rma.js';
import { baixarComoXlsx, contaDeServicoConfigurada } from './google-drive.js';

const inflateRawAsync = promisify(zlib.inflateRaw);
const inflateRaw = async bytes => new Uint8Array(await inflateRawAsync(bytes));

// "Retorno de materiais SP 2026.xlsx". Para o ano seguinte, troque pela
// variável RMA_PLANILHA_ID na Vercel, sem mexer no código.
const PLANILHA_PADRAO = '1VjhmHb5Y7Czs5EXb04r2t8TDsp90ME9e';

const TINY_URL = 'https://api.tiny.com.br/api2/notas.fiscais.pesquisa.php';
const TINY_MAX_PAGINAS = 30;

function dataBr(iso) {
  const [a, m, d] = String(iso).split('-');
  return `${d}/${m}/${a}`;
}

async function parteTiny(req, res) {
  const token = process.env.TINY_TOKEN_SP;
  if (!token) return res.status(200).json({ ok: false, error: 'TINY_TOKEN_SP não configurado na Vercel.' });
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const ini = String(req.query.ini || ''), fim = String(req.query.fim || '');
  if (!iso.test(ini) || !iso.test(fim)) return res.status(400).json({ ok: false, error: 'Informe ini e fim no formato aaaa-mm-dd.' });

  const notas = [];
  let pagina = 1, totalPaginas = 1;
  do {
    const params = new URLSearchParams({
      token, formato: 'json', pagina: String(pagina), tipoNota: 'E', dataInicial: dataBr(ini), dataFinal: dataBr(fim),
    });
    const resp = await fetch(`${TINY_URL}?${params}`);
    const json = await resp.json();
    const r = json.retorno || {};
    if (String(r.status).toLowerCase() === 'erro') {
      const erros = r.erros || [];
      // Código 20 = "A consulta não retornou registros": período sem notas, não é erro.
      if (erros.some(e => String(e.codigo_erro) === '20' || /n[ãa]o retornou registros/i.test(e.erro || ''))) break;
      return res.status(200).json({ ok: false, error: erros.map(e => e.erro).join('; ') || 'Erro na API do Tiny.' });
    }
    totalPaginas = Number(r.numero_paginas || 1);
    for (const item of r.notas_fiscais || []) {
      const nf = item.nota_fiscal || {};
      if (nf.tipo && nf.tipo !== 'E') continue;
      if (/cancelad/i.test(nf.descricao_situacao || '')) continue;
      const doc = String(nf.cliente?.cpf_cnpj || '').replace(/\D/g, '');
      notas.push({
        numero: String(Number(String(nf.numero || '').replace(/\D/g, '')) || nf.numero || ''),
        serie: String(nf.serie || ''),
        data: /^\d{2}\/\d{2}\/\d{4}$/.test(nf.data_emissao || '') ? nf.data_emissao.split('/').reverse().join('-') : null,
        valor: Number(nf.valor) || 0,
        // Sem nome do remetente (o painel abre por link). Só se é pessoa física
        // (típico de devolução de cliente) ou jurídica (pode ser compra de fornecedor).
        pessoa: doc.length === 14 ? 'PJ' : doc.length ? 'PF' : '',
        situacao: nf.descricao_situacao || '',
      });
    }
    pagina++;
  } while (pagina <= totalPaginas && pagina <= TINY_MAX_PAGINAS);

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json({
    ok: true, ini, fim, notas,
    incompleto: totalPaginas > TINY_MAX_PAGINAS,
  });
}

// DIAGNÓSTICO TEMPORÁRIO (remover): natureza de operação de notas de entrada.
// ?parte=tiny-diag&notas=14280-1,13070-2  (numero-serie). Sem nome/documento do cliente.
async function parteTinyDiag(req, res) {
  const token = process.env.TINY_TOKEN_SP;
  const pedidos = String(req.query.notas || '').split(',').filter(Boolean).slice(0, 15);
  const out = [];
  for (const p of pedidos) {
    const [numero, serie] = p.split('-');
    try {
      const ps = new URLSearchParams({ token, formato: 'json', numero, tipoNota: 'E' });
      const r = (await (await fetch(`${TINY_URL}?${ps}`)).json()).retorno || {};
      const achadas = (r.notas_fiscais || []).map(i => i.nota_fiscal || {}).filter(n => !serie || String(n.serie) === serie);
      for (const n of achadas) {
        const po = new URLSearchParams({ token, formato: 'json', id: String(n.id) });
        const o = ((await (await fetch(`https://api.tiny.com.br/api2/nota.fiscal.obter.php?${po}`)).json()).retorno || {}).nota_fiscal || {};
        const itens = (o.itens || []).map(x => x.item || x).map(x => ({ codigo: x.codigo, descricao: String(x.descricao || '').slice(0, 50), qtd: x.quantidade, cfop: x.cfop }));
        out.push({
          pedido: p, serie: o.serie, numero: o.numero, data: o.data_emissao, situacao: o.descricao_situacao || n.descricao_situacao,
          natureza: o.natureza_operacao, finalidade: o.finalidade, tipo: o.tipo_nota || o.tipo, valor: o.valor_nota || n.valor,
          numero_ecommerce: o.numero_ecommerce, id_venda: o.id_venda, refs: o.notas_referenciadas || o.nfe_referenciada || o.refNFe || null,
          obs: String(o.obs || o.observacoes || '').slice(0, 200), itens, chaves: Object.keys(o),
        });
      }
      if (!achadas.length) out.push({ pedido: p, erro: (r.erros || []).map(e => e.erro).join('; ') || 'não achada' });
    } catch (e) { out.push({ pedido: p, erro: e.message }); }
  }
  return res.status(200).json({ ok: true, out });
}

export async function rmaHandler(req, res) {
  try {
    if (req.query.parte === 'tiny') return await parteTiny(req, res);
    if (req.query.parte === 'tiny-diag') return await parteTinyDiag(req, res);

    if (!contaDeServicoConfigurada()) {
      return res.status(200).json({
        ok: false, configurar: true,
        error: 'A conta de serviço do Google ainda não foi configurada na Vercel (GOOGLE_SERVICE_ACCOUNT_JSON).',
      });
    }
    const id = process.env.RMA_PLANILHA_ID || PLANILHA_PADRAO;
    const arquivo = await baixarComoXlsx(id);
    const abas = await lerXlsx(arquivo.bytes, inflateRaw);
    const { registros, avisos } = lerRegistrosRma(abas);

    // Cache na CDN da Vercel: a planilha é baixada no máximo a cada 15 min.
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
    return res.status(200).json({
      ok: true,
      fonte: { nome: arquivo.nome, modificadoEm: arquivo.modificadoEm, lidoEm: new Date().toISOString(), abas: abas.map(a => a.nome) },
      categorias: CATEGORIAS,
      grupos: GRUPOS.map(({ regra, ...g }) => g),
      registros,
      avisos,
    });
  } catch (error) {
    console.error('Erro no RMA:', error);
    return res.status(200).json({ ok: false, error: error.message });
  }
}
