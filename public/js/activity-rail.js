import { ensureStylesheet, escapeHtml, formatRelativeTime, showToast } from "./core/api.js";
import { refreshDashboardData } from "./core/state.js";
import { closeMobileOverlays, registerRail } from "./core/router.js";

const GATEWAYS = [
  { id: "hotmart", label: "Hotmart" },
  { id: "kiwify", label: "Kiwify" },
  { id: "ticto", label: "Ticto" },
  { id: "stripe", label: "Stripe" },
  { id: "cakto", label: "Cakto" },
  { id: "kirvano", label: "Kirvano" },
  { id: "generic", label: "Genérico HMAC" },
];

function formatEmailStatus(emailCfg) {
  const prov = emailCfg?.provider || "none";
  if (prov === "smtp") return { text: "SMTP ativo", led: "on", pill: "pill-active" };
  if (prov === "resend") return { text: "Resend ativo", led: "on", pill: "pill-active" };
  return { text: "Desativado", led: "warn", pill: "pill-warn" };
}

function formatWhatsAppStatus(waCfg) {
  if (waCfg?.provider === "cloud_api") {
    return { text: "Meta Cloud API", led: "on", pill: "pill-active" };
  }
  return { text: "Standby", led: "warn", pill: "pill-warn" };
}

function renderNotificationsBlock(deliveries = [], notificationLogs = []) {
  const alerts = deliveries
    .filter(
      (d) =>
        d.action === "pending_mapping" ||
        d.action === "auth_error" ||
        d.action === "error" ||
        Number(d.http_status) >= 400,
    )
    .slice(0, 4);
  const recentLogs = notificationLogs.slice(0, 4);

  if (!alerts.length && !recentLogs.length) {
    return `<div class="muted">Nenhuma notificação ou alerta recente.</div>`;
  }

  const errCards = alerts
    .map((d) => {
      const targetId = d.id || d.delivery_key || "";
      const isPending = d.action === "pending_mapping";
      const label = isPending
        ? `${String(d.provider || "webhook").toUpperCase()} · Produto não mapeado`
        : `${String(d.provider || "webhook").toUpperCase()} · HTTP ${Number(d.http_status || 400)}`;
      return `
        <button type="button" class="rail-notif-card ${isPending ? "" : "is-error"} clickable" data-rail-delivery="${escapeHtml(targetId)}">
          <div class="row-between">
            <span class="pill ${isPending ? "pill-warn" : "pill-revoked"}">${isPending ? "Mapear Produto" : "Falha Webhook"}</span>
            <span class="muted">${escapeHtml(formatRelativeTime(d.processed_at))}</span>
          </div>
          <div class="rail-item-title">${escapeHtml(label)}</div>
          <div class="rail-item-sub">${escapeHtml(d.error_detail || d.offer_name || d.buyer_email || d.event_name || "Clique para inspecionar")}</div>
        </button>
      `;
    })
    .join("");

  const logCards = recentLogs
    .map((n) => {
      const pillClass = n.status === "sent" ? "pill-active" : n.status === "error" ? "pill-revoked" : "pill-warn";
      const channelName = n.channel === "whatsapp" ? "WhatsApp" : "E-mail";
      return `
        <div class="rail-notif-card">
          <div class="row-between">
            <span class="pill ${pillClass}">${escapeHtml(channelName)} · ${escapeHtml(n.status)}</span>
            <span class="muted">${escapeHtml(formatRelativeTime(n.created_at))}</span>
          </div>
          <div class="rail-item-title">${escapeHtml(n.recipient || "Destinatário")}</div>
          <div class="rail-item-sub">${escapeHtml(n.license_key || n.detail || "")}</div>
        </div>
      `;
    })
    .join("");

  return `${errCards}${logCards}`;
}

