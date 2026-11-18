# Guia Rápido & Controle de Estoque — HP Color (Shopee TI)

Portal web estático com API serverless na **Cloudflare Pages Functions** (`/api`) integrada diretamente à **Google Sheets API v4** via **Service Account**, com painel administrativo protegido por **Google OAuth**.

---

## Visão geral

O projeto resolve dois fluxos do dia a dia da operação e do time de TI:

1. **Autoatendimento operacional:** guias passo a passo para primeira conexão Wi-Fi/driver, troca de toners, digitalização em lote e registro simplificado de consumo/reposição de toners.
2. **Controle de inventário em duas camadas:**
   - **Armário da Impressora (Operação):** visível para todos os usuários; controla os toners instalados/disponíveis junto à impressora e solicita retirada ao TI quando o saldo ficar menor que o estoque reservado na sala de TI.
   - **Armário de TI & Sala de TI (Restrito Admin):** visível e editável apenas no painel administrativo autenticado (`ArmarioTI` para toners cheios em reserva e `VaziosSalaTI` para descarte/coleta).

---

## Páginas e funcionalidades

| Página | Público | Descrição |
| :--- | :--- | :--- |
| [`index.html`](index.html) | Administrativo | Tela inicial com atalhos para os guias, indicador de status na barra superior e resumo **Estoque rápido — Armário da Impressora**. |
| [`conexao.html`](conexao.html) | Administrativo | Guia de primeira conexão à rede corporativa, link de instalação de driver (Windows/macOS) e manual em PDF renderizado inline (desktop via `<embed>`, mobile via `PDF.js` em `<canvas>`). |
| [`toner.html`](toner.html) | Administrativo | Instruções de substituição segura dos cartuchos de toner HP `W2150XC` (Preto), `W2151XC` (Ciano), `W2152XC` (Amarelo) e `W2153XC` (Magenta). |
| [`digitalizacao.html`](digitalizacao.html) | Administrativo | Guia rápido de digitalização em lote no equipamento. |
| [`estoque.html`](estoque.html) | Administrativo | Editor visual (`−` / `+`) para registrar movimentações de toners cheios por responsável, turno (`T1`, `T2`, `T3`) e observação; salva rascunho local contra fechamento acidental, exibe banner automático quando o armário da impressora está abaixo do armário de TI e registra movimentações manuais/vazios. |
| [`login.html`](login.html) | Admin TI | Autenticação via **Google Identity Services** restrita à whitelist de administradores. |
| [`admin.html`](admin.html) | Admin TI | Painel administrativo com expiração por inatividade (5 min), separação entre **Armário de TI · Restrito Admin** (cheios no armário de TI e vazios na sala de TI) e **Armário da Impressora · Operação**, KPIs consolidados e fila de validação (`Validar`, `Divergente`, ações em lote e estorno automático). |

---

## Arquitetura da API (`/api`) e segurança

Por rodar na mesma origem (`https://guiadeimpressoras.pages.dev/api`) via **Cloudflare Pages Functions**, o portal não sofre bloqueios de CORS nem cold starts do Google Apps Script:

- **Separação de saldos:** `GET /api?action=getEstoque` retorna apenas os números do **Armário da Impressora** e a flag booleana `solicitarTI` calculada no servidor (`armarioImpressora < armarioTI`), sem expor as quantidades internas do **Armário de TI**.
- **Aviso automático à operação:** Quando `solicitarTI` está ativo para uma cor, as tabelas públicas e o banner de [`estoque.html`](estoque.html) exibem:
  > `Peça para que o TI retire o toner {cor} da sala`
