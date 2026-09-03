# Histórico do Projeto — Painel Paulicomp

Resumo de tudo que foi feito nesta sessão, para dar contexto rápido a uma nova
conversa sem precisar reler tudo do zero.

## O que é o projeto

Dashboard executivo de expedição/logística da Paulicomp, com 3 filiais
(PAULICOMP SP, PAULICOMP SUL, COMP TRADE). Rodando em:

- **Site**: https://painel-paulicomp.vercel.app/
- **Repositório**: https://github.com/ronaldo640/painel-paulicomp (branch `main`)
- **Arquivo principal**: `index.html.html` (single-file: HTML + Tailwind CSS via
  CDN + Chart.js + SheetJS/xlsx + html2pdf.js, tudo num só arquivo)
- **Banco de dados**: Postgres no Neon, acessado via `api/dispatches.js`
  (GET lista tudo, POST insere em lote com `ON CONFLICT DO NOTHING`)

## Descoberta importante no início

O usuário tinha um arquivo local (`index.html.html` na área de trabalho) que
estava **desatualizado** — uma versão antiga sem integração com banco de
dados. A versão real em produção (puxada do GitHub) já usava Neon Postgres.
Todo o trabalho foi feito em cima da versão real do GitHub, não da cópia
local desatualizada. **Lição**: sempre conferir o repositório Git antes de
assumir que um arquivo local é a fonte da verdade.

## Funcionalidades implementadas (em ordem cronológica)

### 1. Relatório PDF em paisagem, sem sobreposição
- Trocado de A4 retrato (780×1100px) para paisagem (1100×780px).
- Layout dos 5 gráficos reconstruído com flexbox (`flex: 1` em vez de
  alturas fixas em pixel) — antes havia até um hack de `margin-top: 60px`
  para tentar evitar sobreposição manualmente. Agora se adapta sozinho.
- `jsPDF: { orientation: 'landscape' }`.

### 2. Importação de planilha protegida por login
- Sistema de login local (usuário + senha, hash SHA-256 com salt,
  guardado em `localStorage`). Primeiro acesso cria o administrador.
- Sessão de login em `sessionStorage` (dura enquanto a aba estiver aberta).
- Gerenciamento de usuários (adicionar/remover) dentro do modal "Banco
  de Dados".
- **Limitação conhecida**: é proteção client-side, não um backend de
  autenticação de verdade — desestimula uso indevido casual, não é
  segurança robusta.

### 3. Integração com a API do Tiny ERP (Olist) — evoluiu em 2 etapas
- **Primeira versão**: tokens digitados pelo usuário e salvos no
  `localStorage` do navegador. Funcionava, mas cada pessoa que abrisse o
  link precisaria configurar os tokens de novo no próprio navegador.
- **Versão final (atual)**: tokens migrados para variáveis de ambiente
  na Vercel (`TINY_TOKEN_SP`, `TINY_TOKEN_SUL`, `TINY_TOKEN_TRADE`).
  Ninguém que abre o link precisa ver ou configurar token nenhum — só
  clicar em **"Sincronizar Tiny/Olist"** no cabeçalho. Roda também:
  - Automaticamente ao carregar a página.
  - A cada 30 min enquanto alguém estiver com o painel aberto.
  - 1x por dia via Vercel Cron Job (`vercel.json`) mesmo sem ninguém
    com a página aberta (limite do plano Hobby: só 1x/dia; sincronizar
    com mais frequência sem depender do navegador aberto exigiria
    plano Pro).
- **Endpoint do Tiny usado**: API v2 (legada),
  `https://api.tiny.com.br/api2/notas.fiscais.pesquisa.php` — busca
  notas fiscais (não pedidos), porque o painel usa a granularidade
  "1 Nota Fiscal = 1 Embalagem". Notas "Canceladas" são descartadas.
- Arquivo: `api/tiny-sync.js` — roda no servidor (evita CORS), busca as
  notas paginando, mapeia os campos e grava direto no Neon.

### 4. Ajustes de limpeza visual
- Gráfico "Canais Logísticos": só mostra individualmente canais com
  mais de 10 envios; o resto vira uma barra única "Outros".
- Filtro "Mês": reorganizado em hierarquia Ano > Mês (`<optgroup>` por
  ano, com opção "Ano Completo" além dos meses individuais).
- Gráfico "Evolução dos Volumes": agrupa por **mês** (em vez de
  quinzena) sempre que a seleção cobre mais de um mês ("Todos os
  Meses" ou um ano inteiro). Um mês específico continua com visão
  diária.

### 5. Bug crítico encontrado e corrigido: gravação em lote no Neon
- Ao investigar por que 2025 inteiro estava com **zero registros** para
  PAULICOMP SP e COMP TRADE (não era limite de API, era um ano nunca
  sincronizado), a tentativa de preencher esse histórico travava
  (timeout) — a função gravava **uma nota fiscal por vez** no banco
  (1 query por linha), o que é inviável para milhares de registros.
- Corrigido para gravar em lotes de 300 registros por `INSERT ...
  VALUES (...),(...),(...) ON CONFLICT DO NOTHING` (uma tentativa
  anterior usando `UNNEST` com parâmetros de array silenciosamente
  não inseria nada — não usar esse padrão com o driver HTTP do Neon).
- Depois da correção, 2025 foi preenchido manualmente mês a mês via
  `curl` direto no endpoint `/api/tiny-sync?filial=SP&dataInicial=...&dataFinal=...`
  (o parâmetro `filial` restringe a sincronização a uma filial por vez).
  Resultado: SP foi de 0 para 13.083 registros em 2025, COMP TRADE de
  0 para 5.486.

## Arquivos do projeto

- `index.html.html` — aplicação completa (front-end).
- `api/dispatches.js` — GET/POST na tabela `dispatches` do Neon.
- `api/tiny-sync.js` — sincroniza com a API do Tiny e grava no Neon.
- `vercel.json` — `maxDuration: 60` na função de sync + Cron diário.
- `package.json` — dependência `@neondatabase/serverless`.
- `README.md` — instruções de deploy e configuração das variáveis de
  ambiente.

## Variáveis de ambiente necessárias na Vercel

- `DATABASE_URL` — string de conexão do Neon (já configurada antes
  desta sessão).
- `TINY_TOKEN_SP`, `TINY_TOKEN_SUL`, `TINY_TOKEN_TRADE` — tokens da
  API v2 do Tiny, um por filial (configurados nesta sessão).

## Pontos em aberto / possíveis próximos passos

- Cron job roda só 1x/dia no plano Hobby da Vercel — se quiser
  sincronização automática mais frequente sem depender de alguém com
  o painel aberto, precisa do plano Pro.
- O login de importação é proteção client-side (ver limitação acima).
- Vale checar de vez em quando se algum mês/ano ficou com buraco de
  dados (usar `?filial=X&dataInicial=...&dataFinal=...` no
  `/api/tiny-sync` para preencher manualmente, um mês por vez, se
  precisar — evita estourar o limite de páginas por chamada).
- O token da PAULICOMP SP parece ter um limite de requisições da Tiny
  mais sensível — bateu em "API Bloqueada" duas vezes durante os testes
  desta sessão quando chamado repetidamente em sequência rápida.