function renderTimelineBlock(activityFeed = []) {
  if (!activityFeed.length) {
    return `<div class="muted">Sem eventos registrados no período.</div>`;
  }
  return `
    <div class="rail-timeline">
      ${activityFeed
        .slice(0, 10)
        .map((item) => {
          const dotStatus = ["success", "error", "warn", "info"].includes(item.status) ? item.status : "info";
          return `
            <div class="rail-timeline-item">
              <span class="rail-dot ${dotStatus}"></span>
              <div class="rail-item-body">
                <div class="row-between">
                  <span class="rail-item-title">${escapeHtml(item.title)}</span>
                  <span class="muted" style="font-size:10.5px">${escapeHtml(formatRelativeTime(item.createdAt))}</span>
                </div>
                <div class="rail-item-sub">${escapeHtml(item.subtitle || "")}</div>
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderChannelsBlock(integrations = [], notificationsConfig) {
  const activeInts = integrations.filter((i) => i.isActive);
  const emailInfo = formatEmailStatus(notificationsConfig?.email);
  const waInfo = formatWhatsAppStatus(notificationsConfig?.whatsapp);

  return `
    <div class="channel-status-row">
      <span class="channel-dot-label">
        <span class="status-led ${emailInfo.led}"></span>
        <span>E-mail</span>
      </span>
      <span class="pill ${emailInfo.pill}">${escapeHtml(emailInfo.text)}</span>
    </div>
    <div class="channel-status-row">
      <span class="channel-dot-label">
        <span class="status-led ${waInfo.led}"></span>
        <span>WhatsApp</span>
      </span>
      <span class="pill ${waInfo.pill}">${escapeHtml(waInfo.text)}</span>
    </div>
    <div class="channel-status-row">
      <span class="channel-dot-label">
        <span class="status-led ${activeInts.length > 0 ? "on" : "warn"}"></span>
        <span>Integrações (${activeInts.length}/${integrations.length})</span>
      </span>
      <span class="muted tabular-nums">${activeInts.length > 0 ? "Ativas" : "Nenhuma ativa"}</span>
    </div>
    ${
      integrations.length > 0
        ? `<div class="check-row" style="gap:6px">
            ${integrations
              .slice(0, 8)
              .map(
                (i) =>
                  `<span class="pill ${i.isActive ? "pill-active" : "pill-warn"}" title="${escapeHtml(i.name)}">${escapeHtml(i.platformName)}</span>`,
              )
              .join("")}
          </div>`
        : ""
    }
  `;
}

ensureStylesheet("/styles/dashboard.css");

registerRail((root, { store, navigate }) => {
  const state = store.get();
  const deliveries = state.deliveries || [];
  const notificationLogs = state.notificationLogs || [];
  const activityFeed = state.analytics?.activityFeed || [];

  root.innerHTML = `
    <div class="rail-header">
      <div>
        <h3>Alertas & Feed</h3>
        <span class="muted">Eventos, pendências e canais</span>
      </div>
      <div class="btn-row">
        <button type="button" class="icon-btn" id="btn-rail-refresh" title="Atualizar feed" aria-label="Atualizar feed">↻</button>
        <button type="button" class="icon-btn" id="btn-rail-close" title="Fechar feed" aria-label="Fechar feed">✕</button>
      </div>
    </div>

    <section class="rail-section">
      <div class="rail-section-title">
        <span>Notificações</span>
        <span class="tabular-nums">${notificationLogs.length}</span>
      </div>
      ${renderNotificationsBlock(deliveries, notificationLogs)}
    </section>

    <section class="rail-section">
      <div class="rail-section-title">
        <span>Atividades Recentes</span>
        <span class="tabular-nums">${activityFeed.length}</span>
      </div>
      ${renderTimelineBlock(activityFeed)}
    </section>

    <section class="rail-section">
      <div class="rail-section-title">
        <span>Canais & Integrações</span>
      </div>
      ${renderChannelsBlock(state.integrations || [], state.notificationsConfig)}
    </section>
  `;

  root.querySelector("#btn-rail-close")?.addEventListener("click", closeMobileOverlays);

  root.querySelector("#btn-rail-refresh")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await refreshDashboardData(["analytics", "deliveries", "notificationLogs", "integrations", "notificationsConfig"]);
      showToast("Feed ao vivo atualizado!", "success");
    } catch (err) {
      showToast(`Falha ao atualizar feed: ${err.message}`, "error");
    } finally {
      btn.disabled = false;
    }
  });

  root.querySelectorAll("[data-rail-delivery]").forEach((btn) => {
    btn.addEventListener("click", () => {
      closeMobileOverlays();
      navigate("webhooks", { deliveryId: btn.dataset.railDelivery, inspectDeliveryId: btn.dataset.railDelivery });
    });
  });
});
