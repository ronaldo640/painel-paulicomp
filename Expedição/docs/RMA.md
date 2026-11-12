# Indicador de devoluções (RMA) — Qualidade, filial SP

Tela: **/rma** (`rma.html`). Mostra quais produtos estão sendo devolvidos e por
quê, com filtros por mês, canal e tipo de motivo, além da conferência com as
notas de entrada do Tiny SP.

## De onde vêm os dados

- **Planilha** "Retorno de materiais SP 2026.xlsx", no Google Drive. É só
  **lida**: o painel não grava nada nela, e a conta de serviço tem escopo
  somente leitura (`drive.readonly`).
- **Tiny SP**: as notas de entrada do período, pela API v2, usando o
  `TINY_TOKEN_SP` que já existe. Servem para conferir se cada NF de entrada da
  planilha existe no Tiny, para somar o valor e para mostrar notas de entrada de
  pessoa física que não estão na planilha.

Nome de cliente e número de série **não** saem da API: o painel abre por link.

## Ligar a planilha (uma vez só)

### 1. Criar a conta de serviço no Google Cloud

1. Acesse <https://console.cloud.google.com/> com a conta Google da empresa.
2. No topo, **Selecionar projeto → Novo projeto**. Nome: `painel-paulicomp`.
   Crie e selecione o projeto.
3. Menu **APIs e serviços → Biblioteca**, procure **Google Drive API** e clique
   em **Ativar**.
4. Menu **IAM e administrador → Contas de serviço → Criar conta de serviço**.
   Nome: `painel-rma`. Clique em **Criar e continuar**. Não precisa dar nenhum
   papel: clique em **Concluir**.
5. Abra a conta criada, aba **Chaves → Adicionar chave → Criar nova chave →
   JSON**. Um arquivo `.json` é baixado. **Guarde com cuidado**: ele é a senha
   da conta de serviço. Não mande por e-mail nem coloque no GitHub.
6. Anote o e-mail da conta. É parecido com
   `painel-rma@painel-paulicomp.iam.gserviceaccount.com`.

> Se aparecer "A criação de chaves de conta de serviço está desativada", a
> organização Google Workspace bloqueia isso por política
> (`iam.disableServiceAccountKeyCreation`). Um administrador do Workspace
> precisa liberar a criação para este projeto.

### 2. Compartilhar a planilha com a conta de serviço

No Drive, abra a planilha → **Compartilhar** → cole o e-mail da conta de serviço
→ escolha **Leitor** → desmarque "Notificar" → **Compartilhar**.

> A planilha está num drive compartilhado. Se o Google recusar o
> compartilhamento com "pessoas fora da organização", um administrador precisa
> permitir isso nas configurações do drive compartilhado, ou adicionar a conta
> de serviço como **Leitor** do drive inteiro.

### 3. Colocar a chave na Vercel

Na Vercel: **Project → Settings → Environment Variables → Add**:

- **Name:** `GOOGLE_SERVICE_ACCOUNT_JSON`
- **Value:** o conteúdo inteiro do arquivo `.json` (abra no Bloco de Notas,
  Ctrl+A, Ctrl+C, cole)
- Ambientes: Production (e Preview, se quiser testar antes)

Salve e faça um **Redeploy**. Depois disso, abra `/rma`.

### Planilha do ano seguinte

Quando começar a planilha de 2027, compartilhe a nova com a mesma conta de serviço
(Leitor) e crie na Vercel a variável `RMA_PLANILHA_ID` com o ID da nova
planilha. O ID é o trecho do link entre `/d/` e `/edit`. Não precisa mexer no
código.

## Como os motivos são agrupados

O texto da coluna "Motivo abertura de devolução" é livre (mais de 100 redações
diferentes). `lib/rma.js` encaixa cada texto em um grupo por palavras-chave,
testando as regras na ordem abaixo; a primeira que casa vence.

