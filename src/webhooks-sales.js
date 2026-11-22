import express from "express";
import crypto from "node:crypto";
import { timingSafeEqualString } from "./license-hub.js";
import {
  SUPPORTED_PROVIDERS,
  parseMoneyToCents,
  normalizePaymentMethod,
  classifyWebhookEvent,
  resolveProductMapping,
  detectProvider,
  verifyProviderSignature,
  parseWebhookPayload,
} from "./webhook-parsers.js";

const MAX_RAW_PAYLOAD_BYTES = 256 * 1024;

const SENSITIVE_PAYLOAD_KEYS = new Set(["secret", "hottok", "token", "signature", "access_token"]);

function redactSensitivePayload(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitivePayload(item, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_PAYLOAD_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : redactSensitivePayload(v, depth + 1);
  }
  return out;
}

function serializeRawPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  try {
    const json = JSON.stringify(redactSensitivePayload(payload));
    return Buffer.byteLength(json, "utf8") <= MAX_RAW_PAYLOAD_BYTES
      ? json
      : JSON.stringify({ _truncated: true, preview: json.slice(0, MAX_RAW_PAYLOAD_BYTES - 128) });
  } catch {
    return null;
  }
}

function mapStatusLabel(row) {
  if (row.action === "issued_or_updated") return row.is_simulated ? "simulado" : "aprovado";
  if (row.action === "revoked") return "reembolso";
  if (row.action === "auth_error" || row.action === "error") return "erro";
  return "ignorado";
}

