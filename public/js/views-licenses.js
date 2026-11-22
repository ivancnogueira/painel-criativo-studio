import {
  api, closeModal, copyText, ensureStylesheet, escapeHtml, formatDateTime, formatMoney, openModal, showToast,
} from "./core/api.js";
import { refreshDashboardData, store } from "./core/state.js";
import { registerView } from "./core/router.js";

ensureStylesheet("/styles/views.css");

const PLAN_LABELS = { individual: "Individual", agencia_10: "Agência 10", agencia_ilimitada: "Agência Ilimitada" };

function licenseStatusPill(status) {
  const map = {
    active: { cls: "pill-active", label: "Ativa" },
    revoked: { cls: "pill-revoked", label: "Revogada" },
    suspended: { cls: "pill-warn", label: "Suspensa" },
    expired: { cls: "pill-revoked", label: "Expirada" },
  };
  const meta = map[status] || { cls: "pill-info", label: status || "Desconhecida" };
  return `<span class="pill ${meta.cls}">${escapeHtml(meta.label)}</span>`;
}

function openQuickEditModal(lic, onSaved) {
  const upg = Array.isArray(lic.upgrades) ? lic.upgrades : [];
  const amountReais = lic.amount_cents ? (Number(lic.amount_cents) / 100).toFixed(2) : "0.00";
  const expDate = lic.expires_at ? String(lic.expires_at).slice(0, 10) : "";

  openModal({
    title: `Editar Licença ${lic.license_key}`,
    subtitle: lic.customer_email || "",
    width: 580,
    bodyHtml: `
      <form id="edit-license-form" class="form-stack">
        <div class="grid-2">
          <label class="field"><span>Nome do Cliente</span><input type="text" id="ed-name" value="${escapeHtml(lic.customer_name || "")}" placeholder="Comprador Exemplo" /></label>
          <label class="field"><span>WhatsApp</span><input type="text" id="ed-phone" value="${escapeHtml(lic.customer_phone || "")}" placeholder="+5511900000000" /></label>
        </div>
        <div class="grid-3">
          <label class="field"><span>Plano</span>
            <select id="ed-plan">
              <option value="individual" ${lic.plan_tier === "individual" ? "selected" : ""}>Individual</option>
              <option value="agencia_10" ${lic.plan_tier === "agencia_10" ? "selected" : ""}>Agência 10</option>
              <option value="agencia_ilimitada" ${lic.plan_tier === "agencia_ilimitada" ? "selected" : ""}>Agência Ilimitada</option>
            </select>
          </label>
          <label class="field"><span>Limite Custom PCs</span><input type="number" id="ed-max-machines" min="1" value="${escapeHtml(lic.custom_max_machines ?? "")}" placeholder="Padrão" /></label>
          <label class="field"><span>Validade</span><input type="date" id="ed-expires" value="${escapeHtml(expDate)}" /></label>
        </div>
        <div class="grid-3">
          <label class="field"><span>Valor (R$)</span><input type="number" id="ed-amount" step="0.01" min="0" value="${escapeHtml(amountReais)}" /></label>
          <label class="field"><span>Moeda</span>
            <select id="ed-currency">
              <option value="BRL" ${(lic.currency || "BRL") === "BRL" ? "selected" : ""}>BRL</option>
              <option value="USD" ${lic.currency === "USD" ? "selected" : ""}>USD</option>
              <option value="EUR" ${lic.currency === "EUR" ? "selected" : ""}>EUR</option>
            </select>
          </label>
          <label class="field"><span>Método</span>
            <select id="ed-payment">
              <option value="manual" ${(lic.payment_method || "manual") === "manual" ? "selected" : ""}>Manual</option>
              <option value="pix" ${lic.payment_method === "pix" ? "selected" : ""}>PIX</option>
              <option value="credit_card" ${lic.payment_method === "credit_card" ? "selected" : ""}>Cartão</option>
              <option value="boleto" ${lic.payment_method === "boleto" ? "selected" : ""}>Boleto</option>
            </select>
          </label>
        </div>
        <div class="check-row">
          <label class="check-pill"><input type="checkbox" id="ed-upg-bonus" ${upg.includes("bonus") ? "checked" : ""} /> Pack Bônus</label>
          <label class="check-pill"><input type="checkbox" id="ed-upg-video" ${upg.includes("video") ? "checked" : ""} /> Vídeo Remotion</label>
        </div>
        <label class="field"><span>Notas Internas</span><input type="text" id="ed-notes" value="${escapeHtml(lic.notes || "")}" placeholder="Observações..." /></label>
        <div class="btn-row">
          <button type="submit" class="btn btn-primary">Salvar Alterações</button>
          <button type="button" class="btn btn-ghost" id="btn-cancel-edit-lic">Cancelar</button>
        </div>
      </form>`,
    onMount: (root) => {
      root.querySelector("#btn-cancel-edit-lic")?.addEventListener("click", closeModal);
      root.querySelector("#edit-license-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const upgrades = [];
        if (root.querySelector("#ed-upg-bonus")?.checked) upgrades.push("bonus");
        if (root.querySelector("#ed-upg-video")?.checked) upgrades.push("video");
        const maxM = root.querySelector("#ed-max-machines").value.trim();
        const expVal = root.querySelector("#ed-expires").value.trim();
        const body = {
          customer_name: root.querySelector("#ed-name").value.trim(),
          customer_phone: root.querySelector("#ed-phone").value.trim(),
          plan_tier: root.querySelector("#ed-plan").value,
          upgrades,
          custom_max_machines: maxM ? Number(maxM) : null,
          expires_at: expVal ? `${expVal}T23:59:59.000Z` : null,
          amount_cents: Math.max(0, Math.round(Number(root.querySelector("#ed-amount").value || 0) * 100)),
          currency: root.querySelector("#ed-currency").value,
          payment_method: root.querySelector("#ed-payment").value,
          notes: root.querySelector("#ed-notes").value.trim() || null,
        };
        try {
          await api(`/api/admin/licenses/${encodeURIComponent(lic.license_key)}`, { method: "PATCH", body: JSON.stringify(body) });
          closeModal();
          showToast("Licença atualizada!", "success");
          await refreshDashboardData(["licenses", "analytics", "overview"]);
          if (typeof onSaved === "function") await onSaved();
        } catch (err) { showToast(`Erro ao atualizar licença: ${err.message}`, "error"); }
      });
    },
  });
}

