const $ = (id) => document.getElementById(id);

let state = {
  selectedPlan: "individual",
  simProvider: "hotmart",
  simEvent: "PURCHASE_APPROVED",
  emailProvider: "smtp",
  waProvider: "none",
  waSendMode: "template",
  relChannel: "stable",
  relMode: "links",
  lastCreatedLicense: null,
};

function showToast(msg) {
  const box = $("toast-box");
  box.textContent = msg;
  box.classList.remove("hidden");
  clearTimeout(box._t);
  box._t = setTimeout(() => box.classList.add("hidden"), 3800);
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.includes("/api/auth/login")) {
    showLoginView();
    throw new Error("Sessão expirada. Faça login novamente.");
  }
  if (!res.ok) {
    throw new Error(data.message || data.error || `Erro HTTP ${res.status}`);
  }
  return data;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showLoginView() {
  $("login-view").classList.remove("hidden");
  $("admin-view").classList.add("hidden");
}

function showAdminView(user) {
  $("login-view").classList.add("hidden");
  $("admin-view").classList.remove("hidden");
  $("admin-user-email").textContent = user?.email || "Administrador";
  void loadAllDashboardData();
}

// ─── Bootstrap Sessão ──────────────────────────────────────────────────────
async function checkSession() {
  try {
    const res = await fetch("/api/auth/session", { credentials: "include" });
    const data = await res.json();
    if (data.authenticated) {
      showAdminView(data.user);
    } else {
      showLoginView();
    }
  } catch {
    showLoginView();
  }
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errBox = $("login-error");
  errBox.classList.add("hidden");
  const btn = $("login-submit");
  btn.disabled = true;
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: $("login-email").value.trim(),
        password: $("login-password").value,
      }),
    });
    showAdminView(data.user);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
});

$("btn-logout").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  showLoginView();
});

