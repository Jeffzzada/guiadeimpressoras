/* ── CONFIG ── */
const CONFIG = {
  SHEET_ID:        "1hxcjBX7q41HRK3-SqdXT7-nS6r5kWVuK3vi3jcF88Ao",
  SHEET_TAB:       "webinventario",
  APPS_SCRIPT_URL: "https://script.google.com/a/macros/shopee.com/s/AKfycbz8hLmctZmZYNwIVG3D4XFBVuDoMRwxk7SzMcxo8DFRtW9Le9TdaAeaYA45KWTTx82c/exec"
};

const TONERS = [
  { ref: "W2150XC", nome: "Preto",   cor: "#1A1A1A" },
  { ref: "W2151XC", nome: "Ciano",   cor: "#0070C0" },
  { ref: "W2152XC", nome: "Amarelo", cor: "#B8860B" },
  { ref: "W2153XC", nome: "Magenta", cor: "#C0004A" }
];

/* ── NAV ATIVA ── */
function setActiveNav() {
  const page = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".nav-tab").forEach(a => {
    const href = a.getAttribute("href") || "";
    a.classList.toggle("active", href === page || (page === "index.html" && href === "index.html"));
  });
}

/* ── TONER PILL (topnav) ── */
async function loadTonerPill() {
  const pill = document.getElementById("toner-pill");
  if (!pill) return;
  try {
    const res = await fetch(`${CONFIG.APPS_SCRIPT_URL}?action=getEstoque`);
    const data = await res.json();
    const semEstoque = data.some(d => Number(d.cheios) === 0);
    const baixo     = data.some(d => Number(d.cheios) <= 1);
    const dot = pill.querySelector(".pill-dot");
    if (semEstoque) { dot.className = "pill-dot crit"; pill.title = "Sem estoque em algum toner!"; }
    else if (baixo) { dot.className = "pill-dot warn"; pill.title = "Estoque baixo em algum toner"; }
    else            { dot.className = "pill-dot";      pill.title = "Estoque normal"; }

    // guarda em sessionStorage para uso na página de estoque
    sessionStorage.setItem("tonerData", JSON.stringify(data));
  } catch { /* silencioso — pill fica cinza */ }
}

/* ── DADOS DE TONER (para página de estoque) ── */
async function fetchTonerData() {
  const cached = sessionStorage.getItem("tonerData");
  if (cached) return JSON.parse(cached);
  const res = await fetch(`${CONFIG.APPS_SCRIPT_URL}?action=getEstoque`);
  const data = await res.json();
  sessionStorage.setItem("tonerData", JSON.stringify(data));
  return data;
}

/* ── INIT ── */
document.addEventListener("DOMContentLoaded", () => {
  setActiveNav();
  loadTonerPill();
});
