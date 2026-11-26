import express from "express";
import crypto from "node:crypto";
import { timingSafeEqualString } from "./license-hub.js";
import {
  extractWithMapping,
  flattenPayload,
  generateUrlToken,
  getPlatform,
  getPublicPlatformsCatalog,
  normalizeMapping,
  slugify,
  suggestMapping,
} from "./integrations-platforms.js";

const LISTEN_WINDOW_MS = 5 * 60 * 1000;
const MAX_RAW_PAYLOAD_BYTES = 256 * 1024;
const SENSITIVE_KEYS = new Set(["secret", "hottok", "token", "signature", "access_token", "password"]);

function parseJsonSafe(raw, fallback = null) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function redactPayload(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return value;
  if (Array.isArray(value)) return value.map((item) => redactPayload(item, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : redactPayload(v, depth + 1);
  }
  return out;
}

function serializePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  try {
    const txt = JSON.stringify(redactPayload(payload));
    return Buffer.byteLength(txt, "utf8") <= MAX_RAW_PAYLOAD_BYTES
      ? txt
      : JSON.stringify({ _truncated: true, preview: txt.slice(0, MAX_RAW_PAYLOAD_BYTES - 128) });
  } catch {
    return null;
  }
}

function pickRequestHeaders(req) {
  const keep = [
    "content-type",
    "user-agent",
    "x-forwarded-for",
    "x-greenn-signature",
    "x-hotmart-hottok",
    "x-kiwify-signature",
    "x-kiwify-token",
    "x-ticto-token",
    "x-cakto-secret",
    "security-token",
    "stripe-signature",
    "x-webhook-token",
    "x-webhook-signature",
  ];
  const out = {};
  for (const h of keep) {
    const val = req.headers?.[h];
    if (val) out[h] = String(val);
  }
  return out;
}

function buildWebhookUrl(req, platform, slug, urlToken, hasHeaderSecret = false) {
  const configuredBase = String(process.env.PAINEL_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  const reqHost = req?.get?.("host");
  const base = configuredBase || (reqHost ? `${req.protocol || "https"}://${reqHost}` : "https://painel.criativoaistudio.com.br");
  const cleanUrl = `${base}/api/webhooks/${encodeURIComponent(platform)}/${encodeURIComponent(slug)}`;
  if (hasHeaderSecret) return cleanUrl;
  return `${cleanUrl}?token=${encodeURIComponent(urlToken)}`;
}

function verifyStripeHmac(rawBody, headerValue, secret) {
  if (!secret || !headerValue || !rawBody) return false;
  let timestamp = "";
  const v1Sigs = [];
  for (const seg of String(headerValue).split(",")) {
    const idx = seg.indexOf("=");
    if (idx <= 0) continue;
    const k = seg.slice(0, idx).trim();
    const v = seg.slice(idx + 1).trim();
    if (k === "t" && !timestamp) timestamp = v;
    if (k === "v1" && v) v1Sigs.push(v);
  }
  if (!timestamp || v1Sigs.length === 0) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex").toLowerCase();
  return v1Sigs.some((sig) => timingSafeEqualString(sig.toLowerCase(), expected));
}

function normalizeUpgradesList(raw) {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .map((item) => String(item || "").trim().toLowerCase())
        .filter((item) => item === "bonus" || item === "video"),
    ),
  );
}

export function resolveRuleForExtraction(integration, rules = [], extracted = {}) {
  if (integration.delivery_mode === "direct") {
    return {
      matched: true,
      ruleId: null,
      ruleAction: "grant_plan",
      planTier: integration.fixed_plan_tier || "individual",
      addUpgrades: Array.isArray(integration.fixedUpgrades)
        ? integration.fixedUpgrades
        : parseJsonSafe(integration.fixed_upgrades_json, []),
      durationDays: integration.fixed_duration_days ? Number(integration.fixed_duration_days) : null,
      defaultAmountCents: 0,
      currency: "BRL",
      label: "Entrega Direta",
    };
  }

  const cleanProd = String(extracted.productId || "").trim().toLowerCase();
  const cleanOffer = String(extracted.offerName || "").trim().toLowerCase();

  if (cleanProd) {
    const exactProd = rules.find(
      (r) => r.match_field === "product_id" && String(r.match_value || "").trim().toLowerCase() === cleanProd,
    );
    if (exactProd) {
      return {
        matched: true,
        ruleId: exactProd.id,
        ruleAction: exactProd.rule_action || "grant_plan",
        planTier: exactProd.plan_tier || "individual",
        addUpgrades: normalizeUpgradesList(parseJsonSafe(exactProd.add_upgrades_json, exactProd.addUpgrades || [])),
        durationDays: exactProd.duration_days ? Number(exactProd.duration_days) : null,
        defaultAmountCents: Number(exactProd.default_amount_cents || 0),
        currency: String(exactProd.currency || "BRL").toUpperCase(),
        label: exactProd.label || exactProd.match_value,
      };
    }
  }

  if (cleanOffer) {
    const exactOffer = rules.find(
      (r) => r.match_field === "offer_name" && String(r.match_value || "").trim().toLowerCase() === cleanOffer,
    );
    const partialOffer =
      exactOffer ||
      rules.find(
        (r) =>
          r.match_field === "offer_name" &&
          String(r.match_value || "").trim().length > 0 &&
          cleanOffer.includes(String(r.match_value || "").trim().toLowerCase()),
      );
    if (partialOffer) {
      return {
        matched: true,
        ruleId: partialOffer.id,
        ruleAction: partialOffer.rule_action || "grant_plan",
        planTier: partialOffer.plan_tier || "individual",
        addUpgrades: normalizeUpgradesList(parseJsonSafe(partialOffer.add_upgrades_json, partialOffer.addUpgrades || [])),
        durationDays: partialOffer.duration_days ? Number(partialOffer.duration_days) : null,
        defaultAmountCents: Number(partialOffer.default_amount_cents || 0),
        currency: String(partialOffer.currency || "BRL").toUpperCase(),
        label: partialOffer.label || partialOffer.match_value,
      };
    }
  }

  return { matched: false };
}

