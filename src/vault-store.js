import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Cofre AES-256-GCM sobre SQLite para guardar tokens de checkout, senha SMTP e chaves WhatsApp.
 */
export class PainelVaultStore {
  #db;
  #masterKey;

  constructor(db, options = {}) {
    this.#db = db;
    const rawKey =
      options.vaultKey ??
      process.env.PAINEL_VAULT_KEY ??
      process.env.CRIATIVO_VAULT_KEY ??
      "";
    this.#masterKey = this.resolveMasterKey(rawKey, options.dataDir);
  }

  resolveMasterKey(rawKey, dataDir) {
    if (rawKey && rawKey.length >= 32) {
      return crypto.createHash("sha256").update(rawKey, "utf8").digest();
    }
    const baseDir = dataDir || path.resolve(process.cwd(), "dados");
    const keyFile = path.join(baseDir, ".vault-master.key");
    if (fs.existsSync(keyFile)) {
      const saved = fs.readFileSync(keyFile, "utf8").trim();
      if (saved) return crypto.createHash("sha256").update(saved, "utf8").digest();
    }
    const generated = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(keyFile, generated, { mode: 0o600 });
    return crypto.createHash("sha256").update(generated, "utf8").digest();
  }

  encrypt(plainText) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.#masterKey, iv);
    const enc = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
  }

  decrypt(payload) {
    if (!payload || typeof payload !== "string") return "";
    const parts = payload.split(".");
    if (parts.length !== 3) return "";
    try {
      const iv = Buffer.from(parts[0], "base64url");
      const tag = Buffer.from(parts[1], "base64url");
      const data = Buffer.from(parts[2], "base64url");
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.#masterKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    } catch {
      return "";
    }
  }

  setSetting(key, value, { isSecret = false } = {}) {
    const nowIso = new Date().toISOString();
    const stored = isSecret ? (value ? this.encrypt(value) : "") : JSON.stringify(value ?? null);
    this.#db
      .prepare(
        `INSERT INTO painel_settings (setting_key, setting_value, is_secret, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(setting_key) DO UPDATE SET
           setting_value = excluded.setting_value,
           is_secret = excluded.is_secret,
           updated_at = excluded.updated_at;`,
      )
      .run(key, stored, isSecret ? 1 : 0, nowIso);
  }

  getSetting(key, fallback = null) {
    const row = this.#db
      .prepare(`SELECT setting_value, is_secret FROM painel_settings WHERE setting_key = ?;`)
      .get(key);
    if (!row) return fallback;
    if (row.is_secret === 1) {
      return row.setting_value ? this.decrypt(row.setting_value) : fallback;
    }
    try {
      return JSON.parse(row.setting_value);
    } catch {
      return fallback;
    }
  }

  hasSecret(key) {
    const row = this.#db
      .prepare(`SELECT setting_value, is_secret FROM painel_settings WHERE setting_key = ?;`)
      .get(key);
    return Boolean(row && row.setting_value);
  }

  getMaskedSecret(key) {
    const val = this.getSetting(key, "");
    if (!val || typeof val !== "string") return "";
    if (val.length <= 6) return "••••••";
    return `${val.slice(0, 3)}••••${val.slice(-3)}`;
  }
}
