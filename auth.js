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
      if (typeof token !== "string") return null;
      const parts = token.split(".");
      if (parts.length !== 3 || !parts[1]) return null;
      const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
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

  validateTokenClaims(payload) {
    if (!payload || typeof payload !== "object" || !payload.email) {
      return { ok: false, reason: "invalid_token", message: "Não foi possível validar o token retornado pelo Google." };
    }
    if (this.isClientConfigured() && payload.aud !== CONFIG.GOOGLE_CLIENT_ID) {
      return { ok: false, reason: "invalid_aud", message: "Token emitido para outro aplicativo." };
    }
    if (!payload.email_verified) {
      return { ok: false, reason: "unverified", message: "Sua conta Google precisa estar com o e-mail verificado." };
    }
    if (!payload.exp || Date.now() >= Number(payload.exp) * 1000) {
      return { ok: false, reason: "expired", message: "O token retornado já está expirado. Tente entrar novamente." };
    }
    return { ok: true };
  },

  isValidTokenPayload(payload) {
    return this.validateTokenClaims(payload).ok;
  },

  getSession() {
    try {
      const raw = sessionStorage.getItem(AUTH_SESSION_KEY);
      if (!raw) {
        this._lastExpireReason = "auth";
        return null;
      }
      const session = JSON.parse(raw);
      if (!session || !session.email || !session.exp || !session.idToken) {
        this._lastExpireReason = "auth";
        sessionStorage.removeItem(AUTH_SESSION_KEY);
        return null;
      }

      const tokenPayload = this.decodeJwt(session.idToken);
      if (
        !tokenPayload ||
        String(tokenPayload.email).trim().toLowerCase() !== String(session.email).trim().toLowerCase()
      ) {
        this._lastExpireReason = "auth";
        sessionStorage.removeItem(AUTH_SESSION_KEY);
        return null;
      }

      const now = Date.now();
      const tokenExpMs = Math.min(Number(session.exp), Number(tokenPayload.exp || 0)) * 1000;
      if (!tokenExpMs || now >= tokenExpMs) {
        this._lastExpireReason = "timeout";
        sessionStorage.removeItem(AUTH_SESSION_KEY);
        return null;
      }

      if (session.lastActivity && now - session.lastActivity >= this.getTimeoutMs()) {
        this._lastExpireReason = "timeout";
        sessionStorage.removeItem(AUTH_SESSION_KEY);
        return null;
      }

      if (!this.isValidTokenPayload(tokenPayload)) {
        this._lastExpireReason = "auth";
        sessionStorage.removeItem(AUTH_SESSION_KEY);
        return null;
      }

      return session;
    } catch {
      this._lastExpireReason = "auth";
      sessionStorage.removeItem(AUTH_SESSION_KEY);
      return null;
    }
  },

  saveSession(payload, idToken) {
    if (!idToken || !this.isValidTokenPayload(payload)) return null;
    const now = Date.now();
    const session = {
      email: payload.email,
      name: payload.name || payload.email.split("@")[0],
      picture: typeof payload.picture === "string" && payload.picture.startsWith("https://") ? payload.picture : "",
      exp: Number(payload.exp),
      idToken,
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
    const jwtDeadline = Number(active.exp) * 1000;
    return Math.max(0, Math.min(idleDeadline, jwtDeadline) - now);
  },

  handleGoogleCredential(response) {
    const token = response?.credential || "";
    const payload = this.decodeJwt(token);
    const check = this.validateTokenClaims(payload);
    if (!check.ok) return check;

    const session = this.saveSession(payload, token);
    return session ? { ok: true, session } : { ok: false, reason: "invalid_session", message: "Falha ao iniciar sessão." };
  },

  async authenticateWithBackend(response) {
    const token = response?.credential || "";
    const payload = this.decodeJwt(token);
    const check = this.validateTokenClaims(payload);
    if (!check.ok) return check;

    try {
      await apiPost({ action: "verificarAdmin", token });
    } catch (err) {
      return {
        ok: false,
        reason: "unauthorized",
        message: err?.message || "Acesso negado pelo servidor."
      };
    }

    const session = this.saveSession(payload, token);
    return session ? { ok: true, session } : { ok: false, reason: "invalid_session", message: "Falha ao iniciar sessão." };
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
