// Reservas de estoque (Sul e Trade): o que está reservado em cada produto no
// Tiny × o que os pedidos de venda em aberto explicam. A sobra sem pedido é a
// reserva manual ou esquecida, que precisa ser liberada à mão no Tiny.
//
// Responde em /api/reservas, que um rewrite do vercel.json manda para
// /api/tiny-sync?modulo=reservas (o plano Hobby só permite 12 funções).
//
// Cada chamada trabalha até ~40 s no Tiny e devolve "faltam"; a tela chama de
// novo enquanto faltar algo. O que já foi lido fica no Neon:
//   reserva_pedidos   pedidos em aberto e seus itens (relidos se a situação muda)
//   reserva_produtos  saldo e reservado por produto
//   reserva_varredura onde parou a leitura do estoque de todos os produtos
//
//   GET /api/reservas?filial=SUL|TRADE          atualiza (se preciso) e devolve
//   GET /api/reservas?filial=SUL&atualizar=0    só lê o que está no Neon
//   GET /api/reservas?filial=SUL&forcar=1       relê tudo, mesmo se recente
//
// Só leitura no Tiny: nada é alterado lá.

import { neon } from '@neondatabase/serverless';
import { tiny, esperar, bloqueio } from './saldo-insuficiente.js';

const FILIAIS = { SUL: 'TINY_TOKEN_SUL', TRADE: 'TINY_TOKEN_TRADE' };
// Situações de pedido que ainda não viraram nota (a nota baixa o estoque e
// solta a reserva). Código usado na busca → nome mostrado na tela.
const SITUACOES = { aberto: 'Em aberto', aprovado: 'Aprovado', preparando_envio: 'Preparando envio' };
const LIMITE_MS = 40000;
const PAUSA_MS = 1100;
const VALIDADE_HORAS = 6;   // pedidos e estoque lidos há menos que isso não são relidos

let tabelasProntas = false;
async function garantirTabelas(sql) {
  if (tabelasProntas) return;
  await sql`CREATE TABLE IF NOT EXISTS reserva_pedidos (
    filial TEXT NOT NULL,
    pedido_id BIGINT NOT NULL,
    numero TEXT,
    data TEXT,
    situacao TEXT,
    itens JSONB,
    visto_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (filial, pedido_id)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS reserva_produtos (
    filial TEXT NOT NULL,
    produto_id BIGINT NOT NULL,
    sku TEXT,
    nome TEXT,
    saldo NUMERIC,
    reservado NUMERIC,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (filial, produto_id)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS reserva_varredura (
    filial TEXT PRIMARY KEY,
    proxima_pagina INT NOT NULL DEFAULT 1,
    iniciada_em TIMESTAMPTZ,
    concluida_em TIMESTAMPTZ,
    produtos INT NOT NULL DEFAULT 0,
    campo_reservado BOOLEAN,
    pedidos_em TIMESTAMPTZ
  )`;
  // Leitura produto a produto (o Tiny só lista alterações dos últimos 30 dias).
  await sql`ALTER TABLE reserva_produtos ADD COLUMN IF NOT EXISTS lido_em TIMESTAMPTZ`;
  await sql`ALTER TABLE reserva_varredura ADD COLUMN IF NOT EXISTS catalogo_em TIMESTAMPTZ`;
  await sql`ALTER TABLE reserva_varredura ADD COLUMN IF NOT EXISTS incremental_em TIMESTAMPTZ`;
  await sql`ALTER TABLE reserva_pedidos ADD COLUMN IF NOT EXISTS nota_id TEXT`;
  await sql`ALTER TABLE reserva_pedidos ADD COLUMN IF NOT EXISTS nota_lida BOOLEAN NOT NULL DEFAULT false`;
  tabelasProntas = true;
}

const num = v => (v == null || v === '' ? null : Number(String(v).replace(',', '.')));

