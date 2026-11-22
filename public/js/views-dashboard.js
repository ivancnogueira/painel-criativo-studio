import {
  api,
  closeModal,
  ensureStylesheet,
  escapeHtml,
  formatDateTime,
  formatMoney,
  openModal,
  showToast,
} from "./core/api.js";
import { refreshDashboardData } from "./core/state.js";
import { navigate, registerView, renderCurrentView } from "./core/router.js";
import { renderCashFlowChart, renderGoalGaugeSvg, renderPlanDonutChart, renderTrendSparklineSvg } from "./charts.js";

const RANGE_OPTIONS = [
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "90d", label: "90d" },
  { id: "12m", label: "12m" },
  { id: "all", label: "Tudo" },
];
const PLAN_LABELS = { individual: "Individual", agencia_10: "Agência 10", agencia_ilimitada: "Agência Ilimitada" };
const METHOD_LABELS = { pix: "PIX", credit_card: "Cartão", boleto: "Boleto", debit: "Débito", paypal: "PayPal", manual: "Manual", other: "Outro" };

function deltaBadge(pct, { inverse = false } = {}) {
  const num = Number(pct || 0);
  const arrow = num > 0 ? "↑" : num < 0 ? "↓" : "•";
  const cls = num === 0 ? "flat" : (inverse ? num < 0 : num > 0) ? "up" : "down";
  return `<span class="kpi-delta ${cls} tabular-nums">${num > 0 ? "+" : ""}${num.toFixed(1)}% ${arrow}</span>`;
}

