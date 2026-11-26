import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PainelVaultStore } from "./vault-store.js";
import { createAuthService } from "./auth-service.js";
import { buildLicenseEmailPayload, createEmailDispatcher } from "./email-dispatcher.js";
import { createWhatsAppDispatcher } from "./whatsapp-dispatcher.js";
import { createServerClaimsRouter } from "./server-claims.js";
import { createReleasesFeedRouter } from "./releases-feed.js";
import { ensureSchemaAndMigrations } from "./db-migrations.js";
import { createAnalyticsService } from "./analytics-service.js";
import { createLicenseAdminRouter } from "./license-admin-routes.js";
import { parseMoneyToCents, normalizePaymentMethod } from "./webhook-parsers.js";

export const PLAN_MATRIX = {
  individual: {
    plan_tier: "individual",
    nome_exibicao: "Licença Individual",
    max_servers: 2,
    max_machines: 2,
    prefix: "IND",
  },
  agencia_10: {
    plan_tier: "agencia_10",
    nome_exibicao: "Licença Agência 10",
    max_servers: 10,
    max_machines: 3,
    prefix: "AG10",
  },
  agencia_ilimitada: {
    plan_tier: "agencia_ilimitada",
    nome_exibicao: "Licença Agência Ilimitada",
    max_servers: -1,
    max_machines: 5,
    prefix: "AGIL",
  },
};

const VALID_UPGRADES = new Set(["bonus", "video"]);
const PLAN_RANK = { individual: 1, agencia_10: 2, agencia_ilimitada: 3 };
const GRACE_PERIOD_DAYS = 7;
const SELF_UNLINK_LIMIT_30D = 2;
const RETRY_BACKOFF_MINUTES = [2, 10, 30];

function sortValueRecursively(value) {
  if (Array.isArray(value)) return value.map((item) => sortValueRecursively(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = sortValueRecursively(value[key]);
    }
    return out;
  }
  return value;
}

export function canonicalizePayload(payload) {
  return JSON.stringify(sortValueRecursively(payload));
}

export function timingSafeEqualString(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function generateFormattedLicenseKey(planTier) {
  const prefix = PLAN_MATRIX[planTier]?.prefix || "IND";
  const block = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return `CRIA-${prefix}-${block()}-${block()}-${block()}`;
}

function normalizeUpgrades(upgrades) {
  if (!Array.isArray(upgrades)) return [];
  return Array.from(
    new Set(
      upgrades
        .map((item) => String(item || "").trim().toLowerCase())
        .filter((item) => VALID_UPGRADES.has(item)),
    ),
  );
}

function parseUpgradesJson(raw) {
  try {
    return normalizeUpgrades(JSON.parse(raw || "[]"));
  } catch {
    return [];
  }
}

function resolveSigningKeys({ privateKeyPem, publicKeyPem, dataDir }) {
  if (privateKeyPem && publicKeyPem) {
    return { privateKeyPem, publicKeyPem, keyId: "criativo-env-ed25519" };
  }
  const keyFile = path.join(dataDir, "license-keys.json");
  if (fs.existsSync(keyFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(keyFile, "utf8"));
      if (saved.privateKeyPem && saved.publicKeyPem) {
        return {
          privateKeyPem: saved.privateKeyPem,
          publicKeyPem: saved.publicKeyPem,
          keyId: saved.keyId || "criativo-local-ed25519",
        };
      }
    } catch {
      // Regenera abaixo
    }
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    keyFile,
    JSON.stringify({ publicKeyPem: publicKey, privateKeyPem: privateKey, keyId: "criativo-local-ed25519" }, null, 2),
    { mode: 0o600 },
  );
  return { privateKeyPem: privateKey, publicKeyPem: publicKey, keyId: "criativo-local-ed25519" };
}

function initDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  ensureSchemaAndMigrations(db);
  return db;
}

