import { $, api, escapeHtml, formatMoney, openModal, closeModal, showToast } from "./js/core/api.js";
import { store, refreshDashboardData } from "./js/core/state.js";
import { initRouterShell, navigate, renderCurrentView, renderRail, renderSidebarNav } from "./js/core/router.js";
import { initTheme, toggleThemeAnimated } from "./js/core/theme.js";
import { initCommandPalette } from "./js/core/command-palette.js";
import { initAuthFlow } from "./js/core/login.js";

const OPTIONAL_VIEW_MODULES = [
  "/js/activity-rail.js",
  "/js/views-dashboard.js",
  "/js/views-licenses.js",
  "/js/views-webhooks.js",
  "/js/views-messaging.js",
  "/js/views-releases.js",
  "/js/views-security.js",
];

let shellInitialized = false;

function updateSidebarGoalCard(state) {
  const goal = state.analytics?.goal;
  const targetCents = Number(goal?.targetCents ?? 1000000);
  const currentCents = Number(goal?.currentCents ?? 0);
  const currency = goal?.currency || state.analytics?.primaryCurrency || "BRL";
  const pct = targetCents > 0 ? Math.min(100, Math.round((currentCents / targetCents) * 100)) : 0;

  if ($("sidebar-goal-pct")) $("sidebar-goal-pct").textContent = `${pct}%`;
  if ($("sidebar-goal-fill")) $("sidebar-goal-fill").style.width = `${pct}%`;
  if ($("sidebar-goal-sub")) {
    $("sidebar-goal-sub").textContent = `${formatMoney(currentCents, currency)} / ${formatMoney(targetCents, currency)}`;
  }
}

export function openGoalConfigModal() {
  const goal = store.get().analytics?.goal || { targetCents: 1000000, period: "monthly", currency: "BRL" };
  const currentReais = ((Number(goal.targetCents) || 1000000) / 100).toFixed(2);
  openModal({
    title: "Configurar Meta de Faturamento",
    subtitle: "Atualize o objetivo exibido na sidebar e no gauge executivo.",
    width: 440,
    bodyHtml: `
      <form id="modal-goal-form" class="form-stack">
        <label class="field">
          <span>Meta em ${escapeHtml(goal.currency || "BRL")}</span>
          <input type="number" id="modal-goal-value" min="0" step="0.01" required value="${escapeHtml(currentReais)}" />
        </label>
        <div class="btn-row">
          <button type="submit" class="btn btn-primary">Salvar Meta</button>
          <button type="button" class="btn btn-ghost" id="btn-cancel-goal">Cancelar</button>
        </div>
      </form>
    `,
    onMount: (root) => {
      root.querySelector("#btn-cancel-goal")?.addEventListener("click", closeModal);
      root.querySelector("#modal-goal-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const val = Number(root.querySelector("#modal-goal-value")?.value || 0);
        const targetCents = Math.max(0, Math.round(val * 100));
        try {
          await api("/api/admin/analytics/goal", {
            method: "PUT",
            body: JSON.stringify({ target_cents: targetCents, period: "monthly", currency: goal.currency || "BRL" }),
          });
          closeModal();
          showToast("Meta mensal atualizada!", "success");
          await refreshDashboardData(["analytics"]);
          void renderCurrentView();
        } catch (err) {
          showToast(`Erro ao salvar meta: ${err.message}`, "error");
        }
      });
    },
  });
}

function bindTopbarActions() {
  $("btn-quick-license")?.addEventListener("click", () => navigate("licenses", { focus: "create" }));
  $("btn-quick-simulate")?.addEventListener("click", () => navigate("webhooks", { focus: "simulate" }));
  $("btn-global-refresh")?.addEventListener("click", async () => {
    const btn = $("btn-global-refresh");
    if (btn) btn.disabled = true;
    try {
      await refreshDashboardData();
      void renderCurrentView();
      showToast("Painel sincronizado!", "success");
    } catch (err) {
      showToast(`Erro ao atualizar: ${err.message}`, "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  $("sidebar-goal-card")?.addEventListener("click", openGoalConfigModal);
  window.addEventListener("criativo:open-goal-modal", openGoalConfigModal);
}

async function bootstrapAuthenticatedShell() {
  if (!shellInitialized) {
    shellInitialized = true;
    await Promise.allSettled(OPTIONAL_VIEW_MODULES.map((mod) => import(mod)));
    initRouterShell();
    initCommandPalette();
    bindTopbarActions();
    store.subscribe((nextState) => {
      updateSidebarGoalCard(nextState);
      renderSidebarNav();
      renderRail();
    });
  } else {
    void renderCurrentView();
  }

  await refreshDashboardData();
  void renderCurrentView();
  renderRail();
}

initTheme();
$("btn-login-theme")?.addEventListener("click", (e) => void toggleThemeAnimated(e.currentTarget));
$("btn-topbar-theme")?.addEventListener("click", (e) => void toggleThemeAnimated(e.currentTarget));

void initAuthFlow({
  onAuthenticated: bootstrapAuthenticatedShell,
});
