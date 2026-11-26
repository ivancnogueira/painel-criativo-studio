import nodemailer from "nodemailer";

const DEFAULT_DOWNLOAD_LINKS = {
  windows: "https://github.com/ivancnogueira/criativo-studio/releases/download/v1.0.4/CriativoOS-Setup-1.0.4.exe",
  macos: "https://github.com/ivancnogueira/criativo-studio/releases/download/v1.0.4/CriativoOS-1.0.4-universal.dmg",
  linux: "https://github.com/ivancnogueira/criativo-studio/releases/download/v1.0.4/CriativoOS-1.0.4-x86_64.AppImage",
};

const DEFAULT_SUPPORT_GROUP_LABEL = "Entrar no Grupo de Suporte";

function sanitizeSupportUrl(raw) {
  const val = String(raw || "").trim();
  if (!val) return "";
  try {
    const parsed = new URL(val);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.toString();
    }
    return "";
  } catch {
    return "";
  }
}

function isLegacyOrEmptyDownloadLinks(links) {
  if (!links || typeof links !== "object") return true;
  const vals = [links.windows, links.macos, links.linux].map((v) => String(v || "").trim());
  if (vals.some((v) => !v)) return true;
  return vals.some((v) => v.includes("CriativoAIStudio-") && v.includes("1.0.0"));
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function planLimitsText(license) {
  const servers = license.max_servers < 0 ? "Ilimitados" : `${license.max_servers} servidor(es)`;
  const machines = `${license.custom_max_machines ?? license.max_machines} computador(es)`;
  const planMap = {
    individual: "Licença Individual",
    agencia_10: "Licença Agência 10",
    agencia_ilimitada: "Licença Agência Ilimitada",
  };
  return {
    planName: planMap[license.plan_tier] || license.plan_tier,
    servers,
    machines,
  };
}

export function buildLicenseEmailPayload({
  license,
  downloadLinks = DEFAULT_DOWNLOAD_LINKS,
  painelUrl = "https://painel.criativoaistudio.com.br",
  eventType = "license_issued",
  supportGroupUrl = "",
  supportGroupLabel = DEFAULT_SUPPORT_GROUP_LABEL,
}) {
  const meta = planLimitsText(license);
  const firstName = String(license.customer_name || "").trim().split(/\s+/)[0] || "criador(a)";
  const upgrades = Array.isArray(license.upgrades) ? license.upgrades : [];
  const cleanPainelUrl = String(painelUrl || "https://painel.criativoaistudio.com.br").replace(/\/+$/, "");
  const deliveryPageUrl = license.delivery_token ? `${cleanPainelUrl}/entrega/${license.delivery_token}` : null;
  const cleanSupportUrl = sanitizeSupportUrl(supportGroupUrl);
  const cleanSupportLabel = String(supportGroupLabel || "").trim() || DEFAULT_SUPPORT_GROUP_LABEL;

  const eventHeaderMap = {
    license_issued: {
      subject: `🔑 Sua Licença do CriativoOS está pronta! (${license.license_key})`,
      headline: `Olá, ${escapeHtml(firstName)}! Seu acesso foi liberado 🚀`,
      subtitle: "Guarde os dados abaixo para ativar o aplicativo no seu computador.",
    },
    upgrade_added: {
      subject: `✨ Novo módulo liberado na sua Licença CriativoOS! (${license.license_key})`,
      headline: `Olá, ${escapeHtml(firstName)}! Upgrade ativado com sucesso ✨`,
      subtitle: "Seus novos recursos já foram vinculados à sua chave de licença atual.",
    },
    subscription_renewed: {
      subject: `🔄 Assinatura CriativoOS renovada! (${license.license_key})`,
      headline: `Olá, ${escapeHtml(firstName)}! Sua licença foi renovada 🔄`,
      subtitle: "A vigência do seu acesso foi estendida automaticamente.",
    },
    license_revoked: {
      subject: `Aviso sobre sua licença CriativoOS (${license.license_key})`,
      headline: `Olá, ${escapeHtml(firstName)} — atualização de acesso`,
      subtitle: "Sua licença foi suspensa ou cancelada após solicitação de reembolso/cancelamento.",
    },
  };

  const copyMeta = eventHeaderMap[eventType] || eventHeaderMap.license_issued;
  const subject = copyMeta.subject;
  const showDeliverySection = eventType !== "license_revoked";

  const html = `<!doctype html>
<html lang="pt-BR">
<body style="margin:0;padding:0;background:#0b0d12;color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0b0d12;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#141720;border:1px solid #262b38;border-radius:18px;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px;border-bottom:1px solid #232836;background:linear-gradient(135deg,#181c28 0%,#12141c 100%);">
              <div style="font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#B9FC01;">CriativoOS</div>
              <h1 style="margin:8px 0 4px 0;font-size:22px;color:#ffffff;">${copyMeta.headline}</h1>
              <p style="margin:0;font-size:14px;color:#9ca3af;">${copyMeta.subtitle}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px;">
              <div style="background:#0e1017;border:1px solid #2a3040;border-radius:14px;padding:20px;margin-bottom:22px;">
                <div style="font-size:12px;color:#9ca3af;margin-bottom:4px;">E-mail de ativação:</div>
                <div style="font-size:15px;font-weight:600;color:#ffffff;margin-bottom:14px;">${escapeHtml(license.customer_email)}</div>

                <div style="font-size:12px;color:#9ca3af;margin-bottom:6px;">Sua Chave de Licença:</div>
                <div style="background:#191d29;border:1px dashed #B9FC01;border-radius:10px;padding:12px 16px;font-family:'JetBrains Mono',Consolas,monospace;font-size:18px;font-weight:700;color:#B9FC01;letter-spacing:1.2px;text-align:center;">
                  ${escapeHtml(license.license_key)}
                </div>

                <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;font-size:13px;color:#d1d5db;">
                  <tr>
                    <td style="padding:4px 0;color:#9ca3af;">Plano:</td>
                    <td align="right" style="padding:4px 0;font-weight:600;color:#10b981;">${escapeHtml(meta.planName)}</td>
                  </tr>
                  <tr>
                    <td style="padding:4px 0;color:#9ca3af;">Servidores / Marcas:</td>
                    <td align="right" style="padding:4px 0;font-weight:600;">${escapeHtml(meta.servers)}</td>
                  </tr>
                  <tr>
                    <td style="padding:4px 0;color:#9ca3af;">Computadores simultâneos:</td>
                    <td align="right" style="padding:4px 0;font-weight:600;">${escapeHtml(meta.machines)}</td>
                  </tr>
                  ${
                    upgrades.length > 0
                      ? `<tr><td style="padding:4px 0;color:#9ca3af;">Upgrades incluídos:</td><td align="right" style="padding:4px 0;font-weight:600;color:#38bdf8;">${escapeHtml(upgrades.join(", ").toUpperCase())}</td></tr>`
                      : ""
                  }
                </table>
              </div>

              ${
                showDeliverySection && deliveryPageUrl
                  ? `<div style="margin-bottom:22px;text-align:center;">
                      <a href="${escapeHtml(deliveryPageUrl)}" style="display:inline-block;background:#B9FC01;color:#0d0d0d;text-decoration:none;font-weight:700;font-size:14px;padding:12px 24px;border-radius:10px;">
                        Abrir Minha Central de Entrega →
                      </a>
                    </div>`
                  : ""
              }

              ${
                showDeliverySection
                  ? `<h2 style="margin:0 0 12px 0;font-size:15px;color:#ffffff;">1. Baixe o Aplicativo Oficial</h2>
              <table width="100%" cellpadding="0" cellspacing="6" style="margin-bottom:22px;">
                <tr>
                  <td align="center" style="background:#1e2330;border:1px solid #2e3547;border-radius:10px;padding:10px;">
                    <a href="${escapeHtml(downloadLinks.windows)}" style="color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;display:block;">🪟 Windows (.exe)</a>
                  </td>
                  <td align="center" style="background:#1e2330;border:1px solid #2e3547;border-radius:10px;padding:10px;">
                    <a href="${escapeHtml(downloadLinks.macos)}" style="color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;display:block;">🍏 macOS (.dmg)</a>
                  </td>
                  <td align="center" style="background:#1e2330;border:1px solid #2e3547;border-radius:10px;padding:10px;">
                    <a href="${escapeHtml(downloadLinks.linux)}" style="color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;display:block;">🐧 Linux (.AppImage)</a>
                  </td>
                </tr>
              </table>

              <h2 style="margin:0 0 8px 0;font-size:15px;color:#ffffff;">2. Como ativar em 30 segundos</h2>
              <ol style="margin:0;padding-left:18px;font-size:13.5px;color:#d1d5db;line-height:1.65;">
                <li>Instale e abra o <strong>CriativoOS</strong> no seu computador.</li>
                <li>Digite exatamente o e-mail <strong>${escapeHtml(license.customer_email)}</strong>.</li>
                <li>Cole a chave <strong>${escapeHtml(license.license_key)}</strong> e clique em <strong>Ativar licença agora</strong>.</li>
              </ol>
              ${
                cleanSupportUrl
                  ? `<div style="margin-top:22px;background:#101c18;border:1px solid #1f4d3a;border-radius:12px;padding:16px 18px;text-align:center;">
                      <div style="font-size:13px;font-weight:700;color:#ffffff;margin-bottom:4px;">Precisa de ajuda ou quer acompanhar as novidades?</div>
                      <div style="font-size:12.5px;color:#9ca3af;margin-bottom:12px;">Entre no nosso grupo oficial de suporte para tirar dúvidas e conversar com outros usuários.</div>
                      <a href="${escapeHtml(cleanSupportUrl)}" style="display:inline-block;background:#25D366;color:#081c0f;text-decoration:none;font-weight:700;font-size:13.5px;padding:10px 20px;border-radius:9px;">
                        ${escapeHtml(cleanSupportLabel)} →
                      </a>
                    </div>`
                  : ""
              }`
                  : `<p style="font-size:13.5px;color:#9ca3af;">Caso tenha sido um engano ou deseje reativar seu acesso, responda este e-mail.</p>`
              }
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px;background:#0e1017;border-top:1px solid #232836;font-size:12px;color:#6b7280;text-align:center;">
              Enviado automaticamente pelo Hub Central · ${escapeHtml(cleanPainelUrl)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    `Olá, ${firstName}! ${copyMeta.subtitle}`,
    "",
    `E-mail de ativação: ${license.customer_email}`,
    `Chave de licença: ${license.license_key}`,
    `Plano: ${meta.planName} (${meta.servers} · ${meta.machines})`,
    ...(deliveryPageUrl && showDeliverySection ? ["", `Portal de entrega: ${deliveryPageUrl}`] : []),
    ...(showDeliverySection
      ? [
          "",
          "Downloads oficiais:",
          `- Windows: ${downloadLinks.windows}`,
          `- macOS: ${downloadLinks.macos}`,
          `- Linux: ${downloadLinks.linux}`,
          ...(cleanSupportUrl ? ["", `${cleanSupportLabel}: ${cleanSupportUrl}`] : []),
        ]
      : []),
  ].join("\n");

  return { subject, html, text };
}

export function createEmailDispatcher({
  vault,
  logNotification,
  fetchImpl = globalThis.fetch,
  transportFactory,
  resolveDynamicDownloadLinks,
}) {
  function resolveDownloadLinks() {
    const useManual = Boolean(vault.getSetting("use_manual_download_links", false));
    const saved = vault.getSetting("download_links", null);
    if (useManual && !isLegacyOrEmptyDownloadLinks(saved)) {
      return saved;
    }
    const dynamicLinks = typeof resolveDynamicDownloadLinks === "function" ? resolveDynamicDownloadLinks() : null;
    if (dynamicLinks && (dynamicLinks.windows || dynamicLinks.macos || dynamicLinks.linux)) {
      return {
        windows: dynamicLinks.windows || DEFAULT_DOWNLOAD_LINKS.windows,
        macos: dynamicLinks.macos || DEFAULT_DOWNLOAD_LINKS.macos,
        linux: dynamicLinks.linux || DEFAULT_DOWNLOAD_LINKS.linux,
      };
    }
    if (!isLegacyOrEmptyDownloadLinks(saved)) {
      return saved;
    }
    return DEFAULT_DOWNLOAD_LINKS;
  }

  function getConfig() {
    const provider = vault.getSetting("email_provider", process.env.SMTP_HOST ? "smtp" : "none");
    return {
      provider, // "none" | "smtp" | "resend"
      smtpHost: vault.getSetting("smtp_host", process.env.SMTP_HOST || ""),
      smtpPort: Number(vault.getSetting("smtp_port", process.env.SMTP_PORT || 465)) || 465,
      smtpSecure: Boolean(vault.getSetting("smtp_secure", process.env.SMTP_SECURE !== "false")),
      smtpUser: vault.getSetting("smtp_user", process.env.SMTP_USER || ""),
      smtpPass: vault.getSetting("smtp_pass", process.env.SMTP_PASS || ""),
      fromName: vault.getSetting("smtp_from_name", process.env.SMTP_FROM_NAME || "CriativoOS"),
      fromEmail: vault.getSetting("smtp_from_email", process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || ""),
      resendApiKey: vault.getSetting("resend_api_key", process.env.RESEND_API_KEY || ""),
      useManualDownloadLinks: Boolean(vault.getSetting("use_manual_download_links", false)),
      downloadLinks: resolveDownloadLinks(),
      supportGroupUrl: sanitizeSupportUrl(vault.getSetting("support_group_url", process.env.SUPPORT_GROUP_URL || "")),
      supportGroupLabel:
        String(
          vault.getSetting("support_group_label", process.env.SUPPORT_GROUP_LABEL || DEFAULT_SUPPORT_GROUP_LABEL),
        ).trim() || DEFAULT_SUPPORT_GROUP_LABEL,
      painelUrl: process.env.PAINEL_PUBLIC_URL || "https://painel.criativoaistudio.com.br",
    };
  }

  function getPublicConfig() {
    const cfg = getConfig();
    return {
      provider: cfg.provider,
      smtpHost: cfg.smtpHost,
      smtpPort: cfg.smtpPort,
      smtpSecure: cfg.smtpSecure,
      smtpUser: cfg.smtpUser,
      hasSmtpPass: Boolean(cfg.smtpPass),
      fromName: cfg.fromName,
      fromEmail: cfg.fromEmail,
      hasResendApiKey: Boolean(cfg.resendApiKey),
      useManualDownloadLinks: cfg.useManualDownloadLinks,
      downloadLinks: cfg.downloadLinks,
      supportGroupUrl: cfg.supportGroupUrl,
      supportGroupLabel: cfg.supportGroupLabel,
    };
  }

  function saveConfig(input = {}) {
    if (input.provider !== undefined) vault.setSetting("email_provider", String(input.provider));
    if (input.smtpHost !== undefined) vault.setSetting("smtp_host", String(input.smtpHost).trim());
    if (input.smtpPort !== undefined) vault.setSetting("smtp_port", Number(input.smtpPort) || 465);
    if (input.smtpSecure !== undefined) vault.setSetting("smtp_secure", Boolean(input.smtpSecure));
    if (input.smtpUser !== undefined) vault.setSetting("smtp_user", String(input.smtpUser).trim());
    if (input.smtpPass !== undefined && String(input.smtpPass).trim() !== "") {
      vault.setSetting("smtp_pass", String(input.smtpPass), { isSecret: true });
    }
    if (input.fromName !== undefined) vault.setSetting("smtp_from_name", String(input.fromName).trim());
    if (input.fromEmail !== undefined) vault.setSetting("smtp_from_email", String(input.fromEmail).trim());
    if (input.resendApiKey !== undefined && String(input.resendApiKey).trim() !== "") {
      vault.setSetting("resend_api_key", String(input.resendApiKey).trim(), { isSecret: true });
    }
    if (input.useManualDownloadLinks !== undefined) {
      vault.setSetting("use_manual_download_links", Boolean(input.useManualDownloadLinks));
    }
    if (input.downloadLinks && typeof input.downloadLinks === "object") {
      vault.setSetting("download_links", input.downloadLinks);
    }
    if (input.supportGroupUrl !== undefined) {
      vault.setSetting("support_group_url", sanitizeSupportUrl(input.supportGroupUrl));
    }
    if (input.supportGroupLabel !== undefined) {
      vault.setSetting("support_group_label", String(input.supportGroupLabel || "").trim() || DEFAULT_SUPPORT_GROUP_LABEL);
    }
    return getPublicConfig();
  }

  async function sendLicenseEmail(license, { eventType = "license_issued" } = {}) {
    const cfg = getConfig();
    const toEmail = String(license.customer_email || "").trim();
    if (!toEmail) {
      return { ok: false, status: "skipped", error: "E-mail do destinatário vazio." };
    }
    if (cfg.provider === "none") {
      logNotification?.({
        licenseId: license.id,
        licenseKey: license.license_key,
        channel: "email",
        recipient: toEmail,
        status: "skipped",
        detail: "Envio de E-mail não configurado (provider=none).",
      });
      return { ok: false, status: "skipped", error: "Provedor de E-mail não configurado no painel." };
    }

    const msg = buildLicenseEmailPayload({
      license,
      downloadLinks: cfg.downloadLinks,
      painelUrl: cfg.painelUrl,
      eventType,
      supportGroupUrl: cfg.supportGroupUrl,
      supportGroupLabel: cfg.supportGroupLabel,
    });
    const fromHeader = cfg.fromName ? `"${cfg.fromName}" <${cfg.fromEmail}>` : cfg.fromEmail;

    try {
      if (cfg.provider === "resend") {
        if (!cfg.resendApiKey || !cfg.fromEmail) {
          throw new Error("Configure a API Key da Resend e o e-mail remetente.");
        }
        const resp = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.resendApiKey}`,
          },
          body: JSON.stringify({
            from: fromHeader,
            to: [toEmail],
            subject: msg.subject,
            html: msg.html,
            text: msg.text,
          }),
        });
        if (!resp.ok) {
          const errTxt = await resp.text();
          throw new Error(`Resend HTTP ${resp.status}: ${errTxt.slice(0, 220)}`);
        }
      } else {
        if (!cfg.smtpHost || !cfg.smtpUser || !cfg.smtpPass) {
          throw new Error("Configure Host SMTP, Usuário e Senha nas configurações do painel.");
        }
        const createTransport = transportFactory || nodemailer.createTransport;
        const transporter = createTransport({
          host: cfg.smtpHost,
          port: cfg.smtpPort,
          secure: cfg.smtpSecure,
          auth: {
            user: cfg.smtpUser,
            pass: cfg.smtpPass,
          },
        });
        await transporter.sendMail({
          from: fromHeader || cfg.smtpUser,
          to: toEmail,
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
        });
      }

      logNotification?.({
        licenseId: license.id,
        licenseKey: license.license_key,
        channel: "email",
        recipient: toEmail,
        status: "sent",
        detail: `E-mail enviado via ${cfg.provider.toUpperCase()}.`,
      });
      return { ok: true, status: "sent" };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logNotification?.({
        licenseId: license.id,
        licenseKey: license.license_key,
        channel: "email",
        recipient: toEmail,
        status: "error",
        detail: errorMsg,
      });
      return { ok: false, status: "error", error: errorMsg };
    }
  }

  async function sendTestEmail(toEmail) {
    return sendLicenseEmail({
      id: "lic_test_email",
      license_key: "CRIA-IND-TEST-0000-1234",
      customer_email: toEmail,
      customer_name: "Teste do Painel",
      plan_tier: "individual",
      max_servers: 2,
      max_machines: 2,
      upgrades: ["bonus"],
    });
  }

  return {
    getPublicConfig,
    saveConfig,
    sendLicenseEmail,
    sendTestEmail,
  };
}
