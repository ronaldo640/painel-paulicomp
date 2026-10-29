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

// Valor da variável sem espaço ou quebra de linha nas pontas (sobra ao colar na Vercel).
const env = (nome) => String(process.env[nome] || '').trim();

// Devolve 'gestao', 'motorista' ou null.
export function papel(req) {
  const chave = String(req.headers['x-limpeza-key'] || '').trim();
  if (!chave) return null;
  if (igual(chave, env('LIMPEZA_KEY_GESTAO'))) return 'gestao';
  if (igual(chave, env('LIMPEZA_KEY_MOTORISTA'))) return 'motorista';
  return null;
}

// TEMPORÁRIO (diagnóstico de acesso): diz se cada variável existe e quantos
// caracteres tem, nunca o valor. Sai no cabeçalho x-limpeza-diag do 401.
export function diagnostico() {
  const resumo = (nome) => {
    const v = process.env[nome];
    if (v == null) return 'ausente';
    if (v === '') return 'vazia';
    return `definida (${v.length} caracteres, ${v.trim().length} sem espaços nas pontas)`;
  };
  return `gestao: ${resumo('LIMPEZA_KEY_GESTAO')}; motorista: ${resumo('LIMPEZA_KEY_MOTORISTA')}`;
}
