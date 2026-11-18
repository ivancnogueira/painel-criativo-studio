import express from "express";
import crypto from "node:crypto";
import { timingSafeEqualString } from "./license-hub.js";

function resolveProductMapping(productId, offerName, productMap) {
  const cleanId = String(productId || "").trim();
  if (cleanId && productMap[cleanId]) {
    return productMap[cleanId];
  }
  const text = String(offerName || "").toLowerCase();
  const addUpgrades = [];
  if (text.includes("video") || text.includes("vídeo") || text.includes("remotion")) addUpgrades.push("video");
  if (text.includes("bonus") || text.includes("bônus")) addUpgrades.push("bonus");

  let planTier = "individual";
  if (text.includes("ilimitad")) {
    planTier = "agencia_ilimitada";
  } else if (text.includes("agencia") || text.includes("agência")) {
    planTier = "agencia_10";
  }
  return { planTier, addUpgrades };
}

function verifyStripeSignature(rawBody, headerValue, secret) {
  if (!secret || !headerValue || !rawBody) return false;
  const parts = Object.fromEntries(
    String(headerValue)
      .split(",")
      .map((kv) => kv.trim().split("=")),
  );
  if (!parts.t || !parts.v1) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${parts.t}.${rawBody}`)
    .digest("hex");
  return timingSafeEqualString(parts.v1, expected);
}

export function createSalesWebhooksRouter(hub, options = {}) {
  const router = express.Router();

  function getWebhookSettings() {
    let envMap = {};
    if (process.env.PRODUCT_MAP_JSON) {
      try {
        envMap = JSON.parse(process.env.PRODUCT_MAP_JSON);
      } catch {
        envMap = {};
      }
    }
    const vaultMap = hub.vault.getSetting("webhook_product_map", null);
    return {
      hotmart: options.hotmartHottok ?? (hub.vault.getSetting("wh_hotmart_hottok", "") || process.env.HOTMART_HOTTOK || ""),
      kiwify: options.kiwifyToken ?? (hub.vault.getSetting("wh_kiwify_token", "") || process.env.KIWIFY_WEBHOOK_TOKEN || ""),
      ticto: options.tictoToken ?? (hub.vault.getSetting("wh_ticto_token", "") || process.env.TICTO_WEBHOOK_TOKEN || ""),
      stripe: options.stripeSecret ?? (hub.vault.getSetting("wh_stripe_secret", "") || process.env.STRIPE_WEBHOOK_SECRET || ""),
      productMap: options.productMap || (vaultMap && Object.keys(vaultMap).length > 0 ? vaultMap : envMap),
    };
  }

  // Rotas de configuração dos webhooks dentro do Painel Admin
  router.get("/admin/webhooks/config", hub.requireAdmin, (_req, res) => {
    const cfg = getWebhookSettings();
    const baseUrl = (process.env.PAINEL_PUBLIC_URL || "https://painel.criativoaistudio.com.br").replace(/\/+$/, "");
    return res.json({
      urls: {
        hotmart: `${baseUrl}/api/webhooks/sales?provider=hotmart`,
        kiwify: `${baseUrl}/api/webhooks/sales?provider=kiwify`,
        ticto: `${baseUrl}/api/webhooks/sales?provider=ticto`,
        stripe: `${baseUrl}/api/webhooks/sales?provider=stripe`,
      },
      secretsConfigured: {
        hotmart: Boolean(cfg.hotmart),
        kiwify: Boolean(cfg.kiwify),
        ticto: Boolean(cfg.ticto),
        stripe: Boolean(cfg.stripe),
      },
      productMap: cfg.productMap,
    });
  });

  router.put("/admin/webhooks/config", hub.requireAdmin, (req, res) => {
    const body = req.body || {};
    if (body.hotmartHottok !== undefined && String(body.hotmartHottok).trim() !== "") {
      hub.vault.setSetting("wh_hotmart_hottok", String(body.hotmartHottok).trim(), { isSecret: true });
    }
    if (body.kiwifyToken !== undefined && String(body.kiwifyToken).trim() !== "") {
      hub.vault.setSetting("wh_kiwify_token", String(body.kiwifyToken).trim(), { isSecret: true });
    }
    if (body.tictoToken !== undefined && String(body.tictoToken).trim() !== "") {
      hub.vault.setSetting("wh_ticto_token", String(body.tictoToken).trim(), { isSecret: true });
    }
    if (body.stripeSecret !== undefined && String(body.stripeSecret).trim() !== "") {
      hub.vault.setSetting("wh_stripe_secret", String(body.stripeSecret).trim(), { isSecret: true });
    }
    if (body.productMap && typeof body.productMap === "object") {
      hub.vault.setSetting("webhook_product_map", body.productMap);
    }
    return res.json({ ok: true });
  });

  async function processSaleEvent({ provider, eventName, transactionId, buyerEmail, buyerName, buyerPhone, productId, offerName, rawSummary = {} }) {
    const cfg = getWebhookSettings();
    const txId = transactionId || crypto.createHash("sha256").update(JSON.stringify(rawSummary)).digest("hex").slice(0, 24);
    const deliveryKey = `${provider}:${txId}:${eventName}`;
    const alreadyProcessed = hub.db
      .prepare(`SELECT delivery_key, license_key, action FROM sales_webhook_deliveries WHERE delivery_key = ?;`)
      .get(deliveryKey);

    if (alreadyProcessed) {
      return { ok: true, idempotent: true, action: alreadyProcessed.action, license_key: alreadyProcessed.license_key };
    }

    const approvedEvents = new Set([
      "purchase_approved",
      "purchase_complete",
      "compra_aprovada",
      "order_approved",
      "paid",
      "authorized",
      "checkout.session.completed",
      "invoice.payment_succeeded",
    ]);

    const revokedEvents = new Set([
      "purchase_refunded",
      "purchase_chargeback",
      "subscription_cancellation",
      "purchase_canceled",
      "compra_reembolsada",
      "refunded",
      "chargeback",
      "charge.refunded",
      "customer.subscription.deleted",
    ]);

    const normEvent = String(eventName || "").trim().toLowerCase();
    let action = "ignored";
    let licenseKey = null;
    let notifications = null;

    if (approvedEvents.has(normEvent) && buyerEmail) {
      const mapping = resolveProductMapping(productId, offerName, cfg.productMap);
      const lic = hub.issueOrUpdateLicenseFromSale({
        email: buyerEmail,
        customerName: buyerName,
        customerPhone: buyerPhone,
        planTier: mapping.planTier,
        addUpgrades: mapping.addUpgrades,
        provider,
        transactionId: txId,
      });
      action = "issued_or_updated";
      licenseKey = lic.license_key;

      // Dispara automaticamente E-mail e WhatsApp de entrega da licença
      notifications = await hub.dispatchLicenseNotifications(lic, {
        sendEmail: true,
        sendWhatsApp: Boolean(lic.customer_phone),
      });
    } else if (revokedEvents.has(normEvent) && buyerEmail) {
      const lic = hub.revokeLicenseByEmailOrKey({
        email: buyerEmail,
        reason: eventName,
        actor: provider,
      });
      action = lic ? "revoked" : "not_found";
      licenseKey = lic?.license_key || null;
    }

    hub.db
      .prepare(
        `INSERT INTO sales_webhook_deliveries (
          delivery_key, provider, transaction_id, event_name, buyer_email, buyer_phone, action, license_key, summary_json, processed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      )
      .run(
        deliveryKey,
        provider,
        txId,
        eventName,
        buyerEmail || null,
        buyerPhone || null,
        action,
        licenseKey,
        JSON.stringify({ offerName, productId, ...rawSummary }),
        new Date().toISOString(),
      );

    return { ok: true, action, license_key: licenseKey, notifications };
  }

  // Simulador autenticado no Painel para testar compra/reembolso sem precisar fazer venda real
  router.post("/admin/webhooks/simulate", hub.requireAdmin, async (req, res) => {
    const {
      provider = "hotmart",
      event_type = "PURCHASE_APPROVED",
      email,
      name = "Cliente Teste Webhook",
      phone = "",
      product_id = "PROD_INDIVIDUAL",
      offer_name = "Licença Individual",
    } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: "missing_email", message: "Informe um e-mail para simular o webhook." });
    }

    const result = await processSaleEvent({
      provider,
      eventName: event_type,
      transactionId: `sim_${Date.now()}`,
      buyerEmail: email,
      buyerName: name,
      buyerPhone: phone,
      productId: product_id,
      offerName: offer_name,
      rawSummary: { simulated: true },
    });
    return res.json(result);
  });

  // Endpoint público oficial dos Webhooks de Checkout (Hotmart, Kiwify, Ticto, Stripe)
  router.post("/webhooks/sales", async (req, res) => {
    const secrets = getWebhookSettings();
    const provider = String(
      req.query.provider ||
        (req.headers["x-hotmart-hottok"]
          ? "hotmart"
          : req.headers["stripe-signature"]
            ? "stripe"
            : req.headers["x-kiwify-signature"] || req.headers["x-kiwify-token"]
              ? "kiwify"
              : req.body?.provider || ""),
    )
      .trim()
      .toLowerCase();

    if (!["hotmart", "kiwify", "ticto", "stripe"].includes(provider)) {
      return res.status(400).json({ error: "unsupported_provider" });
    }

    if (provider === "hotmart") {
      const hottok = String(req.headers["x-hotmart-hottok"] || req.body?.hottok || "");
      if (!secrets.hotmart || !timingSafeEqualString(hottok, secrets.hotmart)) {
        return res.status(401).json({ error: "invalid_hotmart_hottok" });
      }
    } else if (provider === "kiwify") {
      const sig = String(req.headers["x-kiwify-signature"] || req.query.signature || req.body?.signature || "");
      const tok = String(req.headers["x-kiwify-token"] || req.body?.token || "");
      const hmacOk =
        secrets.kiwify &&
        req.rawBody &&
        timingSafeEqualString(sig, crypto.createHmac("sha1", secrets.kiwify).update(req.rawBody).digest("hex"));
      const tokenOk = secrets.kiwify && timingSafeEqualString(tok, secrets.kiwify);
      if (!hmacOk && !tokenOk) {
        return res.status(401).json({ error: "invalid_kiwify_signature" });
      }
    } else if (provider === "ticto") {
      const tok = String(req.headers["x-ticto-token"] || req.body?.token || "");
      if (!secrets.ticto || !timingSafeEqualString(tok, secrets.ticto)) {
        return res.status(401).json({ error: "invalid_ticto_token" });
      }
    } else if (provider === "stripe") {
      if (!verifyStripeSignature(req.rawBody, req.headers["stripe-signature"], secrets.stripe)) {
        return res.status(401).json({ error: "invalid_stripe_signature" });
      }
    }

    const body = req.body || {};
    let eventName = "";
    let transactionId = "";
    let buyerEmail = "";
    let buyerName = "";
    let buyerPhone = "";
    let productId = "";
    let offerName = "";

    if (provider === "hotmart") {
      eventName = String(body.event || "").toUpperCase();
      transactionId = String(body.data?.purchase?.transaction || body.id || "");
      buyerEmail = String(body.data?.buyer?.email || "");
      buyerName = String(body.data?.buyer?.name || "");
      buyerPhone = String(body.data?.buyer?.checkout_phone || body.data?.buyer?.phone || "");
      productId = String(body.data?.product?.id || "");
      offerName = String(body.data?.product?.name || body.data?.purchase?.offer?.code || "");
    } else if (provider === "kiwify") {
      eventName = String(body.webhook_event_type || body.order_status || "").toLowerCase();
      transactionId = String(body.order_id || "");
      buyerEmail = String(body.Customer?.email || body.customer?.email || "");
      buyerName = String(body.Customer?.full_name || body.customer?.name || "");
      buyerPhone = String(body.Customer?.mobile || body.Customer?.phone || body.customer?.mobile || body.customer?.phone || "");
      productId = String(body.Product?.product_id || body.product_id || "");
      offerName = String(body.Product?.product_name || body.product_name || "");
    } else if (provider === "ticto") {
      eventName = String(body.status || body.event || "").toLowerCase();
      transactionId = String(body.order?.hash || body.transaction_id || "");
      buyerEmail = String(body.customer?.email || "");
      buyerName = String(body.customer?.name || "");
      const phoneObj = body.customer?.phone;
      buyerPhone =
        typeof phoneObj === "string"
          ? phoneObj
          : String(phoneObj?.full_number || `${phoneObj?.ddi || ""}${phoneObj?.ddd || ""}${phoneObj?.number || ""}`);
      productId = String(body.item?.product_id || body.product_id || "");
      offerName = String(body.item?.offer_name || body.offer_name || "");
    } else if (provider === "stripe") {
      eventName = String(body.type || "").toLowerCase();
      const obj = body.data?.object || {};
      transactionId = String(body.id || obj.id || "");
      buyerEmail = String(obj.customer_details?.email || obj.customer_email || obj.receipt_email || "");
      buyerName = String(obj.customer_details?.name || "");
      buyerPhone = String(obj.customer_details?.phone || "");
      productId = String(obj.metadata?.product_id || "");
      offerName = String(obj.metadata?.plan_name || "");
    }

    const result = await processSaleEvent({
      provider,
      eventName,
      transactionId,
      buyerEmail,
      buyerName,
      buyerPhone,
      productId,
      offerName,
    });
    return res.json(result);
  });

  return router;
}
