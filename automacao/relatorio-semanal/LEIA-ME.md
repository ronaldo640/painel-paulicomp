# Relatório semanal por e-mail

Toda **sexta às 18h (Brasília)** o GitHub roda `relatorio-semanal.mjs`, que:

1. **Atualiza os dados com o Tiny**, um sistema de cada vez (todos usam o mesmo token do Tiny):
   notas da Expedição (últimos 14 dias, as 3 filiais), baixa automática das caixas da SP (hoje e 2 dias anteriores)
   e pedidos da Separação (hoje e ontem, uma chamada por dia, com pausa entre elas por causa do limite da API do Tiny).
2. **Gera os PDFs** abrindo os painéis publicados num navegador sem tela, escolhendo "últimos 7 dias" e clicando nos
   mesmos botões "Relatório PDF" de sempre. Expedição e Separação saem **separadas por filial** (SP, SUL e Comp Trade, 6 PDFs) e Controle de Caixas e Insumos sai para SP e Comp Trade (2 PDFs): **8 PDFs no total**.
3. **Envia um e-mail só** com os PDFs anexados, pela conta Gmail da empresa.

Se uma atualização do Tiny falhar, os relatórios saem mesmo assim e o e-mail traz um bloco "Atenção" dizendo o que pode estar
desatualizado. Os PDFs só ficam guardados (1 dia, aba Actions > execução > Artifacts) se você marcar "guardar_pdfs" ao rodar à mão; como o repositório é público, nas execuções de sexta nada fica guardado. O log mostra os destinatários com o endereço parcialmente escondido (ru***@dominio).

## Configuração (uma vez só, no GitHub: Settings > Secrets and variables > Actions)

**Secrets** (aba "Secrets"):

| Nome | O que é |
|---|---|
| `GMAIL_USER` | o endereço Gmail/Workspace que envia |
| `GMAIL_APP_PASSWORD` | "senha de aplicativo" criada em `myaccount.google.com/apppasswords` (16 letras, sem espaços) |

**Variables** (aba "Variables"):

| Nome | O que é |
|---|---|
| `RELATORIO_DESTINOS` | e-mails que recebem toda sexta, separados por vírgula (direção, financeiro e qualidade) |
| `RELATORIO_COPIA` | e-mails em cópia (Cc), separados por vírgula (opcional; não vai nos envios de teste) |
| `RELATORIO_TESTE_DESTINO` | e-mail que recebe o envio de teste |

## Testar

Actions > "Relatório semanal por e-mail" > **Run workflow**. Com a caixa "teste" marcada (padrão), o e-mail vai
só para `RELATORIO_TESTE_DESTINO`, com `[TESTE]` no assunto. Desmarque a caixa para enviar a todos na hora.
A execução agendada de sexta sempre envia a todos.

## Observações

- O horário no GitHub é em UTC (`0 21 * * 5` = 18h de Brasília). O GitHub pode atrasar execuções agendadas alguns minutos.
- No Controle de Caixas, o ranking e a "Referência" do relatório seguem os últimos 7 dias; a tabela de modelos e os
  insumos continuam com a janela de 30 dias, que é a base do ponto de reposição.
- Para mudar quem recebe, edite `RELATORIO_DESTINOS`. Para trocar o dia ou a hora, edite o `cron` em
  `.github/workflows/relatorio-semanal.yml`.
- Se a senha de aplicativo for revogada ou trocada, atualize o secret `GMAIL_APP_PASSWORD`.
