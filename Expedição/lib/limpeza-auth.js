// Acesso à limpeza do veículo por link secreto.
//
// Cada tela abre com ?k=<chave> e manda a chave no cabeçalho x-limpeza-key.
// Duas chaves, definidas na Vercel:
//   LIMPEZA_KEY_GESTAO     tudo: ver custos, configurar, excluir
//   LIMPEZA_KEY_MOTORISTA  só ver a próxima limpeza e registrar (com fotos)
// Sem a variável definida, aquele papel fica desligado (ninguém entra com ele).

import { timingSafeEqual } from 'node:crypto';

function igual(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Devolve 'gestao', 'motorista' ou null.
export function papel(req) {
  const chave = String(req.headers['x-limpeza-key'] || '').trim();
  if (!chave) return null;
  if (igual(chave, process.env.LIMPEZA_KEY_GESTAO)) return 'gestao';
  if (igual(chave, process.env.LIMPEZA_KEY_MOTORISTA)) return 'motorista';
  return null;
}
