# Guia Rápido & Controle de Estoque — HP Color (Shopee TI)

Portal web estático para autoatendimento operacional da impressora **HP Color LaserJet MFP (4303FDW)** e controle de estoque de toners integrado ao **Google Sheets** via **Google Apps Script**, com painel administrativo protegido por **Google OAuth**.

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

## Regras de estoque e segurança

- **Separação de saldos:** O endpoint público `getEstoque` retorna apenas os números do **Armário da Impressora** e uma flag booleana `solicitarTI` calculada no servidor (`armarioImpressora < armarioTI`), sem expor as quantidades internas do **Armário de TI**.
- **Aviso automático à operação:** Quando `solicitarTI` está ativo para uma cor, as tabelas públicas e o banner de [`estoque.html`](estoque.html) exibem:
  > `Peça para que o TI retire o toner {cor} da sala`
- **Validação administrativa no backend:** Operações sensíveis (`validar`, `validarLote`, `remover`, `zerarEstoque`, `getVaziosTI`, `setVaziosTI`, `getArmarioTI`, `setArmarioTI`) validam o `id_token` do Google no Apps Script (`tokeninfo`, `aud`, `email_verified`, `exp` e lista de administradores).
- **Prevenção de inconsistências:**
  - `Divergente` estorna automaticamente a quantidade aplicada no estoque e `Remover` limpa o registro sem estornar em duplicidade.
  - Notificações por e-mail via `MailApp` são disparadas aos administradores sempre que novas movimentações são registradas.
  - Sanitização HTML no cliente (`escapeHtml`) e proteção contra *formula injection* na gravação da planilha.

---

## Estrutura do repositório

```text
.
├── assets/                   # Ícone e manual PDF da impressora HP 4303FDW
├── index.html                # Início e visão rápida do estoque da impressora
├── conexao.html              # Manual PDF e passo a passo de conexão/driver
├── toner.html                # Guia de troca de toners
├── digitalizacao.html        # Guia de digitalização em lote
├── estoque.html              # Controle visual de toners + histórico
├── login.html                # Autenticação Google OAuth para administradores
├── admin.html                # Painel administrativo (Armário TI + Validações)
├── app.js                    # Configurações públicas, cliente API, helpers e badge de status
├── auth.js                   # Gestão de sessão OAuth e timeout por inatividade
├── style.css                 # Design system responsivo (desktop e mobile)
└── .gitignore                # Mantém apps-script/ fora do controle de versão público
```

> **Nota:** A pasta `apps-script/` é ignorada pelo Git (`.gitignore`) para manter lógica e configurações de planilha isoladas no projeto do Google Apps Script.

---

## Configuração e deploy

### 1. Frontend (estático)

O frontend não depende de etapa de build (`HTML`, `CSS` e `JavaScript` puros) e pode ser publicado em qualquer hospedagem estática (como **Cloudflare Workers**, Cloudflare Pages, GitHub Pages ou Netlify).

Antes de publicar em outro ambiente, revise as constantes em [`app.js`](app.js):

- `CONFIG.APPS_SCRIPT_URL` — URL do Web App publicado no Google Apps Script (`/exec`).
- `CONFIG.GOOGLE_CLIENT_ID` — Client ID OAuth 2.0 configurado no Google Cloud Console (com as origens autorizadas do domínio de produção e `localhost` para testes).
- `CONFIG.ADMIN_WHITELIST` — E-mails autorizados no fluxo de login.
- `CONFIG.ADMIN_TIMEOUT_MINUTES` — Tempo limite de inatividade da sessão administrativa (padrão: `5` minutos).

### 2. Backend (Google Apps Script + Google Sheets)

1. Vincule o script à planilha com as abas de inventário (`webinventario`), movimentações (`Registros`), `VaziosSalaTI` e `ArmarioTI`.
2. Configure nas **Propriedades do Script** (`PropertiesService`) caso deseje sobrescrever os padrões de `SHEET_ID`, `GOOGLE_CLIENT_ID`, `ADMIN_EMAILS` ou `APP_ADMIN_URL`.
3. Publique em **Implantar → Gerenciar implantações → Nova versão** como **App da Web** acessível para `Qualquer pessoa`.

---

## Desenvolvimento local

Como as páginas consomem módulos via `fetch` e o login OAuth exige origem HTTP(S), sirva a raiz com um servidor estático simples:

```bash
npx serve .
```

Em seguida, acesse `http://localhost:3000` (certificando-se de que a origem esteja autorizada no Google Cloud Console para testar o login administrativo).
