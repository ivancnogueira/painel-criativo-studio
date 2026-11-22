import { $, escapeHtml, formatMoney, showToast } from "./api.js";
import { store, refreshDashboardData } from "./state.js";
import { ROUTES, navigate, getPaletteSources, renderCurrentView } from "./router.js";
import { toggleThemeAnimated } from "./theme.js";

let isOpen = false;
let activeIndex = 0;
let filteredItems = [];

function buildBaseItems() {
  const items = [];
  for (const grp of ROUTES) {
    for (const r of grp.items) {
      items.push({
        group: "Navegação",
        title: r.label,
        subtitle: `Ir para ${grp.group.toLowerCase()}`,
        keywords: `${r.id} ${r.label} ${grp.group}`,
        run: () => navigate(r.id),
      });
    }
  }

  items.push(
    {
      group: "Ações Rápidas",
      title: "Emitir nova licença",
      subtitle: "Abrir tela de licenças para emissão",
      keywords: "nova licença criar chave emitir",
      run: () => navigate("licenses", { focus: "create" }),
    },
    {
      group: "Ações Rápidas",
      title: "Simular venda de checkout",
      subtitle: "Testar webhook ponta a ponta",
      keywords: "simular venda checkout webhook",
      run: () => navigate("webhooks", { focus: "simulate" }),
    },
    {
      group: "Ações Rápidas",
      title: "Configurar meta mensal",
      subtitle: "Definir objetivo de faturamento",
      keywords: "meta mensal goal faturamento",
      run: () => document.getElementById("sidebar-goal-card")?.click(),
    },
    {
      group: "Ações Rápidas",
      title: "Exportar vendas CSV",
      subtitle: "Baixar planilha do período atual",
      keywords: "exportar csv vendas relatorio",
      run: () => {
        const { range, includeSimulated } = store.get();
        window.open(
          `/api/admin/analytics/sales/export.csv?range=${encodeURIComponent(range)}&include_simulated=${Boolean(includeSimulated)}`,
          "_blank",
        );
      },
    },
    {
      group: "Ações Rápidas",
      title: "Alternar Tema (Claro / Escuro)",
      subtitle: "Troca instantânea com transição circular",
      keywords: "tema claro escuro dark light theme",
      run: () => void toggleThemeAnimated(null),
    },
    {
      group: "Ações Rápidas",
      title: "Atualizar dados do painel",
      subtitle: "Sincronizar KPIs, licenças e webhooks",
      keywords: "atualizar refresh sync dados",
      run: async () => {
        await refreshDashboardData();
        void renderCurrentView();
        showToast("Dados atualizados!", "success");
      },
    },
  );

  const { licenses = [], deliveries = [] } = store.get();
  for (const lic of licenses.slice(0, 40)) {
    items.push({
      group: "Licenças",
      title: `${lic.customer_name || lic.customer_email}`,
      subtitle: `${lic.license_key} · ${lic.plan_tier} (${lic.status})`,
      keywords: `${lic.customer_email} ${lic.customer_name || ""} ${lic.license_key}`,
      run: () => navigate("licenses", { query: lic.license_key }),
    });
  }

  for (const del of deliveries.slice(0, 30)) {
    const val = del.amount_cents ? ` · ${formatMoney(del.amount_cents, del.currency || "BRL")}` : "";
    items.push({
      group: "Webhooks",
      title: `${(del.provider || "").toUpperCase()} · ${del.buyer_email || del.transaction_id || del.id}`,
      subtitle: `${del.event_name || del.action}${val}`,
      keywords: `${del.provider} ${del.transaction_id || ""} ${del.buyer_email || ""} ${del.license_key || ""}`,
      run: () => navigate("webhooks", { deliveryId: del.id || del.delivery_key }),
    });
  }

  for (const src of getPaletteSources()) {
    try {
      const extra = src(store.get());
      if (Array.isArray(extra)) items.push(...extra);
    } catch {
      /* ignora fonte com erro */
    }
  }
  return items;
}

function renderList(query = "") {
  const listEl = $("cmdk-list");
  if (!listEl) return;
  const term = query.trim().toLowerCase();
  const all = buildBaseItems();
  filteredItems = term
    ? all.filter((it) => `${it.title} ${it.subtitle} ${it.keywords || ""}`.toLowerCase().includes(term)).slice(0, 24)
    : all.slice(0, 18);

  if (activeIndex >= filteredItems.length) activeIndex = 0;

  if (!filteredItems.length) {
    listEl.innerHTML = `<div class="muted" style="padding:18px;text-align:center">Nenhum resultado encontrado para "${escapeHtml(query)}".</div>`;
    return;
  }

  let lastGroup = "";
  listEl.innerHTML = filteredItems
    .map((item, idx) => {
      const grpHeader = item.group !== lastGroup ? `<div class="cmdk-group-title">${escapeHtml(item.group)}</div>` : "";
      lastGroup = item.group;
      return `
        ${grpHeader}
        <button type="button" class="cmdk-item ${idx === activeIndex ? "active" : ""}" data-cmdk-idx="${idx}">
          <div>
            <div>${escapeHtml(item.title)}</div>
            <div class="cmdk-item-sub">${escapeHtml(item.subtitle || "")}</div>
          </div>
          <span class="kbd-pill">↵</span>
        </button>
      `;
    })
    .join("");
}

export function closeCommandPalette() {
  const root = $("cmdk-root");
  if (root) root.innerHTML = "";
  isOpen = false;
}

function executeItem(idx) {
  const item = filteredItems[idx];
  if (!item) return;
  closeCommandPalette();
  void item.run?.();
}

export function openCommandPalette() {
  const root = $("cmdk-root");
  if (!root) return;
  isOpen = true;
  activeIndex = 0;
  root.innerHTML = `
    <div class="cmdk-backdrop" id="cmdk-backdrop">
      <div class="cmdk-modal" role="dialog" aria-modal="true" aria-label="Busca Global">
        <div class="cmdk-input-wrap">
          <span>🔍</span>
          <input id="cmdk-input" class="cmdk-input" type="search" placeholder="Ir para rota, ação rápida, e-mail, chave CRIA-* ou transação..." autocomplete="off" />
          <span class="kbd-pill">Esc</span>
        </div>
        <div id="cmdk-list" class="cmdk-list"></div>
      </div>
    </div>
  `;
  renderList("");
  const input = $("cmdk-input");
  input?.focus();

  input?.addEventListener("input", (e) => {
    activeIndex = 0;
    renderList(e.target.value);
  });

  input?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = filteredItems.length ? (activeIndex + 1) % filteredItems.length : 0;
      renderList(input.value);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = filteredItems.length ? (activeIndex - 1 + filteredItems.length) % filteredItems.length : 0;
      renderList(input.value);
    } else if (e.key === "Enter") {
      e.preventDefault();
      executeItem(activeIndex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeCommandPalette();
    }
  });

  $("cmdk-list")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cmdk-idx]");
    if (!btn) return;
    executeItem(Number(btn.dataset.cmdkIdx));
  });

  $("cmdk-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "cmdk-backdrop") closeCommandPalette();
  });
}

export function initCommandPalette() {
  $("btn-open-cmdk")?.addEventListener("click", openCommandPalette);
  $("btn-sidebar-search")?.addEventListener("click", openCommandPalette);

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (isOpen) closeCommandPalette();
      else openCommandPalette();
    } else if (e.key === "Escape" && isOpen) {
      e.preventDefault();
      closeCommandPalette();
    }
  });
}