// ─── Navegação entre abas ──────────────────────────────────────────────────
$("tabs-bar").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  const tab = btn.dataset.tab;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${tab}`));
});

// ─── Pickers segmentados ───────────────────────────────────────────────────
function bindSegmentedPicker(containerId, attr, onSelect) {
  const el = $(containerId);
  el.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    el.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    onSelect(btn.dataset[attr]);
  });
}

bindSegmentedPicker("plan-picker", "plan", (val) => (state.selectedPlan = val));
bindSegmentedPicker("sim-provider-picker", "provider", (val) => (state.simProvider = val));
bindSegmentedPicker("sim-event-picker", "event", (val) => (state.simEvent = val));
bindSegmentedPicker("rel-channel-picker", "channel", (val) => (state.relChannel = val));
bindSegmentedPicker("rel-mode-picker", "relmode", (val) => {
  state.relMode = val;
  $("rel-links-fields").classList.toggle("hidden", val !== "links");
  $("rel-hotbundle-fields").classList.toggle("hidden", val !== "hot_bundle");
});
bindSegmentedPicker("email-provider-picker", "provider", (val) => {
  state.emailProvider = val;
  $("smtp-fields").classList.toggle("hidden", val !== "smtp");
  $("resend-fields").classList.toggle("hidden", val !== "resend");
});
bindSegmentedPicker("wa-provider-picker", "provider", (val) => {
  state.waProvider = val;
  $("wa-standby-note").classList.toggle("hidden", val !== "none");
  $("wa-cloud-fields").classList.toggle("hidden", val !== "cloud_api");
});
bindSegmentedPicker("wa-mode-picker", "mode", (val) => (state.waSendMode = val));

// ─── Carregamento geral ────────────────────────────────────────────────────
async function loadAllDashboardData() {
  await Promise.all([
    loadOverview(),
    loadLicenses(),
    loadWebhooksConfig(),
    loadWebhooksHistory(),
    loadMessagingConfig(),
    loadNotificationLogs(),
    loadReleases(),
  ]);
}

async function loadOverview() {
  const data = await api("/api/admin/overview");
  const s = data.stats;
  $("stat-active").textContent = s.activeLicenses;
  $("stat-total").textContent = `de ${s.totalLicenses} emitidas`;
  $("stat-machines").textContent = s.activeMachines;
  $("stat-webhooks").textContent = s.webhooksCount;
  $("stat-deliveries").textContent = s.emailsSent + s.waSent;
  $("stat-deliveries-sub").textContent = `${s.emailsSent} E-mails · ${s.waSent} WhatsApps`;
  $("public-key-box").value = data.publicKeyPem || "";
}

// ─── Licenças ──────────────────────────────────────────────────────────────
async function loadLicenses() {
  const q = encodeURIComponent($("lic-search").value.trim());
  const data = await api(`/api/admin/licenses?q=${q}`);
  const container = $("licenses-list");
  if (!data.licenses.length) {
    container.innerHTML = `<div class="muted">Nenhuma licença encontrada ainda.</div>`;
    return;
  }

  container.innerHTML = data.licenses
    .map((lic) => {
      const pillCls = lic.status === "active" ? "pill-active" : lic.status === "revoked" ? "pill-revoked" : "pill-warn";
      const maxPcs = lic.custom_max_machines ?? lic.max_machines;
      const srvLabel = lic.max_servers < 0 ? "∞ serv." : `${lic.max_servers} serv.`;
      const devs = lic.devices || [];
      const devHtml = devs.length
        ? devs.map((d) => `💻 ${escapeHtml(d.hostname)} (${escapeHtml(d.os_platform)})`).join(" · ")
        : "Nenhum PC ativado ainda";

      return `
        <div class="license-item" data-key="${escapeHtml(lic.license_key)}">
          <div class="lic-top">
            <div>
              <div class="lic-key-badge">${escapeHtml(lic.license_key)}</div>
              <div class="lic-meta">
                <strong>${escapeHtml(lic.customer_name || "Sem nome")}</strong> · ${escapeHtml(lic.customer_email)}
                ${lic.customer_phone ? ` · 📱 ${escapeHtml(lic.customer_phone)}` : ""}
              </div>
              <div class="lic-meta muted">
                Plano: <strong>${escapeHtml(lic.plan_tier)}</strong> (${srvLabel} · ${devs.length}/${maxPcs} PCs)
                ${lic.upgrades?.length ? ` · Upgrades: ${escapeHtml(lic.upgrades.join(", "))}` : ""}
              </div>
            </div>
            <span class="pill ${pillCls}">${escapeHtml(lic.status.toUpperCase())}</span>
          </div>
          <div class="lic-devices">${devHtml}</div>
          <div class="lic-actions">
            <button class="btn btn-secondary btn-sm" data-act="copy" data-key="${escapeHtml(lic.license_key)}" data-email="${escapeHtml(lic.customer_email)}">Copiar Chave</button>
            <button class="btn btn-secondary btn-sm" data-act="resend-email" data-key="${escapeHtml(lic.license_key)}">Enviar E-mail</button>
            <button class="btn btn-secondary btn-sm" data-act="resend-wa" data-key="${escapeHtml(lic.license_key)}">Enviar WhatsApp</button>
            <button class="btn btn-ghost btn-sm" data-act="reset-pcs" data-key="${escapeHtml(lic.license_key)}">Resetar PCs</button>
            ${
              lic.status === "active"
                ? `<button class="btn btn-ghost btn-sm" data-act="revoke" data-key="${escapeHtml(lic.license_key)}">Revogar</button>`
                : `<button class="btn btn-ghost btn-sm" data-act="reactivate" data-key="${escapeHtml(lic.license_key)}">Reativar</button>`
            }
          </div>
        </div>
      `;
    })
    .join("");
}

$("lic-search").addEventListener("input", () => {
  clearTimeout($("lic-search")._t);
  $("lic-search")._t = setTimeout(() => void loadLicenses(), 250);
});
$("btn-refresh-licenses").addEventListener("click", () => void loadLicenses());

$("create-license-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("btn-create-license");
  btn.disabled = true;
  try {
    const upgrades = [];
    if ($("lic-up-bonus").checked) upgrades.push("bonus");
    if ($("lic-up-video").checked) upgrades.push("video");
    const customPcs = $("lic-custom-pcs").value.trim();

    const data = await api("/api/admin/licenses", {
      method: "POST",
      body: JSON.stringify({
        email: $("lic-email").value.trim(),
        customer_name: $("lic-name").value.trim(),
        customer_phone: $("lic-phone").value.trim(),
        plan_tier: state.selectedPlan,
        upgrades,
        custom_max_machines: customPcs ? Number(customPcs) : null,
        force_new: $("lic-force-new").checked,
        send_email: $("lic-send-email").checked,
        send_whatsapp: $("lic-send-wa").checked,
      }),
    });

    state.lastCreatedLicense = data.license;
    $("created-key-text").textContent = data.license.license_key;
    const deliveryParts = [];
    if (data.notifications?.email) {
      deliveryParts.push(`E-mail: ${data.notifications.email.ok ? "✅ Enviado" : `⚠️ ${data.notifications.email.error}`}`);
    }
    if (data.notifications?.whatsapp) {
      deliveryParts.push(`WhatsApp: ${data.notifications.whatsapp.ok ? "✅ Enviado" : `⚠️ ${data.notifications.whatsapp.error}`}`);
    }
    $("created-delivery-status").textContent = deliveryParts.join(" | ") || "Licença salva no banco.";
    $("created-license-box").classList.remove("hidden");
    showToast(`Licença ${data.license.license_key} criada!`);
    await Promise.all([loadOverview(), loadLicenses(), loadNotificationLogs()]);
  } catch (err) {
    showToast(`Erro: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