- **Validação criptográfica local de OAuth (`RS256`):** Operações administrativas (`validar`, `validarLote`, `remover`, `zerarEstoque`, `getVaziosTI`, `setVaziosTI`, `getArmarioTI`, `setArmarioTI`, `diagnostico`) validam localmente no Worker a assinatura do `id_token` usando as chaves públicas JWKS do Google, `aud`, `email_verified`, `exp` e a lista de administradores (`ADMIN_EMAILS`).
- **Auto-inicialização da planilha:** Caso alguma das abas (`webinventario`, `Movimentações`, `ArmarioTI`, `VaziosSalaTI`) ou colunas obrigatórias ainda não exista, a API detecta automaticamente a aba de log existente ou cria a estrutura na primeira requisição.
- **Prevenção de inconsistências:**
  - `Divergente` estorna automaticamente a quantidade aplicada no estoque e `Remover` limpa o registro sem estornar em duplicidade.
  - Sanitização HTML no cliente (`escapeHtml`) e gravação em modo `RAW` + proteção contra *formula injection* na planilha.
  - Notificações opcionais via **Bot interativo SeaTalk** e/ou **Webhook (SeaTalk, Slack, Google Chat, Discord)** executadas em segundo plano (`waitUntil`).

---

## Estrutura do repositório

```text
.
├── _routes.json                        # Roteia apenas /api e /api/* para Functions
├── functions/
│   ├── api.js                          # Endpoint /api (roteamento HTTP e tratamento de erros)
│   └── _lib/
│       ├── config.js                   # Leitura de variáveis de ambiente e constantes
│       ├── google-auth.js              # Token OAuth da Service Account + validação JWT (JWKS)
│       ├── sheets-client.js            # Cliente fino da Google Sheets API v4 (batchGet/batchUpdate)
│       ├── inventory-service.js        # Regras de estoque, logs, validações e estornos
│       └── notifications.js            # Alertas opcionais (SeaTalk Bot e/ou Webhook)
├── tests/
│   └── api.test.mjs                    # Testes automatizados (node --test)
├── assets/                             # Ícone e manual PDF da impressora HP 4303FDW
├── index.html                          # Início e visão rápida do estoque da impressora
├── conexao.html                        # Manual PDF e passo a passo de conexão/driver
├── toner.html                          # Guia de troca de toners
├── digitalizacao.html                  # Guia de digitalização em lote
├── estoque.html                        # Controle visual de toners + histórico
├── login.html                          # Autenticação Google OAuth para administradores
├── admin.html                          # Painel administrativo (Armário TI + Validações)
├── app.js                              # Configurações públicas, cliente API, helpers e badge
├── auth.js                             # Gestão de sessão OAuth e timeout por inatividade
├── style.css                           # Design system responsivo (desktop e mobile)
├── .dev.vars.example                   # Modelo de variáveis para rodar localmente
└── package.json                        # Scripts `npm test` e `npm run dev` (sem dependências)
```

---

## Guia de configuração e manutenção

### 1. Google Cloud & Planilha (feito uma única vez)

1. No **Google Cloud Console**, crie ou selecione um projeto e ative a **Google Sheets API**.
2. Vá em **IAM e administrador → Contas de serviço → Criar conta de serviço** (ex.: `guiadeimpressoras-sheets`).
3. Abra a conta criada, vá em **Chaves → Adicionar chave → Criar nova chave → JSON** e baixe o arquivo `.json`.
4. Abra a planilha no Google Sheets e clique em **Compartilhar**, adicionando o `client_email` da Service Account (algo como `...@...iam.gserviceaccount.com`) com permissão de **Editor**.
   > **Dica (Google Workspace):** Se a política da organização impedir compartilhar planilhas corporativas com contas externas de Service Account, crie a Service Account dentro de um projeto da própria organização ou mantenha a planilha no Drive da conta sem restrição e compartilhe o link de edição com os admins `@shopee.com`.
5. Copie o **ID da planilha** na URL do navegador (`https://docs.google.com/spreadsheets/d/ESTE_TRECHO_AQUI/edit`).

### 2. Variáveis de ambiente no Cloudflare Pages

No painel do projeto no Cloudflare Pages (**Settings → Environment variables**, configure em **Production** e **Preview**):

