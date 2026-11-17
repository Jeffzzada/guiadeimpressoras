/* ── CONFIG ── */
const CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbwt59m4Z8AdooCvRbWEQn8LINQ0y5-eqJQ_aVFu8tMN5UjzVE5hB7CRH0txeYiFcSxq/exec",
  GOOGLE_CLIENT_ID: "1028346342471-oq4rafb2rr864rl3dck10pc3te3ilvsb.apps.googleusercontent.com",
  ADMIN_TIMEOUT_MINUTES: 5,
  ADMIN_WHITELIST: [
    "jefferson.msantos@shopee.com", "tacio.correia@shopee.com"
  ]
};

const TONERS = [
  { ref: "W2150XC", nome: "Preto",   cor: "#1A1A1A" },
  { ref: "W2151XC", nome: "Ciano",   cor: "#0070C0" },
  { ref: "W2152XC", nome: "Amarelo", cor: "#B8860B" },
  { ref: "W2153XC", nome: "Magenta", cor: "#C0004A" }
];

const CORES_MAP = Object.fromEntries(TONERS.map(t => [t.ref, { nome: t.nome, cor: t.cor }]));

const TIPO_LABEL = {
  entrada_cheio: "Entrada — cheio",
  saida_cheio:   "Saída — instalado",
  entrada_vazio: "Entrada — vazio",
  saida_vazio:   "Saída — descarte"
};

/* ── HELPERS ── */
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizarTexto(str) {
  return String(str ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function normalizeRouteName(pathOrHref) {
  const seg = String(pathOrHref || "").split("?")[0].split("#")[0].split("/").pop() || "index";
  return seg.replace(/\.html$/i, "") || "index";
}

/* ── API CLIENT ── */
async function apiGet(action) {
  const res = await fetch(`${CONFIG.APPS_SCRIPT_URL}?action=${encodeURIComponent(action)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data && !Array.isArray(data) && (data.erro || data.error || data.ok === false)) {
    throw new Error(data.erro || data.error || "Erro ao consultar o servidor.");
  }
  return data;
}

async function apiPost(payload) {
  const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (data && (data.erro || data.error || data.ok === false)) {
    throw new Error(data.erro || data.error || "Erro ao processar solicitação.");
  }
  return data;
}

/* ── NAV ATIVA ── */
function setActiveNav() {
  const current = normalizeRouteName(location.pathname);
  document.querySelectorAll(".nav-tab").forEach(a => {
    const target = normalizeRouteName(a.getAttribute("href"));
    a.classList.toggle("active", target === current);
  });
}

/* ── DADOS DE TONER (compartilhado + deduplicado) ── */
let _tonerDataInFlight = null;

async function fetchTonerData(force = false) {
  if (force) sessionStorage.removeItem("tonerData");
  const cached = sessionStorage.getItem("tonerData");
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* ignora cache corrompido */ }
  }
  if (!_tonerDataInFlight) {
    _tonerDataInFlight = apiGet("getEstoque")
      .then(data => {
        if (!Array.isArray(data)) throw new Error("Resposta inválida de estoque.");
        sessionStorage.setItem("tonerData", JSON.stringify(data));
        return data;
      })
      .finally(() => { _tonerDataInFlight = null; });
  }
  return _tonerDataInFlight;
}

/* ── STATUS HELPER ── */
function formatarStatusToner(row, compact = false) {
  const cheios = Number(row?.cheios) || 0;
  const cor = ((CORES_MAP[row?.ref] && CORES_MAP[row.ref].nome) || row?.ref || "").toLowerCase();
  if (row?.solicitarTI) {
    const prefix = cheios === 0 ? "⚠ Sem estoque · " : "⚠ ";
    return `<span style="color:${cheios === 0 ? "#C0392B" : "#E67E22"};font-weight:600;font-size:12px;">${prefix}Peça para que o TI retire o toner ${escapeHtml(cor)} da sala</span>`;
  }
  if (cheios === 0) {
    return `<span style="color:#C0392B;font-weight:600;font-size:12px;">⚠ Sem estoque</span>`;
  }
  if (cheios <= 1) {
    return `<span style="color:#E67E22;font-weight:600;font-size:12px;">⚡ ${compact ? "Baixo" : "Estoque baixo"}</span>`;
  }
  return `<span style="color:var(--success);font-weight:600;font-size:12px;">✓ Normal</span>`;
}

/* ── TONER PILL (topnav) ── */
async function loadTonerPill() {
  const pill = document.getElementById("toner-pill");
  if (!pill) return;
  try {
    const data = await fetchTonerData();
    const semEstoque  = data.some(d => Number(d.cheios) === 0);
    const solicitarTI = data.some(d => Boolean(d.solicitarTI));
    const baixo       = data.some(d => Number(d.cheios) <= 1);
    const dot = pill.querySelector(".pill-dot");
    if (semEstoque)       { dot.className = "pill-dot crit"; pill.title = solicitarTI ? "Sem estoque — peça para o TI retirar toner da sala!" : "Sem estoque em algum toner!"; }
    else if (solicitarTI) { dot.className = "pill-dot warn"; pill.title = "Peça para que o TI retire toner da sala"; }
    else if (baixo)       { dot.className = "pill-dot warn"; pill.title = "Estoque baixo em algum toner"; }
    else                  { dot.className = "pill-dot";      pill.title = "Estoque normal"; }
  } catch { /* silencioso — pill fica cinza */ }
}

/* ── INIT ── */
document.addEventListener("DOMContentLoaded", () => {
  setActiveNav();
  loadTonerPill();
});
