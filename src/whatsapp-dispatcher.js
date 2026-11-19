const DEFAULT_WHATSAPP_TEMPLATE = [
  "Olá, *{{1}}*! Sua licença do *Criativo AI Studio Online* foi liberada.",
  "",
  "E-mail de ativação: {{2}}",
  "Chave de licença: {{3}}",
  "Plano: {{4}}",
].join("\n");

export function normalizePhoneNumber(rawPhone) {
  let digits = String(rawPhone || "").replace(/\D+/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith("55")) {
    digits = `55${digits}`;
  }
  return digits;
}

function getPlanDisplayName(planTier) {
  const map = {
    individual: "Licença Individual",
    agencia_10: "Licença Agência 10",
    agencia_ilimitada: "Licença Agência Ilimitada",
  };
  return map[planTier] || planTier;
}

export function createWhatsAppDispatcher({ vault, logNotification, fetchImpl = globalThis.fetch }) {
  function getConfig() {
    // Em standby por padrão ("none") até o usuário habilitar "cloud_api" (API Oficial da Meta)
    return {
      provider: vault.getSetting("whatsapp_provider", process.env.WHATSAPP_PROVIDER || "none"), // "none" | "cloud_api"
      cloudPhoneNumberId: vault.getSetting("wa_cloud_phone_id", process.env.WA_CLOUD_PHONE_ID || ""),
      cloudAccessToken: vault.getSetting("wa_cloud_token", process.env.WA_CLOUD_TOKEN || ""),
      cloudApiVersion: vault.getSetting("wa_cloud_version", process.env.WA_CLOUD_API_VERSION || "v27.0"),
      sendMode: vault.getSetting("wa_cloud_send_mode", "template"), // "template" | "text"
      templateName: vault.getSetting("wa_cloud_template_name", process.env.WA_CLOUD_TEMPLATE_NAME || "criativo_entrega_licenca"),
      templateLang: vault.getSetting("wa_cloud_template_lang", process.env.WA_CLOUD_TEMPLATE_LANG || "pt_BR"),
      messageTemplate: vault.getSetting("wa_template", DEFAULT_WHATSAPP_TEMPLATE) || DEFAULT_WHATSAPP_TEMPLATE,
    };
  }

  function getPublicConfig() {
    const cfg = getConfig();
    return {
      provider: cfg.provider,
      standby: cfg.provider !== "cloud_api",
      cloudPhoneNumberId: cfg.cloudPhoneNumberId,
      hasCloudAccessToken: Boolean(cfg.cloudAccessToken),
      cloudApiVersion: cfg.cloudApiVersion,
      sendMode: cfg.sendMode,
      templateName: cfg.templateName,
      templateLang: cfg.templateLang,
      messageTemplate: cfg.messageTemplate,
    };
  }

  function saveConfig(input = {}) {
    if (input.provider !== undefined) {
      vault.setSetting("whatsapp_provider", input.provider === "cloud_api" ? "cloud_api" : "none");
    }
    if (input.cloudPhoneNumberId !== undefined) {
      vault.setSetting("wa_cloud_phone_id", String(input.cloudPhoneNumberId).trim());
    }
    if (input.cloudAccessToken !== undefined && String(input.cloudAccessToken).trim() !== "") {
      vault.setSetting("wa_cloud_token", String(input.cloudAccessToken).trim(), { isSecret: true });
    }
    if (input.cloudApiVersion !== undefined) {
      vault.setSetting("wa_cloud_version", String(input.cloudApiVersion).trim() || "v27.0");
    }
    if (input.sendMode !== undefined) {
      vault.setSetting("wa_cloud_send_mode", input.sendMode === "text" ? "text" : "template");
    }
    if (input.templateName !== undefined) {
      vault.setSetting("wa_cloud_template_name", String(input.templateName).trim());
    }
    if (input.templateLang !== undefined) {
      vault.setSetting("wa_cloud_template_lang", String(input.templateLang).trim() || "pt_BR");
    }
    if (input.messageTemplate !== undefined) {
      vault.setSetting("wa_template", String(input.messageTemplate));
    }
    return getPublicConfig();
  }

  async function sendLicenseWhatsApp(license) {
    const cfg = getConfig();
    const phone = normalizePhoneNumber(license.customer_phone);

    if (!phone) {
      return { ok: false, status: "skipped", error: "Telefone/WhatsApp do comprador não informado." };
    }

    if (cfg.provider !== "cloud_api") {
      logNotification?.({
        licenseId: license.id || null,
        licenseKey: license.license_key || null,
        channel: "whatsapp",
        recipient: phone,
        status: "skipped",
        detail: "WhatsApp em standby (aguardando ativação da Meta Cloud API Oficial).",
      });
      return {
        ok: false,
        status: "skipped",
        error: "WhatsApp em standby (ative a Meta Cloud API Oficial quando desejar).",
      };
    }

    if (!cfg.cloudPhoneNumberId || !cfg.cloudAccessToken) {
      const msg = "Configure o Phone Number ID e o Access Token da Meta Cloud API.";
      logNotification?.({
        licenseId: license.id || null,
        licenseKey: license.license_key || null,
        channel: "whatsapp",
        recipient: phone,
        status: "error",
        detail: msg,
      });
      return { ok: false, status: "error", error: msg };
    }

    const firstName = String(license.customer_name || "").trim().split(/\s+/)[0] || "criador(a)";
    const planLabel = getPlanDisplayName(license.plan_tier);

    let payload;
    if (cfg.sendMode === "template") {
      payload = {
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
          name: cfg.templateName || "criativo_entrega_licenca",
          language: { code: cfg.templateLang || "pt_BR" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: firstName },
                { type: "text", text: String(license.customer_email || "") },
                { type: "text", text: String(license.license_key || "") },
                { type: "text", text: planLabel },
              ],
            },
          ],
        },
      };
    } else {
      const bodyText = String(cfg.messageTemplate || DEFAULT_WHATSAPP_TEMPLATE)
        .replaceAll("{{1}}", firstName)
        .replaceAll("{{2}}", String(license.customer_email || ""))
        .replaceAll("{{3}}", String(license.license_key || ""))
        .replaceAll("{{4}}", planLabel);
      payload = {
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body: bodyText },
      };
    }

    try {
      const resp = await fetchImpl(
        `https://graph.facebook.com/${encodeURIComponent(cfg.cloudApiVersion)}/${encodeURIComponent(cfg.cloudPhoneNumberId)}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.cloudAccessToken}`,
          },
          body: JSON.stringify(payload),
        },
      );
      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`Meta Cloud API HTTP ${resp.status}: ${errBody.slice(0, 220)}`);
      }

      logNotification?.({
        licenseId: license.id || null,
        licenseKey: license.license_key || null,
        channel: "whatsapp",
        recipient: phone,
        status: "sent",
        detail: `Enviado via Meta Cloud API Oficial (${cfg.sendMode}).`,
      });
      return { ok: true, status: "sent", phone };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logNotification?.({
        licenseId: license.id || null,
        licenseKey: license.license_key || null,
        channel: "whatsapp",
        recipient: phone,
        status: "error",
        detail: errorMsg,
      });
      return { ok: false, status: "error", error: errorMsg };
    }
  }

  async function sendTestWhatsApp(phone) {
    return sendLicenseWhatsApp({
      id: "lic_test_wa",
      license_key: "CRIA-IND-TEST-0000-1234",
      customer_email: "teste@criativoaistudio.com.br",
      customer_name: "Teste Painel",
      customer_phone: phone,
      plan_tier: "individual",
    });
  }

  return {
    getPublicConfig,
    saveConfig,
    sendLicenseWhatsApp,
    sendTestWhatsApp,
  };
}