| Variável | Obrigatória | Descrição |
| :--- | :--- | :--- |
| `GOOGLE_SHEET_ID` | Sim | ID da planilha do Google Sheets. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Sim* | Conteúdo completo do arquivo JSON da Service Account (como *Secret*). |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Alternativa* | E-mail da Service Account (use caso prefira separar do JSON). |
| `GOOGLE_PRIVATE_KEY` | Alternativa* | Chave privada PKCS#8 (`-----BEGIN PRIVATE KEY-----...`, como *Secret*). |
| `GOOGLE_CLIENT_ID` | Não | Sobrescreve o Client ID OAuth padrão definido no projeto. |
| `ADMIN_EMAILS` | Não | Lista separada por vírgula dos e-mails autorizados no backend (validada exclusivamente no servidor). |
| `SHEET_TAB_ESTOQUE` | Não | Nome da aba do Armário da Impressora (padrão: `webinventario`). |
| `SHEET_TAB_LOG` | Não | Nome da aba de movimentações (padrão: detecta `Movimentações`, `Registros`, `log`, etc.). |
| `SHEET_TAB_ARMARIO_TI` | Não | Nome da aba do Armário de TI (padrão: `ArmarioTI`). |
| `SHEET_TAB_VAZIOS_TI` | Não | Nome da aba de vazios na sala de TI (padrão: `VaziosSalaTI`). |
| `ALERT_WEBHOOK_URL` | Não | URL de webhook de grupo (detecta automaticamente **SeaTalk**, Discord, Slack ou Google Chat). |
| `SEATALK_APP_ID` | Não | App ID do bot criado no portal `open.seatalk.io` (habilita cards interativos com botões). |
| `SEATALK_APP_SECRET` | Não | App Secret do bot no `open.seatalk.io` (*Secret*). |
| `SEATALK_SIGNING_SECRET` | Não | Signing Secret do Event Callback (`https://guiadeimpressoras.pages.dev/api/seatalk`, *Secret*). |
| `SEATALK_GROUP_ID` | Não | ID(s) do(s) grupo(s) do SeaTalk separados por vírgula (`id1,id2`) onde o bot atua. |
| `CRON_SECRET` | Não | Segredo compartilhado com o GitHub Actions para disparar o resumo semanal no SeaTalk. |
| `APP_URL` | Não | URL pública do portal usada nos links de notificação (padrão: `https://guiadeimpressoras.pages.dev`). |

\* Use **apenas** `GOOGLE_SERVICE_ACCOUNT_JSON` **ou** o par `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY`.

### 3. Verificação semanal automática (Segundas, 9h BRT)

O workflow [`.github/workflows/resumo-semanal.yml`](.github/workflows/resumo-semanal.yml) executa toda **segunda-feira às 09:00 (12:00 UTC)** — e também pode ser disparado manualmente na aba **Actions** — enviando o card de saldo para o Bot no SeaTalk:

1. Gere um texto aleatório forte e cadastre como variável **`CRON_SECRET`** (*Secret*) no Cloudflare Pages (**Production**).
2. No GitHub (**Settings → Secrets and variables → Actions**), crie o *Repository secret* **`CRON_SECRET`** com o mesmo valor.

### 4. Como adicionar ou remover um administrador de TI

A lista de administradores fica **somente no backend** (nunca é exposta no frontend):

1. Configure ou atualize a variável `ADMIN_EMAILS` no Cloudflare Pages (**Settings → Variables and Secrets**, separando os e-mails por vírgula).
2. O padrão de fallback no servidor fica em `DEFAULT_ADMIN_EMAILS` dentro de [`functions/_lib/config.js`](functions/_lib/config.js).

### 5. Verificação rápida após publicar

- Acesse `https://guiadeimpressoras.pages.dev/api?action=health` — deve responder `{"ok":true,...}`.
- Acesse `https://guiadeimpressoras.pages.dev/api?action=getEstoque` — deve listar os 4 toners da planilha em milissegundos, sem erro de CORS.

---

## Desenvolvimento local e testes

### Rodar os testes automatizados (não precisa instalar pacotes)

```bash
npm test
```

### Simular o site + `/api` localmente

1. Copie `.dev.vars.example` para `.dev.vars` e preencha `GOOGLE_SHEET_ID` e `GOOGLE_SERVICE_ACCOUNT_JSON`:
   ```bash
   cp .dev.vars.example .dev.vars
   ```
2. Inicie o servidor local do Cloudflare Pages (inclui static + Functions):
   ```bash
   npm run dev
   ```
3. Acesse `http://localhost:8788` (lembrando de manter `http://localhost:8788` nas origens autorizadas do Google Cloud OAuth caso queira testar o login admin localmente).