function parseJsonSafe(raw, fallback = null) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
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
      cakto: options.caktoSecret ?? (hub.vault.getSetting("wh_cakto_secret", "") || process.env.CAKTO_WEBHOOK_SECRET || ""),
      kirvano: options.kirvanoToken ?? (hub.vault.getSetting("wh_kirvano_token", "") || process.env.KIRVANO_WEBHOOK_TOKEN || ""),
      generic: options.genericHmacSecret ?? (hub.vault.getSetting("wh_generic_hmac_secret", "") || process.env.GENERIC_WEBHOOK_HMAC_SECRET || ""),
      productMap: options.productMap || (vaultMap !== null && vaultMap !== undefined ? vaultMap : envMap),
    };
  }

  router.get("/admin/webhooks/config", hub.requireAdmin, (_req, res) => {
    const cfg = getWebhookSettings();
    const baseUrl = (process.env.PAINEL_PUBLIC_URL || "https://painel.criativoaistudio.com.br").replace(/\/+$/, "");
    const urls = Object.fromEntries(SUPPORTED_PROVIDERS.map((p) => [p, `${baseUrl}/api/webhooks/sales?provider=${p}`]));
    const secretsConfigured = Object.fromEntries(SUPPORTED_PROVIDERS.map((p) => [p, Boolean(cfg[p])]));
    return res.json({ urls, secretsConfigured, productMap: cfg.productMap });
  });

  router.put("/admin/webhooks/config", hub.requireAdmin, (req, res) => {
    const body = req.body || {};
    const secretMap = [
      ["hotmartHottok", "wh_hotmart_hottok"],
      ["kiwifyToken", "wh_kiwify_token"],
      ["tictoToken", "wh_ticto_token"],
      ["stripeSecret", "wh_stripe_secret"],
      ["caktoSecret", "wh_cakto_secret"],
      ["kirvanoToken", "wh_kirvano_token"],
      ["genericHmacSecret", "wh_generic_hmac_secret"],
    ];
    for (const [field, key] of secretMap) {
      if (body[field] !== undefined && String(body[field]).trim() !== "") {
        hub.vault.setSetting(key, String(body[field]).trim(), { isSecret: true });
      }
    }
    if (body.productMap && typeof body.productMap === "object") {
      hub.vault.setSetting("webhook_product_map", body.productMap);
    }
    return res.json({ ok: true });
  });

  function recordWebhookFailure({ provider, body, parsed, httpStatus, action, errorDetail }) {
    const id = crypto.randomBytes(12).toString("hex");
    const deliveryKey = `${provider}:err:${crypto.randomUUID()}`;
    const txId = String(parsed?.transactionId || body?.id || body?.order_id || `err_${crypto.randomUUID().slice(0, 12)}`);
    const eventName = String(parsed?.eventName || body?.event || body?.type || (httpStatus === 401 ? "auth_failed" : "webhook_error"));
    const safePayload = body && typeof body === "object" ? { ...body } : {};
    if (httpStatus === 401) {
      delete safePayload.secret;
      delete safePayload.hottok;
      delete safePayload.token;
    }
    hub.db
      .prepare(
        `INSERT INTO sales_webhook_deliveries (
          id, delivery_key, provider, transaction_id, event_name, buyer_email, buyer_name, buyer_phone,
          action, license_key, amount_cents, currency, payment_method, plan_tier, product_id, offer_name,
          raw_payload_json, http_status, error_detail, is_simulated, summary_json, processed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, ?);`,
      )
      .run(
        id, deliveryKey, provider, txId, eventName, parsed?.buyerEmail || null, parsed?.buyerName || null, parsed?.buyerPhone || null,
        action, parsed?.amountCents || 0, parsed?.currency || "BRL", parsed?.paymentMethod || null,
        parsed?.productId || null, parsed?.offerName || null, serializeRawPayload(safePayload),
        httpStatus, String(errorDetail || "").slice(0, 500), JSON.stringify({ error: errorDetail }), new Date().toISOString(),
      );
    return id;
  }

  async function processSaleEvent({
    provider, eventName, transactionId, buyerEmail, buyerName, buyerPhone, productId, offerName,
    amountCents = 0, currency = "BRL", paymentMethod = null, rawPayload = null, isSimulated = false,
    allowReplay = false, replayOfId = null, forcedPlanTier = null, rawSummary = {},
  }) {
    const cfg = getWebhookSettings();
    const txId = transactionId || crypto.createHash("sha256").update(JSON.stringify(rawPayload || rawSummary)).digest("hex").slice(0, 24);
    const deliveryKey = `${provider}:${txId}:${eventName}`;

    if (!allowReplay) {
      const prev = hub.db.prepare(`SELECT id, license_key, action FROM sales_webhook_deliveries WHERE delivery_key = ?;`).get(deliveryKey);
      if (prev) return { ok: true, idempotent: true, id: prev.id, action: prev.action, license_key: prev.license_key };
    }

    const eventClass = classifyWebhookEvent(eventName);
    let action = "ignored";
    let licenseKey = null;
    let notifications = null;
    const mapping = resolveProductMapping(productId, offerName, cfg.productMap);
    if (forcedPlanTier) mapping.planTier = forcedPlanTier;

    let resolvedAmountCents = Math.max(0, Math.round(Number(amountCents) || 0));
    if (eventClass === "approved" && resolvedAmountCents === 0 && mapping.defaultAmountCents > 0) {
      resolvedAmountCents = mapping.defaultAmountCents;
    }
    const resolvedCurrency = String(currency || mapping.currency || "BRL").toUpperCase();
    const resolvedPlanTier = eventClass === "approved" ? mapping.planTier : null;

    if (eventClass === "approved" && buyerEmail) {
      const lic = hub.issueOrUpdateLicenseFromSale({
        email: buyerEmail, customerName: buyerName, customerPhone: buyerPhone,
        planTier: mapping.planTier, addUpgrades: mapping.addUpgrades, provider, transactionId: txId,
        amountCents: resolvedAmountCents, currency: resolvedCurrency, paymentMethod,
        sourceProvider: provider, isSimulated: Boolean(isSimulated),
      });
      action = "issued_or_updated";
      licenseKey = lic.license_key;
      notifications = await hub.dispatchLicenseNotifications(lic, { sendEmail: true, sendWhatsApp: Boolean(lic.customer_phone) });
    } else if (eventClass === "revoked" && buyerEmail) {
      const lic = hub.revokeLicenseByEmailOrKey({ email: buyerEmail, reason: eventName, actor: provider });
      action = lic ? "revoked" : "not_found";
      licenseKey = lic?.license_key || null;
    }

    const nowIso = new Date().toISOString();
    const summaryJson = JSON.stringify({
      offerName, productId, amountCents: resolvedAmountCents, currency: resolvedCurrency, paymentMethod,
      ...(isSimulated ? { simulated: true } : {}), ...rawSummary,
    });

    if (allowReplay && replayOfId) {
      hub.db
        .prepare(
          `UPDATE sales_webhook_deliveries
           SET action = ?, license_key = ?, plan_tier = COALESCE(?, plan_tier), amount_cents = ?, currency = ?,
               payment_method = COALESCE(?, payment_method), http_status = 200, error_detail = NULL,
               summary_json = ?, replayed_at = ?, replay_count = COALESCE(replay_count, 0) + 1
           WHERE id = ?;`,
        )
        .run(action, licenseKey, resolvedPlanTier, resolvedAmountCents, resolvedCurrency, paymentMethod, summaryJson, nowIso, replayOfId);
      return { ok: true, id: replayOfId, action, license_key: licenseKey, amount_cents: resolvedAmountCents, currency: resolvedCurrency, notifications };
    }

    const id = crypto.randomBytes(12).toString("hex");
    hub.db
      .prepare(
        `INSERT INTO sales_webhook_deliveries (
          id, delivery_key, provider, transaction_id, event_name, buyer_email, buyer_name, buyer_phone,
          action, license_key, amount_cents, currency, payment_method, plan_tier, product_id, offer_name,
          raw_payload_json, http_status, error_detail, is_simulated, summary_json, processed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 200, NULL, ?, ?, ?);`,
      )
      .run(
        id, deliveryKey, provider, txId, eventName, buyerEmail || null, buyerName || null, buyerPhone || null,
        action, licenseKey, resolvedAmountCents, resolvedCurrency, paymentMethod, resolvedPlanTier,
        productId || null, offerName || null, serializeRawPayload(rawPayload), isSimulated ? 1 : 0, summaryJson, nowIso,
      );
    return { ok: true, id, action, license_key: licenseKey, amount_cents: resolvedAmountCents, currency: resolvedCurrency, notifications };
  }

  router.post("/admin/webhooks/simulate", hub.requireAdmin, async (req, res) => {
    const {
      provider = "hotmart", event_type = "PURCHASE_APPROVED", email, name = "Cliente Teste Webhook", phone = "",
      product_id = "PROD_INDIVIDUAL", offer_name = "Licença Individual", plan_tier = null,
      amount_cents = null, amount = null, currency = "BRL", payment_method = "pix",
    } = req.body || {};

    if (!email) return res.status(400).json({ error: "missing_email", message: "Informe um e-mail para simular o webhook." });
    const cleanProvider = String(provider || "hotmart").trim().toLowerCase();
    if (!SUPPORTED_PROVIDERS.includes(cleanProvider)) return res.status(400).json({ error: "unsupported_provider" });

    const parsedCents =
      amount_cents !== null && amount_cents !== undefined && amount_cents !== ""
        ? parseMoneyToCents(amount_cents, { isIntegerCents: true })
        : parseMoneyToCents(amount);

    const result = await processSaleEvent({
      provider: cleanProvider, eventName: event_type, transactionId: `sim_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
      buyerEmail: email, buyerName: name, buyerPhone: phone, productId: product_id, offerName: offer_name,
      amountCents: parsedCents, currency: String(currency || "BRL").toUpperCase(), paymentMethod: normalizePaymentMethod(payment_method),
      rawPayload: req.body || {}, isSimulated: true, forcedPlanTier: plan_tier || null, rawSummary: { simulated: true },
    });
    return res.json(result);
  });

  router.get("/admin/webhooks/history", hub.requireAdmin, (_req, res) => {
    const deliveries = hub.db.prepare(`SELECT * FROM sales_webhook_deliveries ORDER BY processed_at DESC LIMIT 100;`).all();
    return res.json({ deliveries });
  });

  router.get("/admin/webhooks/deliveries", hub.requireAdmin, (req, res) => {
    const provider = String(req.query.provider || "").trim().toLowerCase();
    const status = String(req.query.status || "").trim().toLowerCase();
    const q = String(req.query.q || "").trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit || "50", 10) || 50));
    const offset = Math.max(0, Number.parseInt(req.query.offset || "0", 10) || 0);

    const clauses = [];
    const params = [];
    if (provider) { clauses.push("provider = ?"); params.push(provider); }
    const statusFilters = {
      aprovado: "action = 'issued_or_updated' AND COALESCE(is_simulated, 0) = 0",
      reembolso: "action = 'revoked'",
      ignorado: "action IN ('ignored', 'not_found')",
      erro: "action IN ('error', 'auth_error')",
      simulado: "COALESCE(is_simulated, 0) = 1",
    };
    if (statusFilters[status]) clauses.push(statusFilters[status]);
    else if (status) { clauses.push("action = ?"); params.push(status); }
    if (q) {
      clauses.push("(lower(COALESCE(buyer_email, '')) LIKE ? OR lower(COALESCE(buyer_name, '')) LIKE ? OR lower(COALESCE(transaction_id, '')) LIKE ? OR lower(COALESCE(license_key, '')) LIKE ? OR lower(COALESCE(event_name, '')) LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = hub.db.prepare(`SELECT COUNT(*) AS total FROM sales_webhook_deliveries ${whereSql};`).get(...params)?.total || 0;
    const rows = hub.db
      .prepare(
        `SELECT id, delivery_key, provider, transaction_id, event_name, buyer_email, buyer_name, buyer_phone,
                action, license_key, plan_tier, amount_cents, currency, payment_method, http_status,
                error_detail, is_simulated, replay_count, replayed_at, processed_at
         FROM sales_webhook_deliveries ${whereSql} ORDER BY processed_at DESC LIMIT ? OFFSET ?;`,
      )
      .all(...params, limit, offset);
    return res.json({ ok: true, total, deliveries: rows.map((r) => ({ ...r, status_label: mapStatusLabel(r) })) });
  });

  router.get("/admin/webhooks/deliveries/:id", hub.requireAdmin, (req, res) => {
    const idOrKey = String(req.params.id || "").trim();
    const row = hub.db.prepare(`SELECT * FROM sales_webhook_deliveries WHERE id = ? OR delivery_key = ? LIMIT 1;`).get(idOrKey, idOrKey);
    if (!row) return res.status(404).json({ error: "not_found" });
    return res.json({
      ok: true,
      delivery: { ...row, status_label: mapStatusLabel(row), raw_payload: parseJsonSafe(row.raw_payload_json, null), summary: parseJsonSafe(row.summary_json, {}) },
    });
  });

  router.post("/admin/webhooks/deliveries/:id/replay", hub.requireAdmin, async (req, res) => {
    const idOrKey = String(req.params.id || "").trim();
    const row = hub.db.prepare(`SELECT * FROM sales_webhook_deliveries WHERE id = ? OR delivery_key = ? LIMIT 1;`).get(idOrKey, idOrKey);
    if (!row) return res.status(404).json({ error: "not_found" });

    const rawObj = parseJsonSafe(row.raw_payload_json, null);
    const summaryObj = parseJsonSafe(row.summary_json, {});
    const parsed = rawObj
      ? parseWebhookPayload(row.provider, rawObj)
      : {
          eventName: row.event_name, transactionId: row.transaction_id, buyerEmail: row.buyer_email || "",
          buyerName: row.buyer_name || "", buyerPhone: row.buyer_phone || "",
          productId: row.product_id || summaryObj.productId || "", offerName: row.offer_name || summaryObj.offerName || "",
          amountCents: row.amount_cents || 0, currency: row.currency || "BRL", paymentMethod: row.payment_method || null,
        };

    if (!parsed.buyerEmail) return res.status(422).json({ error: "missing_buyer_email", message: "Entrega sem e-mail de comprador para reprocessar." });

    const result = await processSaleEvent({
      provider: row.provider, ...parsed, rawPayload: rawObj, isSimulated: Boolean(row.is_simulated), allowReplay: true, replayOfId: row.id,
    });
    const updated = hub.db.prepare(`SELECT * FROM sales_webhook_deliveries WHERE id = ?;`).get(row.id);
    return res.json({ ok: true, replayed: true, result, delivery: { ...updated, status_label: mapStatusLabel(updated) } });
  });

  router.post("/webhooks/sales", async (req, res) => {
    const secrets = getWebhookSettings();
    const provider = detectProvider(req);
    if (!SUPPORTED_PROVIDERS.includes(provider)) return res.status(400).json({ error: "unsupported_provider" });

    const authCheck = verifyProviderSignature({ provider, req, secrets, timingSafeEqualString });
    if (!authCheck.ok) {
      recordWebhookFailure({ provider, body: req.body, parsed: null, httpStatus: 401, action: "auth_error", errorDetail: authCheck.error });
      return res.status(401).json({ error: authCheck.error });
    }

    const body = req.body || {};
    const parsed = parseWebhookPayload(provider, body);
    try {
      if (classifyWebhookEvent(parsed.eventName) === "approved" && !parsed.buyerEmail) {
        const id = recordWebhookFailure({ provider, body, parsed, httpStatus: 422, action: "error", errorDetail: "missing_buyer_email" });
        return res.status(422).json({ error: "missing_buyer_email", id });
      }
      return res.json(await processSaleEvent({ provider, ...parsed, rawPayload: body }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const id = recordWebhookFailure({ provider, body, parsed, httpStatus: 500, action: "error", errorDetail: msg });
      return res.status(500).json({ error: "webhook_processing_error", message: msg, id });
    }
  });

  return router;
}
