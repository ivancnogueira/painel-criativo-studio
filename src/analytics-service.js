import express from "express";

const DEFAULT_GOAL = { targetCents: 1000000, period: "monthly", currency: "BRL" };
const PLAN_LABELS = { individual: "Individual", agencia_10: "Agência 10", agencia_ilimitada: "Agência Ilimitada", other: "Outros" };
const METHOD_LABELS = { pix: "PIX", credit_card: "Cartão", boleto: "Boleto", debit: "Débito", paypal: "PayPal", manual: "Manual", other: "Outro" };

export function sanitizeCsvCell(value) {
  let str = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function buildCsv(headers, rows) {
  const lines = [headers.map(sanitizeCsvCell).join(",")];
  for (const row of rows) lines.push(row.map(sanitizeCsvCell).join(","));
  return `\uFEFF${lines.join("\r\n")}`;
}

function resolveWindow(range) {
  const nowMs = Date.now();
  const dayMs = 86400000;
  const daysMap = { "7d": 7, "30d": 30, "90d": 90, "12m": 365 };
  if (range === "all") return { range: "all", startMs: null, endMs: nowMs, prevStartMs: null, prevEndMs: null };
  const safeRange = daysMap[range] ? range : "30d";
  const startMs = nowMs - (daysMap[safeRange] || 30) * dayMs;
  return { range: safeRange, startMs, endMs: nowMs, prevStartMs: startMs - (daysMap[safeRange] || 30) * dayMs, prevEndMs: startMs };
}

function calcPctDelta(curr, prev) {
  if (!prev) return curr > 0 ? 100 : 0;
  return Number((((curr - prev) / Math.abs(prev)) * 100).toFixed(1));
}

function summarizeRows(rows) {
  let grossRevenueCents = 0;
  let refundedRevenueCents = 0;
  let approvedCount = 0;
  let refundCount = 0;
  for (const r of rows) {
    const cents = Math.max(0, Number(r.amount_cents) || 0);
    if (r.action === "revoked") {
      refundCount += 1;
      refundedRevenueCents += cents;
    } else {
      approvedCount += 1;
      grossRevenueCents += cents;
    }
  }
  const netRevenueCents = grossRevenueCents - refundedRevenueCents;
  const refundRatePct = approvedCount > 0 ? Number(((refundCount / approvedCount) * 100).toFixed(1)) : 0;
  const averageTicketCents = approvedCount > 0 ? Math.round(grossRevenueCents / approvedCount) : 0;
  return { grossRevenueCents, refundedRevenueCents, netRevenueCents, approvedCount, refundCount, refundRatePct, averageTicketCents };
}

function buildTimeSeries(rows, { startMs, endMs, granularity }) {
  const map = new Map();
  const effectiveStart =
    startMs ?? (rows.length > 0 ? Math.min(...rows.map((r) => Date.parse(r.created_at) || endMs)) : endMs - 30 * 86400000);
  const cursor = new Date(effectiveStart);
  const endDate = new Date(endMs);

  if (granularity === "monthly") {
    cursor.setUTCDate(1);
    cursor.setUTCHours(0, 0, 0, 0);
    while (cursor <= endDate) {
      const y = cursor.getUTCFullYear();
      const m = String(cursor.getUTCMonth() + 1).padStart(2, "0");
      const key = `${y}-${m}`;
      map.set(key, { key, label: `${m}/${String(y).slice(-2)}`, grossCents: 0, refundedCents: 0, netCents: 0, salesCount: 0, refundCount: 0 });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  } else {
    cursor.setUTCHours(0, 0, 0, 0);
    while (cursor <= endDate) {
      const key = cursor.toISOString().slice(0, 10);
      map.set(key, { key, label: `${key.slice(8, 10)}/${key.slice(5, 7)}`, grossCents: 0, refundedCents: 0, netCents: 0, salesCount: 0, refundCount: 0 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  for (const r of rows) {
    const iso = String(r.created_at || "");
    const bucket = map.get(granularity === "monthly" ? iso.slice(0, 7) : iso.slice(0, 10));
    if (!bucket) continue;
    const cents = Math.max(0, Number(r.amount_cents) || 0);
    if (r.action === "revoked") {
      bucket.refundedCents += cents;
      bucket.refundCount += 1;
    } else {
      bucket.grossCents += cents;
      bucket.salesCount += 1;
    }
    bucket.netCents = bucket.grossCents - bucket.refundedCents;
  }
  return Array.from(map.values());
}

export function createAnalyticsService({ db, vault, requireAdmin }) {
  function getGoal() {
    const saved = vault.getSetting("analytics_revenue_goal", null) || {};
    const rawTarget = saved.target_cents ?? saved.targetCents;
    const targetCents = Number.isFinite(Number(rawTarget)) && Number(rawTarget) >= 0 ? Math.round(Number(rawTarget)) : DEFAULT_GOAL.targetCents;
    return {
      targetCents,
      period: String(saved.period || DEFAULT_GOAL.period),
      currency: String(saved.currency || DEFAULT_GOAL.currency).toUpperCase(),
    };
  }

  function saveGoal(input = {}) {
    const num = Number(input.target_cents ?? input.targetCents);
    if (!Number.isFinite(num) || num < 0) throw new Error("target_cents deve ser um número inteiro maior ou igual a zero.");
    vault.setSetting("analytics_revenue_goal", {
      target_cents: Math.round(num),
      period: String(input.period || "monthly"),
      currency: String(input.currency || "BRL").toUpperCase(),
    });
    return getGoal();
  }

  function queryFinancialTransactions(includeSimulated) {
    const simFilter = includeSimulated ? "" : "AND COALESCE(is_simulated, 0) = 0";
    return db
      .prepare(
        `SELECT id, provider AS source, transaction_id, buyer_name, buyer_email, plan_tier, payment_method,
                COALESCE(amount_cents, 0) AS amount_cents, COALESCE(currency, 'BRL') AS currency,
                action, license_key, COALESCE(is_simulated, 0) AS is_simulated, processed_at AS created_at
         FROM sales_webhook_deliveries WHERE action IN ('issued_or_updated', 'revoked') ${simFilter}
         UNION ALL
         SELECT id, 'manual' AS source, id AS transaction_id, customer_name AS buyer_name, customer_email AS buyer_email,
                plan_tier, COALESCE(payment_method, 'manual') AS payment_method,
                COALESCE(amount_cents, 0) AS amount_cents, COALESCE(currency, 'BRL') AS currency,
                'issued_or_updated' AS action, license_key, COALESCE(is_simulated, 0) AS is_simulated, created_at
         FROM licenses WHERE COALESCE(source_provider, 'manual') = 'manual' AND COALESCE(amount_cents, 0) > 0 ${simFilter}
         ORDER BY created_at DESC;`,
      )
      .all();
  }

  function buildActivityFeed(includeSimulated) {
    const items = [];
    const simFilter = includeSimulated ? "" : "AND COALESCE(is_simulated, 0) = 0";

    for (const d of db
      .prepare(
        `SELECT id, provider, buyer_email, action, license_key, error_detail, processed_at FROM sales_webhook_deliveries
         WHERE action IN ('issued_or_updated', 'revoked', 'auth_error', 'error') ${simFilter} ORDER BY processed_at DESC LIMIT 15;`,
      )
      .all()) {
      const isErr = d.action === "auth_error" || d.action === "error";
      const isRev = d.action === "revoked";
      items.push({
        id: `wh_${d.id}`,
        kind: isErr ? "webhook_error" : "sale",
        title: isErr ? `Falha webhook ${d.provider}` : isRev ? `Reembolso via ${d.provider}` : `Venda aprovada via ${d.provider}`,
        subtitle: d.error_detail || [d.buyer_email, d.license_key].filter(Boolean).join(" · ") || d.provider,
        status: isErr ? "error" : isRev ? "warn" : "success",
        createdAt: d.processed_at,
      });
    }

    for (const ev of db
      .prepare(
        `SELECT le.id, le.event_type, le.created_at, l.license_key, l.customer_email FROM license_events le
         JOIN licenses l ON l.id = le.license_id
         WHERE le.event_type IN ('machine_activated', 'license_issued', 'license_updated', 'license_revoked')
           ${includeSimulated ? "" : "AND COALESCE(l.is_simulated, 0) = 0"} ORDER BY le.created_at DESC LIMIT 12;`,
      )
      .all()) {
      items.push({
        id: `ev_${ev.id}`,
        kind: ev.event_type === "machine_activated" ? "machine" : "sale",
        title: ev.event_type === "machine_activated" ? "Dispositivo ativado" : `Evento ${ev.event_type}`,
        subtitle: [ev.customer_email, ev.license_key].filter(Boolean).join(" · "),
        status: ev.event_type === "license_revoked" ? "warn" : "info",
        createdAt: ev.created_at,
      });
    }

    for (const n of db.prepare(`SELECT id, channel, recipient, status, license_key, created_at FROM notification_logs ORDER BY created_at DESC LIMIT 10;`).all()) {
      items.push({
        id: `nf_${n.id}`,
        kind: "notification",
        title: `${n.channel === "whatsapp" ? "WhatsApp" : "E-mail"} (${n.status})`,
        subtitle: [n.recipient, n.license_key].filter(Boolean).join(" · "),
        status: n.status === "sent" ? "success" : n.status === "error" ? "error" : "warn",
        createdAt: n.created_at,
      });
    }

    try {
      for (const r of db.prepare(`SELECT version, channel, published_at FROM product_releases ORDER BY published_at DESC LIMIT 5;`).all()) {
        items.push({ id: `rel_${r.version}`, kind: "release", title: `Release v${r.version} (${r.channel})`, subtitle: "Publicado no feed de atualizações", status: "info", createdAt: r.published_at });
      }
    } catch {
      // product_releases opcional
    }

    return items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 30);
  }

  function getSalesAnalytics({ range = "30d", includeSimulated = false, granularity = "auto" } = {}) {
    const win = resolveWindow(range);
    const effGranularity = granularity === "daily" || granularity === "monthly" ? granularity : win.range === "12m" || win.range === "all" ? "monthly" : "daily";
    const allRows = queryFinancialTransactions(includeSimulated);
    const currentRows = [];
    const prevRows = [];

    for (const r of allRows) {
      const ts = Date.parse(r.created_at);
      if (!Number.isFinite(ts)) continue;
      if (win.startMs === null || (ts >= win.startMs && ts <= win.endMs)) currentRows.push(r);
      else if (win.prevStartMs !== null && ts >= win.prevStartMs && ts < win.prevEndMs) prevRows.push(r);
    }

    const currSum = summarizeRows(currentRows);
    const prevSum = summarizeRows(prevRows);
    const simCond = includeSimulated ? "" : "WHERE COALESCE(is_simulated, 0) = 0";
    const simAnd = includeSimulated ? "" : "AND COALESCE(is_simulated, 0) = 0";
    const totalLicenses = db.prepare(`SELECT COUNT(*) AS total FROM licenses ${simCond};`).get()?.total || 0;
    const activeLicensesTotal = db.prepare(`SELECT COUNT(*) AS total FROM licenses WHERE status = 'active' ${simAnd};`).get()?.total || 0;
    const activeMachinesTotal =
      db.prepare(`SELECT COUNT(*) AS total FROM license_machines lm JOIN licenses l ON l.id = lm.license_id WHERE lm.revoked_at IS NULL ${includeSimulated ? "" : "AND COALESCE(l.is_simulated, 0) = 0"};`).get()?.total || 0;

    const goalCfg = getGoal();
    const goalPercent = goalCfg.targetCents > 0 ? Number(((currSum.netRevenueCents / goalCfg.targetCents) * 100).toFixed(1)) : 0;
    const planMap = new Map();
    const providerMap = new Map();
    const methodMap = new Map();
    const currencyBreakdown = {};

    for (const r of currentRows) {
      const cents = Math.max(0, Number(r.amount_cents) || 0);
      const cur = String(r.currency || "BRL").toUpperCase();
      if (!currencyBreakdown[cur]) currencyBreakdown[cur] = { grossCents: 0, netCents: 0, count: 0 };
      if (r.action === "revoked") {
        currencyBreakdown[cur].netCents -= cents;
        continue;
      }
      currencyBreakdown[cur].grossCents += cents;
      currencyBreakdown[cur].netCents += cents;
      currencyBreakdown[cur].count += 1;

      const pt = r.plan_tier || "other";
      const pEntry = planMap.get(pt) || { plan_tier: pt, label: PLAN_LABELS[pt] || pt, revenueCents: 0, count: 0 };
      pEntry.revenueCents += cents;
      pEntry.count += 1;
      planMap.set(pt, pEntry);

      const prov = r.source || "manual";
      const prEntry = providerMap.get(prov) || { provider: prov, revenueCents: 0, count: 0 };
      prEntry.revenueCents += cents;
      prEntry.count += 1;
      providerMap.set(prov, prEntry);

      const m = r.payment_method || "other";
      const mEntry = methodMap.get(m) || { method: m, label: METHOD_LABELS[m] || m, revenueCents: 0, count: 0 };
      mEntry.revenueCents += cents;
      mEntry.count += 1;
      methodMap.set(m, mEntry);
    }

    const byPlan = Array.from(planMap.values()).map((item) => ({
      ...item,
      percent: currSum.grossRevenueCents > 0 ? Number(((item.revenueCents / currSum.grossRevenueCents) * 100).toFixed(1)) : 0,
    }));

    const recentSales = currentRows.slice(0, 50).map((r) => ({
      id: r.id,
      source: r.source,
      transactionId: r.transaction_id,
      buyerName: r.buyer_name || "",
      buyerEmail: r.buyer_email || "",
      planTier: r.plan_tier || "individual",
      paymentMethod: r.payment_method || null,
      amountCents: Math.max(0, Number(r.amount_cents) || 0),
      currency: String(r.currency || "BRL").toUpperCase(),
      status: r.action === "revoked" ? "refunded" : "approved",
      licenseKey: r.license_key || null,
      isSimulated: Boolean(r.is_simulated),
      createdAt: r.created_at,
    }));

    return {
      ok: true,
      range: win.range,
      granularity: effGranularity,
      includeSimulated: Boolean(includeSimulated),
      primaryCurrency: goalCfg.currency,
      kpis: { ...currSum, activeLicensesTotal, activeMachinesTotal, totalLicenses },
      deltas: {
        netRevenuePct: win.range === "all" ? 0 : calcPctDelta(currSum.netRevenueCents, prevSum.netRevenueCents),
        approvedCountPct: win.range === "all" ? 0 : calcPctDelta(currSum.approvedCount, prevSum.approvedCount),
        averageTicketPct: win.range === "all" ? 0 : calcPctDelta(currSum.averageTicketCents, prevSum.averageTicketCents),
        refundRateDeltaPts: win.range === "all" ? 0 : Number((currSum.refundRatePct - prevSum.refundRatePct).toFixed(1)),
      },
      goal: { ...goalCfg, currentCents: currSum.netRevenueCents, percent: goalPercent },
      series: buildTimeSeries(currentRows, { startMs: win.startMs, endMs: win.endMs, granularity: effGranularity }),
      byPlan,
      byProvider: Array.from(providerMap.values()),
      byPaymentMethod: Array.from(methodMap.values()),
      currencyBreakdown,
      recentSales,
      activityFeed: buildActivityFeed(includeSimulated),
      allWindowRows: currentRows,
    };
  }

  function exportSalesCsv({ range = "30d", includeSimulated = false } = {}) {
    const data = getSalesAnalytics({ range, includeSimulated });
    const headers = ["ID", "Origem", "Transacao", "Comprador", "Email", "Plano", "Pagamento", "Valor (Centavos)", "Valor", "Moeda", "Status", "Chave", "Simulado", "Data"];
    const rows = data.allWindowRows.map((r) => [
      r.id, r.source, r.transaction_id, r.buyer_name || "", r.buyer_email || "", r.plan_tier || "", r.payment_method || "",
      r.amount_cents || 0, ((Number(r.amount_cents) || 0) / 100).toFixed(2), r.currency || "BRL",
      r.action === "revoked" ? "reembolsado" : "aprovado", r.license_key || "", r.is_simulated ? "sim" : "nao", r.created_at,
    ]);
    return buildCsv(headers, rows);
  }

  function exportLicensesCsv(licenses = []) {
    const headers = ["Chave", "Email", "Nome", "Telefone", "Plano", "Status", "Origem", "Valor (Centavos)", "Moeda", "Pagamento", "MaquinasAtivas", "MaxMaquinas", "ExpiraEm", "CriadoEm", "Notas"];
    const rows = licenses.map((l) => [
      l.license_key, l.customer_email, l.customer_name || "", l.customer_phone || "", l.plan_tier, l.status, l.source_provider || "manual",
      l.amount_cents || 0, l.currency || "BRL", l.payment_method || "", Array.isArray(l.devices) ? l.devices.length : 0,
      l.custom_max_machines ?? l.max_machines, l.expires_at || "", l.created_at, l.notes || "",
    ]);
    return buildCsv(headers, rows);
  }

  const router = express.Router();
  router.get("/admin/analytics/sales", requireAdmin, (req, res) => {
    const payload = getSalesAnalytics({
      range: String(req.query.range || "30d"),
      includeSimulated: String(req.query.include_simulated || "false").toLowerCase() === "true",
      granularity: String(req.query.granularity || "auto"),
    });
    delete payload.allWindowRows;
    return res.json(payload);
  });

  router.put("/admin/analytics/goal", requireAdmin, (req, res) => {
    try {
      return res.json({ ok: true, goal: saveGoal(req.body || {}) });
    } catch (err) {
      return res.status(400).json({ error: "invalid_goal", message: err.message });
    }
  });

  router.get("/admin/analytics/sales/export.csv", requireAdmin, (req, res) => {
    const csv = exportSalesCsv({
      range: String(req.query.range || "30d"),
      includeSimulated: String(req.query.include_simulated || "false").toLowerCase() === "true",
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="vendas-criativo.csv"');
    return res.send(csv);
  });

  return { router, getGoal, saveGoal, getSalesAnalytics, exportSalesCsv, exportLicensesCsv };
}
