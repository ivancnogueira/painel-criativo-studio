import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { createLicenseHub } from "../src/license-hub.js";
import { createPainelApp } from "../server.js";

describe("Fase 39 — Migração SQLite, 7 Gateways, Analytics, CSV, Inspetor/Replay e Edição Rápida", () => {
  const tempDirs = [];
  const cleanupFns = [];

  after(async () => {
    for (const fn of cleanupFns) await fn();
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  });

  async function startServer() {
    const dir = mkdtempSync(join(tmpdir(), "painel-f39-"));
    tempDirs.push(dir);
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const { app, licenseHub } = createPainelApp({
      licenseHub: {
        dbPath: join(dir, "painel.db"),
        releasesDir: join(dir, "releases"),
        privateKeyPem: privateKey,
        publicKeyPem: publicKey,
        adminEmail: "admin@exemplo.invalid",
        adminPassword: "SenhaForte!2026",
        adminToken: "tok_admin_f39",
        sessionSecret: "sess_f39_test",
        emailTransportFactory: () => ({ sendMail: async () => ({ messageId: "mock-id" }) }),
        fetchImpl: async () => new Response(JSON.stringify({ messages: [{ id: "wa-1" }] }), { status: 200 }),
      },
    });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    cleanupFns.push(async () => {
      licenseHub.close();
      await new Promise((r) => server.close(r));
    });

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@exemplo.invalid", password: "SenhaForte!2026" }),
    });
    const cookie = loginRes.headers.get("set-cookie").split(";")[0];
    return { baseUrl, cookie, licenseHub };
  }

  it("Bloco 4 — Migração Idempotente preserva banco legado e adiciona colunas financeiras e de auditoria", () => {
    const dir = mkdtempSync(join(tmpdir(), "painel-mig-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "legacy.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE licenses (
        id TEXT PRIMARY KEY, license_key TEXT NOT NULL UNIQUE, customer_email TEXT NOT NULL,
        customer_name TEXT, customer_phone TEXT, plan_tier TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        max_servers INTEGER NOT NULL, max_machines INTEGER NOT NULL, custom_max_machines INTEGER,
        upgrades_json TEXT NOT NULL DEFAULT '[]', expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE sales_webhook_deliveries (
        delivery_key TEXT PRIMARY KEY, provider TEXT NOT NULL, transaction_id TEXT NOT NULL,
        event_name TEXT NOT NULL, buyer_email TEXT, buyer_phone TEXT, action TEXT,
        license_key TEXT, summary_json TEXT, processed_at TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    legacyDb
      .prepare(`INSERT INTO licenses VALUES (?, ?, ?, ?, ?, 'individual', 'active', 2, 2, NULL, '[]', NULL, ?, ?);`)
      .run("lic_old_1", "CRIA-IND-1111-2222-3333", "cliente@exemplo.invalid", "Cliente Legado", "+5511900000000", now, now);
    legacyDb
      .prepare(`INSERT INTO sales_webhook_deliveries VALUES (?, 'hotmart', 'TX-OLD', 'PURCHASE_APPROVED', ?, ?, 'issued_or_updated', ?, ?, ?);`)
      .run("hotmart:TX-OLD:PURCHASE_APPROVED", "cliente@exemplo.invalid", "+5511900000000", "CRIA-IND-1111-2222-3333", JSON.stringify({ simulated: true }), now);
    legacyDb.close();

    const hub1 = createLicenseHub({ dbPath, adminEmail: "admin@exemplo.invalid", adminPassword: "SenhaForte!2026" });
    hub1.close();
    const hub2 = createLicenseHub({ dbPath, adminEmail: "admin@exemplo.invalid", adminPassword: "SenhaForte!2026" });
    cleanupFns.push(async () => hub2.close());

    const deliveryCols = new Set(hub2.db.prepare(`PRAGMA table_info(sales_webhook_deliveries);`).all().map((c) => c.name));
    for (const col of ["id", "buyer_name", "amount_cents", "currency", "payment_method", "plan_tier", "raw_payload_json", "http_status", "error_detail", "is_simulated", "replay_count"]) {
      assert.ok(deliveryCols.has(col), `Coluna ausente em sales_webhook_deliveries: ${col}`);
    }
    const licenseCols = new Set(hub2.db.prepare(`PRAGMA table_info(licenses);`).all().map((c) => c.name));
    for (const col of ["amount_cents", "currency", "payment_method", "source_provider", "is_simulated", "notes"]) {
      assert.ok(licenseCols.has(col), `Coluna ausente em licenses: ${col}`);
    }

    const oldLic = hub2.findLicenseByKey("CRIA-IND-1111-2222-3333");
    assert.equal(oldLic.customer_email, "cliente@exemplo.invalid");
    assert.equal(oldLic.source_provider, "manual");

    const oldDel = hub2.db.prepare(`SELECT * FROM sales_webhook_deliveries WHERE transaction_id = 'TX-OLD';`).get();
    assert.match(oldDel.id, /^[a-f0-9]{24}$/);
    assert.equal(oldDel.is_simulated, 1);
  });

  it("Bloco 5 — Extração Monetária & 7 Gateways (Hotmart, Kiwify, Ticto, Stripe, Cakto, Kirvano, Genérico + 401 auditável)", async () => {
    const { baseUrl, cookie } = await startServer();
    const secrets = {
      hotmartHottok: "sec_hot",
      kiwifyToken: "sec_kiw",
      tictoToken: "sec_tic",
      stripeSecret: "whsec_str",
      caktoSecret: "sec_cak",
      kirvanoToken: "sec_kir",
      genericHmacSecret: "sec_gen",
    };

    const cfgRes = await fetch(`${baseUrl}/api/admin/webhooks/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(secrets),
    });
    assert.equal(cfgRes.status, 200);

    const cfgGet = await (await fetch(`${baseUrl}/api/admin/webhooks/config`, { headers: { Cookie: cookie } })).json();
    assert.equal(Object.keys(cfgGet.urls).length, 7);
    assert.equal(cfgGet.secretsConfigured.cakto, true);
    assert.equal(cfgGet.secretsConfigured.kirvano, true);
    assert.equal(cfgGet.secretsConfigured.generic, true);

    // 1. Hotmart decimal
    const r1 = await fetch(`${baseUrl}/api/webhooks/sales?provider=hotmart`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hotmart-Hottok": secrets.hotmartHottok },
      body: JSON.stringify({
        event: "PURCHASE_APPROVED",
        data: {
          purchase: { transaction: "HM-1", price: { value: 297.5, currency_value: "BRL" }, payment: { type: "PIX" } },
          buyer: { email: "cliente@exemplo.invalid", name: "Comprador Hotmart" },
          product: { id: "P1", name: "Individual" },
        },
      }),
    });
    assert.equal((await r1.json()).amount_cents, 29750);

    // 2. Kiwify HMAC-SHA1
    const kiwPayload = JSON.stringify({
      webhook_event_type: "order_approved",
      order_id: "KW-1",
      payment_method: "credit_card",
      Commissions: { charge_amount: 49700, product_base_price_currency: "BRL" },
      Customer: { email: "teste@exemplo.invalid", full_name: "Comprador Kiwify" },
      Product: { product_id: "P2", product_name: "Agência 10" },
    });
    const kiwSig = crypto.createHmac("sha1", secrets.kiwifyToken).update(kiwPayload).digest("hex");
    const r2 = await fetch(`${baseUrl}/api/webhooks/sales?provider=kiwify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-kiwify-signature": kiwSig },
      body: kiwPayload,
    });
    assert.equal((await r2.json()).amount_cents, 49700);

    // 3. Ticto v2
    const r3 = await fetch(`${baseUrl}/api/webhooks/sales?provider=ticto`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ticto-token": secrets.tictoToken },
      body: JSON.stringify({
        status: "paid",
        payment_method: "pix",
        data: {
          order: { hash: "TC-2", paid_amount: 19700, currency: "BRL" },
          customer: { email: "ticto@exemplo.invalid", name: "Comprador Ticto" },
          items: [{ id: "P3", name: "Individual" }],
        },
      }),
    });
    assert.equal((await r3.json()).amount_cents, 19700);

    // 4. Stripe HMAC-SHA256 t=,v1=
    const strPayload = JSON.stringify({
      id: "evt_str_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          amount_total: 99700,
          currency: "usd",
          payment_method_types: ["card"],
          customer_details: { email: "stripe@exemplo.invalid", name: "Stripe Buyer" },
          metadata: { plan_name: "Agência Ilimitada" },
        },
      },
    });
    const ts = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac("sha256", secrets.stripeSecret).update(`${ts}.${strPayload}`).digest("hex");
    const r4 = await fetch(`${baseUrl}/api/webhooks/sales?provider=stripe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": `t=${ts},v1=${v1}` },
      body: strPayload,
    });
    const j4 = await r4.json();
    assert.equal(j4.amount_cents, 99700);
    assert.equal(j4.currency, "USD");

    // 5. Cakto
    const r5 = await fetch(`${baseUrl}/api/webhooks/sales?provider=cakto`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cakto-secret": secrets.caktoSecret },
      body: JSON.stringify({
        event: "purchase_approved",
        data: {
          transaction_id: "CK-1",
          amount: 397.0,
          currency: "BRL",
          paymentMethod: "pix",
          customer: { email: "cakto@exemplo.invalid", name: "Cakto User" },
          product: { id: "P5", name: "Agência 10" },
        },
      }),
    });
    assert.equal((await r5.json()).amount_cents, 39700);

    // 6. Kirvano com string BR
    const r6 = await fetch(`${baseUrl}/api/webhooks/sales?provider=kirvano`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Security-Token": secrets.kirvanoToken },
      body: JSON.stringify({
        event: "SALE_APPROVED",
        sale_id: "KR-1",
        total_price: "R$ 197,00",
        payment_method: "boleto",
        customer: { email: "kirvano@exemplo.invalid", name: "Kirvano User" },
        products: [{ id: "P6", name: "Individual" }],
      }),
    });
    assert.equal((await r6.json()).amount_cents, 19700);

    // 7. Genérico HMAC-SHA256
    const genPayload = JSON.stringify({
      event: "order.paid",
      transaction_id: "GEN-1",
      amount_cents: 14700,
      payment_method: "pix",
      customer: { email: "generico@exemplo.invalid", name: "Genérico User" },
      offer_name: "Individual",
    });
    const genSig = crypto.createHmac("sha256", secrets.genericHmacSecret).update(genPayload).digest("hex");
    const r7 = await fetch(`${baseUrl}/api/webhooks/sales?provider=generic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Signature": `sha256=${genSig}` },
      body: genPayload,
    });
    assert.equal((await r7.json()).amount_cents, 14700);

    // Rejeição 401 deve gravar auth_error auditável
    const badRes = await fetch(`${baseUrl}/api/webhooks/sales?provider=generic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Signature": "sha256=invalida" },
      body: genPayload,
    });
    assert.equal(badRes.status, 401);

    const errs = await (await fetch(`${baseUrl}/api/admin/webhooks/deliveries?status=erro`, { headers: { Cookie: cookie } })).json();
    assert.equal(errs.total, 1);
    assert.equal(errs.deliveries[0].action, "auth_error");
    assert.equal(errs.deliveries[0].http_status, 401);
  });

  it("Bloco 6 — Analytics, Meta, Anti-Simulação, Anti-Dupla-Contagem & CSV protegido", async () => {
    const { baseUrl, cookie } = await startServer();
    await fetch(`${baseUrl}/api/admin/webhooks/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ hotmartHottok: "sec_ana" }),
    });

    // Venda 1 real (49700)
    await fetch(`${baseUrl}/api/webhooks/sales?provider=hotmart`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hotmart-Hottok": "sec_ana" },
      body: JSON.stringify({
        event: "PURCHASE_APPROVED",
        data: {
          purchase: { transaction: "AN-1", price: { value: 497.0 }, payment: { type: "PIX" } },
          buyer: { email: "cliente@exemplo.invalid", name: "Comprador Real" },
          product: { id: "AG10", name: "Agência 10" },
        },
      }),
    });

    // Venda 2 real (19700) + Reembolso (19700)
    await fetch(`${baseUrl}/api/webhooks/sales?provider=hotmart`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hotmart-Hottok": "sec_ana" },
      body: JSON.stringify({
        event: "PURCHASE_APPROVED",
        data: {
          purchase: { transaction: "AN-2", price: { value: 197.0 }, payment: { type: "CREDIT_CARD" } },
          buyer: { email: "teste@exemplo.invalid", name: "Comprador Reembolso" },
          product: { id: "IND", name: "Individual" },
        },
      }),
    });
    await fetch(`${baseUrl}/api/webhooks/sales?provider=hotmart`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hotmart-Hottok": "sec_ana" },
      body: JSON.stringify({
        event: "PURCHASE_REFUNDED",
        data: {
          purchase: { transaction: "AN-2-REF", price: { value: 197.0 } },
          buyer: { email: "teste@exemplo.invalid" },
        },
      }),
    });

    // Emissão manual (29700) com fórmula perigosa no nome para testar anti-CSV-injection
    await fetch(`${baseUrl}/api/admin/licenses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        email: "manual@exemplo.invalid",
        customer_name: "=1+1",
        plan_tier: "individual",
        amount_cents: 29700,
        payment_method: "pix",
      }),
    });

    // Simulação (99900) não deve entrar quando include_simulated=false
    await fetch(`${baseUrl}/api/admin/webhooks/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        provider: "hotmart",
        email: "sim@exemplo.invalid",
        amount_cents: 99900,
      }),
    });

    const anaReal = await (await fetch(`${baseUrl}/api/admin/analytics/sales?range=30d`, { headers: { Cookie: cookie } })).json();
    assert.equal(anaReal.kpis.grossRevenueCents, 99100);
    assert.equal(anaReal.kpis.refundedRevenueCents, 19700);
    assert.equal(anaReal.kpis.netRevenueCents, 79400);
    assert.equal(anaReal.kpis.approvedCount, 3);
    assert.equal(anaReal.kpis.refundCount, 1);
    assert.equal(anaReal.kpis.averageTicketCents, Math.round(99100 / 3));
    assert.ok(anaReal.series.length >= 30);
    assert.ok(anaReal.byPlan.length >= 2);

    const anaSim = await (
      await fetch(`${baseUrl}/api/admin/analytics/sales?range=30d&include_simulated=true`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(anaSim.kpis.grossRevenueCents, 199000);

    // Meta configurável
    const goalRes = await fetch(`${baseUrl}/api/admin/analytics/goal`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ target_cents: 158800, period: "monthly", currency: "BRL" }),
    });
    assert.equal(goalRes.status, 200);
    const anaAfterGoal = await (await fetch(`${baseUrl}/api/admin/analytics/sales?range=30d`, { headers: { Cookie: cookie } })).json();
    assert.equal(anaAfterGoal.goal.targetCents, 158800);
    assert.equal(anaAfterGoal.goal.percent, 50);

    // CSV export com BOM e anti-injection
    const salesCsvBuf = Buffer.from(
      await (await fetch(`${baseUrl}/api/admin/analytics/sales/export.csv?range=30d`, { headers: { Cookie: cookie } })).arrayBuffer(),
    );
    assert.deepEqual([...salesCsvBuf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.ok(salesCsvBuf.toString("utf8").includes("'=1+1"));

    const licCsvBuf = Buffer.from(
      await (await fetch(`${baseUrl}/api/admin/licenses/export.csv`, { headers: { Cookie: cookie } })).arrayBuffer(),
    );
    assert.deepEqual([...licCsvBuf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.ok(licCsvBuf.toString("utf8").includes("'=1+1"));
  });

  it("Bloco 7 — Inspetor, Replay, Edição Rápida, Preview E-mail e Rotas Públicas intactas", async () => {
    const { baseUrl, cookie } = await startServer();

    // Dispara webhook com token ainda não configurado -> falha 401 gravada para inspeção e replay
    const failRes = await fetch(`${baseUrl}/api/webhooks/sales?provider=cakto`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cakto-secret": "errado" },
      body: JSON.stringify({
        event: "purchase_approved",
        data: {
          transaction_id: "REPLAY-01",
          customer: { email: "replay@exemplo.invalid", name: "Replay Cliente", phone: "+5511900000000" },
          product: { id: "PROD_VIP_REPLAY", name: "Oferta Genérica" },
        },
      }),
    });
    assert.equal(failRes.status, 401);

    const listJson = await (await fetch(`${baseUrl}/api/admin/webhooks/deliveries?status=erro`, { headers: { Cookie: cookie } })).json();
    assert.equal(listJson.deliveries.length, 1);
    const deliveryId = listJson.deliveries[0].id;

    const inspectJson = await (await fetch(`${baseUrl}/api/admin/webhooks/deliveries/${deliveryId}`, { headers: { Cookie: cookie } })).json();
    assert.equal(inspectJson.delivery.http_status, 401);
    assert.equal(inspectJson.delivery.raw_payload.data.product.id, "PROD_VIP_REPLAY");

    // Ajusta productMap e executa replay em 1 clique
    await fetch(`${baseUrl}/api/admin/webhooks/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        caktoSecret: "sec_ok",
        productMap: {
          PROD_VIP_REPLAY: { planTier: "agencia_10", addUpgrades: ["video"], defaultAmountCents: 49700, currency: "BRL", label: "Agência 10 VIP" },
        },
      }),
    });

    const replayJson = await (
      await fetch(`${baseUrl}/api/admin/webhooks/deliveries/${deliveryId}/replay`, {
        method: "POST",
        headers: { Cookie: cookie },
      })
    ).json();
    assert.equal(replayJson.ok, true);
    assert.equal(replayJson.replayed, true);
    assert.match(replayJson.result.license_key, /^CRIA-AG10-/);
    assert.equal(replayJson.result.amount_cents, 49700);
    assert.equal(replayJson.delivery.replay_count, 1);

    // Edição rápida via PATCH /api/admin/licenses/:key
    const licKey = replayJson.result.license_key;
    const patchRes = await fetch(`${baseUrl}/api/admin/licenses/${licKey}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ plan_tier: "agencia_ilimitada", notes: "Cliente VIP atualizado" }),
    });
    const patchJson = await patchRes.json();
    assert.equal(patchJson.license.plan_tier, "agencia_ilimitada");
    assert.equal(patchJson.license.max_servers, -1);
    assert.equal(patchJson.license.max_machines, 5);
    assert.equal(patchJson.license.notes, "Cliente VIP atualizado");

    // Filtro por status & plan_tier
    const filtered = await (
      await fetch(`${baseUrl}/api/admin/licenses?status=active&plan_tier=agencia_ilimitada`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(filtered.licenses.length, 1);
    assert.equal(filtered.licenses[0].license_key, licKey);

    // Preview de e-mail
    const prevRes = await fetch(`${baseUrl}/api/admin/notifications/preview-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ plan_tier: "agencia_10" }),
    });
    const prevJson = await prevRes.json();
    assert.equal(prevJson.ok, true);
    assert.match(prevJson.html, /cliente@exemplo\.invalid/);

    // Rotas públicas acessíveis sem cookie admin e asset ausente retorna 404 JSON
    const pubKeyRes = await fetch(`${baseUrl}/api/licenses/public-key`);
    assert.equal(pubKeyRes.status, 200);
    const installRes = await fetch(`${baseUrl}/api/releases/install-server.sh`);
    assert.equal(installRes.status, 200);
    const relRes = await fetch(`${baseUrl}/api/releases/latest`, {
      headers: { "X-Criativo-License-Key": licKey },
    });
    assert.notEqual(relRes.status, 401);
    const assetRes = await fetch(`${baseUrl}/js/nao-existe.js`);
    assert.equal(assetRes.status, 404);
    assert.equal((await assetRes.json()).error, "asset_not_found");
  });
});