function initialsFrom(name, email) {
  const raw = String(name || email || "CL").trim();
  const parts = raw.split(/[\s@._-]+/).filter(Boolean);
  return parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}`.toUpperCase() : raw.slice(0, 2).toUpperCase();
}

export function openGoalEditModal(currentGoal) {
  const goal = currentGoal || { targetCents: 1000000, period: "monthly", currency: "BRL" };
  const currentVal = ((Number(goal.targetCents) || 1000000) / 100).toFixed(2);
  openModal({
    title: "Editar Meta de Faturamento",
    subtitle: "Defina o objetivo usado no Gauge executivo e no card da sidebar.",
    width: 440,
    bodyHtml: `
      <form id="dash-goal-form" class="form-stack">
        <label class="field">
          <span>Valor da Meta</span>
          <input type="number" id="dash-goal-amount" min="0" step="0.01" required value="${escapeHtml(currentVal)}" />
        </label>
        <div class="grid-2">
          <label class="field">
            <span>Período</span>
            <select id="dash-goal-period">
              <option value="monthly" ${goal.period === "monthly" ? "selected" : ""}>Mensal</option>
              <option value="quarterly" ${goal.period === "quarterly" ? "selected" : ""}>Trimestral</option>
              <option value="annual" ${goal.period === "annual" ? "selected" : ""}>Anual</option>
            </select>
          </label>
          <label class="field">
            <span>Moeda</span>
            <select id="dash-goal-currency">
              <option value="BRL" ${(goal.currency || "BRL") === "BRL" ? "selected" : ""}>BRL (R$)</option>
              <option value="USD" ${goal.currency === "USD" ? "selected" : ""}>USD ($)</option>
              <option value="EUR" ${goal.currency === "EUR" ? "selected" : ""}>EUR (€)</option>
            </select>
          </label>
        </div>
        <div class="btn-row">
          <button type="submit" class="btn btn-primary">Salvar Meta</button>
          <button type="button" class="btn btn-ghost" id="dash-goal-cancel">Cancelar</button>
        </div>
      </form>
    `,
    onMount: (modalRoot) => {
      modalRoot.querySelector("#dash-goal-cancel")?.addEventListener("click", closeModal);
      modalRoot.querySelector("#dash-goal-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const amount = Number(modalRoot.querySelector("#dash-goal-amount")?.value || 0);
        const period = modalRoot.querySelector("#dash-goal-period")?.value || "monthly";
        const currency = modalRoot.querySelector("#dash-goal-currency")?.value || "BRL";
        try {
          await api("/api/admin/analytics/goal", {
            method: "PUT",
            body: JSON.stringify({ target_cents: Math.max(0, Math.round(amount * 100)), period, currency }),
          });
          closeModal();
          showToast("Meta atualizada com sucesso!", "success");
          await refreshDashboardData(["analytics"]);
          void renderCurrentView();
        } catch (err) {
          showToast(`Erro ao atualizar meta: ${err.message}`, "error");
        }
      });
    },
  });
}

function renderControlToolbar(title, subtitle, state, extraHtml = "") {
  const { range = "30d", includeSimulated = false } = state;
  const exportUrl = `/api/admin/analytics/sales/export.csv?range=${encodeURIComponent(range)}&include_simulated=${Boolean(includeSimulated)}`;
  return `
    <div class="dash-header">
      <div class="dash-title-group">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(subtitle)}</p>
      </div>
      <div class="period-bar">
        <div class="period-pills" role="group" aria-label="Filtro de período">
          ${RANGE_OPTIONS.map((r) => `<button type="button" class="period-pill ${range === r.id ? "active" : ""}" data-range="${r.id}">${escapeHtml(r.label)}</button>`).join("")}
        </div>
        <label class="check-pill">
          <input type="checkbox" id="toggle-include-sim" ${includeSimulated ? "checked" : ""} />
          <span>Incluir simulados</span>
        </label>
        <a class="btn btn-secondary btn-sm" href="${escapeHtml(exportUrl)}" target="_blank" rel="noopener">Exportar CSV</a>
        ${extraHtml}
      </div>
    </div>
  `;
}

function bindControlToolbar(root, store) {
  root.querySelectorAll("[data-range]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      store.set({ range: btn.dataset.range });
      await refreshDashboardData(["analytics"]);
      void renderCurrentView();
    });
  });
  root.querySelector("#toggle-include-sim")?.addEventListener("change", async (e) => {
    store.set({ includeSimulated: Boolean(e.target.checked) });
    await refreshDashboardData(["analytics"]);
    void renderCurrentView();
  });
}

function mountCashFlowWidget(el, analytics, state, store, currency) {
  renderCashFlowChart(el, analytics.series || [], {
    currency,
    granularity: analytics.granularity || (state.granularity === "auto" ? "daily" : state.granularity),
    onToggleGranularity: async (nextGranularity) => {
      store.set({ granularity: nextGranularity });
      await refreshDashboardData(["analytics"]);
      void renderCurrentView();
    },
  });
}

function renderSalesRowsHtml(sales) {
  if (!sales.length) {
    return `<tr><td colspan="7" class="muted" style="text-align:center;padding:24px">Nenhuma venda encontrada com os filtros atuais.</td></tr>`;
  }
  return sales
    .map((s) => {
      const statusBadge =
        s.status === "refunded"
          ? `<span class="pill pill-revoked">Reembolsado</span>`
          : s.isSimulated
            ? `<span class="pill pill-warn">Simulado</span>`
            : `<span class="pill pill-active">Aprovado</span>`;
      const planLabel = PLAN_LABELS[s.planTier] || s.planTier || "-";
      const methodLabel = METHOD_LABELS[s.paymentMethod] || s.paymentMethod || "-";
      return `
        <tr>
          <td>
            <div class="buyer-cell">
              <span class="buyer-avatar">${escapeHtml(initialsFrom(s.buyerName, s.buyerEmail))}</span>
              <div class="buyer-meta">
                <div class="buyer-name">${escapeHtml(s.buyerName || "Comprador")}</div>
                <div class="buyer-email">${escapeHtml(s.buyerEmail || "-")}</div>
              </div>
            </div>
          </td>
          <td>
            <div>${escapeHtml(planLabel)}</div>
            <div class="muted" style="font-size:11px">${escapeHtml(s.licenseKey || s.transactionId || "-")}</div>
          </td>
          <td>
            <span class="pill pill-info">${escapeHtml(String(s.source || "manual").toUpperCase())}</span>
            <span class="muted" style="margin-left:4px">${escapeHtml(methodLabel)}</span>
          </td>
          <td class="muted">${escapeHtml(formatDateTime(s.createdAt))}</td>
          <td class="tabular-nums"><strong>${escapeHtml(formatMoney(s.amountCents, s.currency || "BRL"))}</strong></td>
          <td>${statusBadge}</td>
          <td>
            <div class="btn-row">
              <button type="button" class="btn btn-ghost btn-sm" data-inspect-sale="${escapeHtml(s.id)}" data-sale-source="${escapeHtml(s.source)}">Inspecionar</button>
              ${s.licenseKey ? `<button type="button" class="btn btn-secondary btn-sm" data-view-license="${escapeHtml(s.licenseKey)}">Ver licença</button>` : ""}
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function mountSalesTable(container, sales = [], { title = "Últimas Vendas" } = {}) {
  if (!container) return;
  const providers = [...new Set(sales.map((s) => s.source).filter(Boolean))];
  let query = "";
  let statusFilter = "all";
  let providerFilter = "all";

  container.innerHTML = `
    <div class="table-toolbar">
      <div>
        <h3 style="margin:0;font-size:16px">${escapeHtml(title)}</h3>
        <p class="muted">Pesquise por comprador, e-mail, chave CRIA-* ou ID de transação</p>
      </div>
      <div class="sales-filters">
        <input type="search" id="sales-search-input" placeholder="Buscar comprador, e-mail, chave..." />
        <select id="sales-status-filter" aria-label="Filtrar por status">
          <option value="all">Todos status</option>
          <option value="approved">Aprovado</option>
          <option value="refunded">Reembolsado</option>
          <option value="simulated">Simulado</option>
        </select>
        <select id="sales-provider-filter" aria-label="Filtrar por gateway">
          <option value="all">Todos gateways</option>
          ${providers.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p.toUpperCase())}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr><th>Comprador</th><th>Plano / Chave</th><th>Gateway & Método</th><th>Data</th><th>Valor</th><th>Status</th><th>Ações</th></tr>
        </thead>
        <tbody id="sales-table-body"></tbody>
      </table>
    </div>
  `;

  const tbody = container.querySelector("#sales-table-body");
  const applyFilters = () => {
    const term = query.trim().toLowerCase();
    const filtered = sales.filter((s) => {
      if (statusFilter === "approved" && (s.status !== "approved" || s.isSimulated)) return false;
      if (statusFilter === "refunded" && s.status !== "refunded") return false;
      if (statusFilter === "simulated" && !s.isSimulated) return false;
      if (providerFilter !== "all" && s.source !== providerFilter) return false;
      if (!term) return true;
      return `${s.buyerName} ${s.buyerEmail} ${s.licenseKey || ""} ${s.transactionId || ""} ${s.source}`.toLowerCase().includes(term);
    });
    tbody.innerHTML = renderSalesRowsHtml(filtered);
  };

  applyFilters();
  container.querySelector("#sales-search-input")?.addEventListener("input", (e) => { query = e.target.value || ""; applyFilters(); });
  container.querySelector("#sales-status-filter")?.addEventListener("change", (e) => { statusFilter = e.target.value; applyFilters(); });
  container.querySelector("#sales-provider-filter")?.addEventListener("change", (e) => { providerFilter = e.target.value; applyFilters(); });

  tbody.addEventListener("click", (e) => {
    const licBtn = e.target.closest("[data-view-license]");
    if (licBtn) return navigate("licenses", { query: licBtn.dataset.viewLicense });
    const inspBtn = e.target.closest("[data-inspect-sale]");
    if (!inspBtn) return;
    const saleId = inspBtn.dataset.inspectSale;
    if (inspBtn.dataset.saleSource !== "manual") {
      return navigate("webhooks", { deliveryId: saleId, inspectDeliveryId: saleId });
    }
    const sale = sales.find((item) => String(item.id) === String(saleId));
    if (!sale) return;
    openModal({
      title: "Detalhes da Emissão Manual",
      subtitle: sale.licenseKey || sale.transactionId,
      width: 480,
      bodyHtml: `
        <div class="form-stack">
          <div><strong>Comprador:</strong> ${escapeHtml(sale.buyerName || "-")} (${escapeHtml(sale.buyerEmail || "-")})</div>
          <div><strong>Plano:</strong> ${escapeHtml(PLAN_LABELS[sale.planTier] || sale.planTier)}</div>
          <div><strong>Valor:</strong> ${escapeHtml(formatMoney(sale.amountCents, sale.currency || "BRL"))}</div>
          <div><strong>Data:</strong> ${escapeHtml(formatDateTime(sale.createdAt))}</div>
          ${sale.licenseKey ? `<button type="button" class="btn btn-primary" id="modal-go-lic">Abrir Licença</button>` : ""}
        </div>
      `,
      onMount: (m) => m.querySelector("#modal-go-lic")?.addEventListener("click", () => {
        closeModal();
        navigate("licenses", { query: sale.licenseKey });
      }),
    });
  });
}