export function createIntegrationsWebhooksRouter(hub) {
  const router = express.Router();

  function loadRules(integrationId) {
    return hub.db
      .prepare(`SELECT * FROM webhook_delivery_rules WHERE integration_id = ? ORDER BY created_at ASC;`)
      .all(integrationId)
      .map((r) => ({
        ...r,
        addUpgrades: normalizeUpgradesList(parseJsonSafe(r.add_upgrades_json, [])),
      }));
  }

  function serializeIntegration(row, req, { includePayload = false, includeRules = false } = {}) {
    const platform = getPlatform(row.platform);
    const fieldMapping = normalizeMapping(parseJsonSafe(row.field_mapping_json, {}), platform);
    const fixedUpgrades = normalizeUpgradesList(parseJsonSafe(row.fixed_upgrades_json, []));
    const listeningUntilMs = row.listening_until ? Date.parse(row.listening_until) : 0;
    const listening = Boolean(listeningUntilMs && listeningUntilMs > Date.now());
    const secondsLeft = listening ? Math.max(0, Math.ceil((listeningUntilMs - Date.now()) / 1000)) : 0;
    const samplePayload = parseJsonSafe(row.sample_payload_json, null);

    const counts = hub.db
      .prepare(
        `SELECT
           COUNT(*) AS totalEvents,
           SUM(CASE WHEN action = 'pending_mapping' THEN 1 ELSE 0 END) AS pendingCount,
           SUM(CASE WHEN action IN ('error', 'auth_error') THEN 1 ELSE 0 END) AS errorCount
         FROM sales_webhook_deliveries
         WHERE integration_id = ?;`,
      )
      .get(row.id) || { totalEvents: 0, pendingCount: 0, errorCount: 0 };

    const rules = includeRules ? loadRules(row.id) : null;
    const rulesCount = includeRules
      ? rules.length
      : hub.db.prepare(`SELECT COUNT(*) AS total FROM webhook_delivery_rules WHERE integration_id = ?;`).get(row.id)?.total || 0;

    const hasHeaderSecret = Boolean(row.secret_setting_key && hub.vault.getSetting(row.secret_setting_key, ""));

    return {
      id: row.id,
      platform: row.platform,
      platformName: platform?.name || row.platform,
      platformColor: platform?.color || "#64748b",
      platformLogo: platform?.logo || `/logos-integracoes/${row.platform}.svg`,
      name: row.name,
      slug: row.slug,
      webhookUrl: buildWebhookUrl(req, row.platform, row.slug, row.url_token, hasHeaderSecret),
      webhookUrlWithToken: buildWebhookUrl(req, row.platform, row.slug, row.url_token, false),
      authMode: row.auth_mode || "url_token",
      hasHeaderSecret,
      deliveryMode: row.delivery_mode,
      fixedPlanTier: row.fixed_plan_tier || "individual",
      fixedUpgrades,
      fixedDurationDays: row.fixed_duration_days || null,
      fieldMapping,
      hasMapping: Boolean(fieldMapping.email),
      sendEmail: Boolean(row.send_email),
      sendWhatsapp: Boolean(row.send_whatsapp),
      isActive: Boolean(row.is_active),
      listening,
      listeningUntil: row.listening_until || null,
      secondsLeft,
      hasSamplePayload: Boolean(samplePayload),
      ...(includePayload ? { samplePayload } : {}),
      ...(includeRules ? { rules } : {}),
      rulesCount: Number(rulesCount || 0),
      totalEvents: Number(counts.totalEvents || 0),
      pendingCount: Number(counts.pendingCount || 0),
      errorCount: Number(counts.errorCount || 0),
      lastEventAt: row.last_event_at || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function buildListenState(row, req) {
    const platform = getPlatform(row.platform);
    const payload = parseJsonSafe(row.sample_payload_json, null);
    const fields = payload ? flattenPayload(payload) : [];
    const suggestedMapping = payload ? suggestMapping(payload, platform) : null;
    const mapping = normalizeMapping(parseJsonSafe(row.field_mapping_json, {}), platform);
    const activeMapping = mapping.email ? mapping : suggestedMapping || mapping;
    const rules = loadRules(row.id);
    const integrationView = serializeIntegration(row, req);
    const previewExtracted = payload ? extractWithMapping(payload, activeMapping, platform) : null;
    const previewRule = previewExtracted ? resolveRuleForExtraction({ ...row, fixedUpgrades: integrationView.fixedUpgrades }, rules, previewExtracted) : null;

    return {
      ok: true,
      listening: integrationView.listening,
      listeningUntil: integrationView.listeningUntil,
      secondsLeft: integrationView.secondsLeft,
      payload,
      fields,
      suggestedMapping,
      preview: previewExtracted ? { extracted: previewExtracted, ruleResolution: previewRule } : null,
    };
  }

  function makeUniqueSlug(platform, name) {
    const nameSlug = slugify(name || "");
    const rawBase = nameSlug
      ? nameSlug === platform || nameSlug.startsWith(`${platform}-`)
        ? nameSlug
        : `${platform}-${nameSlug}`
      : platform;
    const base = rawBase.slice(0, 48).replace(/-+$/, "") || platform;
    let candidate = base;
    let attempt = 1;
    while (hub.db.prepare(`SELECT 1 FROM webhook_integrations WHERE slug = ?;`).get(candidate)) {
      attempt += 1;
      candidate = `${base}-${crypto.randomBytes(2).toString("hex")}`;
      if (attempt > 8) {
        candidate = `${platform}-${crypto.randomBytes(4).toString("hex")}`;
        break;
      }
    }
    return candidate;
  }

  function replaceIntegrationRules(integrationId, rawRules = []) {
    hub.db.prepare(`DELETE FROM webhook_delivery_rules WHERE integration_id = ?;`).run(integrationId);
    const nowIso = new Date().toISOString();
    const stmt = hub.db.prepare(
      `INSERT INTO webhook_delivery_rules (
        id, integration_id, match_field, match_value, rule_action, plan_tier,
        add_upgrades_json, duration_days, default_amount_cents, currency, label, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    );
    for (const r of rawRules) {
      const matchValue = String(r?.matchValue ?? r?.match_value ?? "").trim();
      if (!matchValue) continue;
      const matchField = (r?.matchField ?? r?.match_field) === "offer_name" ? "offer_name" : "product_id";
      const ruleAction = ["grant_plan", "add_upgrades_only", "create_new_license", "ignore"].includes(r?.ruleAction ?? r?.rule_action)
        ? (r.ruleAction ?? r.rule_action)
        : "grant_plan";
      const planTier = String(r?.planTier ?? r?.plan_tier ?? "individual");
      const upgrades = normalizeUpgradesList(r?.addUpgrades ?? r?.add_upgrades ?? []);
      const durationDays = Number.isInteger(Number(r?.durationDays ?? r?.duration_days)) && Number(r?.durationDays ?? r?.duration_days) > 0
        ? Number(r?.durationDays ?? r?.duration_days)
        : null;
      const defaultAmountCents = Math.max(0, Math.round(Number(r?.defaultAmountCents ?? r?.default_amount_cents ?? 0) || 0));
      const currency = String(r?.currency || "BRL").toUpperCase();
      const label = r?.label ? String(r.label).trim() : null;
      stmt.run(
        `whr_${crypto.randomBytes(8).toString("hex")}`,
        integrationId,
        matchField,
        matchValue,
        ruleAction,
        planTier,
        JSON.stringify(upgrades),
        durationDays,
        defaultAmountCents,
        currency,
        label,
        nowIso,
        nowIso,
      );
    }
  }

  function recordIntegrationDelivery({
    integration,
    transactionId,
    eventName,
    extracted = {},
    action,
    statusCategory,
    licenseKey = null,
    amountCents = 0,
    currency = "BRL",
    paymentMethod = null,
    planTier = null,
    rawPayload = null,
    httpStatus = 200,
    errorDetail = null,
    deliveryKeyOverride = null,
    summaryExtra = {},
  }) {
    const id = crypto.randomBytes(12).toString("hex");
    const nowIso = new Date().toISOString();
    const deliveryKey =
      deliveryKeyOverride || `${integration.id}:${transactionId || id}:${eventName || action}:${id.slice(0, 6)}`;
    hub.db
      .prepare(
        `INSERT INTO sales_webhook_deliveries (
          id, delivery_key, provider, integration_id, transaction_id, event_name, buyer_email, buyer_name, buyer_phone,
          action, status_category, license_key, amount_cents, currency, payment_method, plan_tier, product_id, offer_name,
          raw_payload_json, http_status, error_detail, is_simulated, summary_json, processed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?);`,
      )
      .run(
        id,
        deliveryKey,
        integration.platform,
        integration.id,
        String(transactionId || id),
        String(eventName || action),
        extracted.buyerEmail || null,
        extracted.buyerName || null,
        extracted.buyerPhone || null,
        action,
        statusCategory,
        licenseKey,
        Math.max(0, Math.round(Number(amountCents) || 0)),
        String(currency || "BRL").toUpperCase(),
        paymentMethod,
        planTier,
        extracted.productId || null,
        extracted.offerName || null,
        serializePayload(rawPayload),
        httpStatus,
        errorDetail ? String(errorDetail).slice(0, 500) : null,
        JSON.stringify({ integrationName: integration.name, ...summaryExtra }),
        nowIso,
      );
    hub.db.prepare(`UPDATE webhook_integrations SET last_event_at = ? WHERE id = ?;`).run(nowIso, integration.id);
    return id;
  }

  async function processExtractedEvent({ integration, rules, extracted, rawPayload, txId, forceDeliveryUpdateId = null }) {
    const platform = getPlatform(integration.platform);
    const nowIso = new Date().toISOString();

    if (extracted.eventAction === "revoke") {
      const revoked = hub.revokeLicenseByEmailOrKey({
        email: extracted.buyerEmail,
        transactionId: txId,
        productId: extracted.productId,
        provider: integration.platform,
        reason: extracted.eventName || "refund",
        actor: `${integration.platform}:${integration.slug}`,
      });
      const action = revoked ? "revoked" : "not_found";
      const statusCategory = revoked ? "revoked" : "ignored";
      if (forceDeliveryUpdateId) {
        hub.db
          .prepare(`UPDATE sales_webhook_deliveries SET action = ?, status_category = ?, license_key = ?, replayed_at = ?, replay_count = COALESCE(replay_count, 0) + 1 WHERE id = ?;`)
          .run(action, statusCategory, revoked?.license_key || null, nowIso, forceDeliveryUpdateId);
      } else {
        recordIntegrationDelivery({
          integration,
          transactionId: txId,
          eventName: extracted.eventName,
          extracted,
          action,
          statusCategory,
          licenseKey: revoked?.license_key || null,
          amountCents: extracted.amountCents,
          currency: extracted.currency,
          paymentMethod: extracted.paymentMethod,
          rawPayload,
          summaryExtra: { revocationScope: revoked?._revocationScope || null },
        });
      }
      return { ok: true, action, license_key: revoked?.license_key || null, revocationScope: revoked?._revocationScope || null };
    }

    if (extracted.eventAction === "ignore") {
      const id = recordIntegrationDelivery({
        integration,
        transactionId: txId,
        eventName: extracted.eventName,
        extracted,
        action: "ignored",
        statusCategory: "ignored",
        amountCents: extracted.amountCents,
        currency: extracted.currency,
        paymentMethod: extracted.paymentMethod,
        rawPayload,
        summaryExtra: { reason: "status_ignored" },
      });
      return { ok: true, id, action: "ignored" };
    }

    // approve ou renew
    if (!extracted.emailValid) {
      const id = recordIntegrationDelivery({
        integration,
        transactionId: txId,
        eventName: extracted.eventName,
        extracted,
        action: "error",
        statusCategory: "error",
        httpStatus: 422,
        errorDetail: "E-mail do comprador ausente ou inválido no campo mapeado.",
        rawPayload,
      });
      return { ok: false, statusCode: 422, error: "missing_buyer_email", id };
    }

    const fixedUpgrades = normalizeUpgradesList(parseJsonSafe(integration.fixed_upgrades_json, []));
    const rule = resolveRuleForExtraction({ ...integration, fixedUpgrades }, rules, extracted);

    if (!rule.matched) {
      const id =
        forceDeliveryUpdateId ||
        recordIntegrationDelivery({
          integration,
          transactionId: txId,
          eventName: extracted.eventName,
          extracted,
          action: "pending_mapping",
          statusCategory: "pending_mapping",
          amountCents: extracted.amountCents,
          currency: extracted.currency,
          paymentMethod: extracted.paymentMethod,
          rawPayload,
          summaryExtra: { reason: "unmapped_product", productId: extracted.productId, offerName: extracted.offerName },
        });
      return {
        ok: true,
        id,
        action: "pending_mapping",
        message: "Produto não mapeado. Configure uma regra no painel para liberar a licença.",
      };
    }

    if (rule.ruleAction === "ignore") {
      const id = recordIntegrationDelivery({
        integration,
        transactionId: txId,
        eventName: extracted.eventName,
        extracted,
        action: "ignored",
        statusCategory: "ignored",
        amountCents: extracted.amountCents,
        currency: extracted.currency,
        paymentMethod: extracted.paymentMethod,
        rawPayload,
        summaryExtra: { ruleId: rule.ruleId, reason: "rule_ignore" },
      });
      return { ok: true, id, action: "ignored" };
    }

    const resolvedAmountCents =
      extracted.amountCents > 0 ? extracted.amountCents : Number(rule.defaultAmountCents || 0);
    const resolvedCurrency = extracted.currency || rule.currency || "BRL";

    const lic = hub.issueOrUpdateLicenseFromSale({
      email: extracted.buyerEmail,
      customerName: extracted.buyerName,
      customerPhone: extracted.buyerPhone,
      planTier: rule.planTier,
      addUpgrades: rule.addUpgrades,
      durationDays: rule.durationDays,
      ruleAction: rule.ruleAction,
      provider: integration.platform,
      integrationId: integration.id,
      transactionId: txId,
      productId: extracted.productId || null,
      offerName: extracted.offerName || null,
      isRenewal: extracted.eventAction === "renew",
      amountCents: resolvedAmountCents,
      currency: resolvedCurrency,
      paymentMethod: extracted.paymentMethod,
      sourceProvider: integration.platform,
      isSimulated: false,
    });

    const notifications = await hub.dispatchLicenseNotifications(lic, {
      sendEmail: Boolean(integration.send_email),
      sendWhatsApp: Boolean(integration.send_whatsapp) && Boolean(lic.customer_phone),
      eventType: lic._deliveryEventType || (extracted.eventAction === "renew" ? "subscription_renewed" : "license_issued"),
    });

    const deliveryKey = `${integration.id}:${txId}:${extracted.eventName || "approved"}`;
    const appliedPlan = rule.ruleAction === "add_upgrades_only" ? lic.plan_tier : rule.planTier;

    if (forceDeliveryUpdateId) {
      hub.db
        .prepare(
          `UPDATE sales_webhook_deliveries
           SET action = 'issued_or_updated', status_category = 'approved', license_key = ?,
               plan_tier = ?, amount_cents = ?, currency = ?, error_detail = NULL,
               http_status = 200, replayed_at = ?, replay_count = COALESCE(replay_count, 0) + 1
           WHERE id = ?;`,
        )
        .run(lic.license_key, appliedPlan, resolvedAmountCents, resolvedCurrency, nowIso, forceDeliveryUpdateId);
      return {
        ok: true,
        id: forceDeliveryUpdateId,
        action: "issued_or_updated",
        license_key: lic.license_key,
        plan_tier: appliedPlan,
        amount_cents: resolvedAmountCents,
        currency: resolvedCurrency,
        notifications,
      };
    }

    const id = recordIntegrationDelivery({
      integration,
      transactionId: txId,
      eventName: extracted.eventName,
      extracted,
      action: "issued_or_updated",
      statusCategory: "approved",
      licenseKey: lic.license_key,
      amountCents: resolvedAmountCents,
      currency: resolvedCurrency,
      paymentMethod: extracted.paymentMethod,
      planTier: appliedPlan,
      rawPayload,
      deliveryKeyOverride: deliveryKey,
      summaryExtra: { platformName: platform?.name || integration.platform, ruleLabel: rule.label },
    });

    return {
      ok: true,
      id,
      action: "issued_or_updated",
      license_key: lic.license_key,
      plan_tier: appliedPlan,
      amount_cents: resolvedAmountCents,
      currency: resolvedCurrency,
      notifications,
    };
  }

  // ─── Rotas Admin ────────────────────────────────────────────────────────────

  router.get("/admin/integrations/platforms", hub.requireAdmin, (_req, res) => {
    return res.json({ ok: true, platforms: getPublicPlatformsCatalog() });
  });

  router.get("/admin/integrations", hub.requireAdmin, (req, res) => {
    const rows = hub.db.prepare(`SELECT * FROM webhook_integrations ORDER BY created_at DESC;`).all();
    return res.json({
      ok: true,
      integrations: rows.map((r) => serializeIntegration(r, req)),
    });
  });

  router.post("/admin/integrations", hub.requireAdmin, (req, res) => {
    const body = req.body || {};
    const platformId = String(body.platform || "").trim().toLowerCase();
    const platform = getPlatform(platformId);
    if (!platform) {
      return res.status(400).json({ error: "unsupported_platform", message: "Plataforma não encontrada no catálogo." });
    }

    const id = `int_${crypto.randomBytes(8).toString("hex")}`;
    const name = String(body.name || `${platform.name} Principal`).trim().slice(0, 80);
    const slug = makeUniqueSlug(platform.id, name);
    const urlToken = generateUrlToken(28);
    const deliveryMode = body.deliveryMode === "direct" ? "direct" : "product_map";
    const fixedPlanTier = String(body.fixedPlanTier || "individual");
    const fixedUpgrades = normalizeUpgradesList(body.fixedUpgrades || []);
    const fixedDurationDays =
      Number.isInteger(Number(body.fixedDurationDays)) && Number(body.fixedDurationDays) > 0
        ? Number(body.fixedDurationDays)
        : null;
    const mapping = normalizeMapping(body.fieldMapping || {}, platform);
    const sendEmail = body.sendEmail !== false ? 1 : 0;
    const sendWhatsapp = body.sendWhatsapp !== false ? 1 : 0;
    const isActive = body.isActive ? 1 : 0;
    const rawSecret = String(body.headerSecret ?? body.webhookToken ?? "").trim();
    const authMode = String(body.authMode || (rawSecret ? "header_secret" : "url_token"));
    let secretKey = null;
    if (rawSecret) {
      secretKey = `wh_int_secret_${id}`;
      hub.vault.setSetting(secretKey, rawSecret, { isSecret: true });
    }
    const nowIso = new Date().toISOString();

    hub.db
      .prepare(
        `INSERT INTO webhook_integrations (
          id, platform, name, slug, url_token, auth_mode, secret_setting_key,
          delivery_mode, fixed_plan_tier, fixed_upgrades_json, fixed_duration_days,
          field_mapping_json, send_email, send_whatsapp, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      )
      .run(
        id,
        platform.id,
        name,
        slug,
        urlToken,
        authMode,
        secretKey,
        deliveryMode,
        fixedPlanTier,
        JSON.stringify(fixedUpgrades),
        fixedDurationDays,
        JSON.stringify(mapping),
        sendEmail,
        sendWhatsapp,
        isActive,
        nowIso,
        nowIso,
      );

    if (Array.isArray(body.rules) && body.rules.length > 0) {
      replaceIntegrationRules(id, body.rules);
    }

    const created = hub.db.prepare(`SELECT * FROM webhook_integrations WHERE id = ?;`).get(id);
    return res.status(201).json({
      ok: true,
      integration: serializeIntegration(created, req, { includePayload: true, includeRules: true }),
    });
  });

  router.get("/admin/integrations/:id", hub.requireAdmin, (req, res) => {
    const row = hub.db.prepare(`SELECT * FROM webhook_integrations WHERE id = ?;`).get(req.params.id);
    if (!row) return res.status(404).json({ error: "not_found" });
    const listenState = buildListenState(row, req);
    const events = hub.db
      .prepare(
        `SELECT id, transaction_id, event_name, buyer_email, buyer_name, action, status_category,
                license_key, plan_tier, amount_cents, currency, http_status, error_detail, processed_at
         FROM sales_webhook_deliveries WHERE integration_id = ? ORDER BY processed_at DESC LIMIT 20;`,
      )
      .all(row.id);
    return res.json({
      ok: true,
      integration: serializeIntegration(row, req, { includePayload: true, includeRules: true }),
      listenState,
      events,
    });
  });

  router.patch("/admin/integrations/:id", hub.requireAdmin, (req, res) => {
    const row = hub.db.prepare(`SELECT * FROM webhook_integrations WHERE id = ?;`).get(req.params.id);
    if (!row) return res.status(404).json({ error: "not_found" });

    const body = req.body || {};
    const platform = getPlatform(row.platform);
    const nextName = body.name !== undefined ? String(body.name).trim().slice(0, 80) || row.name : row.name;
    const nextDeliveryMode =
      body.deliveryMode === "direct" ? "direct" : body.deliveryMode === "product_map" ? "product_map" : row.delivery_mode;
    const nextFixedPlan = body.fixedPlanTier !== undefined ? String(body.fixedPlanTier) : row.fixed_plan_tier;
    const nextFixedUpgrades =
      body.fixedUpgrades !== undefined ? JSON.stringify(normalizeUpgradesList(body.fixedUpgrades)) : row.fixed_upgrades_json;
    const nextFixedDuration =
      body.fixedDurationDays !== undefined
        ? Number.isInteger(Number(body.fixedDurationDays)) && Number(body.fixedDurationDays) > 0
          ? Number(body.fixedDurationDays)
          : null
        : row.fixed_duration_days;
    const nextMapping =
      body.fieldMapping !== undefined
        ? JSON.stringify(normalizeMapping(body.fieldMapping, platform))
        : row.field_mapping_json;
    const nextSendEmail = body.sendEmail !== undefined ? (body.sendEmail ? 1 : 0) : row.send_email;
    const nextSendWa = body.sendWhatsapp !== undefined ? (body.sendWhatsapp ? 1 : 0) : row.send_whatsapp;
    const nextActive = body.isActive !== undefined ? (body.isActive ? 1 : 0) : row.is_active;
    let nextAuthMode = body.authMode !== undefined ? String(body.authMode) : row.auth_mode;
    let nextSecretKey = row.secret_setting_key;
    const incomingSecret = body.headerSecret ?? body.webhookToken;
    if (body.clearHeaderSecret === true) {
      if (nextSecretKey) hub.vault.setSetting(nextSecretKey, "", { isSecret: true });
      nextSecretKey = null;
      nextAuthMode = "url_token";
    } else if (incomingSecret !== undefined && String(incomingSecret).trim()) {
      nextSecretKey = nextSecretKey || `wh_int_secret_${row.id}`;
      hub.vault.setSetting(nextSecretKey, String(incomingSecret).trim(), { isSecret: true });
      if (body.authMode === undefined) nextAuthMode = "header_secret";
    }

    const parsedNextMapping = parseJsonSafe(nextMapping, {});
    if (nextActive && !parsedNextMapping.email) {
      return res.status(400).json({
        error: "missing_email_mapping",
        message: "Mapeie o campo de e-mail do comprador antes de ativar a integração.",
      });
    }

    hub.db
      .prepare(
        `UPDATE webhook_integrations
         SET name = ?, auth_mode = ?, secret_setting_key = ?, delivery_mode = ?,
             fixed_plan_tier = ?, fixed_upgrades_json = ?, fixed_duration_days = ?,
             field_mapping_json = ?, send_email = ?, send_whatsapp = ?, is_active = ?, updated_at = ?
         WHERE id = ?;`,
      )
      .run(
        nextName,
        nextAuthMode,
        nextSecretKey,
        nextDeliveryMode,
        nextFixedPlan,
        nextFixedUpgrades,
        nextFixedDuration,
        nextMapping,
        nextSendEmail,
        nextSendWa,
        nextActive,
        new Date().toISOString(),
        row.id,
      );

    if (Array.isArray(body.rules)) {
      replaceIntegrationRules(row.id, body.rules);
    }

    const updated = hub.db.prepare(`SELECT * FROM webhook_integrations WHERE id = ?;`).get(row.id);
    return res.json({
      ok: true,
      integration: serializeIntegration(updated, req, { includePayload: true, includeRules: true }),
    });
  });

  router.delete("/admin/integrations/:id", hub.requireAdmin, (req, res) => {
    const resDel = hub.db.prepare(`DELETE FROM webhook_integrations WHERE id = ?;`).run(req.params.id);
    if (resDel.changes === 0) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true });
  });

  router.get("/admin/integrations/:id/listen", hub.requireAdmin, (req, res) => {
    const row = hub.db.prepare(`SELECT * FROM webhook_integrations WHERE id = ?;`).get(req.params.id);
    if (!row) return res.status(404).json({ error: "not_found" });
    return res.json(buildListenState(row, req));
  });

  router.post("/admin/integrations/:id/listen", hub.requireAdmin, (req, res) => {
    const row = hub.db.prepare(`SELECT * FROM webhook_integrations WHERE id = ?;`).get(req.params.id);
    if (!row) return res.status(404).json({ error: "not_found" });

    const action = String(req.body?.action || "start").trim();
    const nowIso = new Date().toISOString();

    if (action === "start") {
      const listeningUntil = new Date(Date.now() + LISTEN_WINDOW_MS).toISOString();
      hub.db
        .prepare(`UPDATE webhook_integrations SET listening_until = ?, sample_payload_json = NULL, updated_at = ? WHERE id = ?;`)
        .run(listeningUntil, nowIso, row.id);
    } else if (action === "stop") {
      hub.db.prepare(`UPDATE webhook_integrations SET listening_until = NULL, updated_at = ? WHERE id = ?;`).run(nowIso, row.id);
    } else if (action === "simulate_sample") {
      const platform = getPlatform(row.platform);
      const sample = platform?.samplePayload || { event: "purchase_approved", customer: { email: "cliente@exemplo.invalid", name: "Comprador Exemplo" } };
      hub.db
        .prepare(`UPDATE webhook_integrations SET listening_until = NULL, sample_payload_json = ?, last_event_at = ?, updated_at = ? WHERE id = ?;`)
        .run(JSON.stringify(sample), nowIso, nowIso, row.id);
      recordIntegrationDelivery({
        integration: row,
        transactionId: `sample_${Date.now()}`,
        eventName: "test_captured",
        extracted: {},
        action: "test_captured",
        statusCategory: "test_captured",
        rawPayload: sample,
        summaryExtra: { simulatedSample: true },
      });
    }

    const updated = hub.db.prepare(`SELECT * FROM webhook_integrations WHERE id = ?;`).get(row.id);
    return res.json(buildListenState(updated, req));
  });

  router.post("/admin/integrations/:id/preview", hub.requireAdmin, (req, res) => {
    const row = hub.db.prepare(`SELECT * FROM webhook_integrations WHERE id = ?;`).get(req.params.id);
    if (!row) return res.status(404).json({ error: "not_found" });
    const platform = getPlatform(row.platform);
    const payload = req.body?.payload ?? parseJsonSafe(row.sample_payload_json, null);
    if (!payload) return res.json({ ok: true, preview: null });

    const mapping = normalizeMapping(req.body?.fieldMapping || parseJsonSafe(row.field_mapping_json, {}), platform);
    const deliveryMode = req.body?.deliveryMode || row.delivery_mode;
    const fixedPlanTier = req.body?.fixedPlanTier || row.fixed_plan_tier;
    const fixedUpgrades = normalizeUpgradesList(req.body?.fixedUpgrades ?? parseJsonSafe(row.fixed_upgrades_json, []));
    const rules = Array.isArray(req.body?.rules) ? req.body.rules : loadRules(row.id);

    const extracted = extractWithMapping(payload, mapping, platform);
    const ruleResolution = resolveRuleForExtraction(
      { ...row, delivery_mode: deliveryMode, fixed_plan_tier: fixedPlanTier, fixedUpgrades },
      rules,
      extracted,
    );
    return res.json({ ok: true, preview: { extracted, ruleResolution } });
  });

  router.post("/admin/integrations/:id/resolve-pending/:deliveryId", hub.requireAdmin, async (req, res) => {
    const row = hub.db.prepare(`SELECT * FROM webhook_integrations WHERE id = ?;`).get(req.params.id);
    if (!row) return res.status(404).json({ error: "not_found" });

    const delivery = hub.db
      .prepare(`SELECT * FROM sales_webhook_deliveries WHERE id = ? AND integration_id = ?;`)
      .get(req.params.deliveryId, row.id);
    if (!delivery) return res.status(404).json({ error: "delivery_not_found" });

    const body = req.body || {};
    const matchValue = String(body.matchValue || delivery.product_id || delivery.offer_name || "").trim();
    const matchField = body.matchField === "offer_name" ? "offer_name" : delivery.product_id ? "product_id" : "offer_name";
    if (!matchValue) {
      return res.status(400).json({ error: "missing_match_value", message: "Informe o ID ou nome do produto para mapear." });
    }

    const ruleAction = ["grant_plan", "add_upgrades_only", "create_new_license", "ignore"].includes(body.ruleAction)
      ? body.ruleAction
      : "grant_plan";
    const planTier = String(body.planTier || "individual");
    const addUpgrades = normalizeUpgradesList(body.addUpgrades || []);
    const durationDays =
      Number.isInteger(Number(body.durationDays)) && Number(body.durationDays) > 0 ? Number(body.durationDays) : null;
    const defaultAmountCents = Math.max(0, Math.round(Number(body.defaultAmountCents || 0) || 0));

    if (body.saveRule !== false) {
      const nowIso = new Date().toISOString();
      hub.db
        .prepare(
          `INSERT INTO webhook_delivery_rules (
            id, integration_id, match_field, match_value, rule_action, plan_tier,
            add_upgrades_json, duration_days, default_amount_cents, currency, label, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        )
        .run(
          `whr_${crypto.randomBytes(8).toString("hex")}`,
          row.id,
          matchField,
          matchValue,
          ruleAction,
          planTier,
          JSON.stringify(addUpgrades),
          durationDays,
          defaultAmountCents,
          String(body.currency || delivery.currency || "BRL").toUpperCase(),
          body.label ? String(body.label).trim() : matchValue,
          nowIso,
          nowIso,
        );
    }

    const platform = getPlatform(row.platform);
    const rawPayload = parseJsonSafe(delivery.raw_payload_json, {});
    const mapping = normalizeMapping(parseJsonSafe(row.field_mapping_json, {}), platform);
    const extracted =
      rawPayload && Object.keys(rawPayload).length > 0 && mapping.email
        ? extractWithMapping(rawPayload, mapping, platform)
        : {
            emailValid: Boolean(delivery.buyer_email),
            buyerEmail: String(delivery.buyer_email || "").toLowerCase(),
            buyerName: delivery.buyer_name || "",
            buyerPhone: delivery.buyer_phone || "",
            transactionId: delivery.transaction_id || "",
            eventName: delivery.event_name || "approved",
            eventAction: "approve",
            amountCents: Number(delivery.amount_cents || 0),
            currency: delivery.currency || "BRL",
            paymentMethod: delivery.payment_method || null,
            productId: delivery.product_id || "",
            offerName: delivery.offer_name || "",
          };

    const rules = loadRules(row.id);
    const result = await processExtractedEvent({
      integration: row,
      rules,
      extracted,
      rawPayload,
      txId: extracted.transactionId || delivery.transaction_id,
      forceDeliveryUpdateId: delivery.id,
    });

    return res.json({ ok: true, resolved: true, result });
  });

  // ─── Rotas Públicas de Recepção de Webhooks ─────────────────────────────────

  router.get("/webhooks/:platform/:slug", (req, res) => {
    const platform = String(req.params.platform || "").trim().toLowerCase();
    const slug = String(req.params.slug || "").trim();
    const row = hub.db.prepare(`SELECT id, platform, is_active FROM webhook_integrations WHERE slug = ?;`).get(slug);
    if (!row || row.platform !== platform) {
      return res.status(404).json({ error: "webhook_not_found" });
    }
    return res.json({ ok: true, active: Boolean(row.is_active), message: "Webhook pronto para receber eventos." });
  });

  router.post("/webhooks/:platform/:slug", async (req, res) => {
    const platformId = String(req.params.platform || "").trim().toLowerCase();
    const slug = String(req.params.slug || "").trim();
    const integration = hub.db.prepare(`SELECT * FROM webhook_integrations WHERE slug = ?;`).get(slug);
    if (!integration || integration.platform !== platformId) {
      return res.status(404).json({ error: "webhook_not_found" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const urlToken = String(req.query?.token || req.headers?.["x-webhook-token"] || "").trim();
    const headerSecret = integration.secret_setting_key ? hub.vault.getSetting(integration.secret_setting_key, "") : "";
    const tokenCandidates = [
      req.headers?.["x-greenn-signature"],
      req.headers?.["x-greenn-token"],
      req.headers?.["x-hotmart-hottok"],
      req.headers?.["x-cakto-secret"],
      req.headers?.["security-token"],
      req.headers?.["x-kirvano-token"],
      req.headers?.["x-ticto-token"],
      req.headers?.["x-kiwify-token"],
      req.headers?.["x-webhook-token"],
      req.headers?.["x-api-token"],
      req.headers?.["token"],
      String(req.headers?.authorization || "").replace(/^Bearer\s+/i, ""),
      req.query?.token,
      req.query?.hottok,
      req.query?.secret,
      body.hottok,
      body.token,
      body.webhook_token,
      body.webhookToken,
      body.secret,
      body.api_token,
      body.data?.token,
    ]
      .map((v) => String(v || "").trim())
      .filter(Boolean);

    const urlTokenValid = Boolean(urlToken && timingSafeEqualString(urlToken, integration.url_token));
    const headerTokenValid = Boolean(
      headerSecret && tokenCandidates.some((candidate) => timingSafeEqualString(candidate, headerSecret)),
    );
    const rawBodyStr = typeof req.rawBody === "string" ? req.rawBody : JSON.stringify(body);
    const kiwifySig = String(req.headers?.["x-kiwify-signature"] || req.query?.signature || body.signature || "").trim().toLowerCase();
    const genericHmacSig = String(req.headers?.["x-webhook-signature"] || req.headers?.["x-signature-sha256"] || "")
      .replace(/^sha256=/i, "")
      .trim()
      .toLowerCase();
    const hmacValid = Boolean(
      headerSecret &&
        rawBodyStr &&
        ((req.headers?.["stripe-signature"] && verifyStripeHmac(rawBodyStr, req.headers["stripe-signature"], headerSecret)) ||
          (kiwifySig &&
            timingSafeEqualString(kiwifySig, crypto.createHmac("sha1", headerSecret).update(rawBodyStr).digest("hex").toLowerCase())) ||
          (genericHmacSig &&
            timingSafeEqualString(genericHmacSig, crypto.createHmac("sha256", headerSecret).update(rawBodyStr).digest("hex").toLowerCase()))),
    );

    if (!urlTokenValid && !headerTokenValid && !hmacValid) {
      recordIntegrationDelivery({
        integration,
        transactionId: `auth_err_${Date.now()}`,
        eventName: "auth_failed",
        action: "auth_error",
        statusCategory: "error",
        httpStatus: 401,
        errorDetail: "Token do webhook ausente ou inválido.",
        rawPayload: body,
      });
      return res.status(401).json({ error: "invalid_webhook_token" });
    }

    const nowIso = new Date().toISOString();
    const headers = pickRequestHeaders(req);
    const listeningUntilMs = integration.listening_until ? Date.parse(integration.listening_until) : 0;

    // 1. Modo escuta de teste: apenas captura o payload para mapeamento visual
    if (listeningUntilMs && listeningUntilMs > Date.now()) {
      hub.db
        .prepare(
          `UPDATE webhook_integrations
           SET sample_payload_json = ?, sample_headers_json = ?, listening_until = NULL, last_event_at = ?, updated_at = ?
           WHERE id = ?;`,
        )
        .run(serializePayload(body) || "{}", JSON.stringify(headers), nowIso, nowIso, integration.id);

      recordIntegrationDelivery({
        integration,
        transactionId: `test_${Date.now()}`,
        eventName: "test_captured",
        action: "test_captured",
        statusCategory: "test_captured",
        rawPayload: body,
        summaryExtra: { mode: "listen_capture" },
      });

      return res.json({ ok: true, mode: "test", message: "Evento de teste capturado com sucesso para mapeamento." });
    }

    // 2. Integração pausada: registra e ignora
    if (!integration.is_active) {
      recordIntegrationDelivery({
        integration,
        transactionId: `paused_${Date.now()}`,
        eventName: String(body.event || body.status || "paused"),
        action: "ignored",
        statusCategory: "ignored",
        rawPayload: body,
        summaryExtra: { reason: "integration_paused" },
      });
      return res.json({ ok: true, status: "paused", message: "Integração pausada." });
    }

    // 3. Processamento normal com mapeamento configurado
    const platform = getPlatform(integration.platform);
    const mapping = normalizeMapping(parseJsonSafe(integration.field_mapping_json, {}), platform);

    if (!mapping.email) {
      recordIntegrationDelivery({
        integration,
        transactionId: `unmapped_${Date.now()}`,
        eventName: String(body.event || body.status || "no_mapping"),
        action: "pending_mapping",
        statusCategory: "pending_mapping",
        rawPayload: body,
        summaryExtra: { reason: "missing_field_mapping" },
      });
      return res.json({ ok: true, action: "pending_mapping", message: "Mapeamento de campos pendente." });
    }

    const extracted = extractWithMapping(body, mapping, platform);
    const txId =
      extracted.transactionId ||
      crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 24);
    const deliveryKey = `${integration.id}:${txId}:${extracted.eventName || "approved"}`;

    const existing = hub.db
      .prepare(`SELECT id, action, license_key FROM sales_webhook_deliveries WHERE delivery_key = ?;`)
      .get(deliveryKey);
    if (existing && existing.action === "issued_or_updated") {
      return res.json({ ok: true, idempotent: true, id: existing.id, action: existing.action, license_key: existing.license_key });
    }

    try {
      const rules = loadRules(integration.id);
      const result = await processExtractedEvent({ integration, rules, extracted, rawPayload: body, txId });
      if (result.statusCode) {
        return res.status(result.statusCode).json(result);
      }
      return res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const id = recordIntegrationDelivery({
        integration,
        transactionId: txId,
        eventName: extracted.eventName || "error",
        extracted,
        action: "error",
        statusCategory: "error",
        httpStatus: 500,
        errorDetail: msg,
        rawPayload: body,
      });
      return res.status(500).json({ error: "webhook_processing_error", message: msg, id });
    }
  });

  return router;
}
