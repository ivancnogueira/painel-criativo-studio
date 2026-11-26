import express from "express";

export function createLicenseAdminRouter({
  db,
  keys,
  emailDispatcher,
  whatsappDispatcher,
  analyticsService,
  PLAN_MATRIX,
  getPlanCatalog,
  savePlanCatalog,
  processNotificationQueue,
  parseUpgradesJson,
  normalizeUpgrades,
  listActiveDevices,
  findLicenseByKey,
  logEvent,
  issueOrUpdateLicenseFromSale,
  revokeLicenseByEmailOrKey,
  dispatchLicenseNotifications,
  buildLicenseEmailPayload,
  parseMoneyToCents,
  normalizePaymentMethod,
  requireAdmin,
}) {
  const router = express.Router();

  function queryFilteredLicenses(query = {}) {
    const q = String(query.q || "").trim().toLowerCase();
    const status = String(query.status || "").trim().toLowerCase();
    const planTier = String(query.plan_tier || "").trim().toLowerCase();
    const limit = Math.min(500, Math.max(1, Number.parseInt(query.limit || "200", 10) || 200));

    const clauses = [];
    const params = [];
    if (q) {
      clauses.push("(lower(customer_email) LIKE ? OR lower(license_key) LIKE ? OR lower(COALESCE(customer_name, '')) LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    if (planTier) {
      clauses.push("plan_tier = ?");
      params.push(planTier);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(`SELECT * FROM licenses ${whereSql} ORDER BY created_at DESC LIMIT ?;`).all(...params, limit);
    return rows.map((row) => ({
      ...row,
      upgrades: parseUpgradesJson(row.upgrades_json),
      devices: listActiveDevices(row.id),
    }));
  }

  router.get("/admin/overview", requireAdmin, (_req, res) => {
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

  router.get("/admin/licenses", requireAdmin, (req, res) => {
    return res.json({ licenses: queryFilteredLicenses(req.query) });
  });

  router.get("/admin/licenses/:key/details", requireAdmin, (req, res) => {
    const lic = findLicenseByKey(req.params.key);
    if (!lic) return res.status(404).json({ error: "not_found" });
    const devices = listActiveDevices(lic.id);
    const events = db
      .prepare(`SELECT id, event_type, actor, details_json, created_at FROM license_events WHERE license_id = ? ORDER BY created_at DESC LIMIT 40;`)
      .all(lic.id);
    const transactions = db
      .prepare(`SELECT * FROM license_transactions WHERE license_id = ? ORDER BY created_at DESC LIMIT 40;`)
      .all(lic.id);
    const deliveries = db
      .prepare(
        `SELECT id, provider, integration_id, transaction_id, event_name, action, amount_cents, currency, payment_method, http_status, is_simulated, processed_at
         FROM sales_webhook_deliveries
         WHERE upper(COALESCE(license_key, '')) = upper(?) OR lower(COALESCE(buyer_email, '')) = lower(?)
         ORDER BY processed_at DESC LIMIT 20;`,
      )
      .all(lic.license_key, lic.customer_email);
    const notifications = db
      .prepare(`SELECT * FROM notification_logs WHERE license_id = ? OR upper(COALESCE(license_key, '')) = upper(?) ORDER BY created_at DESC LIMIT 20;`)
      .all(lic.id, lic.license_key);
    const queuedRetries = db
      .prepare(`SELECT * FROM notification_queue WHERE license_id = ? OR upper(COALESCE(license_key, '')) = upper(?) ORDER BY created_at DESC LIMIT 10;`)
      .all(lic.id, lic.license_key);
    const baseUrl = String(process.env.PAINEL_PUBLIC_URL || `${req.protocol}://${req.get("host") || "localhost"}`).replace(/\/+$/, "");
    const deliveryUrl = lic.delivery_token ? `${baseUrl}/entrega/${lic.delivery_token}` : null;

    return res.json({
      ok: true,
      license: lic,
      devices,
      events,
      transactions,
      deliveries,
      notifications,
      queuedRetries,
      deliveryUrl,
    });
  });

  router.get("/admin/plans", requireAdmin, (_req, res) => {
    const plans = typeof getPlanCatalog === "function" ? getPlanCatalog() : PLAN_MATRIX;
    return res.json({ ok: true, plans });
  });

  router.put("/admin/plans", requireAdmin, (req, res) => {
    if (typeof savePlanCatalog !== "function") return res.status(501).json({ error: "not_supported" });
    const plans = savePlanCatalog(req.body?.plans || req.body || {});
    return res.json({ ok: true, plans });
  });

  router.get("/admin/licenses/export.csv", requireAdmin, (req, res) => {
    const licenses = queryFilteredLicenses({ ...req.query, limit: req.query.limit || "500" });
    const csv = analyticsService.exportLicensesCsv(licenses);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="licencas-criativo.csv"');
    return res.send(csv);
  });

  router.post("/admin/licenses", requireAdmin, async (req, res) => {
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
      amount_cents = null,
      amount = null,
      currency = "BRL",
      payment_method = "manual",
      notes = null,
    } = req.body || {};

    if (!email) return res.status(400).json({ error: "missing_email", message: "E-mail do cliente é obrigatório." });

    const resolvedAmountCents =
      amount_cents !== null && amount_cents !== undefined && amount_cents !== ""
        ? parseMoneyToCents(amount_cents, { isIntegerCents: true })
        : parseMoneyToCents(amount);

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
      amountCents: resolvedAmountCents,
      currency: String(currency || "BRL").toUpperCase(),
      paymentMethod: normalizePaymentMethod(payment_method) || "manual",
      sourceProvider: "manual",
      isSimulated: false,
      notes: notes !== null && notes !== undefined ? String(notes) : null,
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
      license: { ...refreshed, devices: listActiveDevices(refreshed.id) },
      notifications,
    });
  });

  router.patch("/admin/licenses/:key", requireAdmin, (req, res) => {
    const row = findLicenseByKey(req.params.key);
    if (!row) return res.status(404).json({ error: "not_found" });

    const body = req.body || {};
    const updates = [];
    const params = [];

    if (body.customer_name !== undefined) {
      updates.push("customer_name = ?");
      params.push(body.customer_name ? String(body.customer_name).trim() : null);
    }
    if (body.customer_phone !== undefined) {
      updates.push("customer_phone = ?");
      params.push(body.customer_phone ? String(body.customer_phone).trim() : null);
    }
    if (body.plan_tier !== undefined && PLAN_MATRIX[body.plan_tier]) {
      const meta = PLAN_MATRIX[body.plan_tier];
      updates.push("plan_tier = ?", "max_servers = ?", "max_machines = ?");
      params.push(meta.plan_tier, meta.max_servers, meta.max_machines);
    }
    if (body.upgrades !== undefined) {
      updates.push("upgrades_json = ?");
      params.push(JSON.stringify(normalizeUpgrades(body.upgrades)));
    }
    if (body.custom_max_machines !== undefined) {
      const val =
        body.custom_max_machines === null || body.custom_max_machines === ""
          ? null
          : Number.isInteger(Number(body.custom_max_machines))
            ? Number(body.custom_max_machines)
            : row.custom_max_machines;
      updates.push("custom_max_machines = ?");
      params.push(val);
    }
    if (body.expires_at !== undefined) {
      updates.push("expires_at = ?");
      params.push(body.expires_at ? String(body.expires_at) : null);
    }
    if (body.amount_cents !== undefined || body.amount !== undefined) {
      const cents =
        body.amount_cents !== undefined && body.amount_cents !== null && body.amount_cents !== ""
          ? parseMoneyToCents(body.amount_cents, { isIntegerCents: true })
          : parseMoneyToCents(body.amount);
      updates.push("amount_cents = ?");
      params.push(cents);
    }
    if (body.currency !== undefined) {
      updates.push("currency = ?");
      params.push(String(body.currency || "BRL").toUpperCase());
    }
    if (body.payment_method !== undefined) {
      updates.push("payment_method = ?");
      params.push(normalizePaymentMethod(body.payment_method));
    }
    if (body.notes !== undefined) {
      updates.push("notes = ?");
      params.push(body.notes !== null ? String(body.notes) : null);
    }

    if (updates.length > 0) {
      updates.push("updated_at = ?");
      params.push(new Date().toISOString(), row.id);
      db.prepare(`UPDATE licenses SET ${updates.join(", ")} WHERE id = ?;`).run(...params);
      logEvent(row.id, "license_updated", "admin", { fields: Object.keys(body) });
    }

    const updated = findLicenseByKey(row.license_key);
    return res.json({ ok: true, license: { ...updated, devices: listActiveDevices(updated.id) } });
  });

  router.post("/admin/licenses/:key/send-notifications", requireAdmin, async (req, res) => {
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

  router.post("/admin/licenses/:key/revoke", requireAdmin, (req, res) => {
    const revoked = revokeLicenseByEmailOrKey({
      licenseKey: req.params.key,
      reason: req.body?.reason || "admin_revoked",
      actor: "admin",
    });
    if (!revoked) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true, status: revoked.status });
  });

  router.post("/admin/licenses/:key/reactivate", requireAdmin, (req, res) => {
    const row = findLicenseByKey(req.params.key);
    if (!row) return res.status(404).json({ error: "not_found" });
    db.prepare(`UPDATE licenses SET status = 'active', updated_at = ? WHERE id = ?;`).run(new Date().toISOString(), row.id);
    logEvent(row.id, "license_reactivated", "admin", {});
    return res.json({ ok: true, status: "active" });
  });

  router.post("/admin/licenses/:key/reset-machines", requireAdmin, (req, res) => {
    const row = findLicenseByKey(req.params.key);
    if (!row) return res.status(404).json({ error: "not_found" });
    db.prepare(`UPDATE license_machines SET revoked_at = ? WHERE license_id = ? AND revoked_at IS NULL;`).run(
      new Date().toISOString(),
      row.id,
    );
    logEvent(row.id, "machines_reset", "admin", {});
    return res.json({ ok: true, devices: [] });
  });

  router.get("/admin/notifications/config", requireAdmin, (_req, res) => {
    return res.json({ email: emailDispatcher.getPublicConfig(), whatsapp: whatsappDispatcher.getPublicConfig() });
  });

  router.put("/admin/notifications/email-config", requireAdmin, (req, res) => {
    return res.json({ ok: true, email: emailDispatcher.saveConfig(req.body || {}) });
  });

  router.post("/admin/notifications/test-email", requireAdmin, async (req, res) => {
    const to = String(req.body?.to || req.adminSession.email || "").trim();
    if (!to) return res.status(400).json({ error: "missing_email" });
    const result = await emailDispatcher.sendTestEmail(to);
    return res.status(result.ok ? 200 : 400).json(result);
  });

  router.post("/admin/notifications/preview-email", requireAdmin, (req, res) => {
    const body = req.body || {};
    const planTier = PLAN_MATRIX[body.plan_tier] ? body.plan_tier : "individual";
    const meta = PLAN_MATRIX[planTier];
    const pubCfg = emailDispatcher.getPublicConfig();
    const eventType = String(body.event_type || "license_issued");
    const payload = buildLicenseEmailPayload({
      license: {
        customer_name: String(body.customer_name || "Cliente Exemplo"),
        customer_email: String(body.customer_email || "cliente@exemplo.invalid"),
        plan_tier: planTier,
        license_key: String(body.license_key || `CRIA-${meta.prefix}-PREV-0000-1234`),
        max_servers: meta.max_servers,
        max_machines: meta.max_machines,
        upgrades: normalizeUpgrades(body.upgrades || []),
        delivery_token: body.delivery_token || "preview-token-demo",
      },
      downloadLinks: pubCfg.downloadLinks,
      painelUrl: process.env.PAINEL_PUBLIC_URL || "https://painel.criativoaistudio.com.br",
      eventType,
      supportGroupUrl: body.support_group_url !== undefined ? body.support_group_url : pubCfg.supportGroupUrl,
      supportGroupLabel: body.support_group_label !== undefined ? body.support_group_label : pubCfg.supportGroupLabel,
    });
    return res.json({ ok: true, ...payload });
  });

  router.get("/admin/notifications/queue", requireAdmin, (_req, res) => {
    const queue = db.prepare(`SELECT * FROM notification_queue ORDER BY created_at DESC LIMIT 60;`).all();
    return res.json({ ok: true, queue });
  });

  router.post("/admin/notifications/retry-due", requireAdmin, async (req, res) => {
    if (typeof processNotificationQueue !== "function") return res.json({ ok: true, processed: 0 });
    const summary = await processNotificationQueue({ forceNow: req.body?.force_now !== false });
    return res.json({ ok: true, ...summary });
  });

  router.put("/admin/notifications/whatsapp-config", requireAdmin, (req, res) => {
    return res.json({ ok: true, whatsapp: whatsappDispatcher.saveConfig(req.body || {}) });
  });

  router.post("/admin/notifications/test-whatsapp", requireAdmin, async (req, res) => {
    const phone = String(req.body?.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "missing_phone", message: "Informe o telefone com DDD." });
    const result = await whatsappDispatcher.sendTestWhatsApp(phone);
    return res.status(result.ok ? 200 : 400).json(result);
  });

  router.get("/admin/notifications/logs", requireAdmin, (_req, res) => {
    const logs = db.prepare(`SELECT * FROM notification_logs ORDER BY created_at DESC LIMIT 100;`).all();
    return res.json({ logs });
  });

  return router;
}