// 1) Pedidos em aberto: lista por situação; lê os itens só dos pedidos novos
//    ou que mudaram de situação. Pedidos que saíram da lista são apagados.
async function lerPedidos(sql, filial, token, inicio, forcar, estado) {
  const fresco = estado.pedidos_em && Date.now() - new Date(estado.pedidos_em).getTime() < VALIDADE_HORAS * 3600e3;
  const avisos = [];
  let faltam = 0, bloqueado = false;
  if (fresco && !forcar) {
    const [r] = await sql`SELECT COUNT(*)::int AS n FROM reserva_pedidos WHERE filial = ${filial} AND (itens IS NULL OR NOT nota_lida)`;
    if (!r.n) return { faltam: 0, bloqueado, avisos };
  }

  // Lista completa dos pedidos em aberto (só cabeçalho, 100 por página).
  const abertos = new Map();
  let listaCompleta = true, cortada = false; // cortada = parou por tempo (continua na próxima chamada)
  try {
    for (const [codigo, nome] of Object.entries(SITUACOES)) {
      let pagina = 1, total = 1;
      do {
        let r;
        try {
          r = await tiny('pedidos.pesquisa.php', { token, situacao: codigo, pagina: String(pagina) });
        } catch (e) {
          if (bloqueio(e)) throw e;
          if (!e.semRegistros) {
            avisos.push(`Busca de pedidos "${nome}": ${e.message}`);
            listaCompleta = false;
          }
          pagina = Infinity; // situação encerrada (sem pedidos ou com erro): não é corte por tempo
          break;
        }
        total = Number(r.numero_paginas || 1);
        for (const it of r.pedidos || []) {
          const p = it.pedido || it;
          if (!p.id) continue;
          abertos.set(String(p.id), { id: Number(p.id), numero: String(p.numero || ''), data: p.data_pedido || '', situacao: p.situacao || nome });
        }
        pagina++;
        await esperar(PAUSA_MS);
      } while (pagina <= total && Date.now() - inicio < LIMITE_MS);
      if (pagina <= total) { listaCompleta = false; cortada = true; }
    }
  } catch (e) {
    if (!bloqueio(e)) throw e;
    return { faltam: 1, bloqueado: true, avisos };
  }
  if (cortada && !abertos.size) return { faltam: 1, bloqueado, avisos };

  // Grava/atualiza o cabeçalho; itens zerados quando a situação mudou.
  const guardados = await sql`SELECT pedido_id, situacao, (itens IS NOT NULL AND nota_lida) AS lido FROM reserva_pedidos WHERE filial = ${filial}`;
  const antes = new Map(guardados.map(g => [String(g.pedido_id), g]));
  for (const p of abertos.values()) {
    const g = antes.get(String(p.id));
    if (g && g.situacao === p.situacao && g.lido && !forcar) continue;
    await sql`
      INSERT INTO reserva_pedidos (filial, pedido_id, numero, data, situacao, itens, visto_em)
      VALUES (${filial}, ${p.id}, ${p.numero}, ${p.data}, ${p.situacao}, NULL, now())
      ON CONFLICT (filial, pedido_id) DO UPDATE SET numero = EXCLUDED.numero, data = EXCLUDED.data,
        situacao = EXCLUDED.situacao, itens = NULL, nota_id = NULL, nota_lida = false, visto_em = now()`;
  }
  // Só apaga os que sumiram quando a lista veio inteira.
  if (listaCompleta) {
    const ids = [...abertos.keys()].map(Number);
    await sql`DELETE FROM reserva_pedidos WHERE filial = ${filial} AND NOT (pedido_id = ANY(${ids}))`;
  }

  // Itens dos pedidos ainda sem itens.
  const pendentes = await sql`SELECT pedido_id FROM reserva_pedidos WHERE filial = ${filial} AND (itens IS NULL OR NOT nota_lida) ORDER BY pedido_id`;
  let i = 0;
  for (; i < pendentes.length; i++) {
    if (Date.now() - inicio > LIMITE_MS) break;
    try {
      const r = await tiny('pedido.obter.php', { token, id: String(pendentes[i].pedido_id) });
      const itens = ((r.pedido || {}).itens || []).map(x => x.item || x).map(it => ({
        produto_id: Number(it.id_produto) || null,
        sku: String(it.codigo || '').trim(),
        descricao: it.descricao || '',
        qtd: num(it.quantidade) || 0,
      })).filter(it => it.qtd > 0);
      const nf = String((r.pedido || {}).id_nota_fiscal || '').trim();
      const notaId = nf && nf !== '0' ? nf : null;
      await sql`UPDATE reserva_pedidos SET itens = ${JSON.stringify(itens)}::jsonb, nota_id = ${notaId}, nota_lida = true WHERE filial = ${filial} AND pedido_id = ${pendentes[i].pedido_id}`;
    } catch (e) {
      if (bloqueio(e)) { bloqueado = true; break; }
      avisos.push(`Pedido ${pendentes[i].pedido_id}: ${e.message}`);
      await sql`UPDATE reserva_pedidos SET itens = '[]'::jsonb, nota_lida = true WHERE filial = ${filial} AND pedido_id = ${pendentes[i].pedido_id}`;
    }
    await esperar(PAUSA_MS);
  }
  faltam = pendentes.length - i + (cortada ? 1 : 0);
  if (!faltam) await sql`UPDATE reserva_varredura SET pedidos_em = now() WHERE filial = ${filial}`;
  return { faltam, bloqueado, avisos };
}