| Grupo | Categoria | Exemplos |
|---|---|---|
| Retorno do Fulfillment | Fora do indicador | "retorno do full", "retirada do full" |
| Cancelamento da venda | Decisão do cliente | "cancelado", "não pode esperar" |
| Falha na entrega | Logística | "não foi possível entregá-lo", "entrega recusada" |
| Avaria / dano físico | Problema no produto | "quebrado", "arranhado", "embalagem rasgada" |
| Incompatibilidade | Anúncio / compatibilidade | "incompatibilidade", "não serve", "não encaixa" |
| Produto divergente do anúncio | Anúncio / compatibilidade | "não é igual ao anúncio", "modelo diferente" |
| Defeito / não funciona | Problema no produto | "não funciona", "não liga", "teclas" |
| Arrependimento | Decisão do cliente | "se arrependeu", "não quer mais" |
| Problema não especificado | Sem detalhe | "há um inconveniente", "relatou um problema" |
| Não informado | Sem detalhe | campo vazio |
| Outros | Sem detalhe | texto que nenhuma regra reconheceu |

Se aparecer devolução em **Outros**, vale criar uma regra nova em `lib/rma.js`.
A coluna "MOTIVO" da planilha (Arrependimento/Defeito) continua aparecendo como
está. A tela avisa quando a coluna e o texto discordam.

O **mês** é o da aba da planilha (mês em que o RMA foi tratado). A "Data de
Entrada" é a data da nota e às vezes cai no mês anterior.

## Conferência com o Tiny

A planilha não traz a série da NF, e o mesmo número existe na série 1 e na série 2.
Por isso cada linha da planilha é ligada à nota do Tiny com a **data mais próxima**.
As notas de entrada do Tiny SP se dividem assim (confirmado em 12/11/2026 com
uma amostra de notas abertas uma a uma no Tiny):

- **Série 1** (pessoa física ou empresa): "Devolução de mercadorias", referenciando
  a NF de venda. São devoluções que passaram pela SP. As que não estão na planilha
  aparecem em **"Devoluções da SP fora da planilha"** para conferir.
- **Série 2**: devolução do **Full**. O produto volta direto para o depósito do
  Mercado Livre e não passa pela SP. Só informativo.
- **"Registrada"**: nota de terceiro (compra de fornecedor). Fica fora da conta.

A API do Tiny SP tem limite baixo de acessos. Abrir nota por nota (nota.fiscal.obter)
bloqueou a API em poucos segundos. Por isso o painel só usa a pesquisa de notas
(algumas páginas por consulta, com 1 h de cache), para não atrapalhar a
sincronização das Caixas.

## Relatório PDF

Botão **Relatório PDF** no topo da tela. Arquivo A4 paisagem
`Devolucoes_RMA_SP_AAAA-MM-DD.pdf`, gerado no navegador com html2pdf, usando os
filtros aplicados na tela:

1. Devoluções e motivos: números do topo, motivos e devoluções por mês
2. Produtos mais devolvidos: os 20 SKUs com mais devoluções
3. Problemas no produto: SKUs com defeito ou avaria, com o laudo da assistência
   técnica, além de responsável, destino, canal e conferência com o Tiny

Shift+clique no botão abre uma prévia na tela, sem baixar. Cada página tem
1123 × 794 px, o tamanho exato de uma folha A4 paisagem nessa largura. O
html2pdf roda sem quebras CSS, porque com elas ele gerava folhas em branco.

## Parte técnica

- `GET /api/rma` → rewrite para `/api/tiny-sync?modulo=rma`. O plano Hobby da
  Vercel limita o projeto a 12 funções, e todas já estão em uso. A resposta
  fica 15 min em cache na CDN; o botão **Atualizar** força uma nova leitura.
- `GET /api/rma?parte=tiny&ini=aaaa-mm-dd&fim=aaaa-mm-dd` → notas de entrada do
  Tiny SP (sem canceladas), 1 h de cache, até 30 páginas.
- `lib/xlsx-ler.js`: leitor de .xlsx sem dependências. A descompactação é
  passada de fora, para o mesmo código rodar na Vercel e no navegador.
- `lib/google-drive.js`: login da conta de serviço (JWT assinado com a chave)
  e download do arquivo.
- `lib/rma.js`: colunas achadas pelo **nome do cabeçalho**, porque mudam de um
  mês para outro; grupos e regras de motivo.
