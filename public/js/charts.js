import { escapeHtml, formatMoney } from "./core/api.js";

const PLAN_COLORS = {
  individual: "var(--accent-lime)",
  agencia_10: "var(--accent-emerald)",
  agencia_ilimitada: "var(--accent-orange)",
  other: "var(--accent-sky)",
};

const FALLBACK_COLORS = [
  "var(--accent-lime)",
  "var(--accent-emerald)",
  "var(--accent-orange)",
  "var(--accent-sky)",
];

function formatCompactMoney(cents, currency = "BRL") {
  const value = (Number(cents) || 0) / 100;
  const prefix = currency === "USD" ? "$" : currency === "EUR" ? "€" : "R$";
  if (Math.abs(value) >= 1000000) return `${prefix} ${(value / 1000000).toFixed(1)}M`;
  if (Math.abs(value) >= 1000) return `${prefix} ${(value / 1000).toFixed(1).replace(".0", "")}k`;
  return `${prefix} ${Math.round(value)}`;
}

export function renderGoalGaugeSvg(percent = 0) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const r = 38;
  const cx = 52;
  const cy = 48;
  const arcLen = Math.PI * r;
  const dashOffset = arcLen * (1 - clamped / 100);
  const angleRad = Math.PI - (clamped / 100) * Math.PI;
  const px = (cx + r * Math.cos(angleRad)).toFixed(2);
  const py = (cy - r * Math.sin(angleRad)).toFixed(2);

  return `
    <svg class="kpi-goal-gauge" viewBox="0 0 104 58" aria-label="Meta ${clamped}%">
      <defs>
        <linearGradient id="goalGaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="var(--accent-lime)" />
          <stop offset="100%" stop-color="var(--accent-emerald)" />
        </linearGradient>
      </defs>
      <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}"
        fill="none" stroke="var(--bg-surface-3)" stroke-width="8" stroke-linecap="round" />
      <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}"
        fill="none" stroke="url(#goalGaugeGrad)" stroke-width="8" stroke-linecap="round"
        stroke-dasharray="${arcLen.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}" />
      <circle cx="${px}" cy="${py}" r="4.2" fill="var(--accent-lime)" stroke="var(--bg-surface)" stroke-width="2" />
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="var(--text-primary)" font-size="12" font-weight="700">${Math.round(clamped)}%</text>
    </svg>
  `;
}

export function renderTrendSparklineSvg(series = []) {
  const ptsSource = Array.isArray(series) && series.length > 0 ? series : [{ netCents: 0 }, { netCents: 0 }];
  const values = ptsSource.map((d) => Math.max(0, Number(d.netCents ?? d.grossCents ?? 0)));
  if (values.length === 1) values.unshift(values[0]);

  const w = 280;
  const h = 76;
  const padX = 6;
  const padY = 10;
  const maxVal = Math.max(1, ...values);
  const coords = values.map((v, i) => {
    const x = padX + (i / (values.length - 1)) * (w - padX * 2);
    const y = h - padY - (v / maxVal) * (h - padY * 2);
    return { x, y };
  });

  let linePath = `M ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`;
  for (let i = 1; i < coords.length; i += 1) {
    const prev = coords[i - 1];
    const curr = coords[i];
    const midX = ((prev.x + curr.x) / 2).toFixed(1);
    linePath += ` C ${midX} ${prev.y.toFixed(1)}, ${midX} ${curr.y.toFixed(1)}, ${curr.x.toFixed(1)} ${curr.y.toFixed(1)}`;
  }

  const last = coords[coords.length - 1];
  const areaPath = `${linePath} L ${last.x.toFixed(1)} ${h - 2} L ${coords[0].x.toFixed(1)} ${h - 2} Z`;

  return `
    <svg class="sparkline-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="sparkAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent-emerald)" stop-opacity="0.35" />
          <stop offset="100%" stop-color="var(--accent-emerald)" stop-opacity="0.02" />
        </linearGradient>
      </defs>
      <path d="${areaPath}" fill="url(#sparkAreaGrad)" />
      <path d="${linePath}" fill="none" stroke="var(--accent-success)" stroke-width="2.4" stroke-linecap="round" />
      <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="4" fill="var(--accent-success)" stroke="var(--bg-surface)" stroke-width="2" />
    </svg>
  `;
}

