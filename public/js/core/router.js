import { $, escapeHtml } from "./api.js";
import { store } from "./state.js";

export const ROUTES = [
  {
    group: "DASHBOARD",
    items: [
      { id: "overview", label: "Visão Geral", icon: "grid" },
      { id: "sales", label: "Vendas & Financeiro", icon: "chart" },
      { id: "licenses", label: "Licenças & Clientes", icon: "key" },
    ],
  },
  {
    group: "FERRAMENTAS",
    items: [
      { id: "webhooks", label: "Central de Webhooks", icon: "webhook", badgeKey: "webhookErrors" },
      { id: "messaging", label: "E-mail & WhatsApp", icon: "mail" },
      { id: "releases", label: "Releases & Versões", icon: "package" },
    ],
  },
  {
    group: "SISTEMA",
    items: [{ id: "security", label: "Segurança & Conta", icon: "shield" }],
  },
];

const ICONS = {
  grid: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
  chart: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M18 17V9M13 17V5M8 17v-3"/></svg>`,
  key: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/></svg>`,
  webhook: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  mail: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>`,
  package: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16.5 9.4-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" y1="22" x2="12" y2="12"/></svg>`,
  shield: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
};

const viewRegistry = new Map();
const paletteSources = [];
let railRenderer = null;
let currentParams = {};

export function registerView(routeId, viewDef) {
  if (!routeId || !viewDef) return;
  viewRegistry.set(routeId, viewDef);
}

export function registerRail(fn) {
  railRenderer = typeof fn === "function" ? fn : null;
}

export function registerPaletteSource(fn) {
  if (typeof fn === "function") paletteSources.push(fn);
}

export function getPaletteSources() {
  return [...paletteSources];
}

export function findRouteMeta(routeId) {
  for (const grp of ROUTES) {
    const found = grp.items.find((it) => it.id === routeId);
    if (found) return { group: grp.group, ...found };
  }
  return { group: "DASHBOARD", id: "overview", label: "Visão Geral", icon: "grid" };
}

export function getCurrentRoute() {
  const raw = String(window.location.hash || "").replace(/^#\/?/, "").split("?")[0].trim();
  const exists = ROUTES.some((g) => g.items.some((i) => i.id === raw));
  return exists ? raw : "overview";
}

export function renderSidebarNav() {
  const nav = $("sidebar-nav");
  if (!nav) return;
  const activeRoute = store.get().route || getCurrentRoute();
  const deliveries = store.get().deliveries || [];
  const webhookErrors = deliveries.filter(
    (d) => d.action === "auth_error" || d.action === "error" || Number(d.http_status) >= 400,
  ).length;

  nav.innerHTML = ROUTES.map((grp) => {
    const itemsHtml = grp.items
      .map((item) => {
        const isActive = item.id === activeRoute;
        const badgeCount = item.badgeKey === "webhookErrors" ? webhookErrors : 0;
        const badgeHtml = badgeCount > 0 ? `<span class="nav-badge tabular-nums">${badgeCount}</span>` : "";
        return `
          <button type="button" class="nav-item ${isActive ? "active" : ""}" data-route="${escapeHtml(item.id)}">
            <span class="nav-item-main">
              <span class="nav-item-icon">${ICONS[item.icon] || ""}</span>
              <span>${escapeHtml(item.label)}</span>
            </span>
            ${badgeHtml}
          </button>
        `;
      })
      .join("");
    return `
      <div class="nav-group">
        <div class="nav-group-label">${escapeHtml(grp.group)}</div>
        ${itemsHtml}
      </div>
    `;
  }).join("");
}

function updateBreadcrumb(routeId) {
  const bc = $("topbar-breadcrumb");
  if (!bc) return;
  const meta = findRouteMeta(routeId);
  const groupTitle = meta.group.charAt(0) + meta.group.slice(1).toLowerCase();
  bc.innerHTML = `
    <span class="breadcrumb-group">${escapeHtml(groupTitle)}</span>
    <span class="breadcrumb-sep">/</span>
    <span class="breadcrumb-current">${escapeHtml(meta.label)}</span>
  `;
}

export async function renderCurrentView() {
  const root = $("view-root");
  if (!root) return;
  const routeId = store.get().route || getCurrentRoute();
  updateBreadcrumb(routeId);
  renderSidebarNav();

  const viewDef = viewRegistry.get(routeId);
  if (!viewDef || typeof viewDef.render !== "function") {
    const meta = findRouteMeta(routeId);
    root.innerHTML = `
      <div class="panel-card">
        <div class="card-header">
          <h2>${escapeHtml(meta.label)}</h2>
          <p class="muted">Módulo da rota <code>${escapeHtml(routeId)}</code> ainda não registrado nesta etapa.</p>
        </div>
        <button type="button" class="btn btn-secondary" id="btn-retry-view">Recarregar Painel</button>
      </div>
    `;
    $("btn-retry-view")?.addEventListener("click", () => window.location.reload());
    return;
  }

  await viewDef.render(root, { route: routeId, params: currentParams, store, navigate });
}

export function renderRail() {
  const rail = $("activity-rail-root");
  if (!rail || !railRenderer) return;
  railRenderer(rail, { store, navigate });
}

export function closeMobileOverlays() {
  $("sidebar")?.classList.remove("sidebar-open");
  $("activity-rail-root")?.classList.remove("rail-open");
  $("sidebar-backdrop")?.classList.add("hidden");
}

export function navigate(routeId, params = {}) {
  const meta = findRouteMeta(routeId);
  currentParams = params || {};
  store.set({ route: meta.id });
  const targetHash = `#/${meta.id}`;
  if (window.location.hash !== targetHash) {
    window.location.hash = targetHash;
  }
  closeMobileOverlays();
  void renderCurrentView();
}

export function initRouterShell() {
  const initialRoute = getCurrentRoute();
  store.set({ route: initialRoute });
  renderSidebarNav();
  updateBreadcrumb(initialRoute);

  $("sidebar-nav")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-route]");
    if (!btn) return;
    navigate(btn.dataset.route);
  });

  $("btn-mobile-menu")?.addEventListener("click", () => {
    $("sidebar")?.classList.add("sidebar-open");
    $("sidebar-backdrop")?.classList.remove("hidden");
  });

  $("btn-toggle-rail")?.addEventListener("click", () => {
    if (window.innerWidth < 1280) {
      const opening = !$("activity-rail-root")?.classList.contains("rail-open");
      $("activity-rail-root")?.classList.toggle("rail-open", opening);
      $("sidebar-backdrop")?.classList.toggle("hidden", !opening);
    } else {
      $("admin-view")?.classList.toggle("rail-hidden");
    }
  });

  $("sidebar-backdrop")?.addEventListener("click", closeMobileOverlays);

  window.addEventListener("hashchange", () => {
    const next = getCurrentRoute();
    if (next !== store.get().route) {
      store.set({ route: next });
      void renderCurrentView();
    }
  });

  void renderCurrentView();
  renderRail();
}
