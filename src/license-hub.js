import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PainelVaultStore } from "./vault-store.js";
import { createAuthService } from "./auth-service.js";
import { createEmailDispatcher } from "./email-dispatcher.js";
import { createWhatsAppDispatcher } from "./whatsapp-dispatcher.js";
import { createServerClaimsRouter } from "./server-claims.js";
import { createReleasesFeedRouter } from "./releases-feed.js";

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
const GRACE_PERIOD_DAYS = 7;
const SELF_UNLINK_LIMIT_30D = 2;

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
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS painel_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      is_secret INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS licenses (
      id TEXT PRIMARY KEY,
      license_key TEXT NOT NULL UNIQUE,
      customer_email TEXT NOT NULL,
      customer_name TEXT,
      customer_phone TEXT,
      plan_tier TEXT NOT NULL CHECK(plan_tier IN ('individual', 'agencia_10', 'agencia_ilimitada')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'revoked', 'expired')),
      max_servers INTEGER NOT NULL,
      max_machines INTEGER NOT NULL,
      custom_max_machines INTEGER,
      upgrades_json TEXT NOT NULL DEFAULT '[]',
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_licenses_email ON licenses(lower(customer_email));

    CREATE TABLE IF NOT EXISTS license_machines (
      id TEXT PRIMARY KEY,
      license_id TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
      machine_id TEXT NOT NULL,
      hostname TEXT NOT NULL,
      os_platform TEXT NOT NULL,
      app_version TEXT,
      first_activated_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      revoked_at TEXT,
      UNIQUE(license_id, machine_id)
    );

    CREATE INDEX IF NOT EXISTS idx_license_machines_active ON license_machines(license_id, revoked_at);

    CREATE TABLE IF NOT EXISTS license_events (
      id TEXT PRIMARY KEY,
      license_id TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_license_events_type_date ON license_events(license_id, event_type, created_at);

    CREATE TABLE IF NOT EXISTS sales_webhook_deliveries (
      delivery_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      transaction_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      buyer_email TEXT,
      buyer_phone TEXT,
      action TEXT,
      license_key TEXT,
      summary_json TEXT,
      processed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notification_logs (
      id TEXT PRIMARY KEY,
      license_id TEXT,
      license_key TEXT,
      channel TEXT NOT NULL CHECK(channel IN ('email', 'whatsapp')),
      recipient TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('sent', 'error', 'skipped')),
      detail TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notification_logs_created ON notification_logs(created_at DESC);
  `);
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

  const emailDispatcher = createEmailDispatcher({
    vault,
    logNotification,
    fetchImpl: options.fetchImpl,
    transportFactory: options.emailTransportFactory,
  });

  const whatsappDispatcher = createWhatsAppDispatcher({
    vault,
    logNotification,
    fetchImpl: options.fetchImpl,
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
    const signature = crypto
      .sign(null, Buffer.from(canonical, "utf8"), keys.privateKeyPem)
      .toString("base64url");
    return { payload, signature, key_id: keys.keyId };
  }

  function listActiveDevices(licenseId, currentMachineId) {
    const rows = db
      .prepare(
        `SELECT machine_id, hostname, os_platform, app_version, first_activated_at, last_heartbeat_at
         FROM license_machines
         WHERE license_id = ? AND revoked_at IS NULL
         ORDER BY last_heartbeat_at DESC;`,
      )
      .all(licenseId);
    return rows.map((row) => ({
      ...row,
      is_current_machine: currentMachineId ? row.machine_id === currentMachineId : false,
    }));
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

  function issueOrUpdateLicenseFromSale({
    email,
    customerName = "",
    customerPhone = "",
    planTier = "individual",
    addUpgrades = [],
    expiresAt = null,
    provider = "manual",
    transactionId = "",
    forceNew = false,
  }) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (!cleanEmail) throw new Error("E-mail do comprador é obrigatório.");
    const cleanPhone = String(customerPhone || "").trim();
    const safePlan = PLAN_MATRIX[planTier] ? planTier : "individual";
    const planMeta = PLAN_MATRIX[safePlan];
    const normalizedNewUpgrades = normalizeUpgrades(addUpgrades);
    const nowIso = new Date().toISOString();

    const existing = forceNew
      ? null
      : db
          .prepare(
            `SELECT * FROM licenses WHERE lower(customer_email) = ? AND status IN ('active', 'suspended')
             ORDER BY created_at DESC LIMIT 1;`,
          )
          .get(cleanEmail);

    if (existing) {
      const mergedUpgrades = Array.from(
        new Set([...parseUpgradesJson(existing.upgrades_json), ...normalizedNewUpgrades]),
      );
      const nextPlan = PLAN_MATRIX[planTier] && planTier !== "individual" ? planTier : existing.plan_tier;
      const nextMeta = PLAN_MATRIX[nextPlan];
      db.prepare(
        `UPDATE licenses
         SET plan_tier = ?, max_servers = ?, max_machines = ?, upgrades_json = ?,
             customer_name = COALESCE(NULLIF(?, ''), customer_name),
             customer_phone = COALESCE(NULLIF(?, ''), customer_phone),
             status = 'active', expires_at = COALESCE(?, expires_at), updated_at = ?
         WHERE id = ?;`,
      ).run(
        nextPlan,
        nextMeta.max_servers,
        nextMeta.max_machines,
        JSON.stringify(mergedUpgrades),
        customerName || "",
        cleanPhone,
        expiresAt,
        nowIso,
        existing.id,
      );
      logEvent(existing.id, "sale_updated", provider, { transactionId, addUpgrades: normalizedNewUpgrades, nextPlan });
      return findLicenseByKey(existing.license_key);
    }

    const id = `lic_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const licenseKey = generateFormattedLicenseKey(safePlan);
    db.prepare(
      `INSERT INTO licenses (
        id, license_key, customer_email, customer_name, customer_phone, plan_tier, status,
        max_servers, max_machines, custom_max_machines, upgrades_json, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?, ?, ?);`,
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
      expiresAt,
      nowIso,
      nowIso,
    );
    logEvent(id, "license_issued", provider, { transactionId, planTier: safePlan, upgrades: normalizedNewUpgrades });
    return findLicenseByKey(licenseKey);
  }

  function revokeLicenseByEmailOrKey({ licenseKey, email, reason = "refund", actor = "webhook" }) {
    let target = licenseKey ? findLicenseByKey(licenseKey) : null;
    if (!target && email) {
      const row = db
        .prepare(`SELECT * FROM licenses WHERE lower(customer_email) = ? ORDER BY created_at DESC LIMIT 1;`)
        .get(String(email).trim().toLowerCase());
      target = row ? findLicenseByKey(row.license_key) : null;
    }
    if (!target) return null;
    const nowIso = new Date().toISOString();
    db.prepare(`UPDATE licenses SET status = 'revoked', updated_at = ? WHERE id = ?;`).run(nowIso, target.id);
    logEvent(target.id, "license_revoked", actor, { reason });
    return findLicenseByKey(target.license_key);
  }

  async function dispatchLicenseNotifications(license, { sendEmail = true, sendWhatsApp = true } = {}) {
    const results = { email: null, whatsapp: null };
    if (sendEmail && license.customer_email) {
      results.email = await emailDispatcher.sendLicenseEmail(license);
    }
    if (sendWhatsApp && license.customer_phone) {
      results.whatsapp = await whatsappDispatcher.sendLicenseWhatsApp(license);
    }
    return results;
  }

  const router = express.Router();

  // ─── Autenticação Web do Painel ────────────────────────────────────────────
  router.post("/auth/login", (req, res) => {
    const { email, password } = req.body || {};
    const clientIp = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
    const result = auth.authenticateCredentials(email, password, clientIp);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, message: result.message });
    }
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

  // ─── API Pública de Licenças (consumida pelos Apps Desktop/VPS dos clientes)
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
    const existingMachine = db
      .prepare(`SELECT * FROM license_machines WHERE license_id = ? AND machine_id = ?;`)
      .get(row.id, machine_id);

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
          `UPDATE license_machines
           SET revoked_at = NULL, hostname = ?, os_platform = ?, app_version = ?, last_heartbeat_at = ?
           WHERE id = ?;`,
        ).run(String(hostname), String(os_platform), String(app_version), nowIso, existingMachine.id);
      } else {
        db.prepare(
          `INSERT INTO license_machines (
            id, license_id, machine_id, hostname, os_platform, app_version, first_activated_at, last_heartbeat_at, revoked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL);`,
        ).run(
          crypto.randomUUID(),
          row.id,
          String(machine_id),
          String(hostname),
          String(os_platform),
          String(app_version),
          nowIso,
          nowIso,
        );
      }
      logEvent(row.id, "machine_activated", "client", { machine_id, hostname, os_platform });
    } else {
      db.prepare(
        `UPDATE license_machines SET hostname = ?, os_platform = ?, app_version = ?, last_heartbeat_at = ? WHERE id = ?;`,
      ).run(String(hostname), String(os_platform), String(app_version), nowIso, existingMachine.id);
    }

    const certificate = signCertificate(row, String(machine_id));
    const devices = listActiveDevices(row.id, String(machine_id));
    return res.json({ ok: true, certificate, devices });
  });

  router.post("/licenses/heartbeat", (req, res) => {
    const { license_key, machine_id, app_version } = req.body || {};
    if (!license_key || !machine_id) return res.status(400).json({ error: "missing_fields" });

    const row = findLicenseByKey(license_key);
    if (!row) return res.status(404).json({ error: "not_found" });
    if (row.status === "revoked" || row.status === "suspended") {
      return res.status(403).json({ error: "revoked", message: "Licença revogada." });
    }
    if (row.status === "expired" || isLicenseExpired(row)) {
      return res.status(403).json({ error: "expired", message: "Licença expirada." });
    }

    const device = db
      .prepare(`SELECT * FROM license_machines WHERE license_id = ? AND machine_id = ? AND revoked_at IS NULL;`)
      .get(row.id, String(machine_id));
    if (!device) {
      return res.status(403).json({ error: "machine_unlinked", message: "Este dispositivo foi desvinculado da licença." });
    }

    const nowIso = new Date().toISOString();
    db.prepare(`UPDATE license_machines SET last_heartbeat_at = ?, app_version = COALESCE(?, app_version) WHERE id = ?;`).run(
      nowIso,
      app_version ? String(app_version) : null,
      device.id,
    );

    const certificate = signCertificate(row, String(machine_id));
    const devices = listActiveDevices(row.id, String(machine_id));
    return res.json({ ok: true, certificate, devices });
  });

  router.post("/licenses/deactivate", (req, res) => {
    const { license_key, email, target_machine_id } = req.body || {};
    if (!license_key || !email || !target_machine_id) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const row = findLicenseByKey(license_key);
    if (!row || row.customer_email.toLowerCase() !== String(email).trim().toLowerCase()) {
      return res.status(404).json({ error: "invalid_credentials" });
    }

    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const unlinkCountRow = db
      .prepare(
        `SELECT COUNT(*) AS total FROM license_events
         WHERE license_id = ? AND event_type = 'device_deactivated' AND actor = 'client' AND created_at >= ?;`,
      )
      .get(row.id, since30d);

    if (Number(unlinkCountRow?.total || 0) >= SELF_UNLINK_LIMIT_30D) {
      return res.status(429).json({
        error: "unlink_limit_reached",
        message: "Limite mensal de 2 trocas self-service de computador atingido. Contate o suporte.",
      });
    }

    const nowIso = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE license_machines SET revoked_at = ? WHERE license_id = ? AND machine_id = ? AND revoked_at IS NULL;`,
      )
      .run(nowIso, row.id, String(target_machine_id));

    if (result.changes > 0) {
      logEvent(row.id, "device_deactivated", "client", { target_machine_id });
    }

    const devices = listActiveDevices(row.id);
    return res.json({ ok: true, removed: result.changes > 0, devices });
  });

  // ─── Rotas Administrativas Protegidas (Painel Web + API Bearer) ───────────
  router.get("/admin/overview", auth.requireAdmin, (_req, res) => {
    const totalLicenses = db.prepare(`SELECT COUNT(*) AS total FROM licenses;`).get()?.total || 0;
    const activeLicenses = db.prepare(`SELECT COUNT(*) AS total FROM licenses WHERE status = 'active';`).get()?.total || 0;
    const activeMachines = db.prepare(`SELECT COUNT(*) AS total FROM license_machines WHERE revoked_at IS NULL;`).get()?.total || 0;
    const webhooksCount = db.prepare(`SELECT COUNT(*) AS total FROM sales_webhook_deliveries;`).get()?.total || 0;
    const emailsSent = db.prepare(`SELECT COUNT(*) AS total FROM notification_logs WHERE channel = 'email' AND status = 'sent';`).get()?.total || 0;
    const waSent = db.prepare(`SELECT COUNT(*) AS total FROM notification_logs WHERE channel = 'whatsapp' AND status = 'sent';`).get()?.total || 0;

    return res.json({
      stats: { totalLicenses, activeLicenses, activeMachines, webhooksCount, emailsSent, waSent },
      publicKeyPem: keys.publicKeyPem,
      keyId: keys.keyId,
    });
  });

  router.get("/admin/licenses", auth.requireAdmin, (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    const rows = q
      ? db
          .prepare(
            `SELECT * FROM licenses WHERE lower(customer_email) LIKE ? OR lower(license_key) LIKE ? OR lower(COALESCE(customer_name, '')) LIKE ? ORDER BY created_at DESC LIMIT 200;`,
          )
          .all(`%${q}%`, `%${q}%`, `%${q}%`)
      : db.prepare(`SELECT * FROM licenses ORDER BY created_at DESC LIMIT 200;`).all();

    return res.json({
      licenses: rows.map((row) => ({
        ...row,
        upgrades: parseUpgradesJson(row.upgrades_json),
        devices: listActiveDevices(row.id),
      })),
    });
  });

  router.post("/admin/licenses", auth.requireAdmin, async (req, res) => {
    const {
      email,
      customer_name = "",
      customer_phone = "",
      plan_tier = "individual",
      upgrades = [],
      custom_max_machines = null,
      expires_at = null,
      force_new = false,
      send_email = false,
      send_whatsapp = false,
    } = req.body || {};

    if (!email) return res.status(400).json({ error: "missing_email", message: "E-mail do cliente é obrigatório." });

    const created = issueOrUpdateLicenseFromSale({
      email,
      customerName: customer_name,
      customerPhone: customer_phone,
      planTier: plan_tier,
      addUpgrades: upgrades,
      expiresAt: expires_at || null,
      provider: "admin",
      transactionId: `adm_${Date.now()}`,
      forceNew: Boolean(force_new),
    });

    if (custom_max_machines !== null && custom_max_machines !== "" && Number.isInteger(Number(custom_max_machines))) {
      db.prepare(`UPDATE licenses SET custom_max_machines = ?, updated_at = ? WHERE id = ?;`).run(
        Number(custom_max_machines),
        new Date().toISOString(),
        created.id,
      );
    }

    const refreshed = findLicenseByKey(created.license_key);
    const notifications = await dispatchLicenseNotifications(refreshed, {
      sendEmail: Boolean(send_email),
      sendWhatsApp: Boolean(send_whatsapp),
    });

    return res.status(201).json({
      ok: true,
      license: {
        ...refreshed,
        devices: listActiveDevices(refreshed.id),
      },
      notifications,
    });
  });

  router.post("/admin/licenses/:key/send-notifications", auth.requireAdmin, async (req, res) => {
    const lic = findLicenseByKey(req.params.key);
    if (!lic) return res.status(404).json({ error: "not_found" });
    const { send_email = true, send_whatsapp = true, override_email, override_phone } = req.body || {};
    if (override_phone) {
      db.prepare(`UPDATE licenses SET customer_phone = ?, updated_at = ? WHERE id = ?;`).run(
        String(override_phone).trim(),
        new Date().toISOString(),
        lic.id,
      );
    }
    const target = {
      ...findLicenseByKey(lic.license_key),
      ...(override_email ? { customer_email: String(override_email).trim() } : {}),
      ...(override_phone ? { customer_phone: String(override_phone).trim() } : {}),
    };
    const notifications = await dispatchLicenseNotifications(target, {
      sendEmail: Boolean(send_email),
      sendWhatsApp: Boolean(send_whatsapp),
    });
    return res.json({ ok: true, notifications });
  });

  router.post("/admin/licenses/:key/revoke", auth.requireAdmin, (req, res) => {
    const revoked = revokeLicenseByEmailOrKey({
      licenseKey: req.params.key,
      reason: req.body?.reason || "admin_revoked",
      actor: "admin",
    });
    if (!revoked) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true, status: revoked.status });
  });

  router.post("/admin/licenses/:key/reactivate", auth.requireAdmin, (req, res) => {
    const row = findLicenseByKey(req.params.key);
    if (!row) return res.status(404).json({ error: "not_found" });
    db.prepare(`UPDATE licenses SET status = 'active', updated_at = ? WHERE id = ?;`).run(
      new Date().toISOString(),
      row.id,
    );
    logEvent(row.id, "license_reactivated", "admin", {});
    return res.json({ ok: true, status: "active" });
  });

  router.post("/admin/licenses/:key/reset-machines", auth.requireAdmin, (req, res) => {
    const row = findLicenseByKey(req.params.key);
    if (!row) return res.status(404).json({ error: "not_found" });
    const nowIso = new Date().toISOString();
    db.prepare(`UPDATE license_machines SET revoked_at = ? WHERE license_id = ? AND revoked_at IS NULL;`).run(
      nowIso,
      row.id,
    );
    logEvent(row.id, "machines_reset", "admin", {});
    return res.json({ ok: true, devices: [] });
  });

  // ─── Configurações E-mail, WhatsApp, Webhooks e Logs no Painel ─────────────
  router.get("/admin/notifications/config", auth.requireAdmin, (_req, res) => {
    return res.json({
      email: emailDispatcher.getPublicConfig(),
      whatsapp: whatsappDispatcher.getPublicConfig(),
    });
  });

  router.put("/admin/notifications/email-config", auth.requireAdmin, (req, res) => {
    const updated = emailDispatcher.saveConfig(req.body || {});
    return res.json({ ok: true, email: updated });
  });

  router.post("/admin/notifications/test-email", auth.requireAdmin, async (req, res) => {
    const to = String(req.body?.to || req.adminSession.email || "").trim();
    if (!to) return res.status(400).json({ error: "missing_email" });
    const result = await emailDispatcher.sendTestEmail(to);
    return res.status(result.ok ? 200 : 400).json(result);
  });

  router.put("/admin/notifications/whatsapp-config", auth.requireAdmin, (req, res) => {
    const updated = whatsappDispatcher.saveConfig(req.body || {});
    return res.json({ ok: true, whatsapp: updated });
  });

  router.post("/admin/notifications/test-whatsapp", auth.requireAdmin, async (req, res) => {
    const phone = String(req.body?.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "missing_phone", message: "Informe o telefone com DDD." });
    const result = await whatsappDispatcher.sendTestWhatsApp(phone);
    return res.status(result.ok ? 200 : 400).json(result);
  });

  router.get("/admin/notifications/logs", auth.requireAdmin, (_req, res) => {
    const logs = db
      .prepare(`SELECT * FROM notification_logs ORDER BY created_at DESC LIMIT 100;`)
      .all();
    return res.json({ logs });
  });

  router.get("/admin/webhooks/history", auth.requireAdmin, (_req, res) => {
    const deliveries = db
      .prepare(`SELECT * FROM sales_webhook_deliveries ORDER BY processed_at DESC LIMIT 100;`)
      .all();
    return res.json({ deliveries });
  });

  const hubApi = {
    router,
    db,
    vault,
    auth,
    keys,
    emailDispatcher,
    whatsappDispatcher,
    logNotification,
    dispatchLicenseNotifications,
    findLicenseByKey,
    listActiveDevices,
    signCertificate,
    issueOrUpdateLicenseFromSale,
    revokeLicenseByEmailOrKey,
    requireAdmin: auth.requireAdmin,
    close: () => db.close(),
  };

  router.use(createServerClaimsRouter(hubApi));
  const releasesFeed = createReleasesFeedRouter(hubApi, options);
  router.use(releasesFeed.router);
  hubApi.publishRelease = releasesFeed.publishRelease;
  hubApi.getLatestRelease = releasesFeed.getLatestRelease;

  return hubApi;
}