// Grava saldo e reservado lidos do Tiny (lido_em marca que o estoque já foi lido).
async function gravarEstoque(sql, filial, id, saldo, reservado) {
  await sql`UPDATE reserva_produtos SET saldo = ${saldo}, reservado = ${reservado}, lido_em = now(), atualizado_em = now()
    WHERE filial = ${filial} AND produto_id = ${id}`;
}

// 2) Estoque (saldo e reservado) de todos os produtos.
//
// O Tiny só lista as alterações de estoque dos últimos 30 dias, então a
// primeira leitura é produto a produto:
//   a) lista de produtos do catálogo (produtos.pesquisa, 100 por página);
//   b) estoque de cada produto (produto.obter.estoque), primeiro os que estão
//      nos pedidos em aberto, depois o resto.
// Lido tudo uma vez, as próximas leituras pegam só o que mudou, pela lista de
// alterações de estoque desde a última leitura (se passar de 29 dias, relê tudo).
// Tudo continua de onde parou na chamada anterior.
async function varrerEstoque(sql, filial, token, inicio, forcar, estado) {
  const tempo = () => Date.now() - inicio < LIMITE_MS;
  let campoReservado = estado.campo_reservado;
  let bloqueado = false, aviso = null;

  // Produtos dos pedidos em aberto entram na fila mesmo antes do catálogo.
  await sql`
    INSERT INTO reserva_produtos (filial, produto_id, sku, nome)
    SELECT DISTINCT ON ((i->>'produto_id')::bigint) ${filial}, (i->>'produto_id')::bigint, i->>'sku', i->>'descricao'
    FROM reserva_pedidos p, jsonb_array_elements(p.itens) i
    WHERE p.filial = ${filial} AND (i->>'produto_id') IS NOT NULL AND (i->>'produto_id') <> 'null'
    ON CONFLICT (filial, produto_id) DO NOTHING`;

  async function lerPendentes(soDosPedidos) {
    const pend = soDosPedidos
      ? await sql`SELECT DISTINCT r.produto_id FROM reserva_produtos r
          JOIN reserva_pedidos p ON p.filial = r.filial
          JOIN LATERAL jsonb_array_elements(p.itens) i ON (i->>'produto_id') = r.produto_id::text
          WHERE r.filial = ${filial} AND r.lido_em IS NULL LIMIT 60`
      : await sql`SELECT produto_id FROM reserva_produtos WHERE filial = ${filial} AND lido_em IS NULL ORDER BY produto_id LIMIT 60`;
    for (const { produto_id } of pend) {
      if (!tempo()) return;
      try {
        const r = await tiny('produto.obter.estoque.php', { token, id: String(produto_id) });
        const p = r.produto || {};
        if ('saldoReservado' in p) campoReservado = true;
        else if (campoReservado == null) campoReservado = false;
        await gravarEstoque(sql, filial, produto_id, num(p.saldo), num(p.saldoReservado) ?? 0);
      } catch (e) {
        if (bloqueio(e)) { bloqueado = true; return; }
        // Produto excluído/inexistente no Tiny: sai da lista.
        await sql`DELETE FROM reserva_produtos WHERE filial = ${filial} AND produto_id = ${produto_id}`;
      }
      await esperar(PAUSA_MS);
    }
  }

  // b1) estoque dos produtos dos pedidos em aberto (o que mais interessa).
  await lerPendentes(true);

  // a) catálogo
  let catalogoOk = !!estado.catalogo_em && !forcar;
  if (!catalogoOk && !bloqueado) {
    let pagina = estado.proxima_pagina || 1;
    if (pagina === 1) await sql`UPDATE reserva_varredura SET iniciada_em = now() WHERE filial = ${filial}`;
    while (tempo()) {
      let r;
      try {
        r = await tiny('produtos.pesquisa.php', { token, pesquisa: '', pagina: String(pagina) });
      } catch (e) {
        if (e.semRegistros) r = { produtos: [] };
        else if (bloqueio(e)) { bloqueado = true; break; }
        else { aviso = `Lista de produtos do Tiny: ${e.message}`; break; }
      }
      const produtos = (r.produtos || []).map(x => x.produto || x);
      for (const p of produtos) {
        if (!p.id || p.tipoVariacao === 'P' || p.tipo_variacao === 'P') continue; // produto pai não tem estoque próprio
        await sql`INSERT INTO reserva_produtos (filial, produto_id, sku, nome) VALUES (${filial}, ${Number(p.id)}, ${String(p.codigo || '').trim()}, ${p.nome || ''})
          ON CONFLICT (filial, produto_id) DO UPDATE SET sku = EXCLUDED.sku, nome = EXCLUDED.nome`;
      }
      const total = Number(r.numero_paginas || 0);
      if (!produtos.length || (total ? pagina >= total : produtos.length < 100)) {
        await sql`UPDATE reserva_varredura SET proxima_pagina = 1, catalogo_em = now() WHERE filial = ${filial}`;
        catalogoOk = true;
        break;
      }
      pagina++;
      await sql`UPDATE reserva_varredura SET proxima_pagina = ${pagina} WHERE filial = ${filial}`;
      await esperar(PAUSA_MS);
    }
  }

  // b2) estoque do resto do catálogo.
  if (!bloqueado && tempo()) await lerPendentes(false);

  const [{ n: pendentes }] = await sql`SELECT COUNT(*)::int AS n FROM reserva_produtos WHERE filial = ${filial} AND lido_em IS NULL`;
  let incrementalPendente = false;

  if (catalogoOk && !pendentes && !bloqueado) {
    const [v] = await sql`SELECT concluida_em, incremental_em, iniciada_em FROM reserva_varredura WHERE filial = ${filial}`;
    if (!v.concluida_em || (v.iniciada_em && new Date(v.iniciada_em) > new Date(v.concluida_em))) {
      // Primeira leitura completa: as alterações feitas durante ela vêm na próxima atualização.
      await sql`UPDATE reserva_varredura SET concluida_em = now(), incremental_em = COALESCE(iniciada_em, now()) WHERE filial = ${filial}`;
    } else if (Date.now() - new Date(v.incremental_em || v.concluida_em).getTime() > VALIDADE_HORAS * 3600e3) {
      const desde = new Date(new Date(v.incremental_em || v.concluida_em).getTime() - 3600e3);
      if (Date.now() - desde.getTime() > 29 * 86400e3) {
        // Muito tempo sem ler: a lista do Tiny não alcança, relê tudo.
        await sql`UPDATE reserva_produtos SET lido_em = NULL WHERE filial = ${filial}`;
        await sql`UPDATE reserva_varredura SET iniciada_em = now(), catalogo_em = NULL WHERE filial = ${filial}`;
        incrementalPendente = true;
      } else {
        const inicioInc = new Date();
        const br = new Date(desde.getTime() - 3 * 3600e3).toISOString(); // horário de Brasília
        const dataAlteracao = `${br.slice(8, 10)}/${br.slice(5, 7)}/${br.slice(0, 4)} ${br.slice(11, 19)}`;
        let pagina = 1, completo = false;
        while (tempo()) {
          let r;
          try {
            r = await tiny('lista.atualizacoes.estoque.php', { token, dataAlteracao, pagina: String(pagina) });
          } catch (e) {
            if (e.semRegistros) { completo = true; break; }
            if (bloqueio(e)) { bloqueado = true; break; }
            aviso = `Atualizações de estoque do Tiny: ${e.message}`; break;
          }
          const produtos = (r.produtos || []).map(x => x.produto || x);
          for (const p of produtos) {
            if (!p.id || p.tipo_variacao === 'P') continue;
            if ('saldoReservado' in p) campoReservado = true;
            await sql`INSERT INTO reserva_produtos (filial, produto_id, sku, nome, saldo, reservado, lido_em, atualizado_em)
              VALUES (${filial}, ${Number(p.id)}, ${String(p.codigo || '').trim()}, ${p.nome || ''}, ${num(p.saldo)}, ${num(p.saldoReservado) ?? 0}, now(), now())
              ON CONFLICT (filial, produto_id) DO UPDATE SET sku = EXCLUDED.sku, nome = EXCLUDED.nome, saldo = EXCLUDED.saldo,
                reservado = EXCLUDED.reservado, lido_em = now(), atualizado_em = now()`;
          }
          const total = Number(r.numero_paginas || 0);
          if (!produtos.length || (total ? pagina >= total : produtos.length < 100)) { completo = true; break; }
          pagina++;
          await esperar(PAUSA_MS);
        }
        if (completo) await sql`UPDATE reserva_varredura SET incremental_em = ${inicioInc.toISOString()} WHERE filial = ${filial}`;
        else if (!aviso) incrementalPendente = true;
      }
    }
  }
  await sql`UPDATE reserva_varredura SET campo_reservado = ${campoReservado ?? null} WHERE filial = ${filial}`;
  const faltam = pendentes + (catalogoOk ? 0 : 1) + (incrementalPendente ? 1 : 0);
  return { faltam: aviso && !catalogoOk ? pendentes : faltam, bloqueado, aviso };
}

