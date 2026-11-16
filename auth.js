/* ── ADMIN OAUTH & SESSION (Google Identity Services) ── */
const AUTH_SESSION_KEY = "tiAdminSession";

const AUTH = {
  isClientConfigured() {
    return Boolean(
      typeof CONFIG !== "undefined" &&
      CONFIG.GOOGLE_CLIENT_ID &&
      !CONFIG.GOOGLE_CLIENT_ID.startsWith("SEU_GOOGLE_CLIENT_ID")
    );
  },

  decodeJwt(token) {
    try {
      const base64Url = token.split(".")[1];
      const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
      const jsonPayload = decodeURIComponent(
        atob(base64)
          .split("")
          .map(c => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
          .join("")
      );
      return JSON.parse(jsonPayload);
    } catch {
      return null;
    }
  },

  isAuthorizedEmail(email) {
    if (!email || typeof CONFIG === "undefined" || !Array.isArray(CONFIG.ADMIN_WHITELIST)) {
      return false;
    }
    const normalized = email.trim().toLowerCase();
    return CONFIG.ADMIN_WHITELIST.some(allowed => allowed.trim().toLowerCase() === normalized);
  },

  getSession() {
    try {
      const raw = sessionStorage.getItem(AUTH_SESSION_KEY);
      if (!raw) return null;
      const session = JSON.parse(raw);
      if (!session || !session.email || !session.exp) return null;
      if (Date.now() >= session.exp * 1000) {
        sessionStorage.removeItem(AUTH_SESSION_KEY);
        return null;
      }
      if (!session.isDemo && !this.isAuthorizedEmail(session.email)) {
        sessionStorage.removeItem(AUTH_SESSION_KEY);
        return null;
      }
      return session;
    } catch {
      return null;
    }
  },

  saveSession(payload, idToken = "", isDemo = false) {
    const session = {
      email: payload.email,
      name: payload.name || payload.email.split("@")[0],
      picture: payload.picture || "",
      exp: payload.exp || Math.floor(Date.now() / 1000) + 3600,
      idToken,
      isDemo,
      loginAt: new Date().toISOString()
    };
    sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
    return session;
  },

  handleGoogleCredential(response) {
    const payload = this.decodeJwt(response?.credential || "");
    if (!payload || !payload.email) {
      return { ok: false, reason: "invalid_token", message: "Não foi possível validar o token retornado pelo Google." };
    }
    if (!payload.email_verified) {
      return { ok: false, reason: "unverified", message: "Sua conta Google precisa estar com o e-mail verificado." };
    }
    if (!this.isAuthorizedEmail(payload.email)) {
      return {
        ok: false,
        reason: "unauthorized",
        email: payload.email,
        message: `Acesso negado: o e-mail "${payload.email}" não está na lista de administradores de TI autorizados.`
      };
    }

    const session = this.saveSession(payload, response.credential, false);
    return { ok: true, session };
  },

  loginDemo() {
    if (this.isClientConfigured()) return null;
    const demoEmail = CONFIG.ADMIN_WHITELIST?.[0] || "admin.ti@shopee.com";
    return this.saveSession(
      {
        email: demoEmail,
        name: "Admin TI (Modo Preview)",
        picture: "",
        exp: Math.floor(Date.now() / 1000) + 3600
      },
      "",
      true
    );
  },

  logout() {
    sessionStorage.removeItem(AUTH_SESSION_KEY);
    if (window.google?.accounts?.id) {
      try {
        window.google.accounts.id.disableAutoSelect();
      } catch { /* ignore */ }
    }
    window.location.href = "login.html";
  },

  requireAdmin() {
    const session = this.getSession();
    if (!session) {
      window.location.replace("login.html?reason=auth");
      return null;
    }
    return session;
  }
};
