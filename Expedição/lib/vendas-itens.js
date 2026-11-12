// Itens vendidos por nota (SKU, quantidade, canal), para comparar devolução ×
// venda no indicador RMA.
//
// Não faz acesso novo ao Tiny no dia a dia: a rotina das Caixas
// (api/caixa-auto-executar.js) já abre cada nota de venda para achar a caixa,
// e aproveita os mesmos itens para gravar aqui.
//
// O histórico (antes desta tabela existir) é carregado por
// /api/caixa-auto-executar?vendas=historico&data=AAAA-MM-DD, um dia por vez,
// com as notas espaçadas para não bloquear a API do Tiny.
//
// Tabelas (criadas sozinhas na primeira gravação; mesma definição em
// sql/025_venda_itens.sql):
//   venda_notas  uma linha por nota de venda (marca que a nota já foi lida)
//   venda_itens  SKU e quantidade de cada nota

const TINY = 'https://api.tiny.com.br/api2';

let tabelasProntas = false;
export async function garantirTabelas(sql) {
  if (tabelasProntas) return;
  await sql`CREATE TABLE IF NOT EXISTS venda_notas (
    nota_id BIGINT PRIMARY KEY,
    filial TEXT NOT NULL,
    numero TEXT,
    serie TEXT,
    data DATE NOT NULL,
    canal TEXT NOT NULL,
    lido_em TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS venda_itens (
    nota_id BIGINT NOT NULL REFERENCES venda_notas(nota_id) ON DELETE CASCADE,
    sku TEXT NOT NULL,
    quantidade NUMERIC NOT NULL,
    PRIMARY KEY (nota_id, sku)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_venda_notas_filial_data ON venda_notas (filial, data)`;
  tabelasProntas = true;
}

// Canal da venda, nos mesmos nomes da coluna "Empresa" da planilha de devoluções
// (ML, FULL, LOJA NUVEM, AMAZON), para comparar no mesmo canal.
export function canalDaNota(nf) {
  if (String(nf.serie) === '2') return 'FULL'; // série 2 = Mercado Envios Fulfillment
  const ecommerce = String(nf.numero_ecommerce || '').trim();
  const transp = String(nf.transportador?.nome || nf.nome_transportador || '').toLowerCase();
  if (transp.includes('nuvem')) return 'LOJA NUVEM';
  if (/^\d{3}-\d{7}-\d{7}$/.test(ecommerce)) return 'AMAZON';
  if (ecommerce.length === 14 && /[A-Za-z]/.test(ecommerce)) return 'SHOPEE';
  if (/^\d{10,}$/.test(ecommerce)) return 'ML';
  return 'OUTROS';
}

// Grava uma nota de venda e seus itens. Idempotente (nota já gravada é ignorada).
export async function gravarVenda(sql, filial, nota, itens) {
  await garantirTabelas(sql);
  const [nova] = await sql`
    INSERT INTO venda_notas (nota_id, filial, numero, serie, data, canal)
    VALUES (${nota.id}, ${filial}, ${nota.numero}, ${nota.serie || null}, ${nota.dataIso}, ${nota.canal})
    ON CONFLICT (nota_id) DO NOTHING
    RETURNING nota_id`;
  if (!nova) return false;
  // Mesmo SKU em duas linhas da nota: soma.
  const porSku = new Map();
  for (const it of itens) porSku.set(it.sku, (porSku.get(it.sku) || 0) + Number(it.quantidade || 0));
  for (const [sku, qtd] of porSku) {
    await sql`INSERT INTO venda_itens (nota_id, sku, quantidade) VALUES (${nota.id}, ${sku}, ${qtd})
      ON CONFLICT (nota_id, sku) DO NOTHING`;
  }
  return true;
}

function brDe(iso) {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}

const esperar = ms => new Promise(r => setTimeout(r, ms));

// Carga do histórico: lê as notas de venda de UM dia que ainda não estão em
// venda_notas. Para no limite de notas ou de tempo; chamar de novo continua
// de onde parou (devolve quantas faltam).
export async function cargaHistorico(sql, token, filial, dataIso, buscarItensDaNota, { maxNotas = 40, pausaMs = 900, limiteMs = 48000 } = {}) {
  const inicio = Date.now();
  await garantirTabelas(sql);
  const notas = [];
  let pagina = 1, totalPaginas = 1;
  do {
    const params = new URLSearchParams({ token, formato: 'json', pagina: String(pagina), dataInicial: brDe(dataIso), dataFinal: brDe(dataIso) });
    const r = ((await (await fetch(`${TINY}/notas.fiscais.pesquisa.php?${params}`)).json()).retorno) || {};
    if (String(r.status).toLowerCase() === 'erro') {
      const erros = r.erros || [];
      if (erros.some(e => String(e.codigo_erro) === '20' || /n[ãa]o retornou registros/i.test(e.erro || ''))) break;
      throw new Error(erros.map(e => e.erro).join('; ') || 'Erro na busca de notas.');
    }
    totalPaginas = Number(r.numero_paginas || 1);
    for (const item of r.notas_fiscais || []) {
      const nf = item.nota_fiscal || {};
      if (nf.tipo !== 'S' || !nf.id) continue;
      if (/cancelad/i.test(nf.descricao_situacao || '')) continue;
      notas.push({ id: nf.id, numero: nf.numero, serie: String(nf.serie || ''), dataIso, canal: canalDaNota(nf) });
    }
    pagina++;
    if (pagina <= totalPaginas) await esperar(pausaMs);
  } while (pagina <= totalPaginas);

  const ids = notas.map(n => n.id);
  const lidas = ids.length ? await sql`SELECT nota_id FROM venda_notas WHERE nota_id = ANY(${ids})` : [];
  const jaLidas = new Set(lidas.map(r => String(r.nota_id)));
  const faltando = notas.filter(n => !jaLidas.has(String(n.id)));

  let gravadas = 0;
  const erros = [];
  for (const nota of faltando) {
    if (gravadas >= maxNotas || Date.now() - inicio > limiteMs) break;
    await esperar(pausaMs);
    try {
      const itens = await buscarItensDaNota(token, nota.id);
      await gravarVenda(sql, filial, nota, itens);
      gravadas++;
    } catch (e) {
      erros.push({ nota: nota.numero, erro: e.message });
      // API bloqueada: para já, insistir só prolonga o bloqueio.
      if (/bloquead|excedido/i.test(e.message)) break;
    }
  }
  return { data: dataIso, notas_do_dia: notas.length, ja_lidas: jaLidas.size, gravadas, faltam: faltando.length - gravadas, erros };
}
