import {
  api,
  bindFloatingTooltips,
  closeDrawer,
  confirmDialog,
  copyText,
  ensureStylesheet,
  escapeHtml,
  formatDateTime,
  formatMoney,
  hideFloatingTooltip,
  openDrawer,
  setButtonLoading,
  showToast,
} from "./core/api.js";
import { refreshDashboardData, store } from "./core/state.js";
import { registerView } from "./core/router.js";

ensureStylesheet("/styles/views.css");

const ICON_EYE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const ICON_TRASH = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;

const PLAN_LABELS = {
  individual: "Individual",
  agencia_10: "Agência 10",
  agencia_ilimitada: "Agência Ilimitada",
};

const LEGACY_GATEWAYS = [
  { id: "hotmart", name: "Hotmart", field: "hotmartHottok", header: "X-Hotmart-Hottok", hint: "Hottok" },
  { id: "kiwify", name: "Kiwify", field: "kiwifyToken", header: "X-Kiwify-Token", hint: "Token / Secret HMAC" },
  { id: "ticto", name: "Ticto", field: "tictoToken", header: "X-Ticto-Token", hint: "Token Secreto" },
  { id: "stripe", name: "Stripe", field: "stripeSecret", header: "Stripe-Signature", hint: "Signing Secret" },
  { id: "cakto", name: "Cakto", field: "caktoSecret", header: "X-Cakto-Secret", hint: "Secret" },
  { id: "kirvano", name: "Kirvano", field: "kirvanoToken", header: "Security-Token", hint: "Token" },
  { id: "generic", name: "Genérico HMAC", field: "genericHmacSecret", header: "X-Webhook-Signature", hint: "HMAC Secret" },
];

let activeListenPoller = null;
let activeCountdownTimer = null;

function stopListenTimers() {
  if (activeListenPoller) {
    clearInterval(activeListenPoller);
    activeListenPoller = null;
  }
  if (activeCountdownTimer) {
    clearInterval(activeCountdownTimer);
    activeCountdownTimer = null;
  }
}

function platformLogoHtml(platform) {
  const logoSrc = escapeHtml(platform?.logo || `/logos-integracoes/${platform?.id || "custom"}.svg`);
  const nameEsc = escapeHtml(platform?.name || platform?.platformName || "Plataforma");
  return `<span class="platform-brand-lockup"><img src="${logoSrc}" alt="" class="platform-icon-img" loading="lazy" /><span class="platform-brand-name">${nameEsc}</span></span>`;
}

function statusBadgeHtml(d) {
  const label =
    d.status_label ||
    (d.action === "test_captured"
      ? "teste"
      : d.action === "pending_mapping"
        ? "aguardando mapeamento"
        : d.action === "issued_or_updated"
          ? d.is_simulated
            ? "simulado"
            : "aprovado"
          : d.action === "revoked"
            ? "reembolso"
            : d.action === "error" || d.action === "auth_error"
              ? "erro"
              : "ignorado");
  const clsMap = {
    aprovado: "pill-active",
    reembolso: "pill-revoked",
    erro: "pill-revoked",
    simulado: "pill-warn",
    "aguardando mapeamento": "pill-warn",
    teste: "pill-info",
    ignorado: "pill-info",
  };
  return `<span class="pill ${clsMap[label] || "pill-info"}">${escapeHtml(label.toUpperCase())}</span>`;
}

function fieldSelectHtml(id, value, fields, placeholder) {
  if (!fields || fields.length === 0) {
    return `<input type="text" id="${escapeHtml(id)}" value="${escapeHtml(value || "")}" placeholder="${escapeHtml(placeholder)}" class="mono-input" />`;
  }
  const hasVal = Boolean(value);
  const inFields = fields.some((f) => f.path === value);
  return `
    <select id="${escapeHtml(id)}">
      <option value="">Não mapear</option>
      ${hasVal && !inFields ? `<option value="${escapeHtml(value)}" selected>${escapeHtml(value)} (manual)</option>` : ""}
      ${fields
        .map(
          (f) =>
            `<option value="${escapeHtml(f.path)}" ${f.path === value ? "selected" : ""}>${escapeHtml(f.path)} = ${escapeHtml(String(f.value).slice(0, 46))}</option>`,
        )
        .join("")}
    </select>
  `;
}