function renderBreakdownCard(title, rows = [], totalRevenue = 0, currency = "BRL") {
  const safeMax = Math.max(1, totalRevenue, ...rows.map((r) => Number(r.revenueCents) || 0));
  const listHtml = rows.length
    ? `<div class="breakdown-list">${rows
        .map((r) => {
          const pct = Math.min(100, Math.round(((Number(r.revenueCents) || 0) / safeMax) * 100));
          return `
            <div class="breakdown-row">
              <div class="row-between">
                <span><strong>${escapeHtml(r.label)}</strong> <small class="muted">(${Number(r.count || 0)}x)</small></span>
                <span class="tabular-nums"><strong>${escapeHtml(formatMoney(r.revenueCents || 0, currency))}</strong></span>
              </div>
              <div class="breakdown-bar-track"><div class="breakdown-bar-fill" style="width:${pct}%"></div></div>
            </div>`;
        })
        .join("")}</div>`
    : `<div class="muted">Sem dados no período selecionado.</div>`;

  return `<div class="panel-card"><div class="card-header"><h3>${escapeHtml(title)}</h3></div>${listHtml}</div>`;
}

ensureStylesheet("/styles/dashboard.css");

registerView("overview", {
  async render(root, { params, store }) {
    if (!store.get().analytics) await refreshDashboardData(["analytics"]);
    const state = store.get();
    const analytics = state.analytics || {};
    const kpis = analytics.kpis || {};
    const deltas = analytics.deltas || {};
    const goal = analytics.goal || { targetCents: 1000000, currentCents: 0, percent: 0, currency: "BRL" };
    const currency = analytics.primaryCurrency || "BRL";

    root.innerHTML = `
      ${renderControlToolbar("Visão Geral", "Cockpit executivo de faturamento, licenças e conversão em tempo real", state)}
      <section class="kpi-grid">
        <article class="kpi-card kpi-hero">
          <div class="kpi-top"><span class="kpi-label">Faturamento Líquido</span><span class="kpi-icon-box">R$</span></div>
          <div class="kpi-value-row">
            <span class="kpi-value tabular-nums">${escapeHtml(formatMoney(kpis.netRevenueCents || 0, currency))}</span>
            ${deltaBadge(deltas.netRevenuePct)}
          </div>
          <div class="kpi-foot"><button type="button" class="kpi-foot-link" id="btn-hero-sales-report">Ver relatório financeiro →</button></div>
        </article>

        <article class="kpi-card kpi-carbon">
          <div class="kpi-top"><span class="kpi-label">Vendas Aprovadas</span><span class="kpi-icon-box">✓</span></div>
          <div class="kpi-value-row">
            <span class="kpi-value tabular-nums">${Number(kpis.approvedCount || 0)}</span>
            ${deltaBadge(deltas.approvedCountPct)}
          </div>
          <div class="kpi-foot tabular-nums"><span>${Number(kpis.refundCount || 0)} reembolsos · ${Number(kpis.refundRatePct || 0).toFixed(1)}% taxa</span></div>
        </article>

        <button type="button" class="kpi-card kpi-carbon kpi-clickable" id="btn-kpi-goal" title="Clique para editar a meta">
          <div class="kpi-top"><span class="kpi-label">Meta de Faturamento</span><span class="pill pill-lime">Editar</span></div>
          <div class="kpi-goal-body">
            <div>
              <div class="kpi-value tabular-nums">${Number(goal.percent || 0).toFixed(0)}%</div>
              <div class="muted tabular-nums">Meta: ${escapeHtml(formatMoney(goal.targetCents || 0, goal.currency || currency))}</div>
            </div>
            ${renderGoalGaugeSvg(goal.percent || 0)}
          </div>
          <div class="kpi-foot tabular-nums"><span>Atual: ${escapeHtml(formatMoney(goal.currentCents || 0, goal.currency || currency))}</span></div>
        </button>

        <article class="kpi-card kpi-carbon">
          <div class="kpi-top"><span class="kpi-label">Ticket Médio</span><span class="kpi-icon-box">◈</span></div>
          <div class="kpi-value-row">
            <span class="kpi-value tabular-nums">${escapeHtml(formatMoney(kpis.averageTicketCents || 0, currency))}</span>
            ${deltaBadge(deltas.averageTicketPct)}
          </div>
          <div class="kpi-foot tabular-nums"><span>${Number(kpis.activeLicensesTotal || 0)} licenças · ${Number(kpis.activeMachinesTotal || 0)} PCs</span></div>
        </article>
      </section>

      <section class="analytics-grid">
        <div class="panel-card chart-card" id="ov-cashflow"></div>
        <div class="analytics-side-stack">
          <div class="panel-card chart-card" id="ov-donut"></div>
          <div class="panel-card chart-card">
            <div class="chart-header"><div><span class="kpi-label">Tendência de Crescimento</span><p class="muted">Ritmo líquido do período</p></div></div>
            <div class="spark-stats">
              <div class="spark-stat-box"><small>Aprovadas</small><strong class="tabular-nums">${Number(kpis.approvedCount || 0)}</strong></div>
              <div class="spark-stat-box"><small>Reembolsos</small><strong class="tabular-nums">${Number(kpis.refundCount || 0)}</strong></div>
            </div>
            ${renderTrendSparklineSvg(analytics.series || [])}
          </div>
        </div>
      </section>

      <section class="panel-card sales-table-card" id="ov-sales-table"></section>
    `;

    bindControlToolbar(root, store);
    root.querySelector("#btn-hero-sales-report")?.addEventListener("click", () => navigate("sales"));
    root.querySelector("#btn-kpi-goal")?.addEventListener("click", () => openGoalEditModal(goal));
    mountCashFlowWidget(root.querySelector("#ov-cashflow"), analytics, state, store, currency);
    renderPlanDonutChart(root.querySelector("#ov-donut"), analytics.byPlan || [], { currency, totalApproved: kpis.approvedCount || 0 });
    mountSalesTable(root.querySelector("#ov-sales-table"), analytics.recentSales || []);
    if (params?.openGoalModal) openGoalEditModal(goal);
  },
});

