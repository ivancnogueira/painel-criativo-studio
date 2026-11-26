import {
  api,
  bindFloatingTooltips,
  closeDrawer,
  closeModal,
  confirmDialog,
  copyText,
  ensureStylesheet,
  escapeHtml,
  formatDateTime,
  formatMoney,
  hideFloatingTooltip,
  openDrawer,
  openModal,
  refreshFloatingTooltip,
  setButtonLoading,
  showToast,
} from "./core/api.js";
import { refreshDashboardData, store } from "./core/state.js";
import { registerView } from "./core/router.js";

ensureStylesheet("/styles/views.css");

const ICON_COPY = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const ICON_CHECK = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
const ICON_EYE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const ICON_EDIT = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
const ICON_TRASH = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;

const PLAN_LABELS = {
  individual: "Individual",
  agencia_10: "Agência 10",
  agencia_ilimitada: "Agência Ilimitada",
};

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

function deliveryStatusBadge(status, channel) {
  if (!status) return `<span class="pill pill-info">${channel}: —</span>`;
  const cls = status === "sent" ? "pill-active" : status === "error" ? "pill-revoked" : "pill-warn";
  const lbl = status === "sent" ? "OK" : status === "error" ? "Erro" : "Standby";
  return `<span class="pill ${cls}">${channel}: ${lbl}</span>`;
}