$("btn-copy-created-key").addEventListener("click", async () => {
  if (!state.lastCreatedLicense) return;
  await navigator.clipboard.writeText(state.lastCreatedLicense.license_key);
  showToast("Chave copiada!");
});

$("btn-copy-created-msg").addEventListener("click", async () => {
  const l = state.lastCreatedLicense;
  if (!l) return;
  const txt = `Sua licença do Criativo AI Studio Online:\nE-mail: ${l.customer_email}\nChave: ${l.license_key}`;
  await navigator.clipboard.writeText(txt);
  showToast("Dados de ativação copiados!");
});

$("licenses-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const key = btn.dataset.key;

  try {
    if (act === "copy") {
      await navigator.clipboard.writeText(key);
      showToast(`Chave ${key} copiada!`);
    } else if (act === "resend-email") {
      const r = await api(`/api/admin/licenses/${encodeURIComponent(key)}/send-notifications`, {
        method: "POST",
        body: JSON.stringify({ send_email: true, send_whatsapp: false }),
      });
      showToast(r.notifications.email?.ok ? "E-mail reenviado!" : `Falha: ${r.notifications.email?.error}`);
      await Promise.all([loadOverview(), loadNotificationLogs()]);
    } else if (act === "resend-wa") {
      const r = await api(`/api/admin/licenses/${encodeURIComponent(key)}/send-notifications`, {
        method: "POST",
        body: JSON.stringify({ send_email: false, send_whatsapp: true }),
      });
      showToast(r.notifications.whatsapp?.ok ? "WhatsApp enviado!" : `Falha: ${r.notifications.whatsapp?.error}`);
      await Promise.all([loadOverview(), loadNotificationLogs()]);
    } else if (act === "reset-pcs") {
      await api(`/api/admin/licenses/${encodeURIComponent(key)}/reset-machines`, { method: "POST" });
      showToast(`PCs desvinculados da chave ${key}.`);
      await Promise.all([loadOverview(), loadLicenses()]);
    } else if (act === "revoke") {
      await api(`/api/admin/licenses/${encodeURIComponent(key)}/revoke`, { method: "POST" });
      showToast(`Licença ${key} revogada.`);
      await Promise.all([loadOverview(), loadLicenses()]);
    } else if (act === "reactivate") {
      await api(`/api/admin/licenses/${encodeURIComponent(key)}/reactivate`, { method: "POST" });
      showToast(`Licença ${key} reativada!`);
      await Promise.all([loadOverview(), loadLicenses()]);
    }
  } catch (err) {
    showToast(`Erro: ${err.message}`);
  }
});