export function renderCashFlowChart(container, series = [], opts = {}) {
  if (!container) return;
  const { currency = "BRL", granularity = "daily", onToggleGranularity } = opts;
  const safeSeries = Array.isArray(series) ? series : [];
  const totalNetCents = safeSeries.reduce((acc, item) => acc + (Number(item.netCents) || 0), 0);
  const hasMovement = safeSeries.some((s) => (Number(s.grossCents) || 0) > 0 || (Number(s.refundedCents) || 0) > 0);

  let defaultActive = -1;
  for (let i = safeSeries.length - 1; i >= 0; i -= 1) {
    if ((Number(safeSeries[i].grossCents) || 0) > 0 || (Number(safeSeries[i].netCents) || 0) > 0) {
      defaultActive = i;
      break;
    }
  }
  if (defaultActive < 0 && safeSeries.length > 0) defaultActive = safeSeries.length - 1;

  const headerHtml = `
    <div class="chart-header">
      <div>
        <span class="kpi-label">Fluxo de Caixa</span>
        <div class="chart-total tabular-nums">${escapeHtml(formatMoney(totalNetCents, currency))}</div>
      </div>
      <div class="granularity-toggle" role="group" aria-label="Granularidade do fluxo">
        <button type="button" class="granularity-btn ${granularity === "daily" ? "active" : ""}" data-granularity="daily">Diário</button>
        <button type="button" class="granularity-btn ${granularity === "monthly" ? "active" : ""}" data-granularity="monthly">Mensal</button>
      </div>
    </div>
  `;

  if (!safeSeries.length || !hasMovement) {
    container.innerHTML = `
      ${headerHtml}
      <div class="chart-empty">
        <strong>Sem movimentação financeira no período</strong>
        <span class="muted">As barras de receita aparecerão assim que novas vendas forem registradas.</span>
      </div>
    `;
    bindGranularityButtons(container, onToggleGranularity);
    return;
  }

  const W = 680;
  const H = 240;
  const padL = 56;
  const padR = 14;
  const padT = 18;
  const padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxCents = Math.max(10000, ...safeSeries.map((d) => Math.max(0, Number(d.grossCents) || 0, Number(d.netCents) || 0)));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const stepW = plotW / safeSeries.length;
  const barW = Math.max(8, Math.min(34, stepW * 0.62));
  const labelInterval = safeSeries.length > 16 ? Math.ceil(safeSeries.length / 10) : 1;

  const gridSvg = ticks
    .map((t) => {
      const y = padT + plotH - t * plotH;
      const val = Math.round(maxCents * t);
      return `
        <line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"
          stroke="var(--chart-grid)" stroke-dasharray="3 4" />
        <text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="var(--text-muted)" font-size="10.5">
          ${escapeHtml(formatCompactMoney(val, currency))}
        </text>
      `;
    })
    .join("");

  const barsSvg = safeSeries
    .map((item, idx) => {
      const val = Math.max(0, Number(item.netCents) || 0);
      const rawH = (val / maxCents) * plotH;
      const barH = val > 0 ? Math.max(6, rawH) : 3;
      const x = padL + idx * stepW + (stepW - barW) / 2;
      const y = padT + plotH - barH;
      const isActive = idx === defaultActive;
      const showLabel = idx % labelInterval === 0 || idx === safeSeries.length - 1;
      const cx = x + barW / 2;

      return `
        <g class="cashflow-bar-hit" data-bar-idx="${idx}">
          <rect x="${(padL + idx * stepW).toFixed(1)}" y="${padT}" width="${stepW.toFixed(1)}" height="${plotH}" fill="transparent" />
          <rect class="cf-bar-rect" data-idx="${idx}" x="${x.toFixed(1)}" y="${y.toFixed(1)}"
            width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="8"
            fill="${isActive ? "url(#cfBarActive)" : "url(#cfBarIdle)"}" />
          <circle class="cf-bar-dot ${isActive ? "" : "hidden"}" data-idx="${idx}"
            cx="${cx.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5"
            fill="var(--accent-orange)" stroke="var(--bg-surface)" stroke-width="2" />
          ${
            showLabel
              ? `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="var(--text-muted)" font-size="10.5">${escapeHtml(item.label || item.key)}</text>`
              : ""
          }
        </g>
      `;
    })
    .join("");

  container.innerHTML = `
    ${headerHtml}
    <div class="cashflow-wrap">
      <svg class="cashflow-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico de Fluxo de Caixa">
        <defs>
          <linearGradient id="cfBarIdle" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--chart-bar-idle)" />
            <stop offset="100%" stop-color="var(--chart-bar-idle-end)" />
          </linearGradient>
          <linearGradient id="cfBarActive" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--accent-orange)" />
            <stop offset="100%" stop-color="rgba(255, 107, 0, 0.18)" />
          </linearGradient>
        </defs>
        ${gridSvg}
        ${barsSvg}
      </svg>
      <div class="chart-tooltip hidden" id="cf-tooltip"></div>
    </div>
  `;

  bindGranularityButtons(container, onToggleGranularity);
  const tooltip = container.querySelector("#cf-tooltip");
  const wrap = container.querySelector(".cashflow-wrap");

  const activateBar = (idx, showTooltip = true) => {
    const item = safeSeries[idx];
    if (!item) return;
    container.querySelectorAll(".cf-bar-rect").forEach((el) => {
      el.setAttribute("fill", Number(el.dataset.idx) === idx ? "url(#cfBarActive)" : "url(#cfBarIdle)");
    });
    container.querySelectorAll(".cf-bar-dot").forEach((el) => {
      el.classList.toggle("hidden", Number(el.dataset.idx) !== idx);
    });
    if (!tooltip || !showTooltip || !wrap) return;
    tooltip.innerHTML = `
      <div class="chart-tooltip-title">${escapeHtml(item.label || item.key)}</div>
      <div class="chart-tooltip-row"><span>Receita Bruta</span><strong class="tabular-nums">${escapeHtml(formatMoney(item.grossCents || 0, currency))}</strong></div>
      <div class="chart-tooltip-row"><span>Reembolsos</span><strong class="tabular-nums">${escapeHtml(formatMoney(item.refundedCents || 0, currency))}</strong></div>
      <div class="chart-tooltip-row"><span>Líquido</span><strong class="tabular-nums">${escapeHtml(formatMoney(item.netCents || 0, currency))}</strong></div>
      <div class="chart-tooltip-row"><span>Vendas</span><strong class="tabular-nums">${Number(item.salesCount || 0)}</strong></div>
    `;
    const pctLeft = Math.min(72, Math.max(4, ((idx + 0.5) / safeSeries.length) * 100 - 10));
    tooltip.style.left = `${pctLeft}%`;
    tooltip.style.top = "8px";
    tooltip.classList.remove("hidden");
  };

  container.querySelectorAll(".cashflow-bar-hit").forEach((group) => {
    const idx = Number(group.dataset.barIdx);
    group.addEventListener("mouseenter", () => activateBar(idx, true));
    group.addEventListener("click", () => activateBar(idx, true));
  });
  wrap?.addEventListener("mouseleave", () => {
    tooltip?.classList.add("hidden");
    if (defaultActive >= 0) activateBar(defaultActive, false);
  });
}