// Junta produtos e pedidos: uma linha por produto com reserva ou com pedido em aberto.
export function montarReservas(produtos, pedidos) {
  const porId = new Map(), porSku = new Map();
  const linha = p => ({ produtoId: p.produto_id != null ? Number(p.produto_id) : null, sku: p.sku || '', produto: p.nome || '',
    saldo: p.saldo == null ? null : Number(p.saldo), reservado: Number(p.reservado || 0), emPedidos: 0, pedidos: [],
    semEstoqueLido: p.lido === false });
  for (const p of produtos) {
    const l = linha(p);
    porId.set(String(p.produto_id), l);
    if (l.sku) porSku.set(l.sku, l);
  }
  for (const ped of pedidos) {
    for (const it of ped.itens || []) {
      let l = (it.produto_id && porId.get(String(it.produto_id))) || (it.sku && porSku.get(it.sku));
      if (!l) {
        l = linha({ produto_id: it.produto_id, sku: it.sku, nome: it.descricao, saldo: null, reservado: 0 });
        l.semEstoqueLido = true;
        if (it.produto_id) porId.set(String(it.produto_id), l);
        if (it.sku) porSku.set(it.sku, l);
      }
      // Pedido que já tem nota: o estoque foi baixado pela nota, então não explica reserva.
      if (!ped.nota_id) l.emPedidos += Number(it.qtd || 0);
      l.pedidos.push({ numero: ped.numero, data: ped.data, situacao: ped.situacao, qtd: Number(it.qtd || 0), comNota: !!ped.nota_id });
    }
  }
  const vistas = new Set();
  const linhas = [];
  for (const l of [...porId.values(), ...porSku.values()]) {
    if (vistas.has(l)) continue;
    vistas.add(l);
    if (!(l.reservado > 0) && !l.pedidos.some(p => !p.comNota)) continue;
    l.semPedido = Math.max(l.reservado - l.emPedidos, 0);
    l.situacao = l.reservado > 0 && !l.emPedidos ? 'sem_pedido'
      : l.reservado > l.emPedidos ? 'parcial'
      : l.reservado === l.emPedidos ? 'ok'
      : 'pedido_sem_reserva';
    linhas.push(l);
  }
  const ordem = { sem_pedido: 0, parcial: 1, pedido_sem_reserva: 2, ok: 3 };
  linhas.sort((a, b) => ordem[a.situacao] - ordem[b.situacao] || b.semPedido - a.semPedido || b.reservado - a.reservado || a.sku.localeCompare(b.sku));
  return linhas;
}