// ─── Webhooks ──────────────────────────────────────────────────────────────
async function loadWebhooksConfig() {
  const data = await api("/api/admin/webhooks/config");
  const urlsBox = $("webhook-urls-box");
  urlsBox.innerHTML = Object.entries(data.urls)
    .map(
      ([prov, url]) => `
      <div class="url-row">
        <div>
          <strong style="text-transform:uppercase;font-size:11px;color:#ff9c52;">${prov}</strong><br/>
          <code>${escapeHtml(url)}</code>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" data-copy-url="${escapeHtml(url)}">Copiar URL</button>
      </div>`,
    )
    .join("");

  $("status-wh-hotmart").classList.toggle("ok", data.secretsConfigured.hotmart);
  $("status-wh-kiwify").classList.toggle("ok", data.secretsConfigured.kiwify);
  $("status-wh-ticto").classList.toggle("ok", data.secretsConfigured.ticto);
  $("status-wh-stripe").classList.toggle("ok", data.secretsConfigured.stripe);
  $("wh-product-map").value = JSON.stringify(data.productMap || {}, null, 2);
}

$("webhook-urls-box").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copy-url]");
  if (!btn) return;
  await navigator.clipboard.writeText(btn.dataset.copyUrl);
  showToast("URL do webhook copiada!");
});

$("webhook-config-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const productMap = JSON.parse($("wh-product-map").value || "{}");
    await api("/api/admin/webhooks/config", {
      method: "PUT",
      body: JSON.stringify({
        hotmartHottok: $("wh-hotmart").value,
        kiwifyToken: $("wh-kiwify").value,
        tictoToken: $("wh-ticto").value,
        stripeSecret: $("wh-stripe").value,
        productMap,
      }),
    });
    $("wh-hotmart").value = "";
    $("wh-kiwify").value = "";
    $("wh-ticto").value = "";
    $("wh-stripe").value = "";
    showToast("Webhooks atualizados!");
    await loadWebhooksConfig();
  } catch (err) {
    showToast(`Erro no JSON ou salvamento: ${err.message}`);
  }
});

$("webhook-sim-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await api("/api/admin/webhooks/simulate", {
      method: "POST",
      body: JSON.stringify({
        provider: state.simProvider,
        event_type: state.simEvent,
        email: $("sim-email").value.trim(),
        name: $("sim-name").value.trim(),
        phone: $("sim-phone").value.trim(),
        product_id: $("sim-product-id").value.trim(),
        offer_name: $("sim-offer").value.trim(),
      }),
    });
    showToast(`Webhook simulado: ${r.action}${r.license_key ? ` (${r.license_key})` : ""}`);
    await Promise.all([loadOverview(), loadLicenses(), loadWebhooksHistory(), loadNotificationLogs()]);
  } catch (err) {
    showToast(`Erro: ${err.message}`);
  }
});

async function loadWebhooksHistory() {
  const data = await api("/api/admin/webhooks/history");
  const list = $("webhooks-history");
  if (!data.deliveries.length) {
    list.innerHTML = `<div class="muted">Nenhum evento de checkout recebido ainda.</div>`;
    return;
  }
  list.innerHTML = data.deliveries
    .map(
      (d) => `
      <div class="history-item">
        <div class="row-between">
          <strong>${escapeHtml(d.provider.toUpperCase())} · ${escapeHtml(d.event_name)}</strong>
          <span class="pill ${d.action === "revoked" ? "pill-revoked" : "pill-active"}">${escapeHtml(d.action || "ok")}</span>
        </div>
        <div class="muted">
          ${escapeHtml(d.buyer_email || "-")} ${d.buyer_phone ? `· ${escapeHtml(d.buyer_phone)}` : ""}
          ${d.license_key ? `· Chave: <strong>${escapeHtml(d.license_key)}</strong>` : ""}
        </div>
        <div class="muted">${new Date(d.processed_at).toLocaleString("pt-BR")}</div>
      </div>`,
    )
    .join("");
}

$("btn-refresh-webhooks").addEventListener("click", () => void loadWebhooksHistory());

