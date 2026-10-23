// Controle de Insumos (fita, plástico, bobinas, etiquetas...).
// Fica em lib/ (e não em api/) por causa do limite de 12 funções do plano
// Hobby da Vercel: quem expõe isso é api/caixa-movimentacoes.js, via
// ?recurso=insumos.
//
// O estoque nunca é guardado: é entradas - saídas lançadas à mão, menos a
// baixa automática (consumo_por_embalagem x embalagens expedidas desde
// auto_desde), quando o insumo tem essa configuração.

const DIAS_CONSUMO = 30;

function erroMigracao(error) {
  return /insumos|insumo_movimentacoes|unidades_por_estoque/.test(error.message || '');
}

const num = v => (v === null || v === undefined || v === '' ? null : Number(v));

// Resumo de todos os insumos: estoque, consumo/dia, cobertura, ponto de
// reposição e situação (crit | warn | ok | sem_config).
export async function calcularInsumos(sql, filial) {
  // unidades_por_estoque (migração 015) é lida à parte: sem ela, tudo segue com fator 1
  let insumos;
  try {
    insumos = await sql`
      SELECT id, nome, unidade, lead_time_dias, estoque_seguranca_pct::float AS estoque_seguranca_pct,
             estoque_minimo, consumo_por_embalagem::float AS consumo_por_embalagem,
             TO_CHAR(auto_desde, 'YYYY-MM-DD') AS auto_desde, auto_inclui_fulfillment, ativo,
             unidades_por_estoque::float AS unidades_por_estoque
      FROM insumos
      ORDER BY ativo DESC, nome
    `;
  } catch (err) {
    if (!/unidades_por_estoque/.test(err.message || '')) throw err;
    insumos = await sql`
      SELECT id, nome, unidade, lead_time_dias, estoque_seguranca_pct::float AS estoque_seguranca_pct,
             estoque_minimo, consumo_por_embalagem::float AS consumo_por_embalagem,
             TO_CHAR(auto_desde, 'YYYY-MM-DD') AS auto_desde, auto_inclui_fulfillment, ativo,
             1::float AS unidades_por_estoque
      FROM insumos
      ORDER BY ativo DESC, nome
    `;
  }
  const movs = await sql`
    SELECT insumo_id,
           COALESCE(SUM(CASE WHEN tipo = 'entrada' THEN quantidade ELSE -quantidade END), 0)::float AS saldo_manual,
           COALESCE(SUM(quantidade) FILTER (WHERE tipo = 'saida' AND conta_consumo = true AND data > current_date - ${DIAS_CONSUMO} * interval '1 day'), 0)::float AS saida_30d,
           TO_CHAR(MAX(data), 'YYYY-MM-DD') AS ultimo_lancamento
    FROM insumo_movimentacoes
    WHERE filial = ${filial}
    GROUP BY insumo_id
  `;
  const porInsumo = new Map(movs.map(m => [m.insumo_id, m]));

  const resultado = [];
  for (const i of insumos) {
    const m = porInsumo.get(i.id) || { saldo_manual: 0, saida_30d: 0, ultimo_lancamento: null };
    let consumoDia = m.saida_30d / DIAS_CONSUMO;
    let baixaAutomatica = 0;
    let embalagens30d = null;
    const automatico = i.consumo_por_embalagem !== null && i.auto_desde !== null;

    if (automatico) {
      // embalagens expedidas = saídas de caixa que baixam o estoque (consumo
      // real); com auto_inclui_fulfillment, também as vendas série 2.
      const [e] = await sql`
        SELECT COALESCE(SUM(quantidade) FILTER (WHERE data >= ${i.auto_desde}::date), 0)::float AS desde,
               COALESCE(SUM(quantidade) FILTER (WHERE data > current_date - ${DIAS_CONSUMO} * interval '1 day'), 0)::float AS ultimos_30d
        FROM caixa_movimentacoes
        WHERE filial = ${filial} AND tipo = 'saida'
          AND ((conta_estoque = true AND conta_consumo = true) OR (${i.auto_inclui_fulfillment}::boolean AND conta_estoque = false))
      `;
      // consumo_por_embalagem está na unidade de consumo (ex: etiquetas); o estoque, na de estoque (ex: rolos)
      const porEmbalagem = i.consumo_por_embalagem / (i.unidades_por_estoque || 1);
      baixaAutomatica = e.desde * porEmbalagem;
      embalagens30d = e.ultimos_30d;
      consumoDia += (e.ultimos_30d * porEmbalagem) / DIAS_CONSUMO;
    }

    const estoque = Math.round((m.saldo_manual - baixaAutomatica) * 100) / 100;
    let ponto = i.estoque_minimo;
    if (ponto === null && i.lead_time_dias) ponto = Math.ceil(consumoDia * i.lead_time_dias * (1 + i.estoque_seguranca_pct));

    let status = 'sem_config';
    if (ponto !== null && ponto !== undefined) {
      if (estoque <= ponto) status = 'crit';
      else if (estoque <= ponto * 1.3) status = 'warn';
      else status = 'ok';
    }
    const diasSemLancamento = m.ultimo_lancamento
      ? Math.floor((Date.now() - new Date(m.ultimo_lancamento + 'T12:00:00').getTime()) / 86400000)
      : null;

    resultado.push({
      ...i,
      estoque_atual: estoque,
      consumo_dia: Math.round(consumoDia * 100) / 100,
      cobertura_dias: consumoDia > 0 ? Math.round(estoque / consumoDia) : null,
      ponto_reposicao: ponto ?? null,
      status: i.ativo ? status : 'inativo',
      automatico,
      baixa_automatica_acumulada: Math.round(baixaAutomatica * 100) / 100,
      embalagens_30d: embalagens30d,
      ultimo_lancamento: m.ultimo_lancamento,
      dias_sem_lancamento: diasSemLancamento,
    });
  }
  return resultado;
}

