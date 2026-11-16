/* ── ADMIN OAUTH & SESSION (Google Identity Services) ── */
const AUTH_SESSION_KEY = "tiAdminSession";

const AUTH = {
  _lastExpireReason: "auth",

  getTimeoutMs() {
    const mins =
      typeof CONFIG !== "undefined" && Number(CONFIG.ADMIN_TIMEOUT_MINUTES) > 0
        ? Number(CONFIG.ADMIN_TIMEOUT_MINUTES)
        : 5;
    return mins * 60 * 1000;
  },

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
      if (!raw) {
        this._lastExpireReason = "auth";
        return null;
      }
      const session = JSON.parse(raw);
      if (!session || !session.email || !session.exp) {
        this._lastExpireReason = "auth";
        return null;
      }
      const now = Date.now();
      if (now >= session.exp * 1000) {
        this._lastExpireReason = "timeout";
        sessionStorage.removeItem(AUTH_SESSION_KEY);
        return null;
      }
      if (session.lastActivity && now - session.lastActivity >= this.getTimeoutMs()) {
        this._lastExpireReason = "timeout";
        sessionStorage.removeItem(AUTH_SESSION_KEY);
        return null;
      }
      if (!session.isDemo && !this.isAuthorizedEmail(session.email)) {
        this._lastExpireReason = "auth";
        sessionStorage.removeItem(AUTH_SESSION_KEY);
        return null;
      }
      return session;
    } catch {
      this._lastExpireReason = "auth";
      return null;
    }
  },

  saveSession(payload, idToken = "", isDemo = false) {
    const now = Date.now();
    const session = {
      email: payload.email,
      name: payload.name || payload.email.split("@")[0],
      picture: payload.picture || "",
      exp: payload.exp || Math.floor(now / 1000) + 3600,
      idToken,
      isDemo,
      loginAt: new Date(now).toISOString(),
      lastActivity: now
    };
    sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
    return session;
  },

  touchSession() {
    const session = this.getSession();
    if (!session) return null;
    session.lastActivity = Date.now();
    sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
    return session;
  },

  getRemainingMs(session) {
    const active = session || this.getSession();
    if (!active) return 0;
    const now = Date.now();
    const idleDeadline = (active.lastActivity || now) + this.getTimeoutMs();
    const jwtDeadline = active.exp * 1000;
    return Math.max(0, Math.min(idleDeadline, jwtDeadline) - now);
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

  logout(reason = "") {
    sessionStorage.removeItem(AUTH_SESSION_KEY);
    if (window.google?.accounts?.id) {
      try {
        window.google.accounts.id.disableAutoSelect();
      } catch { /* ignore */ }
    }
    window.location.href = reason ? `login.html?reason=${encodeURIComponent(reason)}` : "login.html";
  },

  requireAdmin() {
    const session = this.getSession();
    if (!session) {
      const reason = this._lastExpireReason || "auth";
      window.location.replace(`login.html?reason=${encodeURIComponent(reason)}`);
      return null;
    }
    this.touchSession();
    return session;
  },

  startIdleMonitor({ onTick, onTimeout } = {}) {
    const events = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"];
    let lastTouch = 0;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      const session = this.getSession();
      if (!session) {
        cleanup();
        onTimeout?.();
        this.logout("timeout");
        return;
      }
      const remainingMs = this.getRemainingMs(session);
      onTick?.(remainingMs);
      if (remainingMs <= 0) {
        cleanup();
        onTimeout?.();
        this.logout("timeout");
      }
    };

    const handleActivity = () => {
      if (stopped) return;
      const now = Date.now();
      if (now - lastTouch < 1000) return;
      lastTouch = now;
      const session = this.touchSession();
      if (!session) {
        tick();
        return;
      }
      onTick?.(this.getRemainingMs(session));
    };

    const handleVisibility = () => {
      if (!document.hidden) tick();
    };

    events.forEach(ev => window.addEventListener(ev, handleActivity, { passive: true }));
    document.addEventListener("visibilitychange", handleVisibility);
    const timerId = window.setInterval(tick, 1000);
    tick();

    function cleanup() {
      if (stopped) return;
      stopped = true;
      window.clearInterval(timerId);
      events.forEach(ev => window.removeEventListener(ev, handleActivity));
      document.removeEventListener("visibilitychange", handleVisibility);
    }

    return cleanup;
  }
};
