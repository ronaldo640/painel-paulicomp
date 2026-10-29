// Acesso à limpeza do veículo por link secreto.
//
// Cada tela abre com ?k=<chave> e manda a chave no cabeçalho x-limpeza-key.
// Duas chaves, definidas na Vercel:
//   LIMPEZA_KEY_GESTAO     tudo: ver custos, configurar, excluir
//   LIMPEZA_KEY_MOTORISTA  só ver a próxima limpeza e registrar (com fotos)
// Sem a variável definida, aquele papel fica desligado (ninguém entra com ele).

import { createHash, timingSafeEqual } from 'node:crypto';

function igual(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Cada papel aceita o nome LIMPEZA_KEY_* (o documentado) e LIMPEZA_CHAVE_*
// (erro comum de nome). Valores sem espaço ou quebra de linha nas pontas, que
// sobram ao colar na Vercel; variável vazia ou ausente não vale.
const NOMES = {
  gestao: ['LIMPEZA_KEY_GESTAO', 'LIMPEZA_CHAVE_GESTAO'],
  motorista: ['LIMPEZA_KEY_MOTORISTA', 'LIMPEZA_CHAVE_MOTORISTA'],
};
const valores = (papelNome) =>
  NOMES[papelNome].map((n) => String(process.env[n] || '').trim()).filter(Boolean);

// Devolve 'gestao', 'motorista' ou null.
export function papel(req) {
  const chave = String(req.headers['x-limpeza-key'] || '').trim();
  if (!chave) return null;
  if (valores('gestao').some((v) => igual(chave, v))) return 'gestao';
  if (valores('motorista').some((v) => igual(chave, v))) return 'motorista';
  return null;
}

// TEMPORÁRIO (diagnóstico de acesso): diz se cada variável existe, quantos
// caracteres tem e uma impressão digital curta (6 letras de um SHA-256), nunca
// o valor. Faz o mesmo com a chave recebida, pra comparar. Sai no cabeçalho
// x-limpeza-diag e no campo "diag" do 401.
export function diagnostico(req) {
  const digital = (s) => createHash('sha256').update(s).digest('hex').slice(0, 6);
  const resumo = (nome) => {
    const v = process.env[nome];
    if (v == null) return 'ausente';
    if (v === '') return 'vazia';
    return `definida (${v.length} caracteres, digital ${digital(v.trim())})`;
  };
  const recebida = String((req && req.headers['x-limpeza-key']) || '').trim();
  const partes = [`recebida: ${recebida.length} caracteres, digital ${recebida ? digital(recebida) : '-'}`];
  return partes.concat(Object.values(NOMES).flat().map((n) => `${n}: ${resumo(n)}`)).join('; ');
}
