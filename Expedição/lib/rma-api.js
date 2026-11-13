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
import { neon } from '@neondatabase/serverless';
import { garantirTabelas } from './vendas-itens.js';

const inflateRawAsync = promisify(zlib.inflateRaw);
const inflateRaw = async bytes => new Uint8Array(await inflateRawAsync(bytes));

// "Retorno de materiais SP 2026.xlsx". Para o ano seguinte, troque pela
// variável RMA_PLANILHA_ID na Vercel, sem mexer no código.
const PLANILHA_PADRAO = '1VjhmHb5Y7Czs5EXb04r2t8TDsp90ME9e';

const TINY_URL = 'https://api.tiny.com.br/api2/notas.fiscais.pesquisa.php';
const TINY_MAX_PAGINAS = 30; // com 1,1 s entre páginas, 30 páginas ainda cabem nos 60 s da função

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
      // "Registrada" = nota de terceiro lançada no Tiny (compra de fornecedor), não
      // é emitida pela empresa e nunca é devolução de cliente.
      if (/registrad/i.test(nf.descricao_situacao || '')) continue;
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
    // A API do Tiny SP bloqueia por alguns minutos quem faz muitos acessos seguidos
    // (aconteceu em 12/11/2026), e o bloqueio também pararia a sincronização das
    // Caixas. Por isso as páginas vão espaçadas: ~16 páginas levam ~20 s, dentro
    // dos 60 s da função, e o resultado fica 1 h em cache.
    if (pagina <= totalPaginas && pagina <= TINY_MAX_PAGINAS) await new Promise(r => setTimeout(r, 1100));
  } while (pagina <= totalPaginas && pagina <= TINY_MAX_PAGINAS);

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json({
    ok: true, ini, fim, notas,
    incompleto: totalPaginas > TINY_MAX_PAGINAS,
  });
}

// Peças vendidas por SKU, canal e mês (tabelas de lib/vendas-itens.js), para a
// taxa de devolução. Também devolve quantas notas de venda já foram lidas por
// mês, para a tela avisar quando o histórico ainda está incompleto.
async function parteVendas(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  try {
    await garantirTabelas(sql);
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.desde || '')) ? String(req.query.desde) : '2025-11-01';
    // Por dia, em lista compacta [sku, canal, 'aaaa-mm-dd', qtd]: a tela soma as
    // vendas numa janela de 30/60/90 dias antes da devolução.
    const linhas = await sql`
      SELECT i.sku, n.canal, to_char(n.data, 'YYYY-MM-DD') AS dia, SUM(i.quantidade)::float AS qtd
      FROM venda_itens i JOIN venda_notas n ON n.nota_id = i.nota_id
      WHERE n.filial = 'SP' AND n.data >= ${desde}::date
      GROUP BY 1, 2, 3`;
    const vendas = linhas.map(v => [v.sku, v.canal, v.dia, v.qtd]);
    const [ult] = await sql`SELECT to_char(MAX(data), 'YYYY-MM-DD') AS dia FROM venda_notas WHERE filial = 'SP'`;
    const lidas = await sql`
      SELECT to_char(data, 'YYYY-MM') AS mes, COUNT(*)::int AS notas
      FROM venda_notas WHERE filial = 'SP' AND data >= ${desde}::date GROUP BY 1`;
    // Total de notas de venda por mês (tabela da expedição), para medir a cobertura.
    const total = await sql`
      SELECT to_char(data, 'YYYY-MM') AS mes, COUNT(*)::int AS notas
      FROM dispatches WHERE filial = 'PAULICOMP SP' AND data >= ${desde}::date GROUP BY 1`;
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({ ok: true, vendas, ultimoDia: ult?.dia || null, cobertura: { lidas, total } });
  } catch (error) {
    console.error('Erro nas vendas do RMA:', error);
    return res.status(200).json({ ok: false, error: error.message });
  }
}

export async function rmaHandler(req, res) {
  try {
    if (req.query.parte === 'tiny') return await parteTiny(req, res);
    if (req.query.parte === 'vendas') return await parteVendas(req, res);

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