async function movimentosRecentes(sql, filial, limite) {
  return sql`
    SELECT m.id, m.insumo_id, i.nome AS insumo_nome, i.unidade, m.tipo, m.quantidade::float AS quantidade,
           TO_CHAR(m.data, 'YYYY-MM-DD') AS data, m.observacao, m.conta_consumo
    FROM insumo_movimentacoes m
    JOIN insumos i ON i.id = m.insumo_id
    WHERE m.filial = ${filial}
    ORDER BY m.data DESC, m.id DESC
    LIMIT ${limite}
  `;
}

export default async function handlerInsumos(req, res, sql) {
  const filial = req.query.filial ? String(req.query.filial).toUpperCase() : 'SP';

  try {
    if (req.method === 'GET') {
      const limite = Math.min(Number(req.query.limit) || 20, 200);
      const [insumos, movimentos] = await Promise.all([calcularInsumos(sql, filial), movimentosRecentes(sql, filial, limite)]);
      return res.status(200).json({ filial, insumos, movimentos });
    }

    if (req.method === 'POST') {
      const body = req.body || {};

      // novo insumo
      if (body.acao === 'insumo') {
        const nome = String(body.nome || '').trim();
        const unidade = String(body.unidade || 'un').trim() || 'un';
        if (!nome) return res.status(400).json({ error: 'Informe o nome do insumo.' });
        const seg = body.estoque_seguranca_pct === undefined || body.estoque_seguranca_pct === null || body.estoque_seguranca_pct === '' ? 0.2 : Number(body.estoque_seguranca_pct);
        const cpe = num(body.consumo_por_embalagem);
        const desde = body.auto_desde || null;
        if (cpe !== null && !desde) return res.status(400).json({ error: 'Pra baixa automática, informe também a data de início ("A partir de").' });
        const rows = await sql`
          INSERT INTO insumos (nome, unidade, lead_time_dias, estoque_seguranca_pct, estoque_minimo, consumo_por_embalagem, auto_desde, auto_inclui_fulfillment, unidades_por_estoque)
          VALUES (${nome}, ${unidade}, ${num(body.lead_time_dias)}, ${seg}, ${num(body.estoque_minimo)}, ${cpe}, ${desde}, ${body.auto_inclui_fulfillment === true}, ${num(body.unidades_por_estoque) > 0 ? num(body.unidades_por_estoque) : 1})
          RETURNING id`;
        return res.status(201).json(rows[0]);
      }

      // contagem física: lança a diferença como ajuste (não conta como consumo)
      if (body.acao === 'contagem') {
        const contada = Number(body.quantidade_contada);
        if (!body.insumo_id || !(contada >= 0)) return res.status(400).json({ error: 'Informe o insumo e a quantidade contada.' });
        const atuais = await calcularInsumos(sql, filial);
        const atual = atuais.find(i => i.id === Number(body.insumo_id));
        if (!atual) return res.status(404).json({ error: 'Insumo não encontrado.' });
        const dif = Math.round((contada - atual.estoque_atual) * 100) / 100;
        if (dif === 0) return res.status(200).json({ ok: true, diferenca: 0 });
        await sql`
          INSERT INTO insumo_movimentacoes (insumo_id, filial, tipo, quantidade, data, observacao, conta_consumo)
          VALUES (${atual.id}, ${filial}, ${dif > 0 ? 'entrada' : 'saida'}, ${Math.abs(dif)}, ${body.data || new Date().toISOString().slice(0, 10)}, ${'Ajuste de contagem física'}, false)`;
        return res.status(201).json({ ok: true, diferenca: dif });
      }

      // lançamento de entrada ou saída
      const qtd = Number(body.quantidade);
      if (!body.insumo_id) return res.status(400).json({ error: 'Escolha o insumo.' });
      if (body.tipo !== 'entrada' && body.tipo !== 'saida') return res.status(400).json({ error: 'Tipo deve ser entrada ou saída.' });
      if (!(qtd > 0)) return res.status(400).json({ error: 'Informe uma quantidade maior que zero.' });
      if (!body.data) return res.status(400).json({ error: 'Informe a data.' });
      const rows = await sql`
        INSERT INTO insumo_movimentacoes (insumo_id, filial, tipo, quantidade, data, observacao, conta_consumo)
        VALUES (${Number(body.insumo_id)}, ${filial}, ${body.tipo}, ${qtd}, ${body.data}, ${body.observacao || null}, ${body.tipo === 'saida'})
        RETURNING id`;
      return res.status(201).json(rows[0]);
    }

    if (req.method === 'PUT') {
      const b = req.body || {};
      const id = Number(b.id);
      if (!id) return res.status(400).json({ error: 'Campo "id" é obrigatório.' });
      const existe = await sql`SELECT id FROM insumos WHERE id = ${id}`;
      if (existe.length === 0) return res.status(404).json({ error: 'Insumo não encontrado.' });
      if ('consumo_por_embalagem' in b && num(b.consumo_por_embalagem) !== null && !b.auto_desde && !('auto_desde' in b)) {
        const [a] = await sql`SELECT auto_desde FROM insumos WHERE id = ${id}`;
        if (!a.auto_desde) return res.status(400).json({ error: 'Pra baixa automática, informe também a data de início ("A partir de").' });
      }
      // só grava o que veio no corpo (aceita null pra limpar)
      if ('nome' in b && String(b.nome).trim()) await sql`UPDATE insumos SET nome = ${String(b.nome).trim()} WHERE id = ${id}`;
      if ('unidade' in b && String(b.unidade).trim()) await sql`UPDATE insumos SET unidade = ${String(b.unidade).trim()} WHERE id = ${id}`;
      if ('lead_time_dias' in b) await sql`UPDATE insumos SET lead_time_dias = ${num(b.lead_time_dias)} WHERE id = ${id}`;
      if ('estoque_seguranca_pct' in b && num(b.estoque_seguranca_pct) !== null) await sql`UPDATE insumos SET estoque_seguranca_pct = ${num(b.estoque_seguranca_pct)} WHERE id = ${id}`;
      if ('estoque_minimo' in b) await sql`UPDATE insumos SET estoque_minimo = ${num(b.estoque_minimo)} WHERE id = ${id}`;
      if ('consumo_por_embalagem' in b) await sql`UPDATE insumos SET consumo_por_embalagem = ${num(b.consumo_por_embalagem)} WHERE id = ${id}`;
      if ('auto_desde' in b) await sql`UPDATE insumos SET auto_desde = ${b.auto_desde || null} WHERE id = ${id}`;
      if ('unidades_por_estoque' in b && num(b.unidades_por_estoque) > 0) await sql`UPDATE insumos SET unidades_por_estoque = ${num(b.unidades_por_estoque)} WHERE id = ${id}`;
      if ('auto_inclui_fulfillment' in b) await sql`UPDATE insumos SET auto_inclui_fulfillment = ${b.auto_inclui_fulfillment === true} WHERE id = ${id}`;
      if ('ativo' in b) await sql`UPDATE insumos SET ativo = ${b.ativo === true} WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Método não permitido.' });
  } catch (error) {
    console.error('Erro caixa-insumos:', error);
    if (erroMigracao(error) && /unidades_por_estoque/.test(error.message)) {
      return res.status(500).json({ error: 'Migração 015 pendente: rode sql/015_insumos_unidades_por_estoque.sql no Neon.' });
    }
    if (erroMigracao(error) && /does not exist|não existe/.test(error.message)) {
      return res.status(500).json({ error: 'Migração 014 pendente: rode sql/014_insumos.sql no Neon.' });
    }
    if (/duplicate key|unique/i.test(error.message || '')) {
      return res.status(400).json({ error: 'Já existe um insumo com esse nome.' });
    }
    return res.status(500).json({ error: error.message });
  }
}