function bindGranularityButtons(container, onToggleGranularity) {
  if (typeof onToggleGranularity !== "function") return;
  container.querySelectorAll("[data-granularity]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.granularity;
      if (next) onToggleGranularity(next);
    });
  });
}

export function renderPlanDonutChart(container, byPlan = [], opts = {}) {
  if (!container) return;
  const { currency = "BRL", totalApproved = 0 } = opts;
  const items = Array.isArray(byPlan) ? byPlan.filter((p) => (Number(p.revenueCents) || 0) > 0 || (Number(p.count) || 0) > 0) : [];
  const totalRevenue = items.reduce((sum, p) => sum + (Number(p.revenueCents) || 0), 0);
  const totalCount = totalApproved || items.reduce((sum, p) => sum + (Number(p.count) || 0), 0);

  if (!items.length || totalRevenue <= 0) {
    container.innerHTML = `
      <div class="chart-header">
        <div>
          <span class="kpi-label">Receita por Plano</span>
          <p class="muted">Distribuição das assinaturas aprovadas</p>
        </div>
      </div>
      <div class="chart-empty" style="min-height:140px">
        <span>Sem vendas aprovadas no período.</span>
      </div>
    `;
    return;
  }

  const r = 64;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const segmentsHtml = items
    .map((p, idx) => {
      const frac = totalRevenue > 0 ? (Number(p.revenueCents) || 0) / totalRevenue : 0;
      const segLen = Math.max(2, frac * circ - 2);
      const color = PLAN_COLORS[p.plan_tier] || FALLBACK_COLORS[idx % FALLBACK_COLORS.length];
      const dashOffset = -offset;
      offset += frac * circ;
      return `
        <circle class="donut-seg" data-plan-idx="${idx}" cx="90" cy="90" r="${r}"
          fill="none" stroke="${color}" stroke-width="22" stroke-linecap="butt"
          stroke-dasharray="${segLen.toFixed(2)} ${circ.toFixed(2)}"
          stroke-dashoffset="${dashOffset.toFixed(2)}"
          transform="rotate(-90 90 90)" style="transition:opacity .15s ease, stroke-width .15s ease" />
      `;
    })
    .join("");

  const legendHtml = items
    .map((p, idx) => {
      const color = PLAN_COLORS[p.plan_tier] || FALLBACK_COLORS[idx % FALLBACK_COLORS.length];
      return `
        <div class="donut-legend-item" data-plan-idx="${idx}">
          <div class="donut-legend-left">
            <span class="donut-swatch" style="background:${color}"></span>
            <span>${escapeHtml(p.label || p.plan_tier)}</span>
          </div>
          <div class="tabular-nums" style="text-align:right">
            <strong>${escapeHtml(formatMoney(p.revenueCents, currency))}</strong>
            <div class="muted" style="font-size:10.5px">${Number(p.percent || 0).toFixed(1)}% · ${Number(p.count || 0)}x</div>
          </div>
        </div>
      `;
    })
    .join("");

  container.innerHTML = `
    <div class="chart-header">
      <div>
        <span class="kpi-label">Receita por Plano</span>
        <p class="muted">Participação no faturamento bruto</p>
      </div>
    </div>
    <div class="donut-layout">
      <div class="donut-svg-wrap">
        <svg viewBox="0 0 180 180" width="146" height="146" role="img" aria-label="Donut de receita por plano">
          <circle cx="90" cy="90" r="${r}" fill="none" stroke="var(--bg-surface-3)" stroke-width="22" />
          ${segmentsHtml}
        </svg>
        <div class="donut-center">
          <strong class="tabular-nums">${totalCount}</strong>
          <span>vendas</span>
        </div>
      </div>
      <div class="donut-legend">${legendHtml}</div>
    </div>
  `;

  const highlight = (activeIdx) => {
    container.querySelectorAll(".donut-seg").forEach((seg) => {
      const match = activeIdx === null || Number(seg.dataset.planIdx) === activeIdx;
      seg.style.opacity = match ? "1" : "0.28";
      seg.setAttribute("stroke-width", activeIdx !== null && Number(seg.dataset.planIdx) === activeIdx ? "25" : "22");
    });
    container.querySelectorAll(".donut-legend-item").forEach((row) => {
      row.classList.toggle("active", activeIdx !== null && Number(row.dataset.planIdx) === activeIdx);
    });
  };

  container.querySelectorAll(".donut-legend-item, .donut-seg").forEach((el) => {
    const idx = Number(el.dataset.planIdx);
    el.addEventListener("mouseenter", () => highlight(idx));
    el.addEventListener("mouseleave", () => highlight(null));
  });
}
