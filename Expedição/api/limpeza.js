// Vercel Serverless Function — limpeza do veículo (Fiorino).
//
// Acesso por link secreto (x-limpeza-key, ver lib/limpeza-auth.js).
//   GET                      estado: config, agenda prevista e registros.
//                            Motorista recebe só os 5 últimos, sem custo.
//   POST                     registra uma limpeza (motorista ou gestão).
//                            Exige no mínimo 3 fotos já enviadas por
//                            /api/limpeza-foto.
//   POST ?acao=fotos&id=N    acrescenta fotos a uma limpeza já registrada.
//   PUT  ?acao=config        ritmo, primeira limpeza e placa (só gestão).
//   DELETE ?id=N             exclui a limpeza e as fotos (só gestão).

import { neon } from '@neondatabase/serverless';
import { del } from '@vercel/blob';
import { papel } from '../lib/limpeza-auth.js';
import { montarAgenda } from '../lib/limpeza-agenda.js';

const MIN_FOTOS = 3;
const MAX_FOTOS = 12;
const MAX_FOTOS_TOTAL = 24;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
// Só aceitamos endereços do nosso próprio Blob, na pasta da limpeza.
const URL_FOTO = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/limpeza-veiculo\//;

const dataValida = (s) => ISO.test(s) && !Number.isNaN(Date.parse(s + 'T12:00:00Z'));
const fotosValidas = (l) =>
  Array.isArray(l) && l.every((u) => typeof u === 'string' && u.length < 500 && URL_FOTO.test(u));

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const quem = papel(req);
  if (!quem) return res.status(401).json({ error: 'Link inválido ou expirado.' });

  const sql = neon(process.env.DATABASE_URL);
  const acao = String(req.query.acao || '');

  try {
    if (req.method === 'GET') {
      const [cfg] = await sql`
        SELECT frequencia, TO_CHAR(inicio, 'YYYY-MM-DD') AS inicio, placa
        FROM limpeza_config WHERE id = 1`;
      const lista = await sql`
        SELECT id, TO_CHAR(data, 'YYYY-MM-DD') AS data, tipo, custo::float8 AS custo,
               responsavel, obs, fotos
        FROM limpezas
        ORDER BY data DESC, id DESC
        LIMIT 500`;
      const ultima = lista[0] ? { data: lista[0].data, tipo: lista[0].tipo } : null;
      const registros = quem === 'gestao'
        ? lista
        : lista.slice(0, 5).map(({ custo, ...resto }) => resto);
      return res.status(200).json({
        papel: quem,
        config: cfg,
        agenda: montarAgenda(cfg, ultima),
        registros,
        minFotos: MIN_FOTOS,
      });
    }

    if (req.method === 'POST' && acao === 'fotos') {
      const id = parseInt(req.query.id, 10);
      const novas = (req.body || {}).fotos;
      if (!Number.isInteger(id) || !fotosValidas(novas) || !novas.length || novas.length > MAX_FOTOS) {
        return res.status(400).json({ error: 'Fotos inválidas.' });
      }
      const [atual] = await sql`SELECT jsonb_array_length(fotos) AS n FROM limpezas WHERE id = ${id}`;
      if (!atual) return res.status(404).json({ error: 'Limpeza não encontrada.' });
      if (atual.n + novas.length > MAX_FOTOS_TOTAL) {
        return res.status(400).json({ error: `Cada limpeza aceita até ${MAX_FOTOS_TOTAL} fotos.` });
      }
      await sql`UPDATE limpezas SET fotos = fotos || ${JSON.stringify(novas)}::jsonb WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const data = String(b.data || '');
      const tipo = String(b.tipo || '');
      const custo = Math.round((Number(b.custo) || 0) * 100) / 100;
      const responsavel = String(b.responsavel || '').trim().slice(0, 60);
      const obs = String(b.obs || '').trim().slice(0, 200);
      if (!dataValida(data)) return res.status(400).json({ error: 'Data inválida.' });
      if (tipo !== 'completa' && tipo !== 'simples') return res.status(400).json({ error: 'Serviço inválido.' });
      if (custo < 0 || custo > 100000) return res.status(400).json({ error: 'Valor inválido.' });
      if (!fotosValidas(b.fotos)) return res.status(400).json({ error: 'Fotos inválidas.' });
      if (b.fotos.length < MIN_FOTOS) {
        return res.status(400).json({ error: `Envie pelo menos ${MIN_FOTOS} fotos.` });
      }
      if (b.fotos.length > MAX_FOTOS) {
        return res.status(400).json({ error: `Envie no máximo ${MAX_FOTOS} fotos de uma vez.` });
      }
      const [nova] = await sql`
        INSERT INTO limpezas (data, tipo, custo, responsavel, obs, fotos)
        VALUES (${data}, ${tipo}, ${custo}, ${responsavel}, ${obs}, ${JSON.stringify(b.fotos)}::jsonb)
        RETURNING id`;
      return res.status(201).json({ id: nova.id });
    }

    if (req.method === 'PUT' && acao === 'config') {
      if (quem !== 'gestao') return res.status(403).json({ error: 'Sem permissão.' });
      const b = req.body || {};
      const frequencia = String(b.frequencia || '');
      const inicio = String(b.inicio || '');
      const placa = String(b.placa || '').trim().toUpperCase().slice(0, 10);
      if (frequencia !== 'mensal' && frequencia !== 'quinzenal') return res.status(400).json({ error: 'Frequência inválida.' });
      if (!dataValida(inicio)) return res.status(400).json({ error: 'Data inválida.' });
      await sql`
        UPDATE limpeza_config SET frequencia = ${frequencia}, inicio = ${inicio}, placa = ${placa}
        WHERE id = 1`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      if (quem !== 'gestao') return res.status(403).json({ error: 'Sem permissão.' });
      const id = parseInt(req.query.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Identificador inválido.' });
      const [apagada] = await sql`DELETE FROM limpezas WHERE id = ${id} RETURNING fotos`;
      if (apagada && Array.isArray(apagada.fotos) && apagada.fotos.length) {
        try { await del(apagada.fotos); } catch (e) { console.error('Falha ao apagar fotos do Blob:', e); }
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Método não permitido.' });
  } catch (error) {
    console.error('Erro em /api/limpeza:', error);
    return res.status(500).json({ error: 'Falha ao acessar o banco. Confira se a migração 020 foi executada.' });
  }
}