// ─── E-mail & WhatsApp Oficial ─────────────────────────────────────────────
async function loadMessagingConfig() {
  const data = await api("/api/admin/notifications/config");
  const em = data.email;
  const wa = data.whatsapp;

  state.emailProvider = em.provider || "smtp";
  $("email-provider-picker").querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.provider === state.emailProvider),
  );
  $("smtp-fields").classList.toggle("hidden", state.emailProvider !== "smtp");
  $("resend-fields").classList.toggle("hidden", state.emailProvider !== "resend");

  $("smtp-host").value = em.smtpHost || "";
  $("smtp-port").value = em.smtpPort || 465;
  $("smtp-secure").checked = Boolean(em.smtpSecure);
  $("smtp-user").value = em.smtpUser || "";
  $("status-smtp-pass").classList.toggle("ok", em.hasSmtpPass);
  $("status-resend-key").classList.toggle("ok", em.hasResendApiKey);
  $("from-name").value = em.fromName || "Criativo AI Studio";
  $("from-email").value = em.fromEmail || "";
  $("dl-win").value = em.downloadLinks?.windows || "";
  $("dl-mac").value = em.downloadLinks?.macos || "";
  $("dl-linux").value = em.downloadLinks?.linux || "";

  state.waProvider = wa.provider || "none";
  state.waSendMode = wa.sendMode || "template";
  $("wa-provider-picker").querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.provider === state.waProvider),
  );
  $("wa-mode-picker").querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === state.waSendMode),
  );
  $("wa-standby-note").classList.toggle("hidden", state.waProvider !== "none");
  $("wa-cloud-fields").classList.toggle("hidden", state.waProvider !== "cloud_api");

  const standbyBadge = $("wa-standby-badge");
  if (state.waProvider === "cloud_api") {
    standbyBadge.textContent = "API Oficial Ativa";
    standbyBadge.style.color = "#31CF76";
    $("lic-send-wa").checked = true;
  } else {
    standbyBadge.textContent = "Em Standby";
    standbyBadge.style.color = "#ff9c52";
    $("lic-send-wa").checked = false;
  }

  $("wa-cloud-phone").value = wa.cloudPhoneNumberId || "";
  $("status-cloud-key").classList.toggle("ok", wa.hasCloudAccessToken);
  $("wa-cloud-version").value = wa.cloudApiVersion || "v27.0";
  $("wa-template-name").value = wa.templateName || "criativo_entrega_licenca";
  $("wa-template-lang").value = wa.templateLang || "pt_BR";
  $("wa-template").value = wa.messageTemplate || "";
}

$("email-config-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/admin/notifications/email-config", {
      method: "PUT",
      body: JSON.stringify({
        provider: state.emailProvider,
        smtpHost: $("smtp-host").value,
        smtpPort: Number($("smtp-port").value),
        smtpSecure: $("smtp-secure").checked,
        smtpUser: $("smtp-user").value,
        smtpPass: $("smtp-pass").value,
        fromName: $("from-name").value,
        fromEmail: $("from-email").value,
        resendApiKey: $("resend-key").value,
        downloadLinks: {
          windows: $("dl-win").value,
          macos: $("dl-mac").value,
          linux: $("dl-linux").value,
        },
      }),
    });
    $("smtp-pass").value = "";
    $("resend-key").value = "";
    showToast("Configurações de E-mail salvas!");
    await loadMessagingConfig();
  } catch (err) {
    showToast(`Erro: ${err.message}`);
  }
});

$("btn-test-email").addEventListener("click", async () => {
  const to = $("test-email-to").value.trim();
  if (!to) return showToast("Informe o e-mail de destino para teste.");
  try {
    await api("/api/admin/notifications/test-email", {
      method: "POST",
      body: JSON.stringify({ to }),
    });
    showToast(`E-mail de teste enviado para ${to}!`);
    await Promise.all([loadOverview(), loadNotificationLogs()]);
  } catch (err) {
    showToast(`Falha no e-mail: ${err.message}`);
  }
});

$("wa-config-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/admin/notifications/whatsapp-config", {
      method: "PUT",
      body: JSON.stringify({
        provider: state.waProvider,
        cloudPhoneNumberId: $("wa-cloud-phone").value,
        cloudAccessToken: $("wa-cloud-token").value,
        cloudApiVersion: $("wa-cloud-version").value,
        sendMode: state.waSendMode,
        templateName: $("wa-template-name").value,
        templateLang: $("wa-template-lang").value,
        messageTemplate: $("wa-template").value,
      }),
    });
    $("wa-cloud-token").value = "";
    showToast(state.waProvider === "none" ? "WhatsApp mantido em standby." : "Configurações Meta Cloud API salvas!");
    await loadMessagingConfig();
  } catch (err) {
    showToast(`Erro: ${err.message}`);
  }
});

