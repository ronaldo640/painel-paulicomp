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
2. **Blob** (fotos): na Vercel, projeto → Storage → Create → Blob, com acesso
   **Público** (não dá para trocar depois) e conectado ao projeto nos três
   ambientes. A Vercel cria `BLOB_STORE_ID` sozinha e o `@vercel/blob` autentica
   por OIDC; `BLOB_READ_WRITE_TOKEN` não é necessária.
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
  O motorista só recebe as 5 últimas limpezas e **sem custo**; ele só cria
  registros novos. Depois de registrada, a limpeza só muda pela gestão:
  configurar, acrescentar fotos e excluir.
- Foto: `POST /api/limpeza?acao=foto` (mesmo arquivo), uma por vez, grava no
  Vercel Blob (pasta `limpeza-veiculo/`, nome com sufixo aleatório). O navegador
  reduz a foto antes (lado maior 1280 px, JPEG 75%): o corpo da requisição na
  Vercel é limitado a 4,5 MB, e foto menor sobe e abre mais rápido. O histórico da
  gestão mostra as 10 limpezas mais recentes e o botão "Mostrar mais" abre as outras.
  Cada foto sobe com uma **miniatura** de 240 px (~10 KB) ao lado (`<uuid>.jpg` e
  `<uuid>-m.jpg`, 2 gravações no Blob por foto); o histórico carrega só as
  miniaturas e a foto inteira abre ao clicar. Fotos antigas (sem miniatura) caem
  na foto inteira sozinhas. Ao excluir a limpeza, foto e miniatura são apagadas.
- **Limite de 12 funções do plano Hobby:** o projeto já usava as 12. Por isso a
  foto mora em `api/limpeza.js` e o teste de consumo (`caixa-auto-teste`) foi
  para `lib/caixa-auto-teste.js`, chamado por `caixa-auto-executar?modo=teste`
  (o endereço antigo `/api/caixa-auto-teste` segue valendo por rewrite). Nova
  função em `api/` só trocando por outra ou migrando para o plano Pro.
- Tabelas: `limpeza_config` (uma linha) e `limpezas` (fotos como lista JSON de URLs).
- Páginas estáticas: `limpeza.html`, `limpeza-motorista.html`, mais
  `limpeza.css` e `limpeza-comum.js`. As URLs sem `.html` vêm de `rewrites` no
  `vercel.json`.

## Limites conhecidos

- As fotos ficam em endereços públicos do Blob, mas com sufixo aleatório (não dá
  para adivinhar). Quem tiver o endereço exato abre a foto.
- Se o envio das fotos funcionar e o registro falhar, as fotos ficam no Blob sem
  registro (arquivos órfãos). O custo é desprezível.
## Avisos por e-mail: lembrete na véspera e limpeza atrasada

`lib/limpeza-alerta.js`, chamado no fim da rotina diária das 5h
(`api/caixa-auto-executar.js`, a mesma dos caixas; o Hobby só permite 2 crons).

**Lembrete:** um dia antes da data prevista da próxima limpeza (como as datas caem
na sexta, sai na quinta às 5h) chega o e-mail "Lembrete: amanhã é dia de lavar a
Fiorino (dd/mm/aaaa)", escrito já para o motorista ler. O assunto começa sempre
igual: é por ele que o filtro do e-mail reenvia aos motoristas. O Resend sem
domínio verificado só entrega ao dono da conta (ver abaixo), então o reenvio aos
motoristas é feito por filtro na caixa que recebe o aviso.

**Atraso:** quando a próxima limpeza da agenda passa da data, sai um e-mail no 1º dia de
atraso e se repete a cada 7 dias (atraso 1, 8, 15...) até alguém registrar a
limpeza. Não guarda estado nem precisa de migração. Usa o Resend, o remetente e
os destinos do aviso de caixas (`ALERTA_EMAIL_DESTINOS`, padrão ronaldo@paulicomp.com).

- Liga com `LIMPEZA_ALERTA_ATIVO=true`; sem essa variável vale
  `ALERTA_EMAIL_ATIVO` (a chave do aviso de caixas).
- Conferir sem enviar: `/api/caixa-auto-executar?alerta=limpeza-simular` mostra
  a data prevista, o atraso, se o aviso está ligado e o e-mail que sairia.
  Para ver o lembrete, acrescente `&hoje=AAAA-MM-DD` com o dia anterior à data prevista.
- Mandar o lembrete agora, de verdade, com "[TESTE]" no assunto (serve para
  conferir o e-mail e o filtro dos motoristas): `/api/caixa-auto-executar?alerta=limpeza-teste`.