function openCreateLicenseModal(onCreated) {
  openModal({
    title: "Emitir Nova Licença Manual",
    subtitle: "Emissões com valor informado entram no faturamento sem duplicar webhooks.",
    width: 600,
    bodyHtml: `
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
          <label class="field"><span>Limite Customizado PCs</span><input type="number" id="lic-max-machines" min="1" placeholder="Padrão" /></label>
          <label class="field"><span>Validade (opcional)</span><input type="date" id="lic-expires" /></label>
        </div>
        <div class="grid-3">
          <label class="field"><span>Valor & Moeda</span>
            <div class="btn-row" style="flex-wrap:nowrap">
              <input type="number" id="lic-amount" step="0.01" min="0" value="0.00" />
              <select id="lic-currency" style="width:92px"><option value="BRL">BRL</option><option value="USD">USD</option><option value="EUR">EUR</option></select>
            </div>
          </label>
          <label class="field"><span>Método</span>
            <select id="lic-payment"><option value="manual">Manual / Cortesia</option><option value="pix">PIX</option><option value="credit_card">Cartão</option><option value="boleto">Boleto</option></select>
          </label>
          <label class="field"><span>Notas</span><input type="text" id="lic-notes" placeholder="Ex.: Venda direta" /></label>
        </div>
        <div class="check-row">
          <label class="check-pill"><input type="checkbox" id="lic-upg-bonus" /> Pack Bônus</label>
          <label class="check-pill"><input type="checkbox" id="lic-upg-video" /> Vídeo Remotion</label>
          <label class="check-pill"><input type="checkbox" id="lic-force-new" /> Forçar nova chave</label>
          <label class="check-pill"><input type="checkbox" id="lic-send-email" checked /> Enviar E-mail</label>
          <label class="check-pill"><input type="checkbox" id="lic-send-wa" /> Enviar WhatsApp</label>
        </div>
        <div class="btn-row" style="justify-content:flex-end;">
          <button type="button" class="btn btn-ghost" id="btn-cancel-create-lic">Cancelar</button>
          <button type="submit" class="btn btn-primary" id="btn-submit-create-lic">Emitir Licença Agora</button>
        </div>
      </form>`,
    onMount: (root) => {
      root.querySelector("#lic-email")?.focus();
      root.querySelector("#btn-cancel-create-lic")?.addEventListener("click", closeModal);
      root.querySelector("#lic-create-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = root.querySelector("#btn-submit-create-lic");
        setButtonLoading(btn, true, "Emitindo...");
        const upgrades = [];
        if (root.querySelector("#lic-upg-bonus")?.checked) upgrades.push("bonus");
        if (root.querySelector("#lic-upg-video")?.checked) upgrades.push("video");
        const maxM = root.querySelector("#lic-max-machines").value.trim();
        const exp = root.querySelector("#lic-expires").value.trim();
        try {
          const res = await api("/api/admin/licenses", {
            method: "POST",
            body: JSON.stringify({
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
            }),
          });
          closeModal();
          showToast(`Licença emitida: ${res.license?.license_key}`, "success");
          await refreshDashboardData(["licenses", "analytics", "overview", "notificationLogs"]);
          if (typeof onCreated === "function") await onCreated();
        } catch (err) {
          showToast(`Erro ao emitir licença: ${err.message}`, "error");
          setButtonLoading(btn, false);
        }
      });
    },
  });
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
        <div class="btn-row" style="justify-content:flex-end;">
          <button type="button" class="btn btn-ghost" id="btn-cancel-edit-lic">Cancelar</button>
          <button type="submit" class="btn btn-primary" id="btn-save-edit-lic">Salvar Alterações</button>
        </div>
      </form>`,
    onMount: (root) => {
      root.querySelector("#btn-cancel-edit-lic")?.addEventListener("click", closeModal);
      root.querySelector("#edit-license-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = root.querySelector("#btn-save-edit-lic");
        setButtonLoading(btn, true, "Salvando...");
        const upgrades = [];
        if (root.querySelector("#ed-upg-bonus")?.checked) upgrades.push("bonus");
        if (root.querySelector("#ed-upg-video")?.checked) upgrades.push("video");
        const maxM = root.querySelector("#ed-max-machines").value.trim();
        const expVal = root.querySelector("#ed-expires").value.trim();
        try {
          await api(`/api/admin/licenses/${encodeURIComponent(lic.license_key)}`, {
            method: "PATCH",
            body: JSON.stringify({
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
            }),
          });
          closeModal();
          showToast("Licença atualizada!", "success");
          await refreshDashboardData(["licenses", "analytics", "overview"]);
          if (typeof onSaved === "function") await onSaved();
        } catch (err) {
          showToast(`Erro ao atualizar licença: ${err.message}`, "error");
          setButtonLoading(btn, false);
        }
      });
    },
  });
}

async function confirmAndDeleteLicense(lic, onDeleted) {
  if (!lic?.license_key) return;
  hideFloatingTooltip();
  const who = lic.customer_name || lic.customer_email || lic.license_key;
  const ok = await confirmDialog({
    title: "Deletar cliente e licença?",
    message: `Esta ação é irreversível. Vai deletar ${who} (${lic.license_key}), revogar imediatamente a licença e os dispositivos vinculados, e apagar todo o valor pago, histórico de webhooks e notificações.`,
    confirmLabel: "Deletar Tudo",
    danger: true,
  });
  if (!ok) return;

  try {
    await api(`/api/admin/licenses/${encodeURIComponent(lic.license_key)}`, { method: "DELETE" });
    showToast("Cliente, licença e registros financeiros removidos!", "success");
    await refreshDashboardData(["licenses", "analytics", "overview", "webhooks", "notificationLogs"]);
    if (typeof onDeleted === "function") await onDeleted();
  } catch (err) {
    showToast(`Erro ao deletar licença: ${err.message}`, "error");
  }
}

async function openLicenseDetailsDrawer(licenseKey, onChanged) {
  try {
    const res = await api(`/api/admin/licenses/${encodeURIComponent(licenseKey)}/details`);
    const lic = res.license;
    const devices = res.devices || [];
    const transactions = res.transactions || [];
    const notifications = res.notifications || [];
    const cap = Number(lic.custom_max_machines ?? lic.max_machines ?? 2) || 2;
    const upg = Array.isArray(lic.upgrades) && lic.upgrades.length ? lic.upgrades.join(", ").toUpperCase() : "Nenhum";

    openDrawer({
      title: lic.customer_name || lic.customer_email,
      subtitle: `${lic.license_key} · ${PLAN_LABELS[lic.plan_tier] || lic.plan_tier}`,
      bodyHtml: `
        <div class="form-stack">
          <div class="inspector-meta-grid">
            <div class="inspector-meta-item"><div class="inspector-meta-label">Status</div><div class="inspector-meta-val">${licenseStatusPill(lic.status)}</div></div>
            <div class="inspector-meta-item"><div class="inspector-meta-label">E-mail</div><div class="inspector-meta-val wrap-anywhere">${escapeHtml(lic.customer_email)}</div></div>
            <div class="inspector-meta-item"><div class="inspector-meta-label">Valor / Origem</div><div class="inspector-meta-val tabular-nums">${escapeHtml(formatMoney(lic.amount_cents || 0, lic.currency || "BRL"))} · ${escapeHtml(lic.source_provider || "manual")}</div></div>
            <div class="inspector-meta-item"><div class="inspector-meta-label">Upgrades / PCs</div><div class="inspector-meta-val tabular-nums">${escapeHtml(upg)} · ${devices.length}/${cap}</div></div>
          </div>

          <div class="btn-row">
            <button type="button" class="btn btn-primary btn-sm" id="dr-copy-key">Copiar Chave</button>
            ${res.deliveryUrl ? `<button type="button" class="btn btn-secondary btn-sm" id="dr-copy-delivery">Copiar Link de Entrega</button>` : ""}
            ${res.deliveryUrl ? `<a class="btn btn-ghost btn-sm" href="${escapeHtml(res.deliveryUrl)}" target="_blank" rel="noopener">Abrir Portal ↗</a>` : ""}
            <button type="button" class="btn btn-secondary btn-sm" id="dr-edit">Editar</button>
          </div>

          <hr class="divider" style="margin:6px 0;" />

          <div>
            <div class="row-between mb-8">
              <strong>Entregas (E-mail & WhatsApp)</strong>
              <div class="btn-row">
                <button type="button" class="btn btn-secondary btn-sm" id="dr-send-email">Reenviar E-mail</button>
                <button type="button" class="btn btn-secondary btn-sm" id="dr-send-wa">Reenviar WhatsApp</button>
              </div>
            </div>
            <div class="btn-row mb-8">
              ${deliveryStatusBadge(lic.last_email_status, "E-mail")}
              ${deliveryStatusBadge(lic.last_whatsapp_status, "WhatsApp")}
            </div>
            ${
              notifications.length > 0
                ? `<div class="muted">${notifications.slice(0, 4).map((n) => `• ${escapeHtml(n.channel.toUpperCase())} (${escapeHtml(n.status)}) — ${escapeHtml(formatDateTime(n.created_at))}`).join("<br>")}</div>`
                : `<div class="muted">Nenhum disparo registrado ainda.</div>`
            }
          </div>

          <hr class="divider" style="margin:6px 0;" />

          <div>
            <div class="row-between mb-8">
              <strong>Computadores Conectados (${devices.length}/${cap})</strong>
              <button type="button" class="btn btn-ghost btn-sm" id="dr-reset-pcs">Resetar PCs</button>
            </div>
            ${
              devices.length === 0
                ? `<div class="muted">Nenhum computador ativado nesta licença ainda.</div>`
                : devices
                    .map(
                      (dev) => `<div class="vault-item mb-8">
                        <div><strong>${escapeHtml(dev.hostname)}</strong><div class="muted">${escapeHtml(dev.os_platform)} · v${escapeHtml(dev.app_version || "-")}</div></div>
                        <span class="muted tabular-nums">${escapeHtml(formatDateTime(dev.last_heartbeat_at))}</span>
                      </div>`,
                    )
                    .join("")
            }
          </div>

          <hr class="divider" style="margin:6px 0;" />

          <div>
            <strong style="display:block;margin-bottom:8px;">Transações Vinculadas (${transactions.length})</strong>
            ${
              transactions.length === 0
                ? `<div class="muted">Sem transações registradas.</div>`
                : transactions
                    .map(
                      (t) => `<div class="vault-item mb-8">
                        <div><strong>${escapeHtml(t.grant_type.toUpperCase())} · ${escapeHtml(t.provider)}</strong><div class="muted tabular-nums">${escapeHtml(t.transaction_id)}</div></div>
                        <span class="pill ${t.status === "active" ? "pill-active" : "pill-revoked"}">${escapeHtml(t.status)}</span>
                      </div>`,
                    )
                    .join("")
            }
          </div>

          <hr class="divider" style="margin:6px 0;" />

          <div class="row-between">
            <span class="muted">Ação de segurança</span>
            <div class="btn-row">
              ${
                lic.status === "revoked"
                  ? `<button type="button" class="btn btn-secondary btn-sm" id="dr-reactivate">Reativar Licença</button>`
                  : `<button type="button" class="btn btn-danger btn-sm" id="dr-revoke">Revogar Licença</button>`
              }
              <button type="button" class="btn btn-danger btn-sm" id="dr-delete-all">Deletar Tudo</button>
            </div>
          </div>
        </div>
      `,
      onMount: (root) => {
        root.querySelector("#dr-copy-key")?.addEventListener("click", () => void copyText(lic.license_key, "Chave copiada!"));
        root.querySelector("#dr-copy-delivery")?.addEventListener("click", () => void copyText(res.deliveryUrl, "Link de entrega copiado!"));
        root.querySelector("#dr-edit")?.addEventListener("click", () => {
          closeDrawer();
          openQuickEditModal(lic, onChanged);
        });
        root.querySelector("#dr-send-email")?.addEventListener("click", async (e) => {
          const btn = e.currentTarget;
          setButtonLoading(btn, true, "Enviando...");
          try {
            const r = await api(`/api/admin/licenses/${encodeURIComponent(lic.license_key)}/send-notifications`, {
              method: "POST",
              body: JSON.stringify({ send_email: true, send_whatsapp: false }),
            });
            showToast(r.notifications?.email?.ok ? "E-mail enviado!" : `Status: ${r.notifications?.email?.error || "ignorado"}`, "success");
            await refreshDashboardData(["licenses", "notificationLogs"]);
            if (typeof onChanged === "function") await onChanged();
            await openLicenseDetailsDrawer(lic.license_key, onChanged);
          } catch (err) {
            showToast(err.message, "error");
            setButtonLoading(btn, false);
          }
        });
        root.querySelector("#dr-send-wa")?.addEventListener("click", async (e) => {
          const btn = e.currentTarget;
          setButtonLoading(btn, true, "Enviando...");
          try {
            const r = await api(`/api/admin/licenses/${encodeURIComponent(lic.license_key)}/send-notifications`, {
              method: "POST",
              body: JSON.stringify({ send_email: false, send_whatsapp: true }),
            });
            showToast(r.notifications?.whatsapp?.ok ? "WhatsApp enviado!" : `Status: ${r.notifications?.whatsapp?.error || "ignorado"}`, "success");
            await refreshDashboardData(["licenses", "notificationLogs"]);
            if (typeof onChanged === "function") await onChanged();
            await openLicenseDetailsDrawer(lic.license_key, onChanged);
          } catch (err) {
            showToast(err.message, "error");
            setButtonLoading(btn, false);
          }
        });
        root.querySelector("#dr-reset-pcs")?.addEventListener("click", async () => {
          const ok = await confirmDialog({
            title: "Resetar computadores vinculados?",
            message: `Todos os dispositivos ativos de ${lic.license_key} serão desvinculados imediatamente.`,
            confirmLabel: "Resetar PCs",
            danger: true,
          });
          if (!ok) return;
          try {
            await api(`/api/admin/licenses/${encodeURIComponent(lic.license_key)}/reset-machines`, { method: "POST" });
            showToast("Computadores desvinculados!", "success");
            await refreshDashboardData(["licenses", "overview"]);
            if (typeof onChanged === "function") await onChanged();
          } catch (err) {
            showToast(err.message, "error");
          }
        });
        root.querySelector("#dr-revoke")?.addEventListener("click", async () => {
          const ok = await confirmDialog({
            title: `Revogar ${lic.license_key}?`,
            message: "O aplicativo do cliente perderá a validação no próximo heartbeat. Você pode reativar depois se precisar.",
            confirmLabel: "Revogar Licença",
            danger: true,
          });
          if (!ok) return;
          try {
            await api(`/api/admin/licenses/${encodeURIComponent(lic.license_key)}/revoke`, { method: "POST" });
            showToast("Licença revogada!", "success");
            await refreshDashboardData(["licenses", "analytics", "overview"]);
            if (typeof onChanged === "function") await onChanged();
            await openLicenseDetailsDrawer(lic.license_key, onChanged);
          } catch (err) {
            showToast(err.message, "error");
          }
        });
        root.querySelector("#dr-reactivate")?.addEventListener("click", async () => {
          try {
            await api(`/api/admin/licenses/${encodeURIComponent(lic.license_key)}/reactivate`, { method: "POST" });
            showToast("Licença reativada!", "success");
            await refreshDashboardData(["licenses", "analytics", "overview"]);
            if (typeof onChanged === "function") await onChanged();
            await openLicenseDetailsDrawer(lic.license_key, onChanged);
          } catch (err) {
            showToast(err.message, "error");
          }
        });
        root.querySelector("#dr-delete-all")?.addEventListener("click", () => {
          void confirmAndDeleteLicense(lic, async () => {
            closeDrawer();
            if (typeof onChanged === "function") await onChanged();
          });
        });
      },
    });
  } catch (err) {
    showToast(`Erro ao carregar detalhes: ${err.message}`, "error");
  }
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
            <p class="muted">Gerencie chaves emitidas, dispositivos conectados e entregas automáticas em um clique.</p>
          </div>
          <div class="btn-row">
            <button type="button" class="btn btn-secondary" id="btn-export-licenses-csv">Exportar CSV</button>
            <button type="button" class="btn btn-primary" id="btn-open-create-license">+ Nova Licença</button>
          </div>
        </div>

        <section class="panel-card">
          <div class="card-header row-between">
            <div><h2>Licenças Emitidas (<span id="lic-count-label" class="tabular-nums">${licenses.length}</span>)</h2></div>
            <div class="toolbar-row">
              <input type="search" id="lic-filter-q" class="toolbar-search" value="${escapeHtml(filterQ)}" placeholder="Buscar por e-mail, nome ou chave..." />
              <select id="lic-filter-status" class="filter-select">
                <option value="">Todos os status</option>
                <option value="active">Ativa</option>
                <option value="suspended">Suspensa</option>
                <option value="revoked">Revogada</option>
                <option value="expired">Expirada</option>
              </select>
              <select id="lic-filter-plan" class="filter-select">
                <option value="">Todos os planos</option>
                <option value="individual">Individual</option>
                <option value="agencia_10">Agência 10</option>
                <option value="agencia_ilimitada">Agência Ilimitada</option>
              </select>
            </div>
          </div>

          <div class="table-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Chave de Licença</th>
                  <th>Plano & Upgrades</th>
                  <th>Dispositivos</th>
                  <th>Entregas</th>
                  <th>Status</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody id="lic-table-body"></tbody>
            </table>
          </div>
        </section>
      </div>`;

    const tbody = root.querySelector("#lic-table-body");
    const countLabel = root.querySelector("#lic-count-label");
    const buildFilterQueryString = () => {
      const qs = new URLSearchParams();
      if (filterQ) qs.set("q", filterQ);
      if (filterStatus) qs.set("status", filterStatus);
      if (filterPlan) qs.set("plan_tier", filterPlan);
      return qs.toString();
    };

    function renderLicenses(list) {
      if (countLabel) countLabel.textContent = String(list.length);
      if (!tbody) return;
      if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center;padding:28px;">Nenhuma licença encontrada para os filtros aplicados.</td></tr>`;
        return;
      }
      tbody.innerHTML = list
        .map((lic) => {
          const used = Array.isArray(lic.devices) ? lic.devices.length : 0;
          const cap = Number(lic.custom_max_machines ?? lic.max_machines ?? 2) || 2;
          const upg = Array.isArray(lic.upgrades) && lic.upgrades.length ? lic.upgrades.join(", ").toUpperCase() : "—";
          const keyEsc = escapeHtml(lic.license_key);
          return `
            <tr class="delivery-row-clickable" data-lic-row="${keyEsc}">
              <td>
                <div style="font-weight:600;">${escapeHtml(lic.customer_name || "Sem nome")}</div>
                <div class="muted wrap-anywhere">${escapeHtml(lic.customer_email || "-")}</div>
              </td>
              <td>
                <span class="license-key-code">${keyEsc}</span>
              </td>
              <td>
                <div>${escapeHtml(PLAN_LABELS[lic.plan_tier] || lic.plan_tier)}</div>
                <div class="muted tabular-nums">${escapeHtml(formatMoney(lic.amount_cents || 0, lic.currency || "BRL"))} · ${escapeHtml(upg)}</div>
              </td>
              <td class="tabular-nums">${used} / ${cap} PCs</td>
              <td>
                <div class="btn-row" style="gap:4px;">
                  ${deliveryStatusBadge(lic.last_email_status, "E")}
                  ${deliveryStatusBadge(lic.last_whatsapp_status, "W")}
                </div>
              </td>
              <td>${licenseStatusPill(lic.status)}</td>
              <td>
                <div class="action-icon-group">
                  <button type="button" class="action-icon-btn" data-copy-key="${keyEsc}" data-tooltip="Copiar chave" aria-label="Copiar chave">${ICON_COPY}</button>
                  <button type="button" class="action-icon-btn" data-open-details="${keyEsc}" data-tooltip="Ver detalhes" aria-label="Ver detalhes">${ICON_EYE}</button>
                  <button type="button" class="action-icon-btn" data-edit-license="${keyEsc}" data-tooltip="Editar licença" aria-label="Editar licença">${ICON_EDIT}</button>
                  <button type="button" class="action-icon-btn action-icon-btn--danger" data-delete-license="${keyEsc}" data-tooltip="Deletar cliente e licença" aria-label="Deletar cliente e licença">${ICON_TRASH}</button>
                </div>
              </td>
            </tr>`;
        })
        .join("");

      tbody.querySelectorAll("[data-copy-key]").forEach((b) => {
        b.addEventListener("click", async (e) => {
          e.stopPropagation();
          const ok = await copyText(b.dataset.copyKey, "Chave de licença copiada!");
          if (!ok) return;
          if (b._copyTimer) clearTimeout(b._copyTimer);
          b.classList.add("is-copied");
          b.innerHTML = ICON_CHECK;
          b.dataset.tooltip = "Copiado!";
          refreshFloatingTooltip(b);
          b._copyTimer = setTimeout(() => {
            b.classList.remove("is-copied");
            b.innerHTML = ICON_COPY;
            b.dataset.tooltip = "Copiar chave";
            refreshFloatingTooltip(b);
            b._copyTimer = null;
          }, 1600);
        });
      });
      tbody.querySelectorAll("[data-open-details]").forEach((b) => {
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          hideFloatingTooltip();
          void openLicenseDetailsDrawer(b.dataset.openDetails, loadLicenses);
        });
      });
      tbody.querySelectorAll("[data-edit-license]").forEach((b) => {
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          hideFloatingTooltip();
          const lic = list.find((item) => item.license_key === b.dataset.editLicense);
          if (lic) openQuickEditModal(lic, loadLicenses);
        });
      });
      tbody.querySelectorAll("[data-delete-license]").forEach((b) => {
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          const lic = list.find((item) => item.license_key === b.dataset.deleteLicense);
          if (lic) void confirmAndDeleteLicense(lic, loadLicenses);
        });
      });
      tbody.querySelectorAll("[data-lic-row]").forEach((tr) => {
        tr.addEventListener("click", () => {
          hideFloatingTooltip();
          void openLicenseDetailsDrawer(tr.dataset.licRow, loadLicenses);
        });
      });
    }

    async function loadLicenses() {
      try {
        const qs = buildFilterQueryString();
        const res = await api(`/api/admin/licenses?${qs ? `${qs}&` : ""}limit=200`);
        licenses = res.licenses || [];
        renderLicenses(licenses);
      } catch (err) {
        showToast(`Erro ao carregar licenças: ${err.message}`, "error");
      }
    }

    if (filterQ) void loadLicenses();
    else renderLicenses(licenses);

    bindFloatingTooltips(root);

    root.querySelector("#btn-open-create-license")?.addEventListener("click", () => openCreateLicenseModal(loadLicenses));
    let searchTimer = null;
    root.querySelector("#lic-filter-q")?.addEventListener("input", (e) => {
      filterQ = e.target.value.trim();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => void loadLicenses(), 260);
    });
    root.querySelector("#lic-filter-status")?.addEventListener("change", (e) => {
      filterStatus = e.target.value;
      void loadLicenses();
    });
    root.querySelector("#lic-filter-plan")?.addEventListener("change", (e) => {
      filterPlan = e.target.value;
      void loadLicenses();
    });
    root.querySelector("#btn-export-licenses-csv")?.addEventListener("click", () => {
      const qs = buildFilterQueryString();
      window.open(`/api/admin/licenses/export.csv${qs ? `?${qs}` : ""}`, "_blank", "noopener");
    });

    if (ctx.params?.focus === "create") {
      openCreateLicenseModal(loadLicenses);
    }
  },
});
