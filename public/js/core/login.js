import { $, api, setUnauthorizedHandler } from "./api.js";
import { store } from "./state.js";

export function showLoginView() {
  $("login-view")?.classList.remove("hidden");
  $("admin-view")?.classList.add("hidden");
}

export function showAdminView(user) {
  $("login-view")?.classList.add("hidden");
  $("admin-view")?.classList.remove("hidden");
  const email = user?.email || "admin@exemplo.invalid";
  if ($("admin-user-email")) $("admin-user-email").textContent = email;
  if ($("topbar-user-name")) $("topbar-user-name").textContent = user?.name || email.split("@")[0] || "Admin";
  if ($("topbar-avatar")) $("topbar-avatar").textContent = String(email[0] || "A").toUpperCase();
  store.set({ user: user || { email } });
}

export function initAuthFlow({ onAuthenticated, onLoggedOut } = {}) {
  setUnauthorizedHandler(() => {
    store.reset();
    showLoginView();
    if (typeof onLoggedOut === "function") onLoggedOut();
  });

  $("login-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errBox = $("login-error");
    const submitBtn = $("login-submit");
    errBox?.classList.add("hidden");
    if (submitBtn) submitBtn.disabled = true;

    try {
      const data = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: $("login-email")?.value.trim() || "",
          password: $("login-password")?.value || "",
        }),
      });
      showAdminView(data.user);
      if (typeof onAuthenticated === "function") await onAuthenticated(data.user);
    } catch (err) {
      if (errBox) {
        const msg = String(err?.message || "Falha no login.");
        errBox.textContent = msg.includes("429")
          ? "Muitas tentativas de login. Aguarde alguns instantes antes de tentar novamente."
          : msg;
        errBox.classList.remove("hidden");
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  $("btn-logout")?.addEventListener("click", async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } finally {
      store.reset();
      showLoginView();
      if (typeof onLoggedOut === "function") onLoggedOut();
    }
  });

  return (async () => {
    try {
      const res = await fetch("/api/auth/session", { credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (data.authenticated) {
        showAdminView(data.user);
        if (typeof onAuthenticated === "function") await onAuthenticated(data.user);
      } else {
        showLoginView();
      }
    } catch {
      showLoginView();
    }
  })();
}
