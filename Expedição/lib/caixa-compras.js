// Lógica do planejamento de compras de caixas (cotações e pedidos).
// Fica fora de api/ de propósito: o plano Hobby da Vercel limita a 12
// funções serverless e já estamos no limite. Quem expõe isso é
// api/caixa-movimentacoes.js, via ?recurso=compras.
//
// Ciclo: cotacao -> solicitado -> em_transito -> recebido (ou cancelado).
// Receber NÃO lança entrada no estoque — a entrada é manual, em
// "Registrar movimentação". entrada_lancada só marca que o lançamento
// já foi feito (lembrete na tela).

function erroMigracao(error) {
  return /caixa_compras|cobertura_desejada|ponto_reposicao_manual/.test(error.message || '');
}

export default async function handlerCompras(req, res, sql) {
  const filial = req.query.filial ? String(req.query.filial).toUpperCase() : 'SP';

  try {
    if (req.method === 'GET') {
      // Cotações e pedidos em andamento ficam sempre; recebidos só se a
      // entrada ainda não foi lançada ou chegaram nos últimos 60 dias.
      const abertos = await sql`
        SELECT c.id, c.modelo_id, cm.nome AS modelo_nome, c.filial, c.status, c.fornecedor,
               c.quantidade, c.preco_unitario::float AS preco_unitario, c.frete::float AS frete, c.prazo_dias,
               TO_CHAR(c.data_cotacao, 'YYYY-MM-DD') AS data_cotacao,
               TO_CHAR(c.data_pedido, 'YYYY-MM-DD') AS data_pedido,
               TO_CHAR(c.previsao_chegada, 'YYYY-MM-DD') AS previsao_chegada,
               TO_CHAR(c.data_recebimento, 'YYYY-MM-DD') AS data_recebimento,
               c.qtd_recebida, c.entrada_lancada, c.observacao
        FROM caixa_compras c JOIN caixa_modelos cm ON cm.id = c.modelo_id
        WHERE c.filial = ${filial}
          AND (c.status IN ('cotacao','solicitado','em_transito')
               OR (c.status = 'recebido' AND (c.entrada_lancada = false OR c.data_recebimento >= current_date - interval '60 days')))
        ORDER BY c.id DESC
      `;
      return res.status(200).json(abertos);
    }

    if (req.method === 'POST') {
      const { modelo_id, fornecedor, quantidade, preco_unitario, frete, prazo_dias, observacao } = req.body || {};
      const qtd = Number(quantidade);
      const preco = Number(preco_unitario);
      if (!modelo_id) return res.status(400).json({ error: 'Escolha o modelo de caixa.' });
      if (!fornecedor || !String(fornecedor).trim()) return res.status(400).json({ error: 'Informe o fornecedor.' });
      if (!Number.isInteger(qtd) || qtd <= 0) return res.status(400).json({ error: 'Quantidade deve ser um inteiro maior que zero.' });
      if (!(preco >= 0) || preco_unitario === '' || preco_unitario === null || preco_unitario === undefined) {
        return res.status(400).json({ error: 'Informe o preço unitário.' });
      }
      const prazo = prazo_dias === '' || prazo_dias === null || prazo_dias === undefined ? null : Number(prazo_dias);
      if (prazo !== null && (!Number.isInteger(prazo) || prazo < 0)) return res.status(400).json({ error: 'Prazo inválido.' });

      const rows = await sql`
        INSERT INTO caixa_compras (filial, modelo_id, fornecedor, quantidade, preco_unitario, frete, prazo_dias, observacao)
        VALUES (${filial}, ${modelo_id}, ${String(fornecedor).trim()}, ${qtd}, ${preco}, ${Number(frete) || 0}, ${prazo}, ${observacao || null})
        RETURNING id
      `;
      return res.status(201).json(rows[0]);
    }

    if (req.method === 'PUT') {
      const { id, acao, data, data_pedido, previsao_chegada, data_recebimento, qtd_recebida } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Campo "id" é obrigatório.' });

      const atual = await sql`SELECT status, prazo_dias, quantidade FROM caixa_compras WHERE id = ${id}`;
      if (atual.length === 0) return res.status(404).json({ error: 'Compra não encontrada.' });
      const { status, prazo_dias } = atual[0];

      if (acao === 'solicitar') {
        if (status !== 'cotacao') return res.status(400).json({ error: 'Só uma cotação pode ser solicitada.' });
        const dp = data_pedido || data;
        await sql`
          UPDATE caixa_compras SET
            status = 'solicitado',
            data_pedido = COALESCE(${dp || null}::date, current_date),
            previsao_chegada = COALESCE(${previsao_chegada || null}::date,
              CASE WHEN ${prazo_dias}::int IS NOT NULL THEN COALESCE(${dp || null}::date, current_date) + ${prazo_dias}::int END)
          WHERE id = ${id}`;
      } else if (acao === 'em_transito') {
        if (status !== 'solicitado') return res.status(400).json({ error: 'Só um pedido solicitado pode ir pra "em trânsito".' });
        await sql`UPDATE caixa_compras SET status = 'em_transito', previsao_chegada = COALESCE(${previsao_chegada || null}::date, previsao_chegada) WHERE id = ${id}`;
      } else if (acao === 'receber') {
        if (status !== 'solicitado' && status !== 'em_transito') return res.status(400).json({ error: 'Só um pedido solicitado ou em trânsito pode ser recebido.' });
        const qr = Number(qtd_recebida);
        if (!Number.isInteger(qr) || qr <= 0) return res.status(400).json({ error: 'Informe a quantidade recebida.' });
        await sql`
          UPDATE caixa_compras SET status = 'recebido', qtd_recebida = ${qr},
            data_recebimento = COALESCE(${data_recebimento || null}::date, current_date)
          WHERE id = ${id}`;
      } else if (acao === 'cancelar') {
        if (status === 'recebido' || status === 'cancelado') return res.status(400).json({ error: 'Esse pedido já foi encerrado.' });
        await sql`UPDATE caixa_compras SET status = 'cancelado' WHERE id = ${id}`;
      } else if (acao === 'entrada_lancada') {
        await sql`UPDATE caixa_compras SET entrada_lancada = true WHERE id = ${id}`;
      } else {
        return res.status(400).json({ error: 'Ação inválida.' });
      }
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      // Só descarta cotações (não pedidos): pedido se cancela, pra manter histórico.
      const id = Number(req.query.id);
      if (!id) return res.status(400).json({ error: 'Parâmetro "id" é obrigatório.' });
      const del = await sql`DELETE FROM caixa_compras WHERE id = ${id} AND status = 'cotacao' RETURNING id`;
      if (del.length === 0) return res.status(400).json({ error: 'Só cotações podem ser descartadas; pedidos são cancelados.' });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Método não permitido.' });
  } catch (error) {
    console.error('Erro caixa-compras:', error);
    if (erroMigracao(error)) {
      return res.status(500).json({ error: `Falha em caixa_compras (migração 009 pendente?): ${error.message}` });
    }
    return res.status(500).json({ error: error.message });
  }
}
