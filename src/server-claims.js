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
    const licenseKey = String(
      req.headers["x-criativo-license-key"] || req.headers["x-license-key"] || "",
    ).trim();
    const machineId = String(
      req.headers["x-criativo-machine-id"] || req.headers["x-machine-id"] || "",
    ).trim();
    if (!licenseKey || !machineId) {
      res.status(401).json({ error: "missing_license_headers", message: "Cabeçalhos de licença ausentes." });
      return null;
    }
    const row = hubApi.findLicenseByKey(licenseKey);
    if (!row || row.status !== "active") {
      res.status(403).json({ error: "invalid_or_inactive_license", message: "Licença inválida ou inativa." });
      return null;
    }
    const devices = hubApi.listActiveDevices(row.id, machineId);
    const activeHere = devices.some((d) => d.machine_id === machineId);
    if (!activeHere) {
      res.status(403).json({ error: "unlinked_machine", message: "Dispositivo não vinculado à licença." });
      return null;
    }
    return { row, licenseKey, machineId };
  }

  function handleCreateClaim(req, res) {
    const auth = validateLicenseHeaders(req, res);
    if (!auth) return;

    const serverName = String(req.body?.server_name || "").trim() || "Servidor VPS";
    const claimId = `clm_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const claimToken = `CRV_${crypto.randomBytes(16).toString("hex")}`;
    const tokenHash = hashToken(claimToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CLAIM_TTL_SECONDS * 1000).toISOString();

    db.prepare(
      `INSERT INTO server_claims (
        claim_id, claim_token_hash, license_key, owner_machine_id, server_name, status, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?);`,
    ).run(claimId, tokenHash, auth.licenseKey, auth.machineId, serverName, expiresAt, now.toISOString());

    const baseHubUrl = (process.env.PAINEL_PUBLIC_URL || "https://painel.criativoaistudio.com.br").replace(/\/+$/, "");
    const safeName = serverName.replace(/[^a-zA-Z0-9 _.-]/g, "").trim() || "Servidor VPS";
    const bashCmd = `{ echo CRIATIVO_CLAIM=${claimToken}; curl -fsSL ${baseHubUrl}/api/releases/install-server.sh; } | sudo bash -s -- --name "${safeName}" --hub-url "${baseHubUrl}"`;

    return res.status(201).json({
      ok: true,
      claim_id: claimId,
      server_name: serverName,
      claim_token: claimToken,
      claim_secret: claimToken,
      command_bash: bashCmd,
      expires_at: expiresAt,
      ttl_seconds: CLAIM_TTL_SECONDS,
      status: "pending",
    });
  }

  function handleRedeemClaim(req, res) {
    const body = req.body || {};
    const claimToken = String(body.claim_secret || body.claim_token || "").trim();
    const baseUrl = String(body.host_url || body.base_url || "").trim();
    const accessToken = String(body.server_api_token || body.access_token || "").trim();
    const remoteIp = body.public_ip || body.remote_ip || null;
    const version = String(body.app_version || body.version || "1.0.0").trim();
    const incomingServerName = String(body.server_name || "").trim();

    if (!claimToken || !baseUrl || !accessToken) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const tokenHash = hashToken(claimToken);
    const row = db.prepare(`SELECT * FROM server_claims WHERE claim_token_hash = ?;`).get(tokenHash);
    if (!row) return res.status(404).json({ error: "claim_not_found" });
    if (row.status === "redeemed") return res.status(409).json({ error: "claim_already_redeemed" });
    if (Date.now() > Date.parse(row.expires_at)) {
      db.prepare(`UPDATE server_claims SET status = 'expired' WHERE claim_id = ?;`).run(row.claim_id);
      return res.status(410).json({ error: "claim_expired" });
    }

    const finalServerName = incomingServerName || row.server_name || "Servidor VPS";
    const nowIso = new Date().toISOString();
    db.prepare(
      `UPDATE server_claims
       SET status = 'redeemed',
           server_name = ?,
           paired_base_url = ?,
           paired_access_token = ?,
           paired_remote_ip = ?,
           paired_version = ?,
           redeemed_at = ?
       WHERE claim_id = ?;`,
    ).run(finalServerName, baseUrl, accessToken, remoteIp, version, nowIso, row.claim_id);

    return res.json({
      ok: true,
      claim_id: row.claim_id,
      server_name: finalServerName,
      status: "redeemed",
    });
  }

  function handleGetClaimStatus(req, res) {
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
      paired_info:
        status === "redeemed"
          ? {
              server_name: row.server_name,
              host_url: row.paired_base_url,
              public_ip: row.paired_remote_ip,
              server_api_token: row.paired_access_token,
              app_version: row.paired_version,
            }
          : null,
    };

    if (status === "redeemed" && row.paired_access_token) {
      db.prepare(`UPDATE server_claims SET paired_access_token = NULL WHERE claim_id = ?;`).run(row.claim_id);
    }

    return res.json(payload);
  }

  router.post("/servers/claims", handleCreateClaim);
  router.post("/server-claims/create", handleCreateClaim);

  router.post("/servers/claims/redeem", handleRedeemClaim);
  router.post("/server-claims/redeem", handleRedeemClaim);

  router.get("/servers/claims/:claimId", handleGetClaimStatus);
  router.get("/server-claims/:claimId/status", handleGetClaimStatus);

  return router;
}
