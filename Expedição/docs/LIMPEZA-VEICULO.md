# Limpeza do veículo (Fiorino)

Agenda de limpeza no lava-rápido (mensal, com opção de quinzenal), com registro
de cada limpeza, **mínimo de 3 fotos** e custo. Duas telas sobre o mesmo banco:

| Tela | Endereço | Quem usa | O que faz |
|---|---|---|---|
| Motorista (celular) | `/limpeza/motorista?k=CHAVE_MOTORISTA` | motorista | vê a próxima limpeza, registra com fotos |
| Gestão (computador) | `/limpeza?k=CHAVE_GESTAO` | responsável pela frota | agenda, histórico com fotos, custos, ritmo, placa, exclusão |

O acesso é por **link secreto**: a chave vai na URL (`?k=`), a tela guarda no
navegador e manda no cabeçalho `x-limpeza-key`. Sem chave válida a API devolve 401.

## Para ativar

1. **Banco**: rodar `sql/020_limpeza_veiculo.sql` no SQL Editor do Neon.
2. **Blob** (fotos): na Vercel, projeto → Storage → Create → Blob e conectar ao
   projeto. Isso cria `BLOB_READ_WRITE_TOKEN` sozinho.
3. **Chaves**: em Settings → Environment Variables, criar duas variáveis com
   textos longos e aleatórios (30+ caracteres, só letras e números):
   - `LIMPEZA_KEY_GESTAO`
   - `LIMPEZA_KEY_MOTORISTA`
4. **Deploy** (faz instalar o `@vercel/blob` do `package.json`).
5. Mandar ao motorista o link da tela dele com a chave dele. Guardar o link de
   gestão só para quem acompanha a frota.

Para trocar uma chave (link vazou): mudar a variável na Vercel e fazer novo deploy.
O link antigo para de funcionar na hora.

## Como funciona

- `lib/limpeza-agenda.js` calcula as próximas datas a partir da última limpeza
  registrada (ou da data inicial). Mensal: sempre completa. Quinzenal: a cada 14
  dias, alternando completa e simples. Toda data prevista é levada para a
  **sexta-feira mais próxima** (sáb, dom e seg vão para a sexta anterior; ter a
  qui para a seguinte). Feriado em sexta não é tratado (ex.: 25/12/2026).
- `api/limpeza.js`: GET (estado), POST (registrar, exige 3+ fotos), POST
  `?acao=fotos&id=N` (acrescentar fotos), PUT `?acao=config`, DELETE `?id=N`.
  O motorista só recebe as 5 últimas limpezas e **sem custo**; configurar e
  excluir são só da gestão.
- `api/limpeza-foto.js`: recebe uma foto por vez e grava no Vercel Blob (pasta
  `limpeza-veiculo/`, nome com sufixo aleatório). O navegador reduz a foto antes
  (lado maior 1600 px, JPEG), por causa do limite de 4,5 MB do corpo da requisição.
- Tabelas: `limpeza_config` (uma linha) e `limpezas` (fotos como lista JSON de URLs).
- Páginas estáticas: `limpeza.html`, `limpeza-motorista.html`, mais
  `limpeza.css` e `limpeza-comum.js`. As URLs sem `.html` vêm de `rewrites` no
  `vercel.json`.

## Limites conhecidos

- As fotos ficam em endereços públicos do Blob, mas com sufixo aleatório (não dá
  para adivinhar). Quem tiver o endereço exato abre a foto.
- Se o envio das fotos funcionar e o registro falhar, as fotos ficam no Blob sem
  registro (arquivos órfãos). O custo é desprezível.
- Não há aviso por e-mail de limpeza atrasada: o plano Hobby só permite 2 crons e
  os dois já estão em uso. Dá para encaixar na rotina diária de `api/caixa-auto-executar.js`.
