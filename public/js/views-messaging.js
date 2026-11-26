import {
  api,
  ensureStylesheet,
  escapeHtml,
  formatDateTime,
  openModal,
  setButtonLoading,
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
  const cls = status === "sent" ? "pill-active" : status === "error" || status === "failed" ? "pill-revoked" : "pill-warn";
  return `<span class="pill ${cls}">${escapeHtml(String(status || "-").toUpperCase())}</span>`;
}

registerView("messaging", {
  async render(root) {
    if (!store.get().notificationQueue) {
      await refreshDashboardData(["notificationsConfig", "notificationLogs", "notificationQueue"]);
    }
    const state = store.get();
    const ncfg = state.notificationsConfig || { email: {}, whatsapp: {} };
    const em = ncfg.email || {};
    const wa = ncfg.whatsapp || {};
    const dl = em.downloadLinks || {};

    let emailProvider = em.provider || "none";
    let waProvider = wa.provider === "cloud_api" ? "cloud_api" : "none";
    let waSendMode = wa.sendMode === "text" ? "text" : "template";
    let filterChannel = "";
    let filterStatus = "";

    const renderView = () => {
      const queue = store.get().notificationQueue || [];
      const pendingQueue = queue.filter((q) => q.status === "pending");

      root.innerHTML = `
        <div class="view-stack">
          <div class="view-header">
            <div>
              <h1>Entregas (E-mail & WhatsApp)</h1>
              <p class="muted">Configure apenas os canais que utiliza, visualize os 4 templates de evento e monitore a fila de retentativas.</p>
            </div>
            <div class="btn-row">
              <button type="button" class="btn btn-secondary btn-sm" id="btn-preview-email">Preview dos Templates de E-mail</button>
            </div>
          </div>

          <div class="two-col">
            <section class="panel-card">
              <div class="card-header row-between">
                <div>
                  <h2>Entrega por E-mail</h2>
                  <p class="muted">Links de download sincronizam automaticamente com a última Release.</p>
                </div>
                <span class="pill ${emailProvider !== "none" ? "pill-active" : "pill-warn"}">${emailProvider === "none" ? "Desativado" : emailProvider.toUpperCase()}</span>
              </div>
              <form id="email-cfg-form" class="form-stack">
                <div class="grid-2">
                  <label class="field">
                    <span>Provedor de Envio</span>
                    <select id="em-provider">
                      <option value="none" ${emailProvider === "none" ? "selected" : ""}>Desativado</option>
                      <option value="smtp" ${emailProvider === "smtp" ? "selected" : ""}>SMTP (Nodemailer)</option>
                      <option value="resend" ${emailProvider === "resend" ? "selected" : ""}>Resend API</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Nome do Remetente</span>
                    <input type="text" id="em-from-name" value="${escapeHtml(em.fromName || "CriativoOS")}" />
                  </label>
                </div>

                ${
                  emailProvider !== "none"
                    ? `<label class="field">
                        <span>E-mail Remetente</span>
                        <input type="email" id="em-from-email" value="${escapeHtml(em.fromEmail || "")}" placeholder="suporte@exemplo.invalid" />
                      </label>`
                    : ""
                }

                ${
                  emailProvider === "smtp"
                    ? `<div class="grid-3">
                        <label class="field"><span>Host SMTP</span><input type="text" id="em-smtp-host" value="${escapeHtml(em.smtpHost || "")}" placeholder="smtp.exemplo.invalid" /></label>
                        <label class="field"><span>Porta</span><input type="number" id="em-smtp-port" value="${escapeHtml(em.smtpPort || 465)}" /></label>
                        <label class="field"><span>SSL/TLS</span>
                          <select id="em-smtp-secure">
                            <option value="true" ${em.smtpSecure !== false ? "selected" : ""}>Sim (465)</option>
                            <option value="false" ${em.smtpSecure === false ? "selected" : ""}>STARTTLS (587)</option>
                          </select>
                        </label>
                      </div>
                      <div class="grid-2">
                        <label class="field"><span>Usuário SMTP</span><input type="text" id="em-smtp-user" value="${escapeHtml(em.smtpUser || "")}" placeholder="usuario@exemplo.invalid" /></label>
                        <label class="field"><span>Senha SMTP</span><input type="password" id="em-smtp-pass" placeholder="${em.hasSmtpPass ? "•••••••• (mantém atual)" : "Senha SMTP"}" /></label>
                      </div>`
                    : ""
                }

                ${
                  emailProvider === "resend"
                    ? `<label class="field"><span>Resend API Key</span><input type="password" id="em-resend-key" placeholder="${em.hasResendApiKey ? "•••••••• (mantém atual)" : "re_..."}" /></label>`
                    : ""
                }

                <details class="details-box">
                  <summary>Links de Download nos E-mails (${em.useManualDownloadLinks ? "Override Manual Ativo" : "Automático via Releases"})</summary>
                  <div class="form-stack">
                    <label class="check-inline">
                      <input type="checkbox" id="em-use-manual-dl" ${em.useManualDownloadLinks ? "checked" : ""} />
                      <span>Substituir links automáticos da última Release por URLs manuais</span>
                    </label>
                    <div class="grid-3">
                      <label class="field"><span>Windows (.exe)</span><input type="url" id="em-dl-win" value="${escapeHtml(dl.windows || "")}" /></label>
                      <label class="field"><span>macOS (.dmg)</span><input type="url" id="em-dl-mac" value="${escapeHtml(dl.macos || "")}" /></label>
                      <label class="field"><span>Linux (.AppImage)</span><input type="url" id="em-dl-lin" value="${escapeHtml(dl.linux || "")}" /></label>
                    </div>
                  </div>
                </details>

                <button type="submit" class="btn btn-primary" id="btn-save-email-cfg">Salvar Config de E-mail</button>
              </form>
              ${
                emailProvider !== "none"
                  ? `<hr class="divider" />
                     <div class="toolbar-row">
                       <input type="email" id="em-test-to" class="toolbar-search" placeholder="teste@exemplo.invalid" />
                       <button type="button" class="btn btn-secondary" id="btn-test-email">Enviar E-mail Teste</button>
                     </div>`
                  : ""
              }
            </section>

            <section class="panel-card">
              <div class="card-header row-between">
                <div>
                  <h2>WhatsApp (Meta Cloud API)</h2>
                  <p class="muted">Canal opcional oficial para entrega instantânea no celular do comprador.</p>
                </div>
                <span class="pill ${waProvider === "cloud_api" ? "pill-active" : "pill-warn"}">${waProvider === "cloud_api" ? "Cloud API Ativa" : "Em Standby"}</span>
              </div>
              <form id="wa-cfg-form" class="form-stack">
                <label class="field">
                  <span>Modo do Canal</span>
                  <select id="wa-provider">
                    <option value="none" ${waProvider !== "cloud_api" ? "selected" : ""}>Em Standby (Desativado)</option>
                    <option value="cloud_api" ${waProvider === "cloud_api" ? "selected" : ""}>Meta Cloud API Oficial</option>
                  </select>
                </label>

                ${
                  waProvider === "cloud_api"
                    ? `<div class="grid-2">
                        <label class="field"><span>Modo de Envio</span>
                          <select id="wa-send-mode">
                            <option value="template" ${waSendMode !== "text" ? "selected" : ""}>Template Aprovado</option>
                            <option value="text" ${waSendMode === "text" ? "selected" : ""}>Texto Livre</option>
                          </select>
                        </label>
                        <label class="field"><span>Versão Graph</span><input type="text" id="wa-api-ver" value="${escapeHtml(wa.cloudApiVersion || "v27.0")}" /></label>
                      </div>
                      <div class="grid-2">
                        <label class="field"><span>Phone Number ID</span><input type="text" id="wa-phone-id" value="${escapeHtml(wa.cloudPhoneNumberId || "")}" placeholder="100000000000000" /></label>
                        <label class="field"><span>Access Token</span><input type="password" id="wa-token" placeholder="${wa.hasCloudAccessToken ? "•••••••• (mantém atual)" : "EAAG..."}" /></label>
                      </div>
                      ${
                        waSendMode === "template"
                          ? `<div class="grid-2">
                              <label class="field"><span>Nome do Template</span><input type="text" id="wa-tpl-name" value="${escapeHtml(wa.templateName || "criativo_entrega_licenca")}" /></label>
                              <label class="field"><span>Idioma</span><input type="text" id="wa-tpl-lang" value="${escapeHtml(wa.templateLang || "pt_BR")}" /></label>
                            </div>`
                          : `<label class="field"><span>Corpo da Mensagem ({{1}}..{{4}})</span>
                              <textarea id="wa-tpl-body" rows="4">${escapeHtml(wa.messageTemplate || "")}</textarea>
                            </label>
                            <div class="wa-preview-shell">
                              <div class="muted mb-8">Preview ao Vivo</div>
                              <div class="wa-preview-bubble" id="wa-live-bubble"></div>
                            </div>`
                      }`
                    : `<div class="empty-state-card" style="padding:24px 16px;">
                        <p class="muted" style="margin:0;">WhatsApp está em standby. Selecione <strong>Meta Cloud API Oficial</strong> acima quando quiser ativar entregas no WhatsApp.</p>
                      </div>`
                }

                <button type="submit" class="btn btn-primary" id="btn-save-wa-cfg">Salvar Config WhatsApp</button>
              </form>
              ${
                waProvider === "cloud_api"
                  ? `<hr class="divider" />
                     <div class="toolbar-row">
                       <input type="text" id="wa-test-phone" class="toolbar-search" placeholder="+5511900000000" />
                       <button type="button" class="btn btn-secondary" id="btn-test-wa">Enviar WhatsApp Teste</button>
                     </div>`
                  : ""
              }
            </section>
          </div>

          ${
            queue.length > 0
              ? `<section class="panel-card">
                  <div class="card-header row-between">
                    <div>
                      <h2>Fila de Retentativas Automáticas (${pendingQueue.length} pendente(s))</h2>
                      <p class="muted">Quando SMTP, Resend ou Meta falham na hora da venda, os envios entram aqui para retry automático.</p>
                    </div>
                    <button type="button" class="btn btn-secondary btn-sm" id="btn-retry-queue">Reprocessar Fila Agora</button>
                  </div>
                  <div class="table-scroll">
                    <table class="data-table">
                      <thead><tr><th>Canal</th><th>Destinatário</th><th>Licença</th><th>Tentativas</th><th>Status</th><th>Último Erro</th></tr></thead>
                      <tbody>
                        ${queue
                          .slice(0, 15)
                          .map(
                            (q) => `<tr>
                              <td><strong>${escapeHtml(q.channel.toUpperCase())}</strong></td>
                              <td>${escapeHtml(q.recipient)}</td>
                              <td class="tabular-nums">${escapeHtml(q.license_key || "-")}</td>
                              <td class="tabular-nums">${q.attempts}/${q.max_attempts}</td>
                              <td>${logStatusPill(q.status)}</td>
                              <td class="muted">${escapeHtml(q.last_error || "-")}</td>
                            </tr>`,
                          )
                          .join("")}
                      </tbody>
                    </table>
                  </div>
                </section>`
              : ""
          }

          <section class="panel-card">
            <div class="card-header row-between">
              <div>
                <h2>Histórico de Notificações</h2>
                <p class="muted">Últimos disparos automáticos e manuais por canal.</p>
              </div>
              <div class="toolbar-row">
                <select id="log-filter-channel" class="filter-select">
                  <option value="">Todos os canais</option>
                  <option value="email" ${filterChannel === "email" ? "selected" : ""}>E-mail</option>
                  <option value="whatsapp" ${filterChannel === "whatsapp" ? "selected" : ""}>WhatsApp</option>
                </select>
                <select id="log-filter-status" class="filter-select">
                  <option value="">Todos os status</option>
                  <option value="sent" ${filterStatus === "sent" ? "selected" : ""}>Enviado</option>
                  <option value="error" ${filterStatus === "error" ? "selected" : ""}>Erro</option>
                  <option value="skipped" ${filterStatus === "skipped" ? "selected" : ""}>Ignorado</option>
                </select>
              </div>
            </div>
            <div class="table-scroll">
              <table class="data-table">
                <thead><tr><th>Canal</th><th>Destinatário</th><th>Licença</th><th>Status</th><th>Detalhe</th><th>Data</th></tr></thead>
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

      root.querySelector("#em-provider")?.addEventListener("change", (e) => {
        emailProvider = e.target.value;
        renderView();
      });
      root.querySelector("#wa-provider")?.addEventListener("change", (e) => {
        waProvider = e.target.value;
        renderView();
      });
      root.querySelector("#wa-send-mode")?.addEventListener("change", (e) => {
        waSendMode = e.target.value;
        renderView();
      });

      root.querySelector("#btn-preview-email")?.addEventListener("click", async () => {
        const loadPreview = async (evType) => {
          const res = await api("/api/admin/notifications/preview-email", {
            method: "POST",
            body: JSON.stringify({
              customer_name: "Cliente Exemplo",
              customer_email: "cliente@exemplo.invalid",
              plan_tier: "agencia_10",
              license_key: "CRIA-AG10-0000-0000-0000",
              event_type: evType,
            }),
          });
          return res;
        };
        try {
          const initial = await loadPreview("license_issued");
          openModal({
            title: "Preview Visual dos Templates de E-mail",
            subtitle: initial.subject || "",
            width: 700,
            bodyHtml: `
              <div class="form-stack">
                <label class="field"><span>Template do Evento</span>
                  <select id="prev-ev-select">
                    <option value="license_issued">Nova Licença Emitida</option>
                    <option value="upgrade_added">Upgrade / Bônus Adicionado</option>
                    <option value="subscription_renewed">Assinatura Renovada</option>
                    <option value="license_revoked">Aviso de Revogação / Reembolso</option>
                  </select>
                </label>
                <iframe sandbox="" class="email-preview-frame" id="email-preview-iframe" title="Preview do e-mail"></iframe>
              </div>`,
            onMount: (modalRoot) => {
              const iframe = modalRoot.querySelector("#email-preview-iframe");
              if (iframe) iframe.srcdoc = initial.html || "";
              modalRoot.querySelector("#prev-ev-select")?.addEventListener("change", async (e) => {
                const next = await loadPreview(e.target.value);
                if (iframe) iframe.srcdoc = next.html || "";
              });
            },
          });
        } catch (err) {
          showToast(err.message, "error");
        }
      });

      root.querySelector("#email-cfg-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = root.querySelector("#btn-save-email-cfg");
        setButtonLoading(btn, true, "Salvando...");
        const body = {
          provider: emailProvider,
          fromName: root.querySelector("#em-from-name")?.value.trim() || "CriativoOS",
          useManualDownloadLinks: Boolean(root.querySelector("#em-use-manual-dl")?.checked),
          downloadLinks: {
            windows: root.querySelector("#em-dl-win")?.value.trim() || dl.windows || "",
            macos: root.querySelector("#em-dl-mac")?.value.trim() || dl.macos || "",
            linux: root.querySelector("#em-dl-lin")?.value.trim() || dl.linux || "",
          },
        };
        if (root.querySelector("#em-from-email")) body.fromEmail = root.querySelector("#em-from-email").value.trim();
        if (emailProvider === "smtp") {
          body.smtpHost = root.querySelector("#em-smtp-host").value.trim();
          body.smtpPort = Number(root.querySelector("#em-smtp-port").value || 465);
          body.smtpSecure = root.querySelector("#em-smtp-secure").value === "true";
          body.smtpUser = root.querySelector("#em-smtp-user").value.trim();
          const pass = root.querySelector("#em-smtp-pass").value.trim();
          if (pass) body.smtpPass = pass;
        }
        if (emailProvider === "resend") {
          const rKey = root.querySelector("#em-resend-key").value.trim();
          if (rKey) body.resendApiKey = rKey;
        }
        try {
          await api("/api/admin/notifications/email-config", { method: "PUT", body: JSON.stringify(body) });
          showToast("Configurações de e-mail salvas!", "success");
          await refreshDashboardData(["notificationsConfig"]);
          renderView();
        } catch (err) {
          showToast(err.message, "error");
          setButtonLoading(btn, false);
        }
      });

      root.querySelector("#btn-test-email")?.addEventListener("click", async (e) => {
        const to = root.querySelector("#em-test-to")?.value.trim();
        if (!to) return showToast("Informe o e-mail de destino para o teste.", "error");
        const btn = e.currentTarget;
        setButtonLoading(btn, true, "Enviando...");
        try {
          await api("/api/admin/notifications/test-email", { method: "POST", body: JSON.stringify({ to }) });
          showToast("E-mail de teste enviado!", "success");
          await refreshDashboardData(["notificationLogs", "overview"]);
          renderLogs();
        } catch (err) {
          showToast(`Falha no envio teste: ${err.message}`, "error");
          await refreshDashboardData(["notificationLogs"]);
          renderLogs();
        } finally {
          setButtonLoading(btn, false);
        }
      });

      root.querySelector("#wa-cfg-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = root.querySelector("#btn-save-wa-cfg");
        setButtonLoading(btn, true, "Salvando...");
        const body = { provider: waProvider };
        if (waProvider === "cloud_api") {
          body.sendMode = waSendMode;
          body.cloudPhoneNumberId = root.querySelector("#wa-phone-id")?.value.trim() || "";
          body.cloudApiVersion = root.querySelector("#wa-api-ver")?.value.trim() || "v27.0";
          const tok = root.querySelector("#wa-token")?.value.trim();
          if (tok) body.cloudAccessToken = tok;
          if (waSendMode === "template") {
            body.templateName = root.querySelector("#wa-tpl-name")?.value.trim() || "";
            body.templateLang = root.querySelector("#wa-tpl-lang")?.value.trim() || "pt_BR";
          } else {
            body.messageTemplate = root.querySelector("#wa-tpl-body")?.value || "";
          }
        }
        try {
          await api("/api/admin/notifications/whatsapp-config", { method: "PUT", body: JSON.stringify(body) });
          showToast("Configurações de WhatsApp salvas!", "success");
          await refreshDashboardData(["notificationsConfig"]);
          renderView();
        } catch (err) {
          showToast(err.message, "error");
          setButtonLoading(btn, false);
        }
      });

      root.querySelector("#btn-test-wa")?.addEventListener("click", async (e) => {
        const phone = root.querySelector("#wa-test-phone")?.value.trim();
        if (!phone) return showToast("Informe o telefone com DDD para o teste.", "error");
        const btn = e.currentTarget;
        setButtonLoading(btn, true, "Enviando...");
        try {
          await api("/api/admin/notifications/test-whatsapp", { method: "POST", body: JSON.stringify({ phone }) });
          showToast("WhatsApp de teste enviado!", "success");
          await refreshDashboardData(["notificationLogs", "overview"]);
          renderLogs();
        } catch (err) {
          showToast(`Falha no WhatsApp teste: ${err.message}`, "error");
          await refreshDashboardData(["notificationLogs"]);
          renderLogs();
        } finally {
          setButtonLoading(btn, false);
        }
      });

      root.querySelector("#btn-retry-queue")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        setButtonLoading(btn, true, "Reprocessando...");
        try {
          const r = await api("/api/admin/notifications/retry-due", { method: "POST", body: JSON.stringify({ force_now: true }) });
          showToast(`Fila processada: ${r.sent || 0} enviado(s), ${r.failed || 0} falha(s).`, "success");
          await refreshDashboardData(["notificationQueue", "notificationLogs", "licenses"]);
          renderView();
        } catch (err) {
          showToast(err.message, "error");
          setButtonLoading(btn, false);
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
          .map(
            (l) => `
            <tr>
              <td><strong>${escapeHtml(String(l.channel || "").toUpperCase())}</strong></td>
              <td class="wrap-anywhere">${escapeHtml(l.recipient || "-")}</td>
              <td class="tabular-nums">${escapeHtml(l.license_key || "-")}</td>
              <td>${logStatusPill(l.status)}</td>
              <td class="muted wrap-anywhere">${escapeHtml(l.detail || "-")}</td>
              <td class="muted tabular-nums">${escapeHtml(formatDateTime(l.created_at))}</td>
            </tr>`,
          )
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
    };

    renderView();
  },
});
