import { api, copyText, ensureStylesheet, escapeHtml, showToast } from "./core/api.js";
import { store } from "./core/state.js";
import { registerView } from "./core/router.js";

ensureStylesheet("/styles/views.css");

const SECRET_ITEMS = [
  { group: "webhook", key: "hotmart", label: "Gateway Hotmart (Hottok)" },
  { group: "webhook", key: "kiwify", label: "Gateway Kiwify (Token/HMAC)" },
  { group: "webhook", key: "ticto", label: "Gateway Ticto (Token)" },
  { group: "webhook", key: "stripe", label: "Gateway Stripe (Signing Secret)" },
  { group: "webhook", key: "cakto", label: "Gateway Cakto (Secret)" },
  { group: "webhook", key: "kirvano", label: "Gateway Kirvano (Token)" },
  { group: "webhook", key: "generic", label: "Webhook Genérico (HMAC-SHA256)" },
];

registerView("security", {
  async render(root) {
    const state = store.get();
    const ov = state.overview || {};
    const whCfg = state.webhooksConfig?.secretsConfigured || {};
    const emCfg = state.notificationsConfig?.email || {};
    const waCfg = state.notificationsConfig?.whatsapp || {};

    const vaultRows = [
      ...SECRET_ITEMS.map((item) => ({ label: item.label, configured: Boolean(whCfg[item.key]) })),
      { label: "SMTP Password (E-mail)", configured: Boolean(emCfg.hasSmtpPass) },
      { label: "Resend API Key (E-mail)", configured: Boolean(emCfg.hasResendApiKey) },
      { label: "Meta Cloud API Token (WhatsApp)", configured: Boolean(waCfg.hasCloudAccessToken) },
    ];

    root.innerHTML = `
      <div class="view-stack">
        <div class="view-header">
          <div>
            <h1>Segurança & Conta</h1>
            <p class="muted">Assinatura criptográfica Ed25519, status do Cofre AES-256-GCM e credenciais do administrador.</p>
          </div>
        </div>

        <div class="two-col">
          <section class="panel-card">
            <div class="card-header row-between">
              <div>
                <h2>Chave Pública Ed25519</h2>
                <p class="muted">Key ID: <code>${escapeHtml(ov.keyId || "criativo-local-ed25519")}</code></p>
              </div>
              <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-ed25519">Copiar PEM</button>
            </div>
            <pre class="code-snippet" id="sec-pubkey-pre">${escapeHtml(ov.publicKeyPem || "Carregando chave pública...")}</pre>
          </section>

          <section class="panel-card">
            <div class="card-header">
              <h2>Alterar Senha do Administrador</h2>
              <p class="muted">Sessão atual: <strong>${escapeHtml(state.user?.email || "admin")}</strong></p>
            </div>
            <form id="sec-pass-form" class="form-stack">
              <label class="field">
                <span>Senha Atual *</span>
                <input type="password" id="sec-cur-pass" required autocomplete="current-password" />
              </label>
              <label class="field">
                <span>Nova Senha (mín. 8 caracteres) *</span>
                <input type="password" id="sec-new-pass" required minlength="8" autocomplete="new-password" />
              </label>
              <label class="field">
                <span>Confirmar Nova Senha *</span>
                <input type="password" id="sec-conf-pass" required minlength="8" autocomplete="new-password" />
              </label>
              <button type="submit" class="btn btn-primary">Atualizar Senha</button>
            </form>
          </section>
        </div>

        <section class="panel-card">
          <div class="card-header row-between">
            <div>
              <h2>Status do Cofre AES-256-GCM</h2>
              <p class="muted">Resumo de segredos armazenados cifrados no SQLite (nenhum valor é exposto pela API).</p>
            </div>
            <span class="pill pill-active">Criptografia Ativa</span>
          </div>
          <div class="vault-grid">
            ${vaultRows
              .map(
                (v) => `
                <div class="vault-item">
                  <span>${escapeHtml(v.label)}</span>
                  <span class="status-indicator ${v.configured ? "ok" : "pending"}">${v.configured ? "Configurado" : "Pendente"}</span>
                </div>
              `,
              )
              .join("")}
          </div>
        </section>
      </div>
    `;

    root.querySelector("#btn-copy-ed25519")?.addEventListener("click", () => {
      void copyText(ov.publicKeyPem || "", "Chave Pública Ed25519 copiada!");
    });

    root.querySelector("#sec-pass-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const cur = root.querySelector("#sec-cur-pass").value;
      const next = root.querySelector("#sec-new-pass").value;
      const conf = root.querySelector("#sec-conf-pass").value;
      if (next !== conf) return showToast("A confirmação da nova senha não confere.", "error");
      try {
        await api("/api/auth/change-password", {
          method: "POST",
          body: JSON.stringify({ current_password: cur, new_password: next }),
        });
        showToast("Senha alterada com sucesso!", "success");
        e.target.reset();
      } catch (err) {
        showToast(`Erro ao alterar senha: ${err.message}`, "error");
      }
    });
  },
});
