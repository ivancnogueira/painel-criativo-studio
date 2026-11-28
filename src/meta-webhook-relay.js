import express from "express";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const RELAY_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;

function sha256Hex(raw) {
  return createHash("sha256").update(String(raw || ""), "utf8").digest("hex");
}

function safeEqualText(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  return bufA.length > 0 && bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Webhook Relay Zero-Trust para Meta Instagram (DM47-03):
 * - NAO possui App Meta proprio e NAO armazena Access Tokens ou App Secrets dos clientes.
 * - Recebe eventos brutos da Meta, preserva `raw_body` + `x-hub-signature-256` e entrega
 *   ao Daemon local via SSE ou pull autenticado por licenca ativa + segredo SHA-256.
 */
export function createMetaWebhookRelayRouter({ db }) {
  if (!db) {
    throw new Error("createMetaWebhookRelayRouter requer instância 'db'.");
  }

  const router = express.Router();
  const sseListeners = new Map();

  function cleanupExpired() {
    const nowIso = new Date().toISOString();
    db.prepare("DELETE FROM meta_relay_queue WHERE expires_at <= ?;").run(nowIso);
  }

  function authenticateChannel(req) {
    const channelId = String(req.header("x-relay-channel-id") || req.query?.channelId || "").trim();
    const secret = String(req.header("x-relay-secret") || "").trim();
    if (!channelId || !secret) {
      return { ok: false, status: 401, error: "missing_relay_credentials" };
    }

    const row = db
      .prepare(
        `SELECT c.*, l.status AS license_status
         FROM meta_relay_channels c
         JOIN licenses l ON l.id = c.license_id
         WHERE c.channel_id = ? LIMIT 1;`
      )
      .get(channelId);

    if (!row) {
      return { ok: false, status: 404, error: "relay_channel_not_found" };
    }
    if (row.license_status !== "active") {
      return { ok: false, status: 403, error: "license_inactive" };
    }
    if (!safeEqualText(sha256Hex(secret), row.channel_secret_hash)) {
      return { ok: false, status: 401, error: "invalid_relay_secret" };
    }
    return { ok: true, channel: row };
  }

  // Provisionamento ou rotação de canal vitalício autenticado por licença ativa
  router.post("/relay/meta/register", (req, res) => {
    const licenseKey = String(req.body?.license_key || "").trim();
    if (!licenseKey) {
      return res.status(400).json({ ok: false, error: "license_key_required" });
    }

    const license = db
      .prepare("SELECT id, status FROM licenses WHERE upper(license_key) = upper(?) LIMIT 1;")
      .get(licenseKey);
    if (!license) {
      return res.status(404).json({ ok: false, error: "license_not_found" });
    }
    if (license.status !== "active") {
      return res.status(403).json({ ok: false, error: "license_not_active" });
    }

    const existing = db
      .prepare("SELECT channel_id, verify_token FROM meta_relay_channels WHERE license_id = ? LIMIT 1;")
      .get(license.id);

    const channelId = existing?.channel_id || `mrelay_${randomBytes(10).toString("hex")}`;
    const verifyToken =
      String(req.body?.verify_token || "").trim() ||
      existing?.verify_token ||
      `crv_meta_${randomBytes(12).toString("hex")}`;
    const channelSecret = `rsec_${randomBytes(24).toString("hex")}`;
    const nowIso = new Date().toISOString();

    if (existing) {
      db.prepare(
        `UPDATE meta_relay_channels
         SET verify_token = ?, channel_secret_hash = ?, rotated_at = ?
         WHERE channel_id = ?;`
      ).run(verifyToken, sha256Hex(channelSecret), nowIso, channelId);
    } else {
      db.prepare(
        `INSERT INTO meta_relay_channels (channel_id, license_id, verify_token, channel_secret_hash, created_at, rotated_at)
         VALUES (?, ?, ?, ?, ?, ?);`
      ).run(channelId, license.id, verifyToken, sha256Hex(channelSecret), nowIso, nowIso);
    }

    return res.json({
      ok: true,
      channel_id: channelId,
      verify_token: verifyToken,
      channel_secret: channelSecret,
      webhook_url_path: `/api/webhooks/meta-relay/${channelId}`,
    });
  });

  // Handshake hub.challenge oficial da Meta
  router.get("/webhooks/meta-relay/:channelId", (req, res) => {
    const channelId = String(req.params.channelId || "").trim();
    const channel = db
      .prepare("SELECT verify_token FROM meta_relay_channels WHERE channel_id = ? LIMIT 1;")
      .get(channelId);
    if (!channel) {
      return res.status(404).send("channel_not_found");
    }

    const mode = String(req.query["hub.mode"] || "");
    const token = String(req.query["hub.verify_token"] || "");
    const challenge = String(req.query["hub.challenge"] || "");

    if (mode === "subscribe" && safeEqualText(token, channel.verify_token)) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send(challenge);
    }
    return res.status(403).send("forbidden");
  });

  // Ingestão pública Meta (prefixed /api/webhooks/ para reaproveitar req.rawBody do server.js)
  router.post("/webhooks/meta-relay/:channelId", (req, res) => {
    cleanupExpired();
    const channelId = String(req.params.channelId || "").trim();
    const channel = db
      .prepare(
        `SELECT c.channel_id, l.status AS license_status
         FROM meta_relay_channels c
         JOIN licenses l ON l.id = c.license_id
         WHERE c.channel_id = ? LIMIT 1;`
      )
      .get(channelId);
    if (!channel) {
      return res.status(404).json({ ok: false, error: "channel_not_found" });
    }
    if (channel.license_status !== "active") {
      return res.status(403).json({ ok: false, error: "license_inactive" });
    }

    const rawBody =
      typeof req.rawBody === "string" && req.rawBody.length > 0
        ? req.rawBody
        : JSON.stringify(req.body ?? {});
    const sigHeader = String(req.header("x-hub-signature-256") || "").trim() || null;
    const eventId = `mq_${randomUUID().slice(0, 14)}`;
    const nowMs = Date.now();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + RELAY_QUEUE_TTL_MS).toISOString();

    db.prepare(
      `INSERT INTO meta_relay_queue (id, channel_id, raw_body, signature_header, headers_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?);`
    ).run(eventId, channelId, rawBody, sigHeader, JSON.stringify({}), createdAt, expiresAt);

    const listeners = sseListeners.get(channelId);
    if (listeners && listeners.size > 0) {
      const evtPayload = JSON.stringify({
        id: eventId,
        raw_body: rawBody,
        signature_header: sigHeader,
        received_at: createdAt,
      });
      for (const clientRes of listeners) {
        try {
          clientRes.write(`event: meta_webhook\ndata: ${evtPayload}\n\n`);
        } catch {
          // listener encerrado será removido no close
        }
      }
    }

    return res.status(200).json({ ok: true, queued: eventId });
  });

  router.get("/relay/meta/pull", (req, res) => {
    cleanupExpired();
    const auth = authenticateChannel(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ ok: false, error: auth.error });
    }
    const items = db
      .prepare(
        `SELECT id, raw_body, signature_header, created_at AS received_at
         FROM meta_relay_queue
         WHERE channel_id = ?
         ORDER BY created_at ASC
         LIMIT 50;`
      )
      .all(auth.channel.channel_id);
    return res.json({ ok: true, items });
  });

  router.post("/relay/meta/ack", (req, res) => {
    const auth = authenticateChannel(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ ok: false, error: auth.error });
    }
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
    let deleted = 0;
    const delStmt = db.prepare("DELETE FROM meta_relay_queue WHERE channel_id = ? AND id = ?;");
    for (const id of ids) {
      deleted += Number(delStmt.run(auth.channel.channel_id, id).changes ?? 0);
    }
    return res.json({ ok: true, deleted });
  });

  router.get("/relay/meta/stream", (req, res) => {
    const auth = authenticateChannel(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ ok: false, error: auth.error });
    }
    const chId = auth.channel.channel_id;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ channel_id: chId })}\n\n`);

    if (!sseListeners.has(chId)) {
      sseListeners.set(chId, new Set());
    }
    sseListeners.get(chId).add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        // ignore
      }
    }, 20_000);
    heartbeat.unref?.();

    req.on("close", () => {
      clearInterval(heartbeat);
      sseListeners.get(chId)?.delete(res);
    });
  });

  return router;
}
