import express from "express";
import crypto from "node:crypto";

const CLAIM_TTL_SECONDS = 15 * 60;

export function createServerClaimsRouter(hubApi) {
  const router = express.Router();
  const db = hubApi.db;

  db.exec(`
    CREATE TABLE IF NOT EXISTS server_claims (
      claim_id TEXT PRIMARY KEY,
      claim_token_hash TEXT NOT NULL UNIQUE,
      license_key TEXT NOT NULL,
      owner_machine_id TEXT NOT NULL,
      server_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'redeemed', 'expired')),
      paired_base_url TEXT,
      paired_access_token TEXT,
      paired_remote_ip TEXT,
      paired_version TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      redeemed_at TEXT
    );
  `);

  function hashToken(token) {
    return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
  }

  function validateLicenseHeaders(req, res) {
    const licenseKey = String(req.headers["x-criativo-license-key"] || "").trim();
    const machineId = String(req.headers["x-criativo-machine-id"] || "").trim();
    if (!licenseKey || !machineId) {
      res.status(401).json({ error: "missing_license_headers" });
      return null;
    }
    const row = hubApi.findLicenseByKey(licenseKey);
    if (!row || row.status !== "active") {
      res.status(403).json({ error: "invalid_or_inactive_license" });
      return null;
    }
    const devices = hubApi.listActiveDevices(row.id, machineId);
    const activeHere = devices.some((d) => d.machine_id === machineId);
    if (!activeHere) {
      res.status(403).json({ error: "unlinked_machine" });
      return null;
    }
    return { row, licenseKey, machineId };
  }

  router.post("/servers/claims", (req, res) => {
    const auth = validateLicenseHeaders(req, res);
    if (!auth) return;

    const serverName = String(req.body?.server_name || "").trim() || "Servidor VPS";
    const claimId = `clm_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const claimToken = `CRIATIVO_CLAIM_${crypto.randomBytes(18).toString("base64url")}`;
    const tokenHash = hashToken(claimToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CLAIM_TTL_SECONDS * 1000).toISOString();

    db.prepare(
      `INSERT INTO server_claims (
        claim_id, claim_token_hash, license_key, owner_machine_id, server_name, status, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?);`,
    ).run(claimId, tokenHash, auth.licenseKey, auth.machineId, serverName, expiresAt, now.toISOString());

    const baseHubUrl = (process.env.PAINEL_PUBLIC_URL || "https://painel.criativoaistudio.com.br").replace(/\/+$/, "");
    const bashCmd = `curl -fsSL ${baseHubUrl}/api/releases/install-server.sh | CRIATIVO_CLAIM="${claimToken}" CRIATIVO_CLAIM_HUB="${baseHubUrl}" bash`;

    return res.status(201).json({
      claim_id: claimId,
      server_name: serverName,
      claim_token: claimToken,
      command_bash: bashCmd,
      expires_at: expiresAt,
      ttl_seconds: CLAIM_TTL_SECONDS,
      status: "pending",
    });
  });

  router.post("/servers/claims/redeem", (req, res) => {
    const { claim_token, base_url, access_token, remote_ip = null, version = "1.0.0" } = req.body || {};
    if (!claim_token || !base_url || !access_token) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const tokenHash = hashToken(claim_token);
    const row = db.prepare(`SELECT * FROM server_claims WHERE claim_token_hash = ?;`).get(tokenHash);
    if (!row) return res.status(404).json({ error: "claim_not_found" });
    if (row.status === "redeemed") return res.status(409).json({ error: "claim_already_redeemed" });
    if (Date.now() > Date.parse(row.expires_at)) {
      db.prepare(`UPDATE server_claims SET status = 'expired' WHERE claim_id = ?;`).run(row.claim_id);
      return res.status(410).json({ error: "claim_expired" });
    }

    const nowIso = new Date().toISOString();
    db.prepare(
      `UPDATE server_claims
       SET status = 'redeemed', paired_base_url = ?, paired_access_token = ?, paired_remote_ip = ?, paired_version = ?, redeemed_at = ?
       WHERE claim_id = ?;`,
    ).run(String(base_url).trim(), String(access_token).trim(), remote_ip, version, nowIso, row.claim_id);

    return res.json({
      ok: true,
      claim_id: row.claim_id,
      server_name: row.server_name,
      status: "redeemed",
    });
  });

  router.get("/servers/claims/:claimId", (req, res) => {
    const auth = validateLicenseHeaders(req, res);
    if (!auth) return;

    const row = db
      .prepare(`SELECT * FROM server_claims WHERE claim_id = ? AND license_key = ?;`)
      .get(req.params.claimId, auth.licenseKey);
    if (!row) return res.status(404).json({ error: "claim_not_found" });

    let status = row.status;
    if (status === "pending" && Date.now() > Date.parse(row.expires_at)) {
      status = "expired";
      db.prepare(`UPDATE server_claims SET status = 'expired' WHERE claim_id = ?;`).run(row.claim_id);
    }

    const payload = {
      claim_id: row.claim_id,
      server_name: row.server_name,
      expires_at: row.expires_at,
      status,
      paired_server:
        status === "redeemed"
          ? {
              nome: row.server_name,
              base_url: row.paired_base_url,
              access_token: row.paired_access_token,
              remote_ip: row.paired_remote_ip,
              version: row.paired_version,
            }
          : null,
    };

    if (status === "redeemed" && row.paired_access_token) {
      db.prepare(`UPDATE server_claims SET paired_access_token = NULL WHERE claim_id = ?;`).run(row.claim_id);
    }

    return res.json(payload);
  });

  return router;
}