export async function reservasHandler(req, res) {
  try {
    const filial = String(req.query.filial || 'SUL').toUpperCase();
    if (!FILIAIS[filial]) return res.status(400).json({ ok: false, error: 'Filial deve ser SUL ou TRADE.' });
    const sql = neon(process.env.DATABASE_URL);
    await garantirTabelas(sql);
    await sql`INSERT INTO reserva_varredura (filial) VALUES (${filial}) ON CONFLICT (filial) DO NOTHING`;
    const [estado] = await sql`SELECT *, (iniciada_em IS NOT NULL AND (concluida_em IS NULL OR iniciada_em > concluida_em)) AS iniciada_em_aberta
      FROM reserva_varredura WHERE filial = ${filial}`;

    const avisos = [];
    let faltam = 0, bloqueado = false;
    if (req.query.atualizar !== '0') {
      const token = process.env[FILIAIS[filial]];
      if (!token) return res.status(200).json({ ok: false, error: `${FILIAIS[filial]} não configurado na Vercel.` });
      const forcar = req.query.forcar === '1';
      if (forcar) {
        await sql`UPDATE reserva_varredura SET proxima_pagina = 1, concluida_em = NULL, catalogo_em = NULL, pedidos_em = NULL WHERE filial = ${filial}`;
        await sql`UPDATE reserva_produtos SET lido_em = NULL WHERE filial = ${filial}`;
      }
      const inicio = Date.now();
      const p = await lerPedidos(sql, filial, token, inicio, forcar, forcar ? { ...estado, pedidos_em: null } : estado);
      avisos.push(...p.avisos);
      faltam += p.faltam; bloqueado = p.bloqueado;
      if (!bloqueado && Date.now() - inicio < LIMITE_MS) {
        const v = await varrerEstoque(sql, filial, token, inicio, forcar, forcar ? { ...estado, proxima_pagina: 1, concluida_em: null } : estado);
        if (v.aviso) avisos.push(v.aviso);
        faltam += v.faltam; bloqueado = v.bloqueado;
      } else if (!bloqueado) {
        faltam += 1;
      }
    }

    const [est] = await sql`SELECT * FROM reserva_varredura WHERE filial = ${filial}`;
    const produtos = await sql`SELECT produto_id, sku, nome, saldo::float AS saldo, reservado::float AS reservado, lido_em IS NOT NULL AS lido
      FROM reserva_produtos WHERE filial = ${filial} AND reservado > 0`;
    const pedidos = await sql`SELECT numero, data, situacao, itens, nota_id FROM reserva_pedidos WHERE filial = ${filial} AND itens IS NOT NULL`;
    // Produtos dos pedidos que não têm reserva: busca o saldo deles para mostrar.
    const idsPedidos = [...new Set(pedidos.flatMap(p => (p.itens || []).map(i => i.produto_id).filter(Boolean)))];
    const extra = idsPedidos.length ? await sql`SELECT produto_id, sku, nome, saldo::float AS saldo, reservado::float AS reservado, lido_em IS NOT NULL AS lido
      FROM reserva_produtos WHERE filial = ${filial} AND produto_id = ANY(${idsPedidos}) AND COALESCE(reservado, 0) <= 0` : [];
    const linhas = montarReservas([...produtos, ...extra], pedidos);
    const [cont] = await sql`SELECT COUNT(*)::int AS total, COUNT(lido_em)::int AS lidos FROM reserva_produtos WHERE filial = ${filial}`;

    return res.status(200).json({
      ok: true, filial,
      faltam, bloqueado, avisos,
      leitura: {
        estoqueEm: est?.incremental_em && est?.concluida_em && new Date(est.incremental_em) > new Date(est.concluida_em) ? est.incremental_em : est?.concluida_em || null,
        produtosLidos: cont.lidos,
        produtosTotal: cont.total,
        catalogoCompleto: !!est?.catalogo_em,
        varreduraEmAndamento: !est?.catalogo_em || cont.lidos < cont.total,
        campoReservado: est?.campo_reservado,
        pedidosEm: est?.pedidos_em || null,
        pedidosAbertos: pedidos.filter(p => !p.nota_id).length,
        pedidosComNota: pedidos.filter(p => p.nota_id).length,
      },
      linhas,
    });
  } catch (error) {
    console.error('Erro nas reservas:', error);
    return res.status(200).json({ ok: false, error: error.message });
  }
}