registerView("sales", {
  async render(root, { params, store }) {
    if (!store.get().analytics) await refreshDashboardData(["analytics"]);
    const state = store.get();
    const analytics = state.analytics || {};
    const kpis = analytics.kpis || {};
    const goal = analytics.goal || { targetCents: 1000000, currentCents: 0, percent: 0, currency: "BRL" };
    const currency = analytics.primaryCurrency || "BRL";

    const providerRows = (analytics.byProvider || []).map((p) => ({
      label: String(p.provider || "manual").toUpperCase(),
      revenueCents: p.revenueCents,
      count: p.count,
    }));
    const methodRows = (analytics.byPaymentMethod || []).map((m) => ({
      label: m.label || METHOD_LABELS[m.method] || m.method || "Outro",
      revenueCents: m.revenueCents,
      count: m.count,
    }));
    const currencyRows = Object.entries(analytics.currencyBreakdown || {}).map(([cur, vals]) => ({
      label: `${cur} (Líquido: ${formatMoney(vals.netCents || 0, cur)})`,
      revenueCents: vals.grossCents || 0,
      count: vals.count || 0,
    }));

    root.innerHTML = `
      ${renderControlToolbar(
        "Vendas & Financeiro",
        "Análise detalhada por gateway, método de pagamento, moeda e meta mensal",
        state,
        `<button type="button" class="btn btn-primary btn-sm" id="btn-sales-edit-goal">Editar Meta Mensal</button>`,
      )}
      <div class="panel-card chart-card" id="sales-cashflow" style="margin-bottom:18px"></div>
      <section class="breakdown-grid">
        ${renderBreakdownCard("Por Gateway", providerRows, kpis.grossRevenueCents || 0, currency)}
        ${renderBreakdownCard("Por Método de Pagamento", methodRows, kpis.grossRevenueCents || 0, currency)}
        ${renderBreakdownCard("Por Moeda", currencyRows, kpis.grossRevenueCents || 0, currency)}
      </section>
      <section class="panel-card sales-table-card" id="sales-full-table"></section>
    `;

    bindControlToolbar(root, store);
    root.querySelector("#btn-sales-edit-goal")?.addEventListener("click", () => openGoalEditModal(goal));
    mountCashFlowWidget(root.querySelector("#sales-cashflow"), analytics, state, store, currency);
    mountSalesTable(root.querySelector("#sales-full-table"), analytics.recentSales || [], { title: "Transações Financeiras do Período" });
    if (params?.openGoalModal) openGoalEditModal(goal);
  },
});