export function createLicenseHub(options = {}) {
  const dataDir = options.dataDir || path.resolve(process.cwd(), "dados");
  const dbPath = options.dbPath || path.join(dataDir, "painel.db");
  const adminToken = options.adminToken ?? process.env.CRIATIVO_ADMIN_TOKEN ?? "";
  const db = initDatabase(dbPath);
  const vault = new PainelVaultStore(db, { dataDir: path.dirname(dbPath), vaultKey: options.vaultKey });
  const auth = createAuthService({
    db,
    adminToken,
    sessionSecret: options.sessionSecret,
    adminEmail: options.adminEmail,
    adminPassword: options.adminPassword,
  });

  const keys = resolveSigningKeys({
    privateKeyPem: options.privateKeyPem ?? process.env.CRIATIVO_LICENSE_PRIVATE_KEY_PEM?.replace(/\\n/g, "\n"),
    publicKeyPem: options.publicKeyPem ?? process.env.CRIATIVO_LICENSE_PUBLIC_KEY_PEM?.replace(/\\n/g, "\n"),
    dataDir: path.dirname(dbPath),
  });

  function logNotification({ licenseId = null, licenseKey = null, channel, recipient, status, detail = "" }) {
    db.prepare(
      `INSERT INTO notification_logs (id, license_id, license_key, channel, recipient, status, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    ).run(
      crypto.randomUUID(),
      licenseId,
      licenseKey,
      channel,
      String(recipient || ""),
      status,
      String(detail || "").slice(0, 600),
      new Date().toISOString(),
    );
  }

  let releasesFeed = null;

  function resolveDynamicDownloadLinks() {
    const latest = releasesFeed?.getLatestRelease?.("stable");
    if (!latest || !Array.isArray(latest.artifacts) || latest.artifacts.length === 0) {
      return null;
    }
    const findUrl = (predicate) => {
      const hit = latest.artifacts.find((art) => art?.external_url && predicate(art));
      return hit?.external_url || null;
    };
    const windows = findUrl(
      (a) => a.platform === "win32" && String(a.filename || "").toLowerCase().endsWith(".exe"),
    );
    const macos =
      findUrl((a) => a.platform === "darwin" && String(a.filename || "").toLowerCase().endsWith(".dmg")) ||
      findUrl((a) => a.platform === "darwin" && String(a.filename || "").toLowerCase().endsWith(".zip"));
    const linux =
      findUrl((a) => a.platform === "linux" && String(a.filename || "").toLowerCase().endsWith(".appimage")) ||
      findUrl((a) => a.platform === "linux");
    if (!windows && !macos && !linux) return null;
    return { windows, macos, linux };
  }

  const emailDispatcher = createEmailDispatcher({
    vault,
    logNotification,
    fetchImpl: options.fetchImpl,
    transportFactory: options.emailTransportFactory,
    resolveDynamicDownloadLinks,
  });

  const whatsappDispatcher = createWhatsAppDispatcher({
    vault,
    logNotification,
    fetchImpl: options.fetchImpl,
  });

  const analyticsService = createAnalyticsService({
    db,
    vault,
    requireAdmin: auth.requireAdmin,
  });

  function signCertificate(licenseRow, machineId) {
    const now = new Date();
    const graceUntil = new Date(now.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
    const effectiveMaxMachines = licenseRow.custom_max_machines ?? licenseRow.max_machines;
    const payload = {
      version: 1,
      license_id: licenseRow.id,
      license_key: licenseRow.license_key,
      customer_email: licenseRow.customer_email,
      customer_name: licenseRow.customer_name || undefined,
      plan_tier: licenseRow.plan_tier,
      status: licenseRow.status,
      max_servers: licenseRow.max_servers,
      max_machines: effectiveMaxMachines,
      upgrades: parseUpgradesJson(licenseRow.upgrades_json),
      machine_id: machineId,
      issued_at: now.toISOString(),
      last_verified_at: now.toISOString(),
      grace_until: graceUntil.toISOString(),
      expires_at: licenseRow.expires_at ?? null,
    };
    const canonical = canonicalizePayload(payload);
    const signature = crypto.sign(null, Buffer.from(canonical, "utf8"), keys.privateKeyPem).toString("base64url");
    return { payload, signature, key_id: keys.keyId };
  }

  function listActiveDevices(licenseId, currentMachineId) {
    const rows = db
      .prepare(
        `SELECT machine_id, hostname, os_platform, app_version, first_activated_at, last_heartbeat_at
         FROM license_machines WHERE license_id = ? AND revoked_at IS NULL ORDER BY last_heartbeat_at DESC;`,
      )
      .all(licenseId);
    return rows.map((row) => ({ ...row, is_current_machine: currentMachineId ? row.machine_id === currentMachineId : false }));
  }

  function logEvent(licenseId, eventType, actor, details = {}) {
    db.prepare(
      `INSERT INTO license_events (id, license_id, event_type, actor, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?);`,
    ).run(crypto.randomUUID(), licenseId, eventType, actor, JSON.stringify(details), new Date().toISOString());
  }

  function findLicenseByKey(licenseKey) {
    const row = db
      .prepare(`SELECT * FROM licenses WHERE upper(license_key) = upper(?);`)
      .get(String(licenseKey || "").trim());
    if (!row) return null;
    return { ...row, upgrades: parseUpgradesJson(row.upgrades_json) };
  }

  function isLicenseExpired(row) {
    if (!row.expires_at) return false;
    const exp = Date.parse(row.expires_at);
    return Number.isFinite(exp) && Date.now() > exp;
  }

  function getPlanCatalog() {
    const overrides = vault.getSetting("plan_catalog_overrides", {}) || {};
    const out = {};
    for (const [tier, base] of Object.entries(PLAN_MATRIX)) {
      const ov = overrides[tier] && typeof overrides[tier] === "object" ? overrides[tier] : {};
      out[tier] = {
        ...base,
        nome_exibicao: String(ov.nome_exibicao || base.nome_exibicao),
        max_servers: Number.isInteger(Number(ov.max_servers)) ? Number(ov.max_servers) : base.max_servers,
        max_machines: Number.isInteger(Number(ov.max_machines)) && Number(ov.max_machines) > 0 ? Number(ov.max_machines) : base.max_machines,
        default_price_cents: Number.isFinite(Number(ov.default_price_cents)) ? Math.max(0, Math.round(Number(ov.default_price_cents))) : 0,
      };
    }
    return out;
  }

  function savePlanCatalog(input = {}) {
    const current = vault.getSetting("plan_catalog_overrides", {}) || {};
    const next = { ...current };
    for (const tier of Object.keys(PLAN_MATRIX)) {
      if (input[tier] && typeof input[tier] === "object") {
        const src = input[tier];
        next[tier] = {
          nome_exibicao: String(src.nome_exibicao || PLAN_MATRIX[tier].nome_exibicao).trim(),
          max_servers: Number.isInteger(Number(src.max_servers)) ? Number(src.max_servers) : PLAN_MATRIX[tier].max_servers,
          max_machines: Number.isInteger(Number(src.max_machines)) && Number(src.max_machines) > 0 ? Number(src.max_machines) : PLAN_MATRIX[tier].max_machines,
          default_price_cents: Math.max(0, Math.round(Number(src.default_price_cents) || 0)),
        };
      }
    }
    vault.setSetting("plan_catalog_overrides", next);
    return getPlanCatalog();
  }

  function resolveExpiresAt(existingExpiresAt, explicitExpiresAt, durationDays) {
    if (explicitExpiresAt) return explicitExpiresAt;
    const days = Number(durationDays);
    if (!Number.isFinite(days) || days <= 0) return existingExpiresAt || null;
    const nowMs = Date.now();
    const existingMs = existingExpiresAt ? Date.parse(existingExpiresAt) : NaN;
    const baseMs = Number.isFinite(existingMs) && existingMs > nowMs ? existingMs : nowMs;
    return new Date(baseMs + Math.round(days) * 24 * 60 * 60 * 1000).toISOString();
  }

  function recordLicenseTransaction({
    licenseId,
    provider,
    integrationId = null,
    transactionId = "",
    productId = null,
    offerName = null,
    grantType = "plan",
    planTier = null,
    upgrades = [],
    amountCents = 0,
    currency = "BRL",
  }) {
    const txId = String(transactionId || `tx_${crypto.randomBytes(6).toString("hex")}`);
    db.prepare(
      `INSERT INTO license_transactions (
        id, license_id, provider, integration_id, transaction_id, product_id, offer_name,
        grant_type, plan_tier, upgrades_json, amount_cents, currency, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?);`,
    ).run(
      `ltx_${crypto.randomBytes(8).toString("hex")}`,
      licenseId,
      String(provider || "manual"),
      integrationId || null,
      txId,
      productId ? String(productId) : null,
      offerName ? String(offerName) : null,
      grantType,
      planTier || null,
      JSON.stringify(normalizeUpgrades(upgrades)),
      Math.max(0, Math.round(Number(amountCents) || 0)),
      String(currency || "BRL").toUpperCase(),
      new Date().toISOString(),
    );
  }

  function issueOrUpdateLicenseFromSale({
    email,
    customerName = "",
    customerPhone = "",
    planTier = "individual",
    addUpgrades = [],
    expiresAt = null,
    durationDays = null,
    ruleAction = "grant_plan",
    provider = "manual",
    integrationId = null,
    transactionId = "",
    productId = null,
    offerName = null,
    isRenewal = false,
    forceNew = false,
    amountCents = 0,
    currency = "BRL",
    paymentMethod = null,
    sourceProvider = null,
    isSimulated = false,
    notes = null,
  }) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (!cleanEmail) throw new Error("E-mail do comprador é obrigatório.");
    const cleanPhone = String(customerPhone || "").trim();
    const catalog = getPlanCatalog();
    const safePlan = catalog[planTier] ? planTier : "individual";
    const planMeta = catalog[safePlan];
    const normalizedNewUpgrades = normalizeUpgrades(addUpgrades);
    const nowIso = new Date().toISOString();
    const safeAmountCents = Math.max(0, Math.round(Number(amountCents) || 0));
    const safeCurrency = String(currency || "BRL").toUpperCase();
    const safeProvider = sourceProvider || (provider === "admin" ? "manual" : provider) || "manual";
    const simInt = isSimulated ? 1 : 0;
    const shouldForceNew = Boolean(forceNew) || ruleAction === "create_new_license";

    const existing = shouldForceNew
      ? null
      : db
          .prepare(
            `SELECT * FROM licenses WHERE lower(customer_email) = ? AND status IN ('active', 'suspended')
             ORDER BY created_at DESC LIMIT 1;`,
          )
          .get(cleanEmail);

    if (existing) {
      const existingUpgrades = parseUpgradesJson(existing.upgrades_json);
      const mergedUpgrades = Array.from(new Set([...existingUpgrades, ...normalizedNewUpgrades]));
      const existingRank = PLAN_RANK[existing.plan_tier] || 1;
      const incomingRank = PLAN_RANK[safePlan] || 1;
      // Nunca faz downgrade automático em recompra; add_upgrades_only preserva plano atual
      const nextPlan =
        ruleAction === "add_upgrades_only"
          ? existing.plan_tier
          : incomingRank > existingRank
            ? safePlan
            : existing.plan_tier;
      const nextMeta = catalog[nextPlan] || PLAN_MATRIX[nextPlan] || PLAN_MATRIX.individual;
      const nextSim = existing.is_simulated === 0 ? 0 : simInt;
      const nextExpiresAt = resolveExpiresAt(existing.expires_at, expiresAt, durationDays);
      const deliveryToken = existing.delivery_token || crypto.randomBytes(16).toString("hex");

      db.prepare(
        `UPDATE licenses
         SET plan_tier = ?, max_servers = ?, max_machines = ?, upgrades_json = ?,
             customer_name = COALESCE(NULLIF(?, ''), customer_name),
             customer_phone = COALESCE(NULLIF(?, ''), customer_phone),
             status = 'active', expires_at = ?,
             amount_cents = CASE WHEN ? > 0 THEN ? ELSE COALESCE(amount_cents, 0) END,
             currency = COALESCE(NULLIF(?, ''), currency),
             payment_method = COALESCE(?, payment_method),
             source_provider = COALESCE(NULLIF(?, ''), source_provider),
             is_simulated = ?,
             notes = COALESCE(?, notes),
             delivery_token = ?,
             updated_at = ?
         WHERE id = ?;`,
      ).run(
        nextPlan,
        nextMeta.max_servers,
        nextMeta.max_machines,
        JSON.stringify(mergedUpgrades),
        customerName || "",
        cleanPhone,
        nextExpiresAt,
        safeAmountCents,
        safeAmountCents,
        safeCurrency,
        paymentMethod,
        safeProvider,
        nextSim,
        notes,
        deliveryToken,
        nowIso,
        existing.id,
      );

      const grantType = ruleAction === "add_upgrades_only" ? "upgrade" : isRenewal ? "renewal" : "plan";
      recordLicenseTransaction({
        licenseId: existing.id,
        provider: safeProvider,
        integrationId,
        transactionId,
        productId,
        offerName,
        grantType,
        planTier: grantType === "upgrade" ? null : nextPlan,
        upgrades: normalizedNewUpgrades,
        amountCents: safeAmountCents,
        currency: safeCurrency,
      });

      const eventType =
        grantType === "upgrade"
          ? "upgrade_added"
          : grantType === "renewal"
            ? "subscription_renewed"
            : "sale_updated";
      logEvent(existing.id, eventType, provider, { transactionId, addUpgrades: normalizedNewUpgrades, nextPlan });
      const updated = findLicenseByKey(existing.license_key);
      return { ...updated, _deliveryEventType: eventType };
    }

    const id = `lic_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const licenseKey = generateFormattedLicenseKey(safePlan);
    const deliveryToken = crypto.randomBytes(16).toString("hex");
    const initialExpiresAt = resolveExpiresAt(null, expiresAt, durationDays);

    db.prepare(
      `INSERT INTO licenses (
        id, license_key, customer_email, customer_name, customer_phone, plan_tier, status,
        max_servers, max_machines, custom_max_machines, upgrades_json, expires_at,
        amount_cents, currency, payment_method, source_provider, is_simulated, notes, delivery_token, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    ).run(
      id,
      licenseKey,
      cleanEmail,
      customerName || null,
      cleanPhone || null,
      safePlan,
      planMeta.max_servers,
      planMeta.max_machines,
      JSON.stringify(normalizedNewUpgrades),
      initialExpiresAt,
      safeAmountCents,
      safeCurrency,
      paymentMethod,
      safeProvider,
      simInt,
      notes,
      deliveryToken,
      nowIso,
      nowIso,
    );

    recordLicenseTransaction({
      licenseId: id,
      provider: safeProvider,
      integrationId,
      transactionId,
      productId,
      offerName,
      grantType: "plan",
      planTier: safePlan,
      upgrades: normalizedNewUpgrades,
      amountCents: safeAmountCents,
      currency: safeCurrency,
    });

    logEvent(id, "license_issued", provider, { transactionId, planTier: safePlan, upgrades: normalizedNewUpgrades });
    const created = findLicenseByKey(licenseKey);
    return { ...created, _deliveryEventType: "license_issued" };
  }

  function revokeLicenseByEmailOrKey({
    licenseKey,
    email,
    reason = "refund",
    actor = "webhook",
    transactionId = "",
    productId = "",
    provider = "",
  }) {
    let target = licenseKey ? findLicenseByKey(licenseKey) : null;
    if (!target && transactionId) {
      const txRow = db
        .prepare(
          `SELECT l.license_key FROM license_transactions lt
           JOIN licenses l ON l.id = lt.license_id
           WHERE lt.transaction_id = ? ${provider ? "AND lt.provider = ?" : ""}
           ORDER BY lt.created_at DESC LIMIT 1;`,
        )
        .get(...(provider ? [String(transactionId), String(provider)] : [String(transactionId)]));
      if (txRow?.license_key) target = findLicenseByKey(txRow.license_key);
    }
    if (!target && email) {
      const row = db
        .prepare(`SELECT * FROM licenses WHERE lower(customer_email) = ? ORDER BY created_at DESC LIMIT 1;`)
        .get(String(email).trim().toLowerCase());
      target = row ? findLicenseByKey(row.license_key) : null;
    }
    if (!target) return null;

    const nowIso = new Date().toISOString();

    // Tenta revogação granular se encontrarmos uma transação específica de upgrade
    let matchedTx = null;
    if (transactionId) {
      matchedTx = db
        .prepare(`SELECT * FROM license_transactions WHERE license_id = ? AND transaction_id = ? AND status = 'active' LIMIT 1;`)
        .get(target.id, String(transactionId));
    }
    if (!matchedTx && productId) {
      matchedTx = db
        .prepare(
          `SELECT * FROM license_transactions
           WHERE license_id = ? AND status = 'active' AND lower(COALESCE(product_id, '')) = lower(?)
           ORDER BY created_at DESC LIMIT 1;`,
        )
        .get(target.id, String(productId));
    }

    if (matchedTx && matchedTx.grant_type === "upgrade") {
      db.prepare(`UPDATE license_transactions SET status = 'revoked', revoked_at = ? WHERE id = ?;`).run(nowIso, matchedTx.id);
      const txUpgrades = parseUpgradesJson(matchedTx.upgrades_json);
      const stillActiveRows = db
        .prepare(`SELECT upgrades_json FROM license_transactions WHERE license_id = ? AND status = 'active';`)
        .all(target.id);
      const activeUpgradeSet = new Set();
      for (const r of stillActiveRows) {
        for (const u of parseUpgradesJson(r.upgrades_json)) activeUpgradeSet.add(u);
      }
      const nextUpgrades = target.upgrades.filter((u) => !txUpgrades.includes(u) || activeUpgradeSet.has(u));
      db.prepare(`UPDATE licenses SET upgrades_json = ?, updated_at = ? WHERE id = ?;`).run(
        JSON.stringify(nextUpgrades),
        nowIso,
        target.id,
      );
      logEvent(target.id, "upgrade_revoked", actor, { reason, transactionId: matchedTx.transaction_id, upgrades: txUpgrades });
      const updated = findLicenseByKey(target.license_key);
      return { ...updated, _revocationScope: "upgrade", _revokedUpgrades: txUpgrades };
    }

    if (matchedTx) {
      db.prepare(`UPDATE license_transactions SET status = 'revoked', revoked_at = ? WHERE id = ?;`).run(nowIso, matchedTx.id);
    } else {
      db.prepare(`UPDATE license_transactions SET status = 'revoked', revoked_at = ? WHERE license_id = ? AND status = 'active';`).run(
        nowIso,
        target.id,
      );
    }

    db.prepare(`UPDATE licenses SET status = 'revoked', updated_at = ? WHERE id = ?;`).run(nowIso, target.id);
    logEvent(target.id, "license_revoked", actor, { reason, transactionId: transactionId || undefined });
    const updated = findLicenseByKey(target.license_key);
    return { ...updated, _revocationScope: "license" };
  }

  function enqueueNotificationRetry({ license, channel, recipient, eventType, errorDetail }) {
    const now = Date.now();
    const nextRetry = new Date(now + RETRY_BACKOFF_MINUTES[0] * 60 * 1000).toISOString();
    const nowIso = new Date(now).toISOString();
    db.prepare(
      `INSERT INTO notification_queue (
        id, license_id, license_key, channel, event_type, recipient, payload_json,
        attempts, max_attempts, status, next_retry_at, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 3, 'pending', ?, ?, ?, ?);`,
    ).run(
      `nq_${crypto.randomBytes(8).toString("hex")}`,
      license.id || null,
      license.license_key || null,
      channel,
      eventType || "license_issued",
      String(recipient || ""),
      JSON.stringify({ licenseKey: license.license_key, customerEmail: license.customer_email, customerPhone: license.customer_phone }),
      nextRetry,
      String(errorDetail || "").slice(0, 500),
      nowIso,
      nowIso,
    );
  }

  function updateLicenseDeliveryStatus(licenseId, results) {
    if (!licenseId || String(licenseId).startsWith("lic_test")) return;
    const nowIso = new Date().toISOString();
    const updates = [];
    const params = [];
    if (results.email?.status) {
      updates.push("last_email_status = ?");
      params.push(results.email.status);
    }
    if (results.whatsapp?.status) {
      updates.push("last_whatsapp_status = ?");
      params.push(results.whatsapp.status);
    }
    if (updates.length > 0) {
      updates.push("last_delivery_at = ?");
      params.push(nowIso, licenseId);
      db.prepare(`UPDATE licenses SET ${updates.join(", ")} WHERE id = ?;`).run(...params);
    }
  }

  async function dispatchLicenseNotifications(
    license,
    { sendEmail = true, sendWhatsApp = true, eventType = "license_issued", enqueueOnFailure = true } = {},
  ) {
    const effectiveEventType = license._deliveryEventType || eventType;
    const results = { email: null, whatsapp: null };
    if (sendEmail && license.customer_email) {
      results.email = await emailDispatcher.sendLicenseEmail(license, { eventType: effectiveEventType });
      if (enqueueOnFailure && results.email?.status === "error") {
        enqueueNotificationRetry({
          license,
          channel: "email",
          recipient: license.customer_email,
          eventType: effectiveEventType,
          errorDetail: results.email.error,
        });
      }
    }
    if (sendWhatsApp && license.customer_phone) {
      results.whatsapp = await whatsappDispatcher.sendLicenseWhatsApp(license, { eventType: effectiveEventType });
      if (enqueueOnFailure && results.whatsapp?.status === "error") {
        enqueueNotificationRetry({
          license,
          channel: "whatsapp",
          recipient: license.customer_phone,
          eventType: effectiveEventType,
          errorDetail: results.whatsapp.error,
        });
      }
    }
    updateLicenseDeliveryStatus(license.id, results);
    return results;
  }

  async function processNotificationQueue({ forceNow = false } = {}) {
    const nowIso = new Date().toISOString();
    const dueRows = forceNow
      ? db.prepare(`SELECT * FROM notification_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 25;`).all()
      : db
          .prepare(`SELECT * FROM notification_queue WHERE status = 'pending' AND next_retry_at <= ? ORDER BY next_retry_at ASC LIMIT 25;`)
          .all(nowIso);

    const summary = { processed: 0, sent: 0, rescheduled: 0, failed: 0 };
    for (const item of dueRows) {
      summary.processed += 1;
      const lic = item.license_key ? findLicenseByKey(item.license_key) : null;
      if (!lic) {
        db.prepare(`UPDATE notification_queue SET status = 'failed', last_error = 'Licença não encontrada', updated_at = ? WHERE id = ?;`).run(
          nowIso,
          item.id,
        );
        summary.failed += 1;
        continue;
      }
      const res =
        item.channel === "whatsapp"
          ? await whatsappDispatcher.sendLicenseWhatsApp(lic, { eventType: item.event_type })
          : await emailDispatcher.sendLicenseEmail(lic, { eventType: item.event_type });

      updateLicenseDeliveryStatus(lic.id, { [item.channel]: res });

      if (res?.ok) {
        db.prepare(`UPDATE notification_queue SET status = 'sent', updated_at = ? WHERE id = ?;`).run(new Date().toISOString(), item.id);
        summary.sent += 1;
      } else {
        const nextAttempts = Number(item.attempts || 0) + 1;
        const maxAttempts = Number(item.max_attempts || 3);
        const isTerminal = nextAttempts >= maxAttempts || res?.status === "skipped";
        const waitMin = RETRY_BACKOFF_MINUTES[Math.min(RETRY_BACKOFF_MINUTES.length - 1, nextAttempts)] || 30;
        const nextRetryAt = new Date(Date.now() + waitMin * 60 * 1000).toISOString();
        db.prepare(
          `UPDATE notification_queue
           SET attempts = ?, status = ?, next_retry_at = ?, last_error = ?, updated_at = ?
           WHERE id = ?;`,
        ).run(
          nextAttempts,
          isTerminal ? "failed" : "pending",
          nextRetryAt,
          String(res?.error || "Falha no reenvio").slice(0, 500),
          new Date().toISOString(),
          item.id,
        );
        if (isTerminal) summary.failed += 1;
        else summary.rescheduled += 1;
      }
    }
    return summary;
  }

  let retryTimer = null;
  if (options.enableNotificationRetryWorker !== false) {
    retryTimer = setInterval(() => {
      void processNotificationQueue().catch(() => {});
    }, 60 * 1000);
    retryTimer.unref?.();
  }

  const router = express.Router();

  router.post("/auth/login", (req, res) => {
    const { email, password } = req.body || {};
    const clientIp = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
    const result = auth.authenticateCredentials(email, password, clientIp);
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    auth.setSessionCookie(res, result.token, req);
    return res.json({ ok: true, user: result.user });
  });

  router.post("/auth/logout", (_req, res) => {
    auth.clearSessionCookie(res);
    return res.json({ ok: true });
  });

  router.get("/auth/session", (req, res) => {
    const session = auth.getSessionFromRequest(req);
    if (!session) return res.json({ authenticated: false });
    return res.json({ authenticated: true, user: { email: session.email, name: session.name } });
  });

  router.post("/auth/change-password", auth.requireAdmin, (req, res) => {
    const { current_password, new_password } = req.body || {};
    const r = auth.updatePassword(req.adminSession.email, current_password, new_password);
    if (!r.ok) return res.status(400).json(r);
    return res.json({ ok: true, message: "Senha alterada com sucesso." });
  });

  router.get("/licenses/public-key", (_req, res) => {
    res.json({ key_id: keys.keyId, public_key_pem: keys.publicKeyPem });
  });

  router.post("/licenses/activate", (req, res) => {
    const { license_key, email, machine_id, hostname = "computador", os_platform = "unknown", app_version = "1.0.0" } =
      req.body || {};
    if (!license_key || !email || !machine_id) {
      return res.status(400).json({ error: "missing_fields", message: "Chave de licença, e-mail e machine_id são obrigatórios." });
    }
    const row = findLicenseByKey(license_key);
    if (!row || row.customer_email.toLowerCase() !== String(email).trim().toLowerCase()) {
      return res.status(404).json({ error: "invalid_credentials", message: "Chave de licença ou e-mail não encontrado." });
    }
    if (row.status === "revoked" || row.status === "suspended") {
      return res.status(403).json({ error: "revoked", message: "Esta licença foi revogada ou suspensa." });
    }
    if (row.status === "expired" || isLicenseExpired(row)) {
      return res.status(403).json({ error: "expired", message: "A vigência desta licença expirou." });
    }

    const nowIso = new Date().toISOString();
    const existingMachine = db.prepare(`SELECT * FROM license_machines WHERE license_id = ? AND machine_id = ?;`).get(row.id, machine_id);
    const activeDevices = listActiveDevices(row.id, machine_id);
    const maxMachines = row.custom_max_machines ?? row.max_machines;

    if (!existingMachine || existingMachine.revoked_at !== null) {
      if (activeDevices.length >= maxMachines) {
        return res.status(403).json({
          error: "machine_limit",
          message: `Limite de ${maxMachines} computador(es) atingido para o plano ${PLAN_MATRIX[row.plan_tier]?.nome_exibicao || row.plan_tier}. Desvincule um dispositivo antigo para ativar este.`,
          max_machines: maxMachines,
          active_machines: activeDevices,
        });
      }
      if (existingMachine) {
        db.prepare(
          `UPDATE license_machines SET revoked_at = NULL, hostname = ?, os_platform = ?, app_version = ?, last_heartbeat_at = ? WHERE id = ?;`,
        ).run(String(hostname), String(os_platform), String(app_version), nowIso, existingMachine.id);
      } else {
        db.prepare(
          `INSERT INTO license_machines (id, license_id, machine_id, hostname, os_platform, app_version, first_activated_at, last_heartbeat_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL);`,
        ).run(crypto.randomUUID(), row.id, String(machine_id), String(hostname), String(os_platform), String(app_version), nowIso, nowIso);
      }
      logEvent(row.id, "machine_activated", "client", { machine_id, hostname, os_platform });
    } else {
      db.prepare(`UPDATE license_machines SET hostname = ?, os_platform = ?, app_version = ?, last_heartbeat_at = ? WHERE id = ?;`).run(
        String(hostname), String(os_platform), String(app_version), nowIso, existingMachine.id,
      );
    }
    return res.json({ ok: true, certificate: signCertificate(row, String(machine_id)), devices: listActiveDevices(row.id, String(machine_id)) });
  });

  router.post("/licenses/heartbeat", (req, res) => {
    const { license_key, machine_id, app_version } = req.body || {};
    if (!license_key || !machine_id) return res.status(400).json({ error: "missing_fields" });
    const row = findLicenseByKey(license_key);
    if (!row) return res.status(404).json({ error: "not_found" });
    if (row.status === "revoked" || row.status === "suspended") return res.status(403).json({ error: "revoked", message: "Licença revogada." });
    if (row.status === "expired" || isLicenseExpired(row)) return res.status(403).json({ error: "expired", message: "Licença expirada." });

    const device = db.prepare(`SELECT * FROM license_machines WHERE license_id = ? AND machine_id = ? AND revoked_at IS NULL;`).get(row.id, String(machine_id));
    if (!device) return res.status(403).json({ error: "machine_unlinked", message: "Este dispositivo foi desvinculado da licença." });

    db.prepare(`UPDATE license_machines SET last_heartbeat_at = ?, app_version = COALESCE(?, app_version) WHERE id = ?;`).run(
      new Date().toISOString(), app_version ? String(app_version) : null, device.id,
    );
    return res.json({ ok: true, certificate: signCertificate(row, String(machine_id)), devices: listActiveDevices(row.id, String(machine_id)) });
  });

  router.post("/licenses/deactivate", (req, res) => {
    const { license_key, email, target_machine_id } = req.body || {};
    if (!license_key || !email || !target_machine_id) return res.status(400).json({ error: "missing_fields" });
    const row = findLicenseByKey(license_key);
    if (!row || row.customer_email.toLowerCase() !== String(email).trim().toLowerCase()) {
      return res.status(404).json({ error: "invalid_credentials" });
    }
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const unlinkCount = db.prepare(`SELECT COUNT(*) AS total FROM license_events WHERE license_id = ? AND event_type = 'device_deactivated' AND actor = 'client' AND created_at >= ?;`).get(row.id, since30d)?.total || 0;
    if (Number(unlinkCount) >= SELF_UNLINK_LIMIT_30D) {
      return res.status(429).json({ error: "unlink_limit_reached", message: "Limite mensal de 2 trocas self-service de computador atingido. Contate o suporte." });
    }
    const result = db.prepare(`UPDATE license_machines SET revoked_at = ? WHERE license_id = ? AND machine_id = ? AND revoked_at IS NULL;`).run(
      new Date().toISOString(), row.id, String(target_machine_id),
    );
    if (result.changes > 0) logEvent(row.id, "device_deactivated", "client", { target_machine_id });
    return res.json({ ok: true, removed: result.changes > 0, devices: listActiveDevices(row.id) });
  });

  router.use(
    createLicenseAdminRouter({
      db, keys, emailDispatcher, whatsappDispatcher, analyticsService, PLAN_MATRIX, getPlanCatalog, savePlanCatalog,
      processNotificationQueue, parseUpgradesJson, normalizeUpgrades,
      listActiveDevices, findLicenseByKey, logEvent, issueOrUpdateLicenseFromSale, revokeLicenseByEmailOrKey,
      dispatchLicenseNotifications, buildLicenseEmailPayload, parseMoneyToCents, normalizePaymentMethod, requireAdmin: auth.requireAdmin,
    }),
  );
  router.use(analyticsService.router);

  const hubApi = {
    router, db, vault, auth, keys, emailDispatcher, whatsappDispatcher, analyticsService,
    logNotification, dispatchLicenseNotifications, processNotificationQueue, getPlanCatalog, savePlanCatalog,
    findLicenseByKey, listActiveDevices, signCertificate,
    issueOrUpdateLicenseFromSale, revokeLicenseByEmailOrKey, requireAdmin: auth.requireAdmin,
    close: () => {
      if (retryTimer) clearInterval(retryTimer);
      db.close();
    },
  };

  router.use(createServerClaimsRouter(hubApi));
  releasesFeed = createReleasesFeedRouter(hubApi, options);
  router.use(releasesFeed.router);
  hubApi.publishRelease = releasesFeed.publishRelease;
  hubApi.getLatestRelease = releasesFeed.getLatestRelease;
  hubApi.syncLatestReleaseFromGithub = releasesFeed.syncLatestFromGithub;

  return hubApi;
}