registerView("licenses", {
  async render(root, ctx) {
    let filterQ = String(ctx.params?.query || "").trim();
    let filterStatus = "";
    let filterPlan = "";
    let licenses = store.get().licenses || [];

    root.innerHTML = `
      <div class="view-stack">
        <div class="view-header">
          <div>
            <h1>Licenças & Clientes</h1>
            <p class="muted">Emissão manual com registro financeiro, filtros por plano/status, edição rápida e exportação CSV.</p>
          </div>
          <button type="button" class="btn btn-secondary" id="btn-export-licenses-csv">Exportar CSV</button>
        </div>

        <section class="panel-card" id="lic-create-card">
          <div class="card-header">
            <h2>Emitir Nova Licença Manual</h2>
            <p class="muted">Emissões com valor informado entram no faturamento sem duplicar webhooks.</p>
          </div>
          <form id="lic-create-form" class="form-stack">
            <div class="grid-3">
              <label class="field"><span>E-mail do Cliente *</span><input type="email" id="lic-email" required placeholder="cliente@exemplo.invalid" /></label>
              <label class="field"><span>Nome Completo</span><input type="text" id="lic-name" placeholder="Comprador Exemplo" /></label>
              <label class="field"><span>WhatsApp (opcional)</span><input type="text" id="lic-phone" placeholder="+5511900000000" /></label>
            </div>
            <div class="grid-3">
              <label class="field"><span>Plano</span>
                <select id="lic-plan">
                  <option value="individual">Individual (2 servidores · 2 PCs)</option>
                  <option value="agencia_10">Agência 10 (10 servidores · 3 PCs)</option>
                  <option value="agencia_ilimitada">Agência Ilimitada (∞ servidores · 5 PCs)</option>
                </select>
              </label>
              <label class="field"><span>Limite Customizado de PCs</span><input type="number" id="lic-max-machines" min="1" placeholder="Opcional" /></label>
              <label class="field"><span>Validade (opcional)</span><input type="date" id="lic-expires" /></label>
            </div>
            <div class="grid-3">
              <label class="field"><span>Valor (R$) & Moeda</span>
                <div class="btn-row" style="flex-wrap:nowrap">
                  <input type="number" id="lic-amount" step="0.01" min="0" value="0.00" />
                  <select id="lic-currency" style="width:92px"><option value="BRL">BRL</option><option value="USD">USD</option><option value="EUR">EUR</option></select>
                </div>
              </label>
              <label class="field"><span>Método de Pagamento</span>
                <select id="lic-payment"><option value="manual">Manual / Cortesia</option><option value="pix">PIX</option><option value="credit_card">Cartão de Crédito</option><option value="boleto">Boleto</option></select>
              </label>
              <label class="field"><span>Notas</span><input type="text" id="lic-notes" placeholder="Ex.: Venda direta WhatsApp" /></label>
            </div>
            <div class="check-row">
              <label class="check-pill"><input type="checkbox" id="lic-upg-bonus" /> Pack Bônus</label>
              <label class="check-pill"><input type="checkbox" id="lic-upg-video" /> Vídeo Remotion</label>
              <label class="check-pill"><input type="checkbox" id="lic-force-new" /> Forçar nova chave</label>
              <label class="check-pill"><input type="checkbox" id="lic-send-email" checked /> Enviar por E-mail</label>
              <label class="check-pill"><input type="checkbox" id="lic-send-wa" /> Enviar por WhatsApp</label>
            </div>
            <div class="btn-row"><button type="submit" class="btn btn-primary">Emitir Licença Agora</button></div>
          </form>
        </section>

        <section class="panel-card">
          <div class="card-header row-between">
            <div><h2>Licenças Emitidas (<span id="lic-count-label" class="tabular-nums">${licenses.length}</span>)</h2></div>
            <div class="toolbar-row">
              <input type="search" id="lic-filter-q" class="toolbar-search" value="${escapeHtml(filterQ)}" placeholder="Buscar por e-mail, nome ou chave..." />
              <select id="lic-filter-status" class="filter-select">
                <option value="">Todos os status</option><option value="active">Ativa</option><option value="suspended">Suspensa</option><option value="revoked">Revogada</option><option value="expired">Expirada</option>
              </select>
              <select id="lic-filter-plan" class="filter-select">
                <option value="">Todos os planos</option><option value="individual">Individual</option><option value="agencia_10">Agência 10</option><option value="agencia_ilimitada">Agência Ilimitada</option>
              </select>
            </div>
          </div>
          <div class="license-grid" id="lic-cards-grid"></div>
        </section>
      </div>`;

    const grid = root.querySelector("#lic-cards-grid");
    const countLabel = root.querySelector("#lic-count-label");
    const buildFilterQueryString = () => {
      const qs = new URLSearchParams();
      if (filterQ) qs.set("q", filterQ);
      if (filterStatus) qs.set("status", filterStatus);
      if (filterPlan) qs.set("plan_tier", filterPlan);
      return qs.toString();
    };

    const runLicenseAction = async (key, endpoint, payload, okMsg, scopes) => {
      try {
        const res = await api(`/api/admin/licenses/${encodeURIComponent(key)}/${endpoint}`, {
          method: "POST",
          ...(payload ? { body: JSON.stringify(payload) } : {}),
        });
        showToast(typeof okMsg === "function" ? okMsg(res) : okMsg, "success");
        await refreshDashboardData(scopes);
        await loadLicenses();
      } catch (err) { showToast(err.message, "error"); }
    };

    function renderLicenses(list) {
      if (countLabel) countLabel.textContent = String(list.length);
      if (!grid) return;
      if (!list.length) { grid.innerHTML = `<p class="muted">Nenhuma licença encontrada para os filtros aplicados.</p>`; return; }
      grid.innerHTML = list.map((lic) => {
        const used = Array.isArray(lic.devices) ? lic.devices.length : 0;
        const cap = Number(lic.custom_max_machines ?? lic.max_machines ?? 2) || 2;
        const pct = Math.min(100, Math.round((used / cap) * 100));
        const upg = Array.isArray(lic.upgrades) && lic.upgrades.length ? lic.upgrades.join(", ").toUpperCase() : "Nenhum";
        const keyEsc = escapeHtml(lic.license_key);
        return `
          <article class="license-card">
            <div class="license-card-head">
              <div>
                <span class="license-key-code">${keyEsc}</span>
                <div class="mt-8"><strong>${escapeHtml(lic.customer_name || "Sem nome")}</strong></div>
                <div class="muted">${escapeHtml(lic.customer_email || "-")}</div>
              </div>
              <div style="text-align:right">
                ${licenseStatusPill(lic.status)}
                <div class="muted mt-8">${escapeHtml(PLAN_LABELS[lic.plan_tier] || lic.plan_tier)}</div>
              </div>
            </div>
            <div class="row-between muted tabular-nums">
              <span>Valor: <strong>${escapeHtml(formatMoney(lic.amount_cents || 0, lic.currency || "BRL"))}</strong> (${escapeHtml(lic.payment_method || lic.source_provider || "manual")})</span>
              <span>Upgrades: ${escapeHtml(upg)}</span>
            </div>
            <div class="device-bar">
              <div class="row-between muted tabular-nums"><span>Computadores ativos</span><span>${used} / ${cap}</span></div>
              <div class="device-bar-track"><div class="device-bar-fill" style="width:${pct}%"></div></div>
            </div>
            ${lic.notes ? `<div class="muted">Nota: ${escapeHtml(lic.notes)}</div>` : ""}
            <div class="muted tabular-nums">Criada em ${escapeHtml(formatDateTime(lic.created_at))}${lic.expires_at ? ` · Expira ${escapeHtml(formatDateTime(lic.expires_at))}` : ""}</div>
            <div class="license-actions">
              <button type="button" class="btn btn-secondary btn-sm" data-act="copy" data-key="${keyEsc}">Copiar Chave</button>
              <button type="button" class="btn btn-ghost btn-sm" data-act="email" data-key="${keyEsc}">E-mail</button>
              <button type="button" class="btn btn-ghost btn-sm" data-act="wa" data-key="${keyEsc}">WhatsApp</button>
              <button type="button" class="btn btn-secondary btn-sm" data-act="edit" data-key="${keyEsc}">Editar Rápido</button>
              <button type="button" class="btn btn-ghost btn-sm" data-act="reset" data-key="${keyEsc}">Resetar PCs</button>
              ${lic.status === "revoked"
                ? `<button type="button" class="btn btn-secondary btn-sm" data-act="reactivate" data-key="${keyEsc}">Reativar</button>`
                : `<button type="button" class="btn btn-danger btn-sm" data-act="revoke" data-key="${keyEsc}">Revogar</button>`}
            </div>
          </article>`;
      }).join("");

      grid.querySelectorAll("[data-act]").forEach((btn) => btn.addEventListener("click", () => {
        const key = btn.dataset.key;
        const act = btn.dataset.act;
        if (act === "copy") return void copyText(key, "Chave de licença copiada!");
        if (act === "edit") {
          const target = list.find((i) => i.license_key === key);
          if (target) openQuickEditModal(target, loadLicenses);
          return;
        }
        if (act === "email") return void runLicenseAction(key, "send-notifications", { send_email: true, send_whatsapp: false }, (r) => r.notifications?.email?.ok ? "E-mail enviado!" : `Status: ${r.notifications?.email?.error || "ignorado"}`, ["notificationLogs"]);
        if (act === "wa") return void runLicenseAction(key, "send-notifications", { send_email: false, send_whatsapp: true }, (r) => r.notifications?.whatsapp?.ok ? "WhatsApp enviado!" : `Status: ${r.notifications?.whatsapp?.error || "ignorado"}`, ["notificationLogs"]);
        if (act === "reset") return void runLicenseAction(key, "reset-machines", null, "Computadores desvinculados!", ["licenses", "overview"]);
        if (act === "revoke") return void runLicenseAction(key, "revoke", null, "Licença revogada!", ["licenses", "analytics", "overview"]);
        if (act === "reactivate") return void runLicenseAction(key, "reactivate", null, "Licença reativada!", ["licenses", "analytics", "overview"]);
      }));
    }

    async function loadLicenses() {
      try {
        const qs = buildFilterQueryString();
        const res = await api(`/api/admin/licenses?${qs ? `${qs}&` : ""}limit=200`);
        licenses = res.licenses || [];
        renderLicenses(licenses);
      } catch (err) { showToast(`Erro ao carregar licenças: ${err.message}`, "error"); }
    }

    if (filterQ) void loadLicenses();
    else renderLicenses(licenses);

    let searchTimer = null;
    root.querySelector("#lic-filter-q")?.addEventListener("input", (e) => { filterQ = e.target.value.trim(); clearTimeout(searchTimer); searchTimer = setTimeout(() => void loadLicenses(), 260); });
    root.querySelector("#lic-filter-status")?.addEventListener("change", (e) => { filterStatus = e.target.value; void loadLicenses(); });
    root.querySelector("#lic-filter-plan")?.addEventListener("change", (e) => { filterPlan = e.target.value; void loadLicenses(); });
    root.querySelector("#btn-export-licenses-csv")?.addEventListener("click", () => {
      const qs = buildFilterQueryString();
      window.open(`/api/admin/licenses/export.csv${qs ? `?${qs}` : ""}`, "_blank", "noopener");
    });

    root.querySelector("#lic-create-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const upgrades = [];
      if (root.querySelector("#lic-upg-bonus")?.checked) upgrades.push("bonus");
      if (root.querySelector("#lic-upg-video")?.checked) upgrades.push("video");
      const maxM = root.querySelector("#lic-max-machines").value.trim();
      const exp = root.querySelector("#lic-expires").value.trim();
      const body = {
        email: root.querySelector("#lic-email").value.trim(),
        customer_name: root.querySelector("#lic-name").value.trim(),
        customer_phone: root.querySelector("#lic-phone").value.trim(),
        plan_tier: root.querySelector("#lic-plan").value,
        upgrades,
        custom_max_machines: maxM ? Number(maxM) : null,
        expires_at: exp ? `${exp}T23:59:59.000Z` : null,
        amount_cents: Math.max(0, Math.round(Number(root.querySelector("#lic-amount").value || 0) * 100)),
        currency: root.querySelector("#lic-currency").value,
        payment_method: root.querySelector("#lic-payment").value,
        notes: root.querySelector("#lic-notes").value.trim() || null,
        force_new: Boolean(root.querySelector("#lic-force-new")?.checked),
        send_email: Boolean(root.querySelector("#lic-send-email")?.checked),
        send_whatsapp: Boolean(root.querySelector("#lic-send-wa")?.checked),
      };
      try {
        const res = await api("/api/admin/licenses", { method: "POST", body: JSON.stringify(body) });
        showToast(`Licença emitida: ${res.license?.license_key}`, "success");
        e.target.reset();
        await refreshDashboardData(["licenses", "analytics", "overview", "notificationLogs"]);
        await loadLicenses();
      } catch (err) { showToast(`Erro ao emitir licença: ${err.message}`, "error"); }
    });

    if (ctx.params?.focus === "create") { root.querySelector("#lic-create-card")?.scrollIntoView({ behavior: "smooth", block: "start" }); root.querySelector("#lic-email")?.focus(); }
  },
});
