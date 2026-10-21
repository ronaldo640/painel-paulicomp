// Vercel Serverless Function — lançamentos de entrada (compra) e saída
// (uso) de caixas, por filial. GET lista os últimos lançamentos, POST
// registra um novo. A data é sempre informada manualmente (nunca
// travada em "hoje"), porque o repasse de consumo da equipe às vezes
// chega atrasado.

import { neon } from '@neondatabase/serverless';
import handlerCompras from '../lib/caixa-compras.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  // Compras (cotações e pedidos) moram em lib/ pra não gastar uma das 12
  // funções do plano Hobby da Vercel.
  if (req.query.recurso === 'compras') return handlerCompras(req, res, sql);

  if (req.method === 'GET') {
    try {
      const filial = req.query.filial ? String(req.query.filial).toUpperCase() : 'SP';
      const limit = Math.min(Number(req.query.limit) || 20, 200);

      let rows;
      try {
        rows = await sql`
          SELECT m.id, m.modelo_id, cm.nome AS modelo_nome, m.filial, m.tipo,
                 m.quantidade, TO_CHAR(m.data, 'YYYY-MM-DD') AS data, m.observacao, m.conta_consumo, m.envio_fulfillment
          FROM caixa_movimentacoes m
          JOIN caixa_modelos cm ON cm.id = m.modelo_id
          WHERE m.filial = ${filial}
          ORDER BY m.data DESC, m.id DESC
          LIMIT ${limit}
        `;
      } catch (err) {
        // migração 011 ainda não rodada: lista sem a marca de envio ao Fulfillment
        console.error('Coluna envio_fulfillment indisponível (migração 011 pendente?):', err.message);
        rows = await sql`
          SELECT m.id, m.modelo_id, cm.nome AS modelo_nome, m.filial, m.tipo,
                 m.quantidade, TO_CHAR(m.data, 'YYYY-MM-DD') AS data, m.observacao, m.conta_consumo
          FROM caixa_movimentacoes m
          JOIN caixa_modelos cm ON cm.id = m.modelo_id
          WHERE m.filial = ${filial}
          ORDER BY m.data DESC, m.id DESC
          LIMIT ${limit}
        `;
      }
      return res.status(200).json(rows);
    } catch (error) {
      console.error('Erro GET caixa_movimentacoes:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const { modelo_id, filial, tipo, quantidade, data, observacao } = req.body || {};

      if (!modelo_id) return res.status(400).json({ error: 'Campo "modelo_id" é obrigatório.' });
      if (!filial) return res.status(400).json({ error: 'Campo "filial" é obrigatório.' });
      if (tipo !== 'entrada' && tipo !== 'saida') {
        return res.status(400).json({ error: 'Campo "tipo" deve ser "entrada" ou "saida".' });
      }
      const qtd = Number(quantidade);
      if (!Number.isInteger(qtd) || qtd <= 0) {
        return res.status(400).json({ error: 'Campo "quantidade" deve ser um número inteiro maior que zero.' });
      }
      if (!data) return res.status(400).json({ error: 'Campo "data" é obrigatório.' });

      // Tipo da saída (só vale pra tipo = 'saida'):
      //  - 'consumo' (padrão): uso normal.
      //  - 'transferencia': pra outra filial. Baixa o estoque, mas fica fora
      //    de consumo/dia, tendência e gráficos.
      //  - 'fulfillment': envio de lote ao Fulfillment. Baixa o estoque, fica
      //    fora do "consumo real", mas entra no consumo do planejamento.
      let saidaTipo = tipo === 'saida' ? (req.body.saida_tipo || 'consumo') : 'consumo';
      if (tipo === 'saida' && !req.body.saida_tipo && req.body.conta_consumo === false) saidaTipo = 'transferencia'; // compat.
      //  - 'ajuste': correção de estoque por contagem física (inventário). Só
      //    acerta o saldo; nunca é consumo.
      if (!['consumo', 'transferencia', 'fulfillment', 'ajuste'].includes(saidaTipo)) {
        return res.status(400).json({ error: 'Campo "saida_tipo" deve ser "consumo", "transferencia", "fulfillment" ou "ajuste".' });
      }
      const contaConsumo = saidaTipo === 'consumo';
      const envioFulfillment = saidaTipo === 'fulfillment';

      let rows;
      try {
        rows = await sql`
        INSERT INTO caixa_movimentacoes (modelo_id, filial, tipo, quantidade, data, observacao, conta_consumo, envio_fulfillment)
        VALUES (${modelo_id}, ${String(filial).toUpperCase()}, ${tipo}, ${qtd}, ${data}, ${observacao || null}, ${contaConsumo}, ${envioFulfillment})
        RETURNING id, modelo_id, filial, tipo, quantidade, TO_CHAR(data, 'YYYY-MM-DD') AS data, observacao
      `;
      } catch (err) {
        if (/envio_fulfillment/.test(err.message)) {
          return res.status(400).json({ error: 'Migração 011 pendente: rode sql/011_caixa_mov_envio_fulfillment.sql no Neon.' });
        }
        throw err;
      }
      return res.status(201).json(rows[0]);
    } catch (error) {
      console.error('Erro POST caixa_movimentacoes:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Método não permitido.' });
}
