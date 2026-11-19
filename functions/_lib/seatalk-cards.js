import { TONERS, TONER_MAP } from "./config.js";

const TIPO_LABEL = {
  entrada_cheio: "Entrada — cheio",
  saida_cheio: "Saída — instalado",
  entrada_vazio: "Entrada — vazio",
  saida_vazio: "Saída — descarte"
};

function truncate(str, maxLen) {
  const s = String(str ?? "").trim();
  if (s.length <= maxLen) return s;
  return maxLen > 1 ? `${s.slice(0, maxLen - 1)}…` : s.slice(0, maxLen);
}

function escapeMd(str) {
  return String(str ?? "").replace(/([*_`~])/g, "\\$1");
}

function webRedirectButton(text, url) {
  return {
    button_type: "redirect",
    text: truncate(text, 50),
    mobile_link: { type: "web", path: url },
    desktop_link: { type: "web", path: url }
  };
}

function callbackButton(text, value) {
  return {
    button_type: "callback",
    text: truncate(text, 50),
    value: truncate(value, 200)
  };
}

export function formatEstoqueResumo(estoque = []) {
  const byRef = Object.fromEntries(estoque.map(r => [r.ref, r]));
  return TONERS.map(t => {
    const row = byRef[t.ref] || { cheios: 0, vazios: 0 };
    return `${t.nome}: **${Number(row.cheios) || 0}**`;
  }).join(" | ");
}

export function formatArmarioTIResumo(armarioTI = []) {
  const byRef = Object.fromEntries(armarioTI.map(r => [r.ref, r]));
  return TONERS.map(t => {
    const row = byRef[t.ref] || { cheios: 0 };
    return `${t.nome}: **${Number(row.cheios) || 0}**`;
  }).join(" | ");
}

export function formatSolicitarTILine(estoque = []) {
  const faltando = estoque
    .filter(r => r && r.solicitarTI)
    .map(r => (TONER_MAP[r.ref]?.nome || r.ref).toLowerCase());
  if (!faltando.length) return "";
  return `⚠️ **Retirar da sala de TI:** ${faltando.join(", ")}`;
}

function formatShortDate(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso || "");
    return d.toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return String(iso || "");
  }
}

export function buildBatchCallbackValue(prefix, ids, fallbackData = "", fallbackResp = "") {
  const joined = Array.isArray(ids) ? ids.filter(Boolean).join(",") : "";
  const direct = `${prefix}:${joined}`;
  if (joined && direct.length <= 200) {
    return direct;
  }
  const sessionKey = `${prefix}S:${fallbackData}|${String(fallbackResp || "").slice(0, 120)}`;
  return truncate(sessionKey, 200);
}

export function buildMovementAlertCard({
  movimentos = [],
  ids = [],
  resp = "",
  turno = "T1",
  obs = "",
  data = "",
  estoque = [],
  appUrl = "https://guiadeimpressoras.pages.dev"
}) {
  const title = truncate(`🖨️ Movimentação (${turno}) · ${resp}`, 120);
  const linhasMov = movimentos.map(m => {
    const nome = TONER_MAP[m.modelo]?.nome || m.modelo;
    const tipo = TIPO_LABEL[m.tipo] || m.tipo;
    return `• **${escapeMd(nome)}** (${m.modelo}) · ${escapeMd(tipo)} · Qtd: **${m.qtd}**`;
  });

  const descParts = [
    `**Data:** ${escapeMd(formatShortDate(data))} · **Responsável:** ${escapeMd(resp)}`,
    ...linhasMov
  ];
  if (obs) descParts.push(`**Obs:** ${escapeMd(obs)}`);
  if (estoque.length) {
    descParts.push("", `**Armário Impressora:** ${formatEstoqueResumo(estoque)}`);
    const alertTI = formatSolicitarTILine(estoque);
    if (alertTI) descParts.push(alertTI);
  }

  const valValue = buildBatchCallbackValue("val", ids, data, resp);
  const divValue = buildBatchCallbackValue("div", ids, data, resp);

  return {
    tag: "interactive_message",
    interactive_message: {
      elements: [
        {
          element_type: "title",
          title: { text: title }
        },
        {
          element_type: "description",
          description: {
            format: 1,
            text: truncate(descParts.join("\n"), 1000)
          }
        },
        {
          element_type: "button_group",
          button_group: [
            callbackButton("✅ Permitir", valValue),
            callbackButton("❌ Recusar", divValue),
            callbackButton("📦 Gerenciar Toners", "menu:toners")
          ]
        },
        {
          element_type: "button",
          button: webRedirectButton("🌐 Abrir Painel Admin", `${appUrl}/admin.html`)
        }
      ]
    }
  };
}

export function buildTonerMenuCard({
  estoque = [],
  armarioTI = [],
  pendentesCount = 0,
  appUrl = "https://guiadeimpressoras.pages.dev",
  title = "📦 Controle Rápido de Toners · Shopee TI",
  extraLines = [],
  actionPrompt = "Clique abaixo para **adicionar +1 toner cheio** no Armário da Impressora:"
}) {
  const descParts = [
    `**Armário Impressora:** ${formatEstoqueResumo(estoque)}`,
    `**Armário TI (reserva):** ${formatArmarioTIResumo(armarioTI)}`,
    `**Pendentes de validação:** ${pendentesCount}`,
    ...extraLines
  ];

  const alertTI = formatSolicitarTILine(estoque);
  if (alertTI) descParts.push(alertTI);
  descParts.push("", actionPrompt);

  return {
    tag: "interactive_message",
    interactive_message: {
      elements: [
        {
          element_type: "title",
          title: { text: truncate(title, 120) }
        },
        {
          element_type: "description",
          description: {
            format: 1,
            text: truncate(descParts.join("\n"), 1000)
          }
        },
        {
          element_type: "button_group",
          button_group: [
            callbackButton("➕1 Preto", "add_imp:W2150XC"),
            callbackButton("➕1 Ciano", "add_imp:W2151XC"),
            callbackButton("➕1 Amarelo", "add_imp:W2152XC")
          ]
        },
        {
          element_type: "button_group",
          button_group: [
            callbackButton("➕1 Magenta", "add_imp:W2153XC"),
            callbackButton("🏢 Armário de TI", "menu:ti"),
            callbackButton(`📋 Pendentes (${pendentesCount})`, "menu:pendentes")
          ]
        },
        {
          element_type: "button_group",
          button_group: [
            callbackButton("🔄 Atualizar", "menu:toners"),
            webRedirectButton("🌐 Painel Admin", `${appUrl}/admin.html`),
            webRedirectButton("📦 Estoque Web", `${appUrl}/estoque.html`)
          ]
        }
      ]
    }
  };
}

export function buildUserTonerCard({
  estoque = [],
  mode = "add",
  appUrl = "https://guiadeimpressoras.pages.dev"
}) {
  const isAdd = mode !== "sub";
  const prefix = isAdd ? "usr_add" : "usr_sub";
  const sign = isAdd ? "➕1" : "➖1";

  const descParts = [
    `**Armário Impressora:** ${formatEstoqueResumo(estoque)}`
  ];
  const alertTI = formatSolicitarTILine(estoque);
  if (alertTI) descParts.push(alertTI);
  descParts.push(
    "",
    isAdd
      ? "Clique abaixo para **adicionar +1 toner cheio** (envia para validação do TI):"
      : "Clique abaixo para **retirar −1 toner cheio** (envia para validação do TI):"
  );

  return {
    tag: "interactive_message",
    interactive_message: {
      elements: [
        {
          element_type: "title",
          title: { text: "📦 Armário da Impressora · Controle de Toners" }
        },
        {
          element_type: "description",
          description: {
            format: 1,
            text: truncate(descParts.join("\n"), 1000)
          }
        },
        {
          element_type: "button_group",
          button_group: [
            callbackButton(`${sign} Preto`, `${prefix}:W2150XC`),
            callbackButton(`${sign} Ciano`, `${prefix}:W2151XC`),
            callbackButton(`${sign} Amarelo`, `${prefix}:W2152XC`)
          ]
        },
        {
          element_type: "button_group",
          button_group: [
            callbackButton(`${sign} Magenta`, `${prefix}:W2153XC`),
            callbackButton(
              isAdd ? "➖ Retirar (−1)" : "➕ Adicionar (+1)",
              isAdd ? "menu:user_sub" : "menu:user_add"
            ),
            callbackButton("🔄 Atualizar", isAdd ? "menu:user_add" : "menu:user_sub")
          ]
        },
        {
          element_type: "button",
          button: webRedirectButton("📦 Estoque Web", `${appUrl}/estoque.html`)
        }
      ]
    }
  };
}

export function buildWeeklyStockCard({
  estoque = [],
  armarioTI = [],
  pendentesCount = 0,
  appUrl = "https://guiadeimpressoras.pages.dev"
}) {
  const zerados = estoque
    .filter(r => (Number(r?.cheios) || 0) === 0)
    .map(r => (TONER_MAP[r.ref]?.nome || r.ref).toLowerCase());
  const baixos = estoque
    .filter(r => (Number(r?.cheios) || 0) === 1)
    .map(r => (TONER_MAP[r.ref]?.nome || r.ref).toLowerCase());

  const extraLines = [];
  if (zerados.length) extraLines.push(`🚨 **Sem estoque na impressora:** ${zerados.join(", ")}`);
  if (baixos.length) extraLines.push(`⚡ **Estoque baixo (1 un.):** ${baixos.join(", ")}`);
  if (!zerados.length && !baixos.length && !estoque.some(r => r?.solicitarTI)) {
    extraLines.push("✅ **Armário da impressora abastecido.**");
  }

  return buildTonerMenuCard({
    estoque,
    armarioTI,
    pendentesCount,
    appUrl,
    title: "🗓️ Verificação Semanal · Estoque HP Color",
    extraLines,
    actionPrompt: "Confira o armário físico da impressora e use os botões abaixo se precisar repor ou validar:"
  });
}

export function buildArmarioTIMenuCard({
  armarioTI = [],
  estoque = [],
  mode = "add"
}) {
  const isAdd = mode === "add";
  const prefix = isAdd ? "add_ti" : "sub_ti";
  const signLabel = isAdd ? "➕1" : "➖1";

  const descParts = [
    `**Armário TI (reserva):** ${formatArmarioTIResumo(armarioTI)}`,
    `**Armário Impressora:** ${formatEstoqueResumo(estoque)}`
  ];
  const alertTI = formatSolicitarTILine(estoque);
  if (alertTI) descParts.push(alertTI);
  descParts.push(
    "",
    isAdd
      ? "Selecione uma cor para **adicionar +1** ao Armário de TI:"
      : "Selecione uma cor para **retirar −1** do Armário de TI:"
  );

  return {
    tag: "interactive_message",
    interactive_message: {
      elements: [
        {
          element_type: "title",
          title: {
            text: isAdd
              ? "🏢 Armário de TI · Adicionar (+1)"
              : "🏢 Armário de TI · Retirar (−1)"
          }
        },
        {
          element_type: "description",
          description: {
            format: 1,
            text: truncate(descParts.join("\n"), 1000)
          }
        },
        {
          element_type: "button_group",
          button_group: [
            callbackButton(`${signLabel} Preto (TI)`, `${prefix}:W2150XC`),
            callbackButton(`${signLabel} Ciano (TI)`, `${prefix}:W2151XC`),
            callbackButton(`${signLabel} Amarelo (TI)`, `${prefix}:W2152XC`)
          ]
        },
        {
          element_type: "button_group",
          button_group: [
            callbackButton(`${signLabel} Magenta (TI)`, `${prefix}:W2153XC`),
            callbackButton(isAdd ? "➖ Modo Retirar" : "➕ Modo Adicionar", isAdd ? "menu:ti_sub" : "menu:ti"),
            callbackButton("⬅️ Voltar", "menu:toners")
          ]
        }
      ]
    }
  };
}

export function buildPendingItemCard({
  entry,
  appUrl = "https://guiadeimpressoras.pages.dev"
}) {
  const nome = TONER_MAP[entry.modelo]?.nome || entry.modelo;
  const tipo = TIPO_LABEL[entry.tipo] || entry.tipo;
  const descParts = [
    `**Data:** ${escapeMd(formatShortDate(entry.data))} · **Turno:** ${escapeMd(entry.turno || "—")}`,
    `**Responsável:** ${escapeMd(entry.resp || "—")}`,
    `**Movimentação:** ${escapeMd(tipo)} · Qtd: **${entry.qtd}**`
  ];
  if (entry.obs) descParts.push(`**Obs:** ${escapeMd(entry.obs)}`);

  return {
    tag: "interactive_message",
    interactive_message: {
      elements: [
        {
          element_type: "title",
          title: { text: truncate(`⏳ Pendente · ${nome} (${entry.modelo})`, 120) }
        },
        {
          element_type: "description",
          description: {
            format: 1,
            text: truncate(descParts.join("\n"), 1000)
          }
        },
        {
          element_type: "button_group",
          button_group: [
            callbackButton("✅ Permitir", `val:${entry.id}`),
            callbackButton("❌ Recusar", `div:${entry.id}`),
            webRedirectButton("🌐 Painel", `${appUrl}/admin.html`)
          ]
        }
      ]
    }
  };
}

export function buildActionResultCard({
  title,
  summary,
  estoque = [],
  armarioTI = null,
  appUrl = "https://guiadeimpressoras.pages.dev"
}) {
  const descParts = [summary];
  if (estoque.length) {
    descParts.push("", `**Armário Impressora:** ${formatEstoqueResumo(estoque)}`);
  }
  if (Array.isArray(armarioTI) && armarioTI.length) {
    descParts.push(`**Armário TI:** ${formatArmarioTIResumo(armarioTI)}`);
  }
  const alertTI = formatSolicitarTILine(estoque);
  if (alertTI) descParts.push(alertTI);

  return {
    tag: "interactive_message",
    interactive_message: {
      elements: [
        {
          element_type: "title",
          title: { text: truncate(title, 120) }
        },
        {
          element_type: "description",
          description: {
            format: 1,
            text: truncate(descParts.join("\n"), 1000)
          }
        },
        {
          element_type: "button_group",
          button_group: [
            callbackButton("📦 Menu Toners", "menu:toners"),
            callbackButton("🏢 Armário TI", "menu:ti"),
            webRedirectButton("🌐 Painel Admin", `${appUrl}/admin.html`)
          ]
        }
      ]
    }
  };
}