$("btn-test-wa").addEventListener("click", async () => {
  const phone = $("test-wa-phone").value.trim();
  if (!phone) return showToast("Informe o WhatsApp (ex: 5511999999999) para testar.");
  try {
    await api("/api/admin/notifications/test-whatsapp", {
      method: "POST",
      body: JSON.stringify({ phone }),
    });
    showToast(`Mensagem de teste enviada via Meta Cloud API para ${phone}!`);
    await Promise.all([loadOverview(), loadNotificationLogs()]);
  } catch (err) {
    showToast(`WhatsApp: ${err.message}`);
  }
});

async function loadNotificationLogs() {
  const data = await api("/api/admin/notifications/logs");
  const list = $("notification-logs-list");
  if (!data.logs.length) {
    list.innerHTML = `<div class="muted">Nenhum disparo registrado ainda.</div>`;
    return;
  }
  list.innerHTML = data.logs
    .map(
      (l) => `
      <div class="history-item">
        <div class="row-between">
          <strong>${l.channel === "email" ? "📧 E-mail" : "💬 WhatsApp"} ➔ ${escapeHtml(l.recipient)}</strong>
          <span class="pill ${l.status === "sent" ? "pill-active" : l.status === "error" ? "pill-revoked" : "pill-warn"}">${escapeHtml(l.status)}</span>
        </div>
        <div class="muted">${escapeHtml(l.detail)} ${l.license_key ? `· ${escapeHtml(l.license_key)}` : ""}</div>
        <div class="muted">${new Date(l.created_at).toLocaleString("pt-BR")}</div>
      </div>`,
    )
    .join("");
}

$("btn-refresh-logs").addEventListener("click", () => void loadNotificationLogs());

// ─── Releases & Senha ──────────────────────────────────────────────────────
function inferFilenameFromUrl(url, fallback) {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split("/").filter(Boolean).pop();
    return base || fallback;
  } catch {
    return fallback;
  }
}

function buildFriendlyArtifactsList(version) {
  const ver = version || "1.0.1";
  const rows = [];
  const winUrl = $("rel-win-url").value.trim();
  const winSha = $("rel-win-sha").value.trim();
  if (winUrl || winSha) {
    rows.push({
      platform: "win32",
      arch: "x64",
      filename: inferFilenameFromUrl(winUrl, `CriativoAIStudio-Setup-${ver}.exe`),
      sha256: winSha,
      external_url: winUrl || undefined,
      install_mode: "native_installer",
    });
  }
  const macUrl = $("rel-mac-url").value.trim();
  const macSha = $("rel-mac-sha").value.trim();
  if (macUrl || macSha) {
    rows.push({
      platform: "darwin",
      arch: "universal",
      filename: inferFilenameFromUrl(macUrl, `CriativoAIStudio-${ver}-universal.dmg`),
      sha256: macSha,
      external_url: macUrl || undefined,
      install_mode: "native_installer",
    });
  }
  const linuxUrl = $("rel-linux-url").value.trim();
  const linuxSha = $("rel-linux-sha").value.trim();
  if (linuxUrl || linuxSha) {
    rows.push({
      platform: "linux",
      arch: "x64",
      filename: inferFilenameFromUrl(linuxUrl, `CriativoAIStudio-${ver}.AppImage`),
      sha256: linuxSha,
      external_url: linuxUrl || undefined,
      install_mode: "native_installer",
    });
  }
  return rows;
}

$("rel-hotbundle-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  $("rel-hotbundle-json").value = text;
  try {
    const parsed = JSON.parse(text);
    if (parsed.version && !$("rel-version").value.trim()) {
      $("rel-version").value = parsed.version;
    }
    if (parsed.changelog_markdown && !$("rel-changelog").value.trim()) {
      $("rel-changelog").value = parsed.changelog_markdown;
    }
    showToast(`Bundle ${file.name} carregado (${parsed.files?.length || 0} arquivos).`);
  } catch {
    showToast("Arquivo selecionado não é um JSON válido.");
  }
});

