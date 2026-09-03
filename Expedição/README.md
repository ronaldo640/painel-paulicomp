# Painel Paulicomp — Expedição & Logística

Dashboard executivo estático (HTML + Tailwind + Chart.js), com uma função
serverless para sincronizar notas fiscais direto do Tiny ERP (Olist).

## Deploy na Vercel

1. Suba este repositório para o GitHub/GitLab.
2. Na Vercel, clique em **Add New → Project** e importe o repositório.
3. Framework preset: **Other**. Não é necessário configurar build command
   nem output directory — a Vercel detecta `index.html.html` na raiz e a
   pasta `api/` automaticamente.
4. Configure a variável de ambiente `DATABASE_URL` (string de conexão do
   Neon) e os tokens do Tiny abaixo, em **Project → Settings →
   Environment Variables**.
5. Deploy. Pronto — o painel e a rota `/api/tiny-sync` sobem juntos.

## Integração com o Tiny ERP (Olist)

Os tokens ficam só na Vercel (nunca no navegador), então qualquer pessoa
que abrir o link do painel pode sincronizar sem precisar configurar nada:

1. Gere o token da API v2 de cada filial em Tiny → Preferências → API v2.
2. Na Vercel, em **Project → Settings → Environment Variables**, crie:
   - `TINY_TOKEN_SP` — token da PAULICOMP SP
   - `TINY_TOKEN_SUL` — token da PAULICOMP SUL
   - `TINY_TOKEN_TRADE` — token da COMP TRADE

   (pode configurar só as filiais que já tiverem token — as demais ficam
   de fora da sincronização até serem adicionadas).
3. Refaça o deploy (ou aguarde o próximo) para as variáveis entrarem em
   vigor.
4. No painel, o botão **Sincronizar Tiny/Olist** já funciona pra qualquer
   pessoa com o link. Ele também roda sozinho a cada 30 min enquanto
   alguém estiver com o painel aberto, e uma vez por dia via Vercel Cron
   (`vercel.json`) mesmo que ninguém esteja com a página aberta — o
   plano Hobby da Vercel limita cron jobs a 1x/dia; para sincronizar com
   mais frequência de forma totalmente automática (sem depender de
   alguém com o painel aberto) é necessário o plano Pro.

## Controle de acesso à importação de planilhas

O primeiro acesso ao botão **Importar Planilha** pede a criação de um
usuário administrador (usuário + senha, com hash SHA-256 salvo no
navegador). Depois disso, qualquer importação de `.xls`/`.xlsx` exige
login. Usuários adicionais podem ser cadastrados em **Banco de Dados →
Gerenciar Usuários**.

> Como o painel não tem backend de autenticação, essa proteção evita uso
> descuidado por quem tem acesso ao link do dashboard — não substitui um
> controle de acesso real caso o painel vá lidar com dados sensíveis.

## Arquivos

- `index.html.html` — aplicação completa (single-file).
- `api/dispatches.js` — lê/grava a base compartilhada no Neon.
- `api/tiny-sync.js` — busca as notas fiscais no Tiny (usando os tokens
  das variáveis de ambiente) e grava direto no Neon.
- `vercel.json` — agenda a Vercel Cron Job diária de `/api/tiny-sync`.