async function confirmAndDeleteDelivery(d, onDeleted) {
  const targetId = d?.id || d?.delivery_key;
  if (!targetId) return;
  hideFloatingTooltip();
  const ok = await confirmDialog({
    title: "Excluir log de entrega?",
    message: `Apaga o evento ${d.event_name || "-"} (${String(d.provider || "webhook").toUpperCase()}) do histórico e remove seu valor do faturamento se for uma venda aprovada, sem revogar nem excluir a licença do cliente.`,
    confirmLabel: "Excluir Log",
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/admin/webhooks/deliveries/${encodeURIComponent(targetId)}/delete`, { method: "POST" });
    showToast("Log de entrega excluído!", "success");
    await refreshDashboardData(["deliveries", "analytics", "integrations", "overview"]);
    if (typeof onDeleted === "function") await onDeleted();
  } catch (err) {
    showToast(`Erro ao excluir log: ${err.message}`, "error");
  }
}

async function openDeliveryInspector(deliveryId, onAfterAction) {
  try {
    const res = await api(`/api/admin/webhooks/deliveries/${encodeURIComponent(deliveryId)}`);
    const d = res.delivery;
    const prettyJson = JSON.stringify(d.raw_payload ?? d.summary ?? {}, null, 2);
    const metaItem = (lbl, val) =>
      `<div class="inspector-meta-item"><div class="inspector-meta-label">${lbl}</div><div class="inspector-meta-val tabular-nums">${val}</div></div>`;
    const isPendingMap = d.action === "pending_mapping" && d.integration_id;

    openDrawer({
      title: `Entrega ${String(d.provider || "WEBHOOK").toUpperCase()}`,
      subtitle: d.transaction_id || d.id,
      bodyHtml: `
        <div class="inspector-meta-grid">
          ${metaItem("Status / HTTP", `${statusBadgeHtml(d)} <span class="muted">HTTP ${escapeHtml(d.http_status ?? 200)}</span>`)}
          ${metaItem("Transação", escapeHtml(d.transaction_id || "-"))}
          ${metaItem("Comprador", escapeHtml(d.buyer_email || "-"))}
          ${metaItem("Produto / Oferta", escapeHtml(d.product_id || d.offer_name || "-"))}
          ${metaItem("Valor / Plano", `${escapeHtml(formatMoney(d.amount_cents || 0, d.currency || "BRL"))} · ${escapeHtml(d.plan_tier || "-")}`)}
          ${metaItem("Licença", escapeHtml(d.license_key || "-"))}
        </div>
        ${d.error_detail ? `<div class="alert alert-danger"><strong>Detalhe do erro:</strong> ${escapeHtml(d.error_detail)}</div>` : ""}
        ${
          isPendingMap
            ? `<div class="panel-card mb-8" style="background:var(--bg-surface-2);border-color:var(--accent-warn);">
                <h3 style="margin:0 0 6px;font-size:14px;">Produto aguardando mapeamento</h3>
                <p class="muted" style="margin-bottom:10px;">Crie a regra abaixo para mapear este produto e liberar a licença imediatamente.</p>
                <form id="resolve-pending-form" class="form-stack">
                  <div class="grid-2">
                    <label class="field"><span>Identificador do produto</span>
                      <input type="text" id="rp-match-value" value="${escapeHtml(d.product_id || d.offer_name || "")}" required />
                    </label>
                    <label class="field"><span>Ação</span>
                      <select id="rp-action">
                        <option value="grant_plan">Liberar Plano</option>
                        <option value="add_upgrades_only">Apenas Adicionar Upgrades</option>
                      </select>
                    </label>
                  </div>
                  <div class="grid-2">
                    <label class="field"><span>Plano</span>
                      <select id="rp-plan">
                        <option value="individual">Individual</option>
                        <option value="agencia_10">Agência 10</option>
                        <option value="agencia_ilimitada">Agência Ilimitada</option>
                      </select>
                    </label>
                    <div class="field"><span>Upgrades</span>
                      <div class="check-row">
                        <label class="check-pill"><input type="checkbox" id="rp-upg-bonus" /> Bônus</label>
                        <label class="check-pill"><input type="checkbox" id="rp-upg-video" /> Vídeo</label>
                      </div>
                    </div>
                  </div>
                  <button type="submit" class="btn btn-primary btn-sm" id="btn-resolve-pending">Salvar Regra & Liberar Licença</button>
                </form>
              </div>`
            : ""
        }
        <div class="row-between mb-8">
          <strong>Payload Bruto Recebido</strong>
          <div class="btn-row">
            <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-raw-json">Copiar JSON</button>
            ${
              d.integration_id
                ? ""
                : `<button type="button" class="btn btn-primary btn-sm" id="btn-replay-delivery">Reprocessar (Replay)</button>`
            }
            <button type="button" class="btn btn-danger btn-sm" id="btn-delete-delivery">Excluir Log</button>
          </div>
        </div>
        <pre class="json-viewer">${escapeHtml(prettyJson)}</pre>`,
      onMount: (root) => {
        root.querySelector("#btn-copy-raw-json")?.addEventListener("click", () => void copyText(prettyJson, "Payload JSON copiado!"));
        root.querySelector("#btn-delete-delivery")?.addEventListener("click", () => {
          void confirmAndDeleteDelivery(d, async () => {
            closeDrawer();
            if (typeof onAfterAction === "function") await onAfterAction();
          });
        });
        root.querySelector("#btn-replay-delivery")?.addEventListener("click", async (e) => {
          const btn = e.currentTarget;
          setButtonLoading(btn, true, "Reprocessando...");
          try {
            const rp = await api(`/api/admin/webhooks/deliveries/${encodeURIComponent(d.id)}/replay`, { method: "POST" });
            showToast(`Replay concluído! Ação: ${rp.result?.action || "ok"}`, "success");
            await refreshDashboardData(["deliveries", "analytics", "licenses", "overview"]);
            if (typeof onAfterAction === "function") await onAfterAction();
            await openDeliveryInspector(d.id, onAfterAction);
          } catch (err) {
            showToast(`Erro no replay: ${err.message}`, "error");
            setButtonLoading(btn, false);
          }
        });
        root.querySelector("#resolve-pending-form")?.addEventListener("submit", async (e) => {
          e.preventDefault();
          const btn = root.querySelector("#btn-resolve-pending");
          setButtonLoading(btn, true, "Liberando...");
          const addUpgrades = [];
          if (root.querySelector("#rp-upg-bonus")?.checked) addUpgrades.push("bonus");
          if (root.querySelector("#rp-upg-video")?.checked) addUpgrades.push("video");
          try {
            const resResolve = await api(
              `/api/admin/integrations/${encodeURIComponent(d.integration_id)}/resolve-pending/${encodeURIComponent(d.id)}`,
              {
                method: "POST",
                body: JSON.stringify({
                  matchField: d.product_id ? "product_id" : "offer_name",
                  matchValue: root.querySelector("#rp-match-value").value.trim(),
                  ruleAction: root.querySelector("#rp-action").value,
                  planTier: root.querySelector("#rp-plan").value,
                  addUpgrades,
                  saveRule: true,
                }),
              },
            );
            showToast(`Licença liberada: ${resResolve.result?.license_key || "ok"}`, "success");
            closeDrawer();
            await refreshDashboardData(["deliveries", "integrations", "analytics", "licenses", "overview"]);
            if (typeof onAfterAction === "function") await onAfterAction();
          } catch (err) {
            showToast(`Erro ao resolver pendência: ${err.message}`, "error");
            setButtonLoading(btn, false);
          }
        });
      },
    });
  } catch (err) {
    showToast(`Erro ao carregar entrega: ${err.message}`, "error");
  }
}

registerView("webhooks", {
  async render(root, ctx) {
    stopListenTimers();
    if (!store.get().platforms?.length || !store.get().integrations) {
      await refreshDashboardData(["platforms", "integrations", "deliveries", "webhooksConfig"]);
    }

    let state = store.get();
    let platforms = state.platforms || [];
    let integrations = state.integrations || [];
    let subMode = ctx.params?.mode || (ctx.params?.focus === "simulate" ? "simulator" : "list");
    let activePlatformId = ctx.params?.platformId || null;
    let activeIntegrationId = ctx.params?.integrationId || null;
    let catalogCategory = "all";
    let catalogSearch = "";
    let filterProvider = "";
    let filterStatus = ctx.params?.status || "";
    let filterQ = "";
    let currentDeliveries = state.deliveries || [];

    if (ctx.params?.status === "pending_mapping") subMode = "deliveries";

    async function renderMode() {
      stopListenTimers();
      state = store.get();
      platforms = state.platforms || [];
      integrations = state.integrations || [];

      if (subMode === "catalog") return renderCatalog();
      if (subMode === "config") return await renderConfigWizard();
      if (subMode === "deliveries") return renderDeliveriesTab();
      if (subMode === "simulator") return renderSimulatorTab();
      return renderIntegrationsList();
    }

    function headerTabsHtml(activeTab) {
      return `
        <div class="view-header">
          <div>
            <h1>Integrações & Webhooks</h1>
            <p class="muted">Conecte Greenn, Appmax e mais 12 plataformas com captura ao vivo de eventos de teste.</p>
          </div>
          <div class="btn-row">
            <div class="tab-switch">
              <button type="button" class="tab-btn ${activeTab === "list" ? "active" : ""}" data-wh-tab="list">Integrações (${integrations.length})</button>
              <button type="button" class="tab-btn ${activeTab === "deliveries" ? "active" : ""}" data-wh-tab="deliveries">Entregas & Logs</button>
              <button type="button" class="tab-btn ${activeTab === "simulator" ? "active" : ""}" data-wh-tab="simulator">Simulador</button>
            </div>
            <button type="button" class="btn btn-primary" id="btn-new-integration">+ Nova Integração</button>
          </div>
        </div>
      `;
    }

    function bindHeaderTabs() {
      root.querySelectorAll("[data-wh-tab]").forEach((btn) => {
        btn.addEventListener("click", () => {
          subMode = btn.dataset.whTab;
          void renderMode();
        });
      });
      root.querySelector("#btn-new-integration")?.addEventListener("click", () => {
        subMode = "catalog";
        void renderMode();
      });
    }

    function renderIntegrationsList() {
      const pendingCount = (store.get().deliveries || []).filter((d) => d.action === "pending_mapping").length;
      const cfg = store.get().webhooksConfig || { urls: {}, secretsConfigured: {}, productMap: {} };

      root.innerHTML = `
        <div class="view-stack">
          ${headerTabsHtml("list")}
          ${
            pendingCount > 0
              ? `<div class="alert alert-warn row-between">
                  <span><strong>${pendingCount} venda(s) aguardando mapeamento de produto.</strong> Revise para liberar as licenças.</span>
                  <button type="button" class="btn btn-secondary btn-sm" id="btn-go-pending">Ver Pendentes</button>
                </div>`
              : ""
          }
          ${
            integrations.length === 0
              ? `<div class="empty-state-card">
                  <div class="empty-state-icon">⚡</div>
                  <h2 style="margin:0;font-size:18px;">Nenhuma integração configurada ainda</h2>
                  <p class="muted" style="max-width:52ch;">Conecte sua conta da Greenn, Appmax, Hotmart, Kiwify ou outra plataforma em menos de 2 minutos usando captura de evento de teste.</p>
                  <button type="button" class="btn btn-primary mt-8" id="btn-empty-new-int">+ Conectar Primeira Plataforma</button>
                </div>`
              : `<div class="integration-grid">
                  ${integrations
                    .map((intItem) => {
                      const modeText =
                        intItem.deliveryMode === "direct"
                          ? `Plano fixo: ${PLAN_LABELS[intItem.fixedPlanTier] || intItem.fixedPlanTier}`
                          : `Roteamento (${intItem.rulesCount} ${intItem.rulesCount === 1 ? "regra" : "regras"})`;
                      return `
                        <article class="integration-card">
                          <div class="integration-card-head">
                            <div style="min-width:0;">
                              ${platformLogoHtml({ id: intItem.platform, logo: intItem.platformLogo, name: intItem.platformName })}
                              <div class="mt-8" style="font-weight:700;font-size:15px;">${escapeHtml(intItem.name)}</div>
                              <div class="muted">${escapeHtml(modeText)}</div>
                            </div>
                            <span class="pill ${intItem.isActive ? "pill-active" : "pill-warn"}">${intItem.isActive ? "Ativa" : "Pausada"}</span>
                          </div>
                          ${
                            !intItem.hasMapping
                              ? `<div class="alert alert-warn" style="margin:0;padding:8px 10px;">Mapeamento de campos pendente — clique em Configurar.</div>`
                              : ""
                          }
                          <div class="gateway-url-row">
                            <input type="text" readonly value="${escapeHtml(intItem.webhookUrl)}" aria-label="URL ${escapeHtml(intItem.name)}" />
                            <button type="button" class="btn btn-secondary btn-sm" data-copy-int="${escapeHtml(intItem.webhookUrl)}">Copiar</button>
                          </div>
                          <div class="row-between integration-meta-row">
                            <span class="tabular-nums">${intItem.totalEvents} eventos${intItem.pendingCount ? ` · ${intItem.pendingCount} pendente(s)` : ""}</span>
                            <div class="btn-row">
                              <button type="button" class="btn btn-danger btn-sm" data-del-int="${escapeHtml(intItem.id)}" data-del-name="${escapeHtml(intItem.name)}">Excluir</button>
                              <button type="button" class="btn btn-primary btn-sm" data-cfg-int="${escapeHtml(intItem.id)}">Configurar →</button>
                            </div>
                          </div>
                        </article>`;
                    })
                    .join("")}
                </div>`
          }

          <details class="details-box">
            <summary>Webhooks Legados (URL única por gateway — compatibilidade retroativa)</summary>
            <p class="muted" style="margin-bottom:12px;">Use esta seção apenas se você já possui integrações antigas apontando para <code>/api/webhooks/sales?provider=...</code>.</p>
            <div class="gateway-grid">
              ${LEGACY_GATEWAYS.map((gw) => {
                const url = cfg.urls?.[gw.id] || `${window.location.origin}/api/webhooks/sales?provider=${gw.id}`;
                const ok = Boolean(cfg.secretsConfigured?.[gw.id]);
                return `
                  <div class="gateway-card">
                    <div class="gateway-card-head">
                      <span class="gateway-name">${escapeHtml(gw.name)}</span>
                      <span class="status-indicator ${ok ? "ok" : "pending"}">${ok ? "Configurado" : "Pendente"}</span>
                    </div>
                    <div class="gateway-url-row">
                      <input type="text" readonly value="${escapeHtml(url)}" />
                      <button type="button" class="btn btn-secondary btn-sm" data-copy-int="${escapeHtml(url)}">Copiar</button>
                    </div>
                    <label class="field">
                      <span>${escapeHtml(gw.hint)} (${escapeHtml(gw.header)})</span>
                      <input type="password" data-legacy-secret="${escapeHtml(gw.field)}" placeholder="${ok ? "•••••••• (mantém atual)" : "Cole o token/secret"}" />
                    </label>
                  </div>`;
              }).join("")}
            </div>
            <div class="btn-row mt-12">
              <button type="button" class="btn btn-secondary btn-sm" id="btn-save-legacy-secrets">Salvar Tokens Legados</button>
            </div>
          </details>
        </div>
      `;

      bindHeaderTabs();
      root.querySelector("#btn-empty-new-int")?.addEventListener("click", () => {
        subMode = "catalog";
        void renderMode();
      });
      root.querySelector("#btn-go-pending")?.addEventListener("click", () => {
        filterStatus = "pending_mapping";
        subMode = "deliveries";
        void renderMode();
      });
      root.querySelectorAll("[data-copy-int]").forEach((b) => {
        b.addEventListener("click", () => void copyText(b.dataset.copyInt, "URL do webhook copiada!"));
      });
      root.querySelectorAll("[data-cfg-int]").forEach((b) => {
        b.addEventListener("click", () => {
          activeIntegrationId = b.dataset.cfgInt;
          activePlatformId = null;
          subMode = "config";
          void renderMode();
        });
      });
      root.querySelectorAll("[data-del-int]").forEach((b) => {
        b.addEventListener("click", async () => {
          const confirmed = await confirmDialog({
            title: `Excluir "${b.dataset.delName}"?`,
            message: "O webhook deixará de receber novas vendas imediatamente. As licenças já emitidas permanecem ativas.",
            confirmLabel: "Excluir Integração",
            danger: true,
          });
          if (!confirmed) return;
          try {
            await api(`/api/admin/integrations/${encodeURIComponent(b.dataset.delInt)}`, { method: "DELETE" });
            showToast("Integração excluída.", "success");
            await refreshDashboardData(["integrations", "deliveries"]);
            void renderMode();
          } catch (err) {
            showToast(err.message, "error");
          }
        });
      });
      root.querySelector("#btn-save-legacy-secrets")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        const payload = {};
        root.querySelectorAll("[data-legacy-secret]").forEach((inp) => {
          if (inp.value.trim()) payload[inp.dataset.legacySecret] = inp.value.trim();
        });
        setButtonLoading(btn, true, "Salvando...");
        try {
          await api("/api/admin/webhooks/config", { method: "PUT", body: JSON.stringify(payload) });
          showToast("Tokens legados salvos no Cofre!", "success");
          await refreshDashboardData(["webhooksConfig"]);
        } catch (err) {
          showToast(err.message, "error");
        } finally {
          setButtonLoading(btn, false);
        }
      });
    }

    function renderCatalog() {
      const cats = [
        { id: "all", label: "Todas" },
        { id: "destaques", label: "Destaques (Greenn & Appmax)" },
        { id: "checkouts_br", label: "Checkouts BR" },
        { id: "pagamentos", label: "Pagamentos" },
        { id: "automacao", label: "Automação / API" },
      ];
      const filtered = platforms.filter((p) => {
        if (catalogCategory !== "all" && p.category !== catalogCategory) return false;
        if (!catalogSearch.trim()) return true;
        return `${p.name} ${p.description} ${p.categoryLabel}`.toLowerCase().includes(catalogSearch.trim().toLowerCase());
      });

      root.innerHTML = `
        <div class="view-stack">
          <div class="view-header">
            <div class="btn-row">
              <button type="button" class="btn btn-ghost btn-sm" id="btn-back-to-list">← Voltar</button>
              <div>
                <h1>Escolha a Plataforma de Venda</h1>
                <p class="muted">Selecione o checkout ou gateway para gerar o webhook e capturar os campos automaticamente.</p>
              </div>
            </div>
          </div>
          <div class="toolbar-row">
            <input type="search" id="cat-search" class="toolbar-search" value="${escapeHtml(catalogSearch)}" placeholder="Buscar Greenn, Appmax, Hotmart, Eduzz..." />
            <div class="tab-switch">
              ${cats.map((c) => `<button type="button" class="tab-btn ${catalogCategory === c.id ? "active" : ""}" data-cat="${c.id}">${escapeHtml(c.label)}</button>`).join("")}
            </div>
          </div>
          <div class="platform-catalog-grid">
            ${filtered
              .map(
                (p) => `
                  <button type="button" class="platform-card" data-pick-platform="${escapeHtml(p.id)}">
                    <div class="row-between">
                      ${platformLogoHtml(p)}
                      <span class="pill pill-info">${escapeHtml(p.categoryLabel)}</span>
                    </div>
                    <div>
                      <h2 class="platform-card-title">${escapeHtml(p.name)}</h2>
                      <p class="platform-card-desc">${escapeHtml(p.description)}</p>
                    </div>
                    <span class="platform-card-cta">Configurar ${escapeHtml(p.name)} →</span>
                  </button>`,
              )
              .join("")}
          </div>
        </div>
      `;

      root.querySelector("#btn-back-to-list")?.addEventListener("click", () => {
        subMode = "list";
        void renderMode();
      });
      root.querySelector("#cat-search")?.addEventListener("input", (e) => {
        catalogSearch = e.target.value;
        renderCatalog();
        const inp = root.querySelector("#cat-search");
        if (inp) {
          inp.focus();
          inp.setSelectionRange(inp.value.length, inp.value.length);
        }
      });
      root.querySelectorAll("[data-cat]").forEach((b) => {
        b.addEventListener("click", () => {
          catalogCategory = b.dataset.cat;
          renderCatalog();
        });
      });
      root.querySelectorAll("[data-pick-platform]").forEach((b) => {
        b.addEventListener("click", () => {
          activePlatformId = b.dataset.pickPlatform;
          activeIntegrationId = null;
          subMode = "config";
          void renderMode();
        });
      });
    }

    async function renderConfigWizard() {
      let integration = null;
      let listenState = { listening: false, secondsLeft: 0, payload: null, fields: [], suggestedMapping: null, preview: null };
      let intEvents = [];

      if (activeIntegrationId) {
        try {
          const detail = await api(`/api/admin/integrations/${encodeURIComponent(activeIntegrationId)}`);
          integration = detail.integration;
          listenState = detail.listenState || listenState;
          intEvents = detail.events || [];
          activePlatformId = integration.platform;
        } catch (err) {
          showToast(err.message, "error");
          subMode = "list";
          return renderMode();
        }
      }

      const platform = platforms.find((p) => p.id === activePlatformId) || platforms[0];
      if (!platform) return;

      let formName = integration?.name || `${platform.name} Principal`;
      let formHeaderSecret = "";
      let deliveryMode = integration?.deliveryMode || (platform.id === "greenn" ? "direct" : "product_map");
      let fixedPlanTier = integration?.fixedPlanTier || "individual";
      let fixedUpgrades = [...(integration?.fixedUpgrades || [])];
      let fixedDurationDays = integration?.fixedDurationDays || "";
      let sendEmail = integration ? Boolean(integration.sendEmail) : true;
      let sendWhatsapp = integration ? Boolean(integration.sendWhatsapp) : true;
      let isActive = integration ? Boolean(integration.isActive) : false;
      let splitNameMode = Boolean(integration?.fieldMapping?.firstName || integration?.fieldMapping?.lastName || platform.id === "appmax");
      let mapping = integration?.fieldMapping || {
        email: "",
        name: "",
        firstName: "",
        lastName: "",
        phone: "",
        externalId: "",
        statusField: "",
        amountField: "",
        amountUnit: platform.defaultAmountUnit || "decimal",
        currencyField: "",
        paymentMethodField: "",
        productIdField: "",
        offerNameField: "",
        approveValues: [...(platform.approveValues || [])],
        revokeValues: [...(platform.revokeValues || [])],
        renewValues: [...(platform.renewValues || [])],
      };
      let rules = (integration?.rules || []).map((r) => ({
        matchField: r.match_field || "product_id",
        matchValue: r.match_value || "",
        ruleAction: r.rule_action || "grant_plan",
        planTier: r.plan_tier || "individual",
        addUpgrades: r.addUpgrades || [],
        durationDays: r.duration_days || "",
        defaultAmountReais: r.default_amount_cents ? (Number(r.default_amount_cents) / 100).toFixed(2) : "",
        label: r.label || "",
      }));
      let showRawPayload = false;

      const drawWizard = () => {
        const fields = listenState.fields || [];
        const hasPayload = Boolean(listenState.payload);
        const extracted = listenState.preview?.extracted || null;
        const ruleRes = listenState.preview?.ruleResolution || null;

        root.innerHTML = `
          <div class="view-stack" style="max-width:1040px;">
            <div class="view-header">
              <div class="btn-row">
                <button type="button" class="btn btn-ghost btn-sm" id="btn-wiz-back">← Voltar</button>
                ${platformLogoHtml(platform)}
                <div>
                  <h1 style="font-size:18px;">${escapeHtml(formName)}</h1>
                  <p class="muted">${escapeHtml(platform.description)}</p>
                </div>
              </div>
              ${
                integration
                  ? `<span class="pill ${isActive ? "pill-active" : "pill-warn"}">${isActive ? "Integração Ativa" : "Pausada (Rascunho)"}</span>`
                  : ""
              }
            </div>

            <!-- Passo 1 -->
            <section class="step-wizard-card">
              <h2 class="step-card-title"><span class="step-number-badge">1</span> Identificação & Modo de Entrega</h2>
              <div class="grid-2">
                <label class="field">
                  <span>Nome desta integração</span>
                  <input type="text" id="wiz-name" value="${escapeHtml(formName)}" placeholder="Ex.: Greenn Funil Principal" />
                </label>
                <label class="field">
                  <span>${escapeHtml(platform.tokenLabel || "Token / Secret do Webhook")} ${integration?.hasHeaderSecret ? `<span class="pill pill-active" style="margin-left:6px;">Salvo no Cofre ✓</span>` : ""}</span>
                  <input type="password" id="wiz-header-secret" value="${escapeHtml(formHeaderSecret)}" placeholder="${integration?.hasHeaderSecret ? "•••••••• (mantém token atual)" : escapeHtml(platform.tokenPlaceholder || "Opcional: cole o token da plataforma")}" autocomplete="off" />
                </label>
              </div>
              <p class="muted" style="margin:-6px 0 0;">
                Cole o token configurado na ${escapeHtml(platform.name)} (ex.: Webhook Token da Greenn ou Hottok da Hotmart) para gerar uma <strong>URL limpa</strong> validada por ele, ou deixe em branco para usar token automático na URL.
              </p>

              <div class="field">
                <span>Canais automáticos ao liberar</span>
                <div class="check-row">
                  <label class="check-pill"><input type="checkbox" id="wiz-send-email" ${sendEmail ? "checked" : ""} /> Enviar E-mail</label>
                  <label class="check-pill"><input type="checkbox" id="wiz-send-wa" ${sendWhatsapp ? "checked" : ""} /> Enviar WhatsApp</label>
                </div>
              </div>

              <div class="mode-choice-grid">
                <button type="button" class="mode-choice-card ${deliveryMode === "direct" ? "active" : ""}" data-mode-pick="direct">
                  <strong>Entrega Direta (1 URL = 1 Plano fixo)</strong>
                  <span>Tudo que chegar nesta URL libera o plano escolhido abaixo. Zero mapeamento de SKU.</span>
                </button>
                <button type="button" class="mode-choice-card ${deliveryMode === "product_map" ? "active" : ""}" data-mode-pick="product_map">
                  <strong>Roteamento por Produto (1 URL = Vários Planos & Bumps)</strong>
                  <span>Ideal para Appmax, Stripe ou funis com vários planos, order bumps e upsells na mesma URL.</span>
                </button>
              </div>

              ${
                deliveryMode === "direct"
                  ? `<div class="grid-3">
                      <label class="field"><span>Plano liberado</span>
                        <select id="wiz-fixed-plan">
                          <option value="individual" ${fixedPlanTier === "individual" ? "selected" : ""}>Individual</option>
                          <option value="agencia_10" ${fixedPlanTier === "agencia_10" ? "selected" : ""}>Agência 10</option>
                          <option value="agencia_ilimitada" ${fixedPlanTier === "agencia_ilimitada" ? "selected" : ""}>Agência Ilimitada</option>
                        </select>
                      </label>
                      <label class="field"><span>Validade em dias (vazio = vitalícia)</span>
                        <input type="number" min="1" id="wiz-fixed-days" value="${escapeHtml(fixedDurationDays)}" placeholder="Ex.: 30 ou 365" />
                      </label>
                      <div class="field"><span>Upgrades incluídos</span>
                        <div class="check-row">
                          <label class="check-pill"><input type="checkbox" id="wiz-fix-bonus" ${fixedUpgrades.includes("bonus") ? "checked" : ""} /> Bônus</label>
                          <label class="check-pill"><input type="checkbox" id="wiz-fix-video" ${fixedUpgrades.includes("video") ? "checked" : ""} /> Vídeo</label>
                        </div>
                      </div>
                    </div>`
                  : ""
              }

              ${
                !integration
                  ? `<div class="btn-row">
                      <button type="button" class="btn btn-primary" id="btn-create-integration">Gerar URL do Webhook →</button>
                    </div>`
                  : ""
              }
            </section>

            ${
              integration
                ? `
            <!-- Passo 2 -->
            <section class="step-wizard-card">
              <h2 class="step-card-title"><span class="step-number-badge">2</span> URL do Webhook & Captura de Evento de Teste</h2>
              <p class="muted" style="margin:0;">Cole esta URL na ${escapeHtml(platform.name)} (${escapeHtml(platform.headerAuthHint)}). Depois clique em <strong>Receber evento de teste</strong>.</p>
              <div class="gateway-url-row">
                <input type="text" readonly value="${escapeHtml(integration.webhookUrl)}" id="wiz-url-input" />
                <button type="button" class="btn btn-secondary" id="btn-copy-wiz-url">Copiar URL</button>
                ${
                  integration.hasHeaderSecret && integration.webhookUrlWithToken
                    ? `<button type="button" class="btn btn-ghost btn-sm" id="btn-copy-wiz-url-token" title="Copiar alternativa com ?token= na URL">Com ?token</button>`
                    : ""
                }
              </div>
              <div class="muted">
                ${
                  integration.hasHeaderSecret
                    ? `Autenticação ativa pelo <strong>${escapeHtml(platform.tokenLabel || "Token da Plataforma")}</strong> salvo no Cofre AES-256-GCM.`
                    : `Autenticação automática via <code>?token=</code> na URL.`
                }
              </div>
              <div class="listen-banner">
                <div class="btn-row">
                  <button type="button" class="btn ${listenState.listening ? "btn-danger" : "btn-primary"}" id="btn-toggle-listen">
                    ${listenState.listening ? `<span class="listen-pulse"></span> Escutando... ${Math.floor((listenState.secondsLeft || 0) / 60)}:${String((listenState.secondsLeft || 0) % 60).padStart(2, "0")} (Cancelar)` : "📡 Receber evento de teste"}
                  </button>
                  <button type="button" class="btn btn-secondary btn-sm" id="btn-load-sample">Usar payload de exemplo (${escapeHtml(platform.name)})</button>
                </div>
                <span class="muted">${hasPayload ? `✓ Payload capturado (${fields.length} campos)` : "Nenhum payload capturado ainda"}</span>
              </div>

              ${
                hasPayload
                  ? `<details class="details-box" ${showRawPayload ? "open" : ""}>
                      <summary>Ver JSON bruto capturado (${fields.length} campos detectados)</summary>
                      <pre class="json-viewer">${escapeHtml(JSON.stringify(listenState.payload, null, 2))}</pre>
                    </details>`
                  : ""
              }
            </section>

            <!-- Passo 3 -->
            <section class="step-wizard-card">
              <div class="row-between">
                <h2 class="step-card-title"><span class="step-number-badge">3</span> Mapeamento Visual dos Campos</h2>
                <label class="check-pill">
                  <input type="checkbox" id="wiz-split-name" ${splitNameMode ? "checked" : ""} />
                  <span>Nome e Sobrenome separados (ex.: Appmax)</span>
                </label>
              </div>

              <div class="mapping-grid">
                <label class="field"><span>E-mail do comprador *</span>${fieldSelectHtml("map-email", mapping.email, fields, "client.email")}</label>
                ${
                  splitNameMode
                    ? `<div class="grid-2">
                        <label class="field"><span>Primeiro Nome</span>${fieldSelectHtml("map-first-name", mapping.firstName, fields, "data.customer.firstname")}</label>
                        <label class="field"><span>Sobrenome</span>${fieldSelectHtml("map-last-name", mapping.lastName, fields, "data.customer.lastname")}</label>
                      </div>`
                    : `<label class="field"><span>Nome completo</span>${fieldSelectHtml("map-name", mapping.name, fields, "client.name")}</label>`
                }
                <label class="field"><span>Telefone / WhatsApp</span>${fieldSelectHtml("map-phone", mapping.phone, fields, "client.cellphone")}</label>
                <label class="field"><span>ID da Transação</span>${fieldSelectHtml("map-tx", mapping.externalId, fields, "sale.id")}</label>
                <label class="field"><span>Campo de Status / Evento</span>${fieldSelectHtml("map-status", mapping.statusField, fields, "current_status")}</label>
                <div class="grid-2">
                  <label class="field"><span>Campo de Valor</span>${fieldSelectHtml("map-amount", mapping.amountField, fields, "sale.amount")}</label>
                  <label class="field"><span>Formato do Valor</span>
                    <select id="map-amount-unit">
                      <option value="decimal" ${mapping.amountUnit === "decimal" ? "selected" : ""}>Reais / Decimal (497.00)</option>
                      <option value="cents" ${mapping.amountUnit === "cents" ? "selected" : ""}>Centavos (49700)</option>
                    </select>
                  </label>
                </div>
                <label class="field"><span>Método de Pagamento</span>${fieldSelectHtml("map-method", mapping.paymentMethodField, fields, "payment_method")}</label>
                <label class="field"><span>Moeda</span>${fieldSelectHtml("map-currency", mapping.currencyField, fields, "currency")}</label>
                ${
                  deliveryMode === "product_map"
                    ? `<label class="field"><span>ID / SKU do Produto</span>${fieldSelectHtml("map-product-id", mapping.productIdField, fields, "product.id")}</label>
                       <label class="field"><span>Nome do Produto / Oferta</span>${fieldSelectHtml("map-offer-name", mapping.offerNameField, fields, "product.name")}</label>`
                    : ""
                }
              </div>

              <div class="grid-3">
                <label class="field"><span>Valores que LIBERAM (vírgula)</span>
                  <input type="text" id="map-approve-vals" value="${escapeHtml((mapping.approveValues || []).join(", "))}" />
                </label>
                <label class="field"><span>Valores que RENOVAM (vírgula)</span>
                  <input type="text" id="map-renew-vals" value="${escapeHtml((mapping.renewValues || []).join(", "))}" />
                </label>
                <label class="field"><span>Valores que REVOGAM (vírgula)</span>
                  <input type="text" id="map-revoke-vals" value="${escapeHtml((mapping.revokeValues || []).join(", "))}" />
                </label>
              </div>

              ${
                extracted
                  ? `<div>
                      <div class="muted mb-8"><strong>Preview ao Vivo da Extração:</strong></div>
                      <div class="preview-extract-box" id="wiz-live-preview">
                        <div class="preview-kv"><small>Comprador</small><strong>${escapeHtml(extracted.buyerName || "-")} (${escapeHtml(extracted.buyerEmail || "sem e-mail")})</strong></div>
                        <div class="preview-kv"><small>Ação / Status</small><strong>${escapeHtml(extracted.eventAction.toUpperCase())} (${escapeHtml(extracted.eventName)})</strong></div>
                        <div class="preview-kv"><small>Valor / Método</small><strong>${escapeHtml(formatMoney(extracted.amountCents, extracted.currency))} · ${escapeHtml(extracted.paymentMethod || "-")}</strong></div>
                        <div class="preview-kv"><small>Produto Detectado</small><strong>${escapeHtml(extracted.productId || extracted.offerName || "-")}</strong></div>
                        <div class="preview-kv"><small>Regra Aplicada</small><strong>${ruleRes?.matched ? escapeHtml(`${ruleRes.ruleAction} → ${PLAN_LABELS[ruleRes.planTier] || ruleRes.planTier}`) : "Aguardando regra"}</strong></div>
                      </div>
                    </div>`
                  : ""
              }
            </section>

            ${
              deliveryMode === "product_map"
                ? `
            <!-- Passo 4: Regras -->
            <section class="step-wizard-card">
              <div class="row-between">
                <div>
                  <h2 class="step-card-title"><span class="step-number-badge">4</span> Regras por Produto / Oferta</h2>
                  <p class="muted" style="margin:4px 0 0;">Produtos não listados caem na fila "Aguardando Mapeamento" (nunca liberam plano errado).</p>
                </div>
                <button type="button" class="btn btn-secondary btn-sm" id="btn-add-rule">+ Adicionar Regra</button>
              </div>
              <div id="wiz-rules-list" class="form-stack"></div>
            </section>`
                : ""
            }

            <section class="step-wizard-card">
              <div class="row-between">
                <div>
                  <strong>Pronto para ativar?</strong>
                  <p class="muted" style="margin:2px 0 0;">Você pode salvar como rascunho ou salvar e ativar imediatamente.</p>
                </div>
                <div class="btn-row">
                  <button type="button" class="btn btn-secondary" id="btn-save-draft">Salvar Rascunho</button>
                  <button type="button" class="btn btn-primary" id="btn-save-activate">${isActive ? "Salvar Alterações" : "Salvar e Ativar Integração"}</button>
                </div>
              </div>
            </section>

            <section class="panel-card">
              <div class="card-header"><h2>Últimos Eventos desta Integração (${intEvents.length})</h2></div>
              <div class="table-scroll">
                <table class="data-table">
                  <thead><tr><th>Evento / Transação</th><th>Comprador</th><th>Status</th><th>Licença</th><th>Data</th></tr></thead>
                  <tbody>
                    ${
                      intEvents.length === 0
                        ? `<tr><td colspan="5" class="muted">Nenhum evento recebido nesta integração ainda.</td></tr>`
                        : intEvents
                            .map(
                              (ev) => `
                                <tr class="delivery-row-clickable" data-inspect-id="${escapeHtml(ev.id)}">
                                  <td><div>${escapeHtml(ev.event_name)}</div><div class="muted tabular-nums">${escapeHtml(ev.transaction_id)}</div></td>
                                  <td><div>${escapeHtml(ev.buyer_name || "-")}</div><div class="muted">${escapeHtml(ev.buyer_email || "-")}</div></td>
                                  <td>${statusBadgeHtml(ev)}</td>
                                  <td class="tabular-nums">${escapeHtml(ev.license_key || "-")}</td>
                                  <td class="muted tabular-nums">${escapeHtml(formatDateTime(ev.processed_at))}</td>
                                </tr>`,
                            )
                            .join("")
                    }
                  </tbody>
                </table>
              </div>
            </section>
            `
                : ""
            }
          </div>
        `;

        const syncFormState = () => {
          formName = root.querySelector("#wiz-name")?.value.trim() || formName;
          const secretInp = root.querySelector("#wiz-header-secret");
          if (secretInp) formHeaderSecret = secretInp.value.trim();
          sendEmail = Boolean(root.querySelector("#wiz-send-email")?.checked);
          sendWhatsapp = Boolean(root.querySelector("#wiz-send-wa")?.checked);
          if (deliveryMode === "direct") {
            fixedPlanTier = root.querySelector("#wiz-fixed-plan")?.value || fixedPlanTier;
            fixedDurationDays = root.querySelector("#wiz-fixed-days")?.value || "";
            const up = [];
            if (root.querySelector("#wiz-fix-bonus")?.checked) up.push("bonus");
            if (root.querySelector("#wiz-fix-video")?.checked) up.push("video");
            fixedUpgrades = up;
          }
          if (integration) {
            mapping.email = root.querySelector("#map-email")?.value.trim() || "";
            if (splitNameMode) {
              mapping.firstName = root.querySelector("#map-first-name")?.value.trim() || "";
              mapping.lastName = root.querySelector("#map-last-name")?.value.trim() || "";
            } else {
              mapping.name = root.querySelector("#map-name")?.value.trim() || "";
            }
            mapping.phone = root.querySelector("#map-phone")?.value.trim() || "";
            mapping.externalId = root.querySelector("#map-tx")?.value.trim() || "";
            mapping.statusField = root.querySelector("#map-status")?.value.trim() || "";
            mapping.amountField = root.querySelector("#map-amount")?.value.trim() || "";
            mapping.amountUnit = root.querySelector("#map-amount-unit")?.value || "decimal";
            mapping.paymentMethodField = root.querySelector("#map-method")?.value.trim() || "";
            mapping.currencyField = root.querySelector("#map-currency")?.value.trim() || "";
            if (deliveryMode === "product_map") {
              mapping.productIdField = root.querySelector("#map-product-id")?.value.trim() || "";
              mapping.offerNameField = root.querySelector("#map-offer-name")?.value.trim() || "";
            }
            const splitList = (sel) =>
              String(root.querySelector(sel)?.value || "")
                .split(",")
                .map((s) => s.trim().toLowerCase())
                .filter(Boolean);
            mapping.approveValues = splitList("#map-approve-vals");
            mapping.renewValues = splitList("#map-renew-vals");
            mapping.revokeValues = splitList("#map-revoke-vals");
          }
        };

        const renderRulesList = () => {
          const box = root.querySelector("#wiz-rules-list");
          if (!box) return;
          if (rules.length === 0) {
            box.innerHTML = `<p class="muted">Nenhuma regra ainda. Clique em "+ Adicionar Regra" para mapear um Product ID ou Nome de Oferta.</p>`;
            return;
          }
          box.innerHTML = rules
            .map(
              (r, idx) => `
              <div class="rule-row-card" data-rule-idx="${idx}">
                <select data-rcol="matchField">
                  <option value="product_id" ${r.matchField === "product_id" ? "selected" : ""}>Product ID</option>
                  <option value="offer_name" ${r.matchField === "offer_name" ? "selected" : ""}>Nome contém</option>
                </select>
                <input type="text" data-rcol="matchValue" value="${escapeHtml(r.matchValue)}" placeholder="Ex.: PROD_AG10" />
                <select data-rcol="ruleAction">
                  <option value="grant_plan" ${r.ruleAction === "grant_plan" ? "selected" : ""}>Liberar Plano</option>
                  <option value="add_upgrades_only" ${r.ruleAction === "add_upgrades_only" ? "selected" : ""}>Só Upgrade</option>
                  <option value="create_new_license" ${r.ruleAction === "create_new_license" ? "selected" : ""}>Nova Chave</option>
                  <option value="ignore" ${r.ruleAction === "ignore" ? "selected" : ""}>Ignorar</option>
                </select>
                <select data-rcol="planTier">
                  <option value="individual" ${r.planTier === "individual" ? "selected" : ""}>Individual</option>
                  <option value="agencia_10" ${r.planTier === "agencia_10" ? "selected" : ""}>Agência 10</option>
                  <option value="agencia_ilimitada" ${r.planTier === "agencia_ilimitada" ? "selected" : ""}>Ilimitada</option>
                </select>
                <div class="product-map-upgrades">
                  <label><input type="checkbox" data-rupg="bonus" ${r.addUpgrades.includes("bonus") ? "checked" : ""} /> Bônus</label>
                  <label><input type="checkbox" data-rupg="video" ${r.addUpgrades.includes("video") ? "checked" : ""} /> Vídeo</label>
                </div>
                <input type="number" min="1" data-rcol="durationDays" value="${escapeHtml(r.durationDays)}" placeholder="Dias" title="Validade em dias" />
                <input type="number" step="0.01" min="0" data-rcol="defaultAmountReais" value="${escapeHtml(r.defaultAmountReais)}" placeholder="R$ fallback" />
                <button type="button" class="btn btn-danger btn-sm" data-rdel="${idx}">✕</button>
              </div>`,
            )
            .join("");

          box.querySelectorAll("[data-rule-idx]").forEach((rowEl) => {
            const idx = Number(rowEl.dataset.ruleIdx);
            rowEl.querySelectorAll("[data-rcol]").forEach((inp) => {
              inp.addEventListener("input", () => {
                rules[idx][inp.dataset.rcol] = inp.value;
              });
            });
            rowEl.querySelectorAll("[data-rupg]").forEach((chk) => {
              chk.addEventListener("change", () => {
                const s = new Set(rules[idx].addUpgrades || []);
                chk.checked ? s.add(chk.dataset.rupg) : s.delete(chk.dataset.rupg);
                rules[idx].addUpgrades = [...s];
              });
            });
            rowEl.querySelector("[data-rdel]")?.addEventListener("click", () => {
              rules.splice(idx, 1);
              renderRulesList();
            });
          });
        };

        renderRulesList();

        root.querySelector("#btn-wiz-back")?.addEventListener("click", () => {
          stopListenTimers();
          subMode = "list";
          void renderMode();
        });

        root.querySelectorAll("[data-mode-pick]").forEach((b) => {
          b.addEventListener("click", () => {
            syncFormState();
            deliveryMode = b.dataset.modePick;
            drawWizard();
          });
        });

        root.querySelector("#wiz-split-name")?.addEventListener("change", (e) => {
          syncFormState();
          splitNameMode = Boolean(e.target.checked);
          drawWizard();
        });

        root.querySelector("#btn-create-integration")?.addEventListener("click", async (e) => {
          syncFormState();
          const btn = e.currentTarget;
          setButtonLoading(btn, true, "Gerando...");
          try {
            const createdRes = await api("/api/admin/integrations", {
              method: "POST",
              body: JSON.stringify({
                platform: platform.id,
                name: formName,
                deliveryMode,
                fixedPlanTier,
                fixedUpgrades,
                fixedDurationDays: fixedDurationDays ? Number(fixedDurationDays) : null,
                sendEmail,
                sendWhatsapp,
                fieldMapping: mapping,
                ...(formHeaderSecret ? { headerSecret: formHeaderSecret } : {}),
              }),
            });
            integration = createdRes.integration;
            formHeaderSecret = "";
            activeIntegrationId = integration.id;
            showToast("URL gerada! Agora capture um evento de teste ou carregue o exemplo.", "success");
            await refreshDashboardData(["integrations"]);
            drawWizard();
          } catch (err) {
            showToast(err.message, "error");
            setButtonLoading(btn, false);
          }
        });

        root.querySelector("#btn-copy-wiz-url")?.addEventListener("click", () => {
          if (integration) void copyText(integration.webhookUrl, "URL do webhook copiada!");
        });
        root.querySelector("#btn-copy-wiz-url-token")?.addEventListener("click", () => {
          if (integration?.webhookUrlWithToken) void copyText(integration.webhookUrlWithToken, "URL com ?token copiada!");
        });

        root.querySelector("#btn-load-sample")?.addEventListener("click", async (e) => {
          if (!integration) return;
          const btn = e.currentTarget;
          setButtonLoading(btn, true, "Carregando...");
          try {
            const st = await api(`/api/admin/integrations/${encodeURIComponent(integration.id)}/listen`, {
              method: "POST",
              body: JSON.stringify({ action: "simulate_sample" }),
            });
            listenState = st;
            if (st.suggestedMapping) {
              mapping = { ...mapping, ...st.suggestedMapping };
              splitNameMode = Boolean(mapping.firstName || mapping.lastName);
            }
            showRawPayload = true;
            showToast("Payload de exemplo carregado e campos sugeridos!", "success");
            drawWizard();
          } catch (err) {
            showToast(err.message, "error");
            setButtonLoading(btn, false);
          }
        });

        root.querySelector("#btn-toggle-listen")?.addEventListener("click", async () => {
          if (!integration) return;
          const nextAction = listenState.listening ? "stop" : "start";
          try {
            const st = await api(`/api/admin/integrations/${encodeURIComponent(integration.id)}/listen`, {
              method: "POST",
              body: JSON.stringify({ action: nextAction }),
            });
            listenState = st;
            drawWizard();
            if (nextAction === "start") {
              showToast(`Escutando! Dispare o evento de teste na ${platform.name} agora.`, "success");
              startListeningPoll();
            } else {
              stopListenTimers();
            }
          } catch (err) {
            showToast(err.message, "error");
          }
        });

        root.querySelector("#btn-add-rule")?.addEventListener("click", () => {
          rules.push({
            matchField: "product_id",
            matchValue: extracted?.productId || "",
            ruleAction: "grant_plan",
            planTier: "individual",
            addUpgrades: [],
            durationDays: "",
            defaultAmountReais: "",
            label: extracted?.offerName || "",
          });
          renderRulesList();
        });

        const saveIntegration = async (activateFlag) => {
          syncFormState();
          if (activateFlag && !mapping.email) {
            return showToast("Mapeie o campo de E-mail antes de ativar a integração.", "error");
          }
          const headerSecret = root.querySelector("#wiz-header-secret")?.value.trim() || "";
          const serializedRules = rules.map((r) => ({
            matchField: r.matchField,
            matchValue: r.matchValue,
            ruleAction: r.ruleAction,
            planTier: r.planTier,
            addUpgrades: r.addUpgrades,
            durationDays: r.durationDays ? Number(r.durationDays) : null,
            defaultAmountCents: Math.max(0, Math.round((Number(String(r.defaultAmountReais || "0").replace(",", ".")) || 0) * 100)),
            label: r.label,
          }));
          try {
            const res = await api(`/api/admin/integrations/${encodeURIComponent(integration.id)}`, {
              method: "PATCH",
              body: JSON.stringify({
                name: formName,
                deliveryMode,
                fixedPlanTier,
                fixedUpgrades,
                fixedDurationDays: fixedDurationDays ? Number(fixedDurationDays) : null,
                sendEmail,
                sendWhatsapp,
                isActive: activateFlag,
                fieldMapping: mapping,
                rules: deliveryMode === "product_map" ? serializedRules : undefined,
                ...(headerSecret ? { headerSecret } : {}),
              }),
            });
            integration = res.integration;
            formHeaderSecret = "";
            isActive = integration.isActive;
            await refreshDashboardData(["integrations", "deliveries"]);
            showToast(isActive ? "Integração salva e ativada!" : "Rascunho salvo com sucesso!", "success");
            drawWizard();
          } catch (err) {
            showToast(err.message, "error");
          }
        };

        root.querySelector("#btn-save-draft")?.addEventListener("click", () => void saveIntegration(false));
        root.querySelector("#btn-save-activate")?.addEventListener("click", () => void saveIntegration(true));
        root.querySelectorAll("[data-inspect-id]").forEach((tr) => {
          tr.addEventListener("click", () => void openDeliveryInspector(tr.dataset.inspectId, () => renderMode()));
        });
      };

      function startListeningPoll() {
        stopListenTimers();
        activeCountdownTimer = setInterval(() => {
          if (!listenState.listening) return;
          listenState.secondsLeft = Math.max(0, (listenState.secondsLeft || 0) - 1);
          const btn = root.querySelector("#btn-toggle-listen");
          if (btn) {
            const m = Math.floor(listenState.secondsLeft / 60);
            const s = String(listenState.secondsLeft % 60).padStart(2, "0");
            btn.innerHTML = `<span class="listen-pulse"></span> Escutando... ${m}:${s} (Cancelar)`;
          }
        }, 1000);

        activeListenPoller = setInterval(async () => {
          if (!integration) return stopListenTimers();
          try {
            const st = await api(`/api/admin/integrations/${encodeURIComponent(integration.id)}/listen`);
            if (st.payload) {
              stopListenTimers();
              listenState = st;
              if (st.suggestedMapping) {
                mapping = {
                  ...mapping,
                  email: mapping.email || st.suggestedMapping.email,
                  name: mapping.name || st.suggestedMapping.name,
                  firstName: mapping.firstName || st.suggestedMapping.firstName,
                  lastName: mapping.lastName || st.suggestedMapping.lastName,
                  phone: mapping.phone || st.suggestedMapping.phone,
                  externalId: mapping.externalId || st.suggestedMapping.externalId,
                  statusField: mapping.statusField || st.suggestedMapping.statusField,
                  amountField: mapping.amountField || st.suggestedMapping.amountField,
                  currencyField: mapping.currencyField || st.suggestedMapping.currencyField,
                  paymentMethodField: mapping.paymentMethodField || st.suggestedMapping.paymentMethodField,
                  productIdField: mapping.productIdField || st.suggestedMapping.productIdField,
                  offerNameField: mapping.offerNameField || st.suggestedMapping.offerNameField,
                };
                splitNameMode = Boolean(mapping.firstName || mapping.lastName);
              }
              showRawPayload = true;
              showToast("Evento capturado! Campos mapeados automaticamente.", "success");
              drawWizard();
            } else if (!st.listening) {
              stopListenTimers();
              listenState.listening = false;
              showToast("Tempo de escuta esgotado. Clique em Receber evento para tentar novamente.", "error");
              drawWizard();
            }
          } catch {
            // tenta no próximo ciclo
          }
        }, 2000);
      }

      drawWizard();
      if (listenState.listening) startListeningPoll();
    }

    function renderDeliveriesTab() {
      root.innerHTML = `
        <div class="view-stack">
          ${headerTabsHtml("deliveries")}
          <section class="panel-card">
            <div class="card-header row-between">
              <div>
                <h2>Log de Entregas & Inspetor</h2>
                <p class="muted">Clique em qualquer linha para inspecionar o payload, mapear pendências ou reprocessar.</p>
              </div>
              <div class="toolbar-row">
                <input type="search" id="del-filter-q" class="toolbar-search" value="${escapeHtml(filterQ)}" placeholder="Buscar e-mail, transação ou chave..." />
                <select id="del-filter-provider" class="filter-select">
                  <option value="">Todas plataformas</option>
                  ${platforms.map((p) => `<option value="${escapeHtml(p.id)}" ${filterProvider === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
                </select>
                <select id="del-filter-status" class="filter-select">
                  <option value="">Todos os status</option>
                  <option value="aprovado" ${filterStatus === "aprovado" ? "selected" : ""}>Aprovado</option>
                  <option value="pending_mapping" ${filterStatus === "pending_mapping" ? "selected" : ""}>Aguardando Mapeamento</option>
                  <option value="reembolso" ${filterStatus === "reembolso" ? "selected" : ""}>Reembolso</option>
                  <option value="simulado" ${filterStatus === "simulado" ? "selected" : ""}>Simulado</option>
                  <option value="teste" ${filterStatus === "teste" ? "selected" : ""}>Teste Capturado</option>
                  <option value="ignorado" ${filterStatus === "ignorado" ? "selected" : ""}>Ignorado</option>
                  <option value="erro" ${filterStatus === "erro" ? "selected" : ""}>Erro / 401</option>
                </select>
              </div>
            </div>
            <div class="table-scroll">
              <table class="data-table">
                <thead><tr><th>Plataforma</th><th>Evento / Transação</th><th>Comprador</th><th>Plano & Valor</th><th>Status</th><th>Data</th><th>Ação</th></tr></thead>
                <tbody id="wh-deliveries-tbody"></tbody>
              </table>
            </div>
          </section>
        </div>
      `;

      bindHeaderTabs();
      const tbody = root.querySelector("#wh-deliveries-tbody");

      const drawRows = (rows) => {
        if (!tbody) return;
        if (!rows.length) {
          tbody.innerHTML = `<tr><td colspan="7" class="muted">Nenhuma entrega encontrada para os filtros atuais.</td></tr>`;
          return;
        }
        tbody.innerHTML = rows
          .map((d) => {
            const idEsc = escapeHtml(d.id || d.delivery_key);
            return `
            <tr class="delivery-row-clickable" data-delivery-id="${idEsc}">
              <td><strong>${escapeHtml(String(d.provider || "").toUpperCase())}</strong></td>
              <td><div>${escapeHtml(d.event_name || "-")}</div><div class="muted tabular-nums">${escapeHtml(d.transaction_id || "-")}</div></td>
              <td><div>${escapeHtml(d.buyer_name || "-")}</div><div class="muted">${escapeHtml(d.buyer_email || "-")}</div></td>
              <td class="tabular-nums"><div>${escapeHtml(PLAN_LABELS[d.plan_tier] || d.plan_tier || "-")}</div><div class="muted">${escapeHtml(formatMoney(d.amount_cents || 0, d.currency || "BRL"))}</div></td>
              <td>${statusBadgeHtml(d)} <span class="muted">HTTP ${escapeHtml(d.http_status ?? 200)}</span></td>
              <td class="muted tabular-nums">${escapeHtml(formatDateTime(d.processed_at))}</td>
              <td>
                <div class="action-icon-group">
                  <button type="button" class="action-icon-btn" data-inspect-delivery="${idEsc}" data-tooltip="Inspecionar payload" aria-label="Inspecionar payload">${ICON_EYE}</button>
                  <button type="button" class="action-icon-btn action-icon-btn--danger" data-delete-delivery="${idEsc}" data-tooltip="Excluir log e registro financeiro" aria-label="Excluir log e registro financeiro">${ICON_TRASH}</button>
                </div>
              </td>
            </tr>`;
          })
          .join("");
        tbody.querySelectorAll("[data-inspect-delivery]").forEach((btn) => {
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            hideFloatingTooltip();
            void openDeliveryInspector(btn.dataset.inspectDelivery, loadDeliveries);
          });
        });
        tbody.querySelectorAll("[data-delete-delivery]").forEach((btn) => {
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const item = rows.find((r) => String(r.id || r.delivery_key) === String(btn.dataset.deleteDelivery));
            if (item) void confirmAndDeleteDelivery(item, loadDeliveries);
          });
        });
        tbody.querySelectorAll("[data-delivery-id]").forEach((tr) => {
          tr.addEventListener("click", () => {
            hideFloatingTooltip();
            void openDeliveryInspector(tr.dataset.deliveryId, loadDeliveries);
          });
        });
      };

      bindFloatingTooltips(root);

      const loadDeliveries = async () => {
        const qs = new URLSearchParams({ limit: "60" });
        if (filterProvider) qs.set("provider", filterProvider);
        if (filterStatus) qs.set("status", filterStatus);
        if (filterQ) qs.set("q", filterQ);
        try {
          const res = await api(`/api/admin/webhooks/deliveries?${qs.toString()}`);
          currentDeliveries = res.deliveries || [];
          drawRows(currentDeliveries);
        } catch (err) {
          showToast(err.message, "error");
        }
      };

      if (filterStatus || filterProvider || filterQ) void loadDeliveries();
      else drawRows(currentDeliveries);

      let searchTimer = null;
      root.querySelector("#del-filter-q")?.addEventListener("input", (e) => {
        filterQ = e.target.value.trim();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => void loadDeliveries(), 250);
      });
      root.querySelector("#del-filter-provider")?.addEventListener("change", (e) => {
        filterProvider = e.target.value;
        void loadDeliveries();
      });
      root.querySelector("#del-filter-status")?.addEventListener("change", (e) => {
        filterStatus = e.target.value;
        void loadDeliveries();
      });
    }

    function renderSimulatorTab() {
      root.innerHTML = `
        <div class="view-stack">
          ${headerTabsHtml("simulator")}
          <section class="panel-card">
            <div class="card-header row-between">
              <div>
                <h2>Simulador Ponta a Ponta</h2>
                <p class="muted">Dispare compras simuladas (<code>is_simulated=1</code>) para validar emissão, e-mail e WhatsApp sem poluir o faturamento real.</p>
              </div>
            </div>
            <form id="wh-sim-form" class="form-stack">
              <div class="grid-3">
                <label class="field"><span>Gateway</span>
                  <select id="sim-provider">${LEGACY_GATEWAYS.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join("")}</select>
                </label>
                <label class="field"><span>Evento</span>
                  <select id="sim-event"><option value="PURCHASE_APPROVED">PURCHASE_APPROVED (Aprovação)</option><option value="PURCHASE_REFUNDED">PURCHASE_REFUNDED (Reembolso)</option></select>
                </label>
                <label class="field"><span>Plano</span>
                  <select id="sim-plan"><option value="individual">Individual</option><option value="agencia_10">Agência 10</option><option value="agencia_ilimitada">Agência Ilimitada</option></select>
                </label>
              </div>
              <div class="grid-3">
                <label class="field"><span>E-mail do Comprador *</span><input type="email" id="sim-email" required placeholder="cliente@exemplo.invalid" /></label>
                <label class="field"><span>Nome do Comprador</span><input type="text" id="sim-name" placeholder="Comprador Exemplo" /></label>
                <label class="field"><span>WhatsApp (opcional)</span><input type="text" id="sim-phone" placeholder="+5511900000000" /></label>
              </div>
              <div class="grid-3">
                <label class="field"><span>Valor (R$)</span><input type="number" id="sim-amount" step="0.01" min="0" value="197.00" /></label>
                <label class="field"><span>Moeda</span><select id="sim-currency"><option value="BRL">BRL</option><option value="USD">USD</option><option value="EUR">EUR</option></select></label>
                <label class="field"><span>Pagamento</span><select id="sim-payment"><option value="pix">PIX</option><option value="credit_card">Cartão</option><option value="boleto">Boleto</option></select></label>
              </div>
              <div class="btn-row"><button type="submit" class="btn btn-primary" id="btn-run-sim">Executar Simulação</button></div>
            </form>
          </section>
        </div>
      `;
      bindHeaderTabs();
      root.querySelector("#wh-sim-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = root.querySelector("#btn-run-sim");
        setButtonLoading(btn, true, "Simulando...");
        try {
          const res = await api("/api/admin/webhooks/simulate", {
            method: "POST",
            body: JSON.stringify({
              provider: root.querySelector("#sim-provider").value,
              event_type: root.querySelector("#sim-event").value,
              plan_tier: root.querySelector("#sim-plan").value,
              email: root.querySelector("#sim-email").value.trim(),
              name: root.querySelector("#sim-name").value.trim() || "Comprador Exemplo",
              phone: root.querySelector("#sim-phone").value.trim(),
              amount_cents: Math.max(0, Math.round(Number(root.querySelector("#sim-amount").value || 0) * 100)),
              currency: root.querySelector("#sim-currency").value,
              payment_method: root.querySelector("#sim-payment").value,
            }),
          });
          showToast(`Simulação executada: ${res.action}${res.license_key ? ` · ${res.license_key}` : ""}`, "success");
          await refreshDashboardData(["analytics", "deliveries", "licenses", "overview"]);
        } catch (err) {
          showToast(err.message, "error");
        } finally {
          setButtonLoading(btn, false);
        }
      });
    }

    await renderMode();
    const inspectId = ctx.params?.inspectDeliveryId || ctx.params?.deliveryId;
    if (inspectId) void openDeliveryInspector(inspectId, () => renderMode());
  },
});