$("btn-import-github").addEventListener("click", async () => {
  const repo = $("rel-gh-repo").value.trim();
  const tag = $("rel-gh-tag").value.trim();
  if (!repo) return showToast("Informe o repositório GitHub (ex: owner/repo).");
  try {
    const res = await api("/api/admin/releases/import-github", {
      method: "POST",
      body: JSON.stringify({ repo, tag }),
    });
    const draft = res.draft;
    if (draft.version) $("rel-version").value = draft.version;
    if (draft.changelog_markdown) $("rel-changelog").value = draft.changelog_markdown;
    if (draft.channel === "beta" || draft.channel === "stable") {
      state.relChannel = draft.channel;
      document
        .querySelectorAll("#rel-channel-picker .seg-btn")
        .forEach((b) => b.classList.toggle("active", b.dataset.channel === draft.channel));
    }
    const winArt = (draft.artifacts || []).find((a) => a.platform === "win32");
    const macArt = (draft.artifacts || []).find((a) => a.platform === "darwin");
    const linuxArt = (draft.artifacts || []).find((a) => a.platform === "linux");
    $("rel-win-url").value = winArt?.external_url || "";
    $("rel-win-sha").value = winArt?.sha256 || "";
    $("rel-mac-url").value = macArt?.external_url || "";
    $("rel-mac-sha").value = macArt?.sha256 || "";
    $("rel-linux-url").value = linuxArt?.external_url || "";
    $("rel-linux-sha").value = linuxArt?.sha256 || "";
    $("rel-artifacts").value = JSON.stringify(draft.artifacts || [], null, 2);
    showToast(`Release ${draft.version} importada do GitHub (${draft.artifacts?.length || 0} artefatos).`);
  } catch (err) {
    showToast(`GitHub: ${err.message}`);
  }
});

async function loadReleases() {
  const data = await api("/api/admin/releases");
  const list = $("releases-list");
  if (!data.releases.length) {
    list.innerHTML = `<div class="muted">Nenhuma release cadastrada ainda.</div>`;
    return;
  }
  list.innerHTML = data.releases
    .map((r) => {
      const arts = r.artifacts || [];
      const hasHot = arts.some((a) => a.install_mode === "hot_bundle");
      const plats = Array.from(new Set(arts.map((a) => a.platform))).join(", ");
      return `
      <div class="history-item">
        <div class="row-between">
          <strong>v${escapeHtml(r.version)}</strong>
          <div>
            <span class="pill ${hasHot ? "pill-active" : "pill-warn"}">${hasHot ? "Hot-Bundle" : "Instalador"}</span>
            <span class="pill pill-active">${escapeHtml(r.channel)}</span>
          </div>
        </div>
        <div class="muted">${escapeHtml(r.changelog_markdown || "Sem notas")}</div>
        <div class="muted">${arts.length} artefato(s) [${escapeHtml(plats || "nenhum")}] · ${new Date(r.published_at).toLocaleString("pt-BR")}</div>
      </div>`;
    })
    .join("");
}

$("release-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const version = $("rel-version").value.trim();
    const changelog = $("rel-changelog").value;
    const payload = {
      version,
      channel: state.relChannel,
      changelog_markdown: changelog,
    };

    if (state.relMode === "hot_bundle") {
      const rawHot = $("rel-hotbundle-json").value.trim();
      if (!rawHot) throw new Error("Selecione ou cole o JSON do Hot-Bundle.");
      payload.hot_bundle = JSON.parse(rawHot);
    } else {
      const friendly = buildFriendlyArtifactsList(version);
      const rawJson = $("rel-artifacts").value.trim();
      const parsedJson = rawJson ? JSON.parse(rawJson) : [];
      payload.artifacts = friendly.length > 0 ? friendly : parsedJson;
    }

    await api("/api/admin/releases", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    showToast("Release publicada no feed!");
    await loadReleases();
  } catch (err) {
    showToast(`Erro: ${err.message}`);
  }
});

$("change-password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({
        current_password: $("pwd-current").value,
        new_password: $("pwd-new").value,
      }),
    });
    $("pwd-current").value = "";
    $("pwd-new").value = "";
    showToast("Senha alterada com sucesso!");
  } catch (err) {
    showToast(`Erro: ${err.message}`);
  }
});

void checkSession();
