import {
  api,
  ensureStylesheet,
  escapeHtml,
  formatDateTime,
  openModal,
  showToast,
} from "./core/api.js";
import { refreshDashboardData, store } from "./core/state.js";
import { registerView } from "./core/router.js";

ensureStylesheet("/styles/views.css");

function interpolateWhatsAppPreview(tpl) {
  return String(tpl || "")
    .replaceAll("{{1}}", "Cliente Exemplo")
    .replaceAll("{{2}}", "cliente@exemplo.invalid")
    .replaceAll("{{3}}", "CRIA-IND-0000-0000-0000")
    .replaceAll("{{4}}", "Licença Individual");
}

function logStatusPill(status) {
  const cls = status === "sent" ? "pill-active" : status === "error" ? "pill-revoked" : "pill-warn";
  return `<span class="pill ${cls}">${escapeHtml(String(status || "-").toUpperCase())}</span>`;
}

registerView("messaging", {
  async render(root) {
    const state = store.get();
    const ncfg = state.notificationsConfig || { email: {}, whatsapp: {} };
    const em = ncfg.email || {};
    const wa = ncfg.whatsapp || {};
    const dl = em.downloadLinks || {};
    let filterChannel = "";
    let filterStatus = "";

    root.innerHTML = `
      <div class="view-stack">
        <div class="view-header">
          <div>
            <h1>E-mail & WhatsApp</h1>
            <p class="muted">Configure SMTP/Resend, Meta Cloud API Oficial, visualize previews seguros e audite os envios.</p>
          </div>
        </div>

        <div class="two-col">
          <section class="panel-card">
            <div class="card-header row-between">
              <div>
                <h2>Provedor de E-mail</h2>
                <p class="muted">Entrega automática da chave de licença e links de download.</p>
              </div>
              <button type="button" class="btn btn-secondary btn-sm" id="btn-preview-email">Preview Visual</button>
            </div>
            <form id="email-cfg-form" class="form-stack">
              <div class="grid-2">
                <label class="field">
                  <span>Provedor</span>
                  <select id="em-provider">
                    <option value="none" ${em.provider === "none" ? "selected" : ""}>Desativado</option>
                    <option value="smtp" ${em.provider === "smtp" ? "selected" : ""}>SMTP (Nodemailer)</option>
                    <option value="resend" ${em.provider === "resend" ? "selected" : ""}>Resend API</option>
                  </select>
                </label>
                <label class="field">
                  <span>Nome do Remetente</span>
                  <input type="text" id="em-from-name" value="${escapeHtml(em.fromName || "Criativo AI Studio")}" />
                </label>
              </div>
              <label class="field">
                <span>E-mail Remetente</span>
                <input type="email" id="em-from-email" value="${escapeHtml(em.fromEmail || "")}" placeholder="suporte@exemplo.invalid" />
              </label>
              <div class="grid-3">
                <label class="field">
                  <span>Host SMTP</span>
                  <input type="text" id="em-smtp-host" value="${escapeHtml(em.smtpHost || "")}" placeholder="smtp.exemplo.invalid" />
                </label>
                <label class="field">
                  <span>Porta</span>
                  <input type="number" id="em-smtp-port" value="${escapeHtml(em.smtpPort || 465)}" />
                </label>
                <label class="field">
                  <span>SSL/TLS</span>
                  <select id="em-smtp-secure">
                    <option value="true" ${em.smtpSecure !== false ? "selected" : ""}>Sim (465)</option>
                    <option value="false" ${em.smtpSecure === false ? "selected" : ""}>Não / STARTTLS</option>
                  </select>
                </label>
              </div>
              <div class="grid-2">
                <label class="field">
                  <span>Usuário SMTP</span>
                  <input type="text" id="em-smtp-user" value="${escapeHtml(em.smtpUser || "")}" placeholder="usuario@exemplo.invalid" />
                </label>
                <label class="field">
                  <span>Senha SMTP</span>
                  <input type="password" id="em-smtp-pass" placeholder="${em.hasSmtpPass ? "•••••••• (mantém atual)" : "Senha SMTP"}" />
                </label>
              </div>
              <label class="field">
                <span>Resend API Key</span>
                <input type="password" id="em-resend-key" placeholder="${em.hasResendApiKey ? "•••••••• (mantém atual)" : "re_..."}" />
              </label>
              <div class="grid-3">
                <label class="field">
                  <span>Link Windows (.exe)</span>
                  <input type="url" id="em-dl-win" value="${escapeHtml(dl.windows || "")}" />
                </label>
                <label class="field">
                  <span>Link macOS (.dmg)</span>
                  <input type="url" id="em-dl-mac" value="${escapeHtml(dl.macos || "")}" />
                </label>
                <label class="field">
                  <span>Link Linux (.AppImage)</span>
                  <input type="url" id="em-dl-lin" value="${escapeHtml(dl.linux || "")}" />
                </label>
              </div>
              <button type="submit" class="btn btn-primary">Salvar Config de E-mail</button>
            </form>
            <hr class="divider" />
            <div class="toolbar-row">
              <input type="email" id="em-test-to" class="toolbar-search" placeholder="teste@exemplo.invalid" />
              <button type="button" class="btn btn-secondary" id="btn-test-email">Enviar E-mail Teste</button>
            </div>
          </section>

          <section class="panel-card">
            <div class="card-header row-between">
              <div>
                <h2>WhatsApp (Meta Cloud API)</h2>
                <p class="muted">Modo padrão em standby até ativar a API oficial da Meta.</p>
              </div>
              <span class="pill ${wa.provider === "cloud_api" ? "pill-active" : "pill-warn"}">${wa.provider === "cloud_api" ? "Cloud API Ativa" : "Em Standby"}</span>
            </div>
            <form id="wa-cfg-form" class="form-stack">
              <div class="grid-2">
                <label class="field">
                  <span>Modo do Canal</span>
                  <select id="wa-provider">
                    <option value="none" ${wa.provider !== "cloud_api" ? "selected" : ""}>Em Standby (Desativado)</option>
                    <option value="cloud_api" ${wa.provider === "cloud_api" ? "selected" : ""}>Meta Cloud API Oficial</option>
                  </select>
                </label>
                <label class="field">
                  <span>Modo de Envio</span>
                  <select id="wa-send-mode">
                    <option value="template" ${wa.sendMode !== "text" ? "selected" : ""}>Template Aprovado</option>
                    <option value="text" ${wa.sendMode === "text" ? "selected" : ""}>Texto Livre</option>
                  </select>
                </label>
              </div>
              <div class="grid-3">
                <label class="field">
                  <span>Phone Number ID</span>
                  <input type="text" id="wa-phone-id" value="${escapeHtml(wa.cloudPhoneNumberId || "")}" placeholder="100000000000000" />
                </label>
                <label class="field">
                  <span>Versão Graph</span>
                  <input type="text" id="wa-api-ver" value="${escapeHtml(wa.cloudApiVersion || "v27.0")}" />
                </label>
                <label class="field">
                  <span>Access Token</span>
                  <input type="password" id="wa-token" placeholder="${wa.hasCloudAccessToken ? "•••••••• (mantém atual)" : "EAAG..."}" />
                </label>
              </div>
              <div class="grid-2">
                <label class="field">
                  <span>Nome do Template</span>
                  <input type="text" id="wa-tpl-name" value="${escapeHtml(wa.templateName || "criativo_entrega_licenca")}" />
                </label>
                <label class="field">
                  <span>Idioma</span>
                  <input type="text" id="wa-tpl-lang" value="${escapeHtml(wa.templateLang || "pt_BR")}" />
                </label>
              </div>
              <label class="field">
                <span>Corpo da Mensagem (Placeholders {{1}}..{{4}})</span>
                <textarea id="wa-tpl-body" rows="4">${escapeHtml(wa.messageTemplate || "")}</textarea>
              </label>
              <div class="wa-preview-shell">
                <div class="muted mb-8">Preview ao Vivo da Bolha WhatsApp</div>
                <div class="wa-preview-bubble" id="wa-live-bubble"></div>
                <div class="wa-preview-meta">Variáveis de exemplo: Cliente Exemplo · cliente@exemplo.invalid · CRIA-IND-0000-0000-0000</div>
              </div>
              <button type="submit" class="btn btn-primary">Salvar Config WhatsApp</button>
            </form>
            <hr class="divider" />
            <div class="toolbar-row">
              <input type="text" id="wa-test-phone" class="toolbar-search" placeholder="+5511900000000" />
              <button type="button" class="btn btn-secondary" id="btn-test-wa">Enviar WhatsApp Teste</button>
            </div>
          </section>
        </div>

        <section class="panel-card">
          <div class="card-header row-between">
            <div>
              <h2>Histórico de Notificações</h2>
              <p class="muted">Últimos disparos automáticos e manuais por canal.</p>
            </div>
            <div class="toolbar-row">
              <select id="log-filter-channel" class="filter-select">
                <option value="">Todos os canais</option>
                <option value="email">E-mail</option>
                <option value="whatsapp">WhatsApp</option>
              </select>
              <select id="log-filter-status" class="filter-select">
                <option value="">Todos os status</option>
                <option value="sent">Enviado (sent)</option>
                <option value="error">Erro (error)</option>
                <option value="skipped">Ignorado (skipped)</option>
              </select>
            </div>
          </div>
          <div class="table-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Canal</th>
                  <th>Destinatário</th>
                  <th>Licença</th>
                  <th>Status</th>
                  <th>Detalhe</th>
                  <th>Data</th>
                </tr>
              </thead>
              <tbody id="msg-logs-tbody"></tbody>
            </table>
          </div>
        </section>
      </div>
    `;

    const bubble = root.querySelector("#wa-live-bubble");
    const tplInput = root.querySelector("#wa-tpl-body");
    const syncBubble = () => {
      if (bubble && tplInput) bubble.textContent = interpolateWhatsAppPreview(tplInput.value);
    };
    syncBubble();
    tplInput?.addEventListener("input", syncBubble);

    root.querySelector("#btn-preview-email")?.addEventListener("click", async () => {
      try {
        const res = await api("/api/admin/notifications/preview-email", {
          method: "POST",
          body: JSON.stringify({
            customer_name: "Cliente Exemplo",
            customer_email: "cliente@exemplo.invalid",
            plan_tier: "agencia_10",
            license_key: "CRIA-AG10-0000-0000-0000",
          }),
        });
        openModal({
          title: "Preview Visual do E-mail",
          subtitle: res.subject || "Assunto do e-mail de entrega",
          width: 680,
          bodyHtml: `<iframe sandbox="" class="email-preview-frame" id="email-preview-iframe" title="Preview do e-mail"></iframe>`,
          onMount: (modalRoot) => {
            const iframe = modalRoot.querySelector("#email-preview-iframe");
            if (iframe) iframe.srcdoc = res.html || "";
          },
        });
      } catch (err) {
        showToast(`Erro ao gerar preview: ${err.message}`, "error");
      }
    });

    root.querySelector("#email-cfg-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = {
        provider: root.querySelector("#em-provider").value,
        fromName: root.querySelector("#em-from-name").value.trim(),
        fromEmail: root.querySelector("#em-from-email").value.trim(),
        smtpHost: root.querySelector("#em-smtp-host").value.trim(),
        smtpPort: Number(root.querySelector("#em-smtp-port").value || 465),
        smtpSecure: root.querySelector("#em-smtp-secure").value === "true",
        smtpUser: root.querySelector("#em-smtp-user").value.trim(),
        downloadLinks: {
          windows: root.querySelector("#em-dl-win").value.trim(),
          macos: root.querySelector("#em-dl-mac").value.trim(),
          linux: root.querySelector("#em-dl-lin").value.trim(),
        },
      };
      const pass = root.querySelector("#em-smtp-pass").value.trim();
      const resendKey = root.querySelector("#em-resend-key").value.trim();
      if (pass) body.smtpPass = pass;
      if (resendKey) body.resendApiKey = resendKey;
      try {
        await api("/api/admin/notifications/email-config", { method: "PUT", body: JSON.stringify(body) });
        showToast("Configurações de e-mail salvas!", "success");
        await refreshDashboardData(["notificationsConfig"]);
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    root.querySelector("#btn-test-email")?.addEventListener("click", async () => {
      const to = root.querySelector("#em-test-to").value.trim();
      if (!to) return showToast("Informe o e-mail de destino para o teste.", "error");
      try {
        await api("/api/admin/notifications/test-email", { method: "POST", body: JSON.stringify({ to }) });
        showToast("E-mail de teste enviado!", "success");
        await refreshDashboardData(["notificationLogs", "overview"]);
        renderLogs();
      } catch (err) {
        showToast(`Falha no envio teste: ${err.message}`, "error");
        await refreshDashboardData(["notificationLogs"]);
        renderLogs();
      }
    });

    root.querySelector("#wa-cfg-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = {
        provider: root.querySelector("#wa-provider").value,
        sendMode: root.querySelector("#wa-send-mode").value,
        cloudPhoneNumberId: root.querySelector("#wa-phone-id").value.trim(),
        cloudApiVersion: root.querySelector("#wa-api-ver").value.trim(),
        templateName: root.querySelector("#wa-tpl-name").value.trim(),
        templateLang: root.querySelector("#wa-tpl-lang").value.trim(),
        messageTemplate: root.querySelector("#wa-tpl-body").value,
      };
      const tok = root.querySelector("#wa-token").value.trim();
      if (tok) body.cloudAccessToken = tok;
      try {
        await api("/api/admin/notifications/whatsapp-config", { method: "PUT", body: JSON.stringify(body) });
        showToast("Configurações de WhatsApp salvas!", "success");
        await refreshDashboardData(["notificationsConfig"]);
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    root.querySelector("#btn-test-wa")?.addEventListener("click", async () => {
      const phone = root.querySelector("#wa-test-phone").value.trim();
      if (!phone) return showToast("Informe o telefone com DDD para o teste.", "error");
      try {
        await api("/api/admin/notifications/test-whatsapp", { method: "POST", body: JSON.stringify({ phone }) });
        showToast("WhatsApp de teste enviado!", "success");
        await refreshDashboardData(["notificationLogs", "overview"]);
        renderLogs();
      } catch (err) {
        showToast(`Falha no WhatsApp teste: ${err.message}`, "error");
        await refreshDashboardData(["notificationLogs"]);
        renderLogs();
      }
    });

    const tbody = root.querySelector("#msg-logs-tbody");
    function renderLogs() {
      if (!tbody) return;
      const logs = (store.get().notificationLogs || []).filter((l) => {
        if (filterChannel && l.channel !== filterChannel) return false;
        if (filterStatus && l.status !== filterStatus) return false;
        return true;
      });
      if (!logs.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="muted">Nenhum registro encontrado.</td></tr>`;
        return;
      }
      tbody.innerHTML = logs
        .map((l) => `
          <tr>
            <td><strong>${escapeHtml(String(l.channel || "").toUpperCase())}</strong></td>
            <td>${escapeHtml(l.recipient || "-")}</td>
            <td class="tabular-nums">${escapeHtml(l.license_key || "-")}</td>
            <td>${logStatusPill(l.status)}</td>
            <td class="muted">${escapeHtml(l.detail || "-")}</td>
            <td class="muted tabular-nums">${escapeHtml(formatDateTime(l.created_at))}</td>
          </tr>
        `)
        .join("");
    }

    renderLogs();
    root.querySelector("#log-filter-channel")?.addEventListener("change", (e) => {
      filterChannel = e.target.value;
      renderLogs();
    });
    root.querySelector("#log-filter-status")?.addEventListener("change", (e) => {
      filterStatus = e.target.value;
      renderLogs();
    });
  },
});
