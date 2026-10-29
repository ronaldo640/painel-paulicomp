// Agenda de limpeza do veículo: calcula as próximas datas a partir da última
// limpeza registrada (ou da data inicial, se ainda não houve nenhuma).
//
// Mensal: sempre limpeza completa, perto do mesmo dia do mês (dia 31 vira o
// último dia dos meses mais curtos). Quinzenal: a cada 14 dias, alternando completa e
// simples; depois de uma completa vem uma simples, e vice-versa.
//
// Toda data prevista é levada para a sexta-feira mais próxima (sáb e dom vão
// para a sexta anterior, seg para a anterior, ter a qui para a seguinte). Cada
// data sai da base, não da anterior, então o ajuste não se acumula.
//
// Datas sempre como texto AAAA-MM-DD, calculadas em UTC pra não depender do
// fuso do servidor.

const DIA_MS = 86400000;

function paraTempo(s) {
  const [a, m, d] = s.split('-').map(Number);
  return Date.UTC(a, m - 1, d);
}

function paraTexto(t) {
  return new Date(t).toISOString().slice(0, 10);
}

function somaDias(s, n) {
  return paraTexto(paraTempo(s) + n * DIA_MS);
}

function somaMeses(s, n) {
  const [a, m, d] = s.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + n, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimoDia));
  return alvo.toISOString().slice(0, 10);
}

const SEXTA = 5;

function paraSexta(s) {
  const dow = new Date(paraTempo(s)).getUTCDay();
  let desvio = SEXTA - dow; // dom +5, seg +4, ter +3 ... sáb -1
  if (desvio > 3) desvio -= 7; // dom e seg voltam para a sexta anterior
  return somaDias(s, desvio);
}

// config: { frequencia: 'mensal' | 'quinzenal', inicio: 'AAAA-MM-DD' }
// ultima: { data, tipo } da limpeza mais recente, ou null
export function montarAgenda(config, ultima, quantidade = 6) {
  const quinzenal = config.frequencia === 'quinzenal';
  const base = ultima ? ultima.data : config.inicio;
  const comecaCompleta = ultima ? ultima.tipo !== 'completa' : true;
  const itens = [];
  for (let i = 0; i < quantidade; i++) {
    const passo = ultima ? i + 1 : i;
    const data = paraSexta(quinzenal ? somaDias(base, 14 * passo) : somaMeses(base, passo));
    const tipo = !quinzenal || ((i % 2 === 0) === comecaCompleta) ? 'completa' : 'simples';
    itens.push({ data, tipo });
  }
  return itens;
}
