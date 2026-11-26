import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createPainelApp } from "../server.js";

describe("Novo Motor de Webhooks (14 Plataformas), Entregas & Proteções de Licença", () => {
  const tempDirs = [];
  const cleanupFns = [];

  after(async () => {
    for (const fn of cleanupFns) await fn();
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  });

  async function startServer({ failEmailsOnce = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "painel-int-"));
    tempDirs.push(dir);
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const sentEmails = [];
    let shouldFailEmail = failEmailsOnce;

    const { app, licenseHub } = createPainelApp({
      licenseHub: {
        dbPath: join(dir, "painel.db"),
        releasesDir: join(dir, "releases"),
        privateKeyPem: privateKey,
        publicKeyPem: publicKey,
        adminEmail: "admin@exemplo.invalid",
        adminPassword: "SenhaForte!2026",
        adminToken: "tok_admin_int",
        sessionSecret: "sess_int_test",
        enableNotificationRetryWorker: false,
        emailTransportFactory: () => ({
          sendMail: async (mail) => {
            if (shouldFailEmail) {
              shouldFailEmail = false;
              throw new Error("SMTP timeout simulado");
            }
            sentEmails.push(mail);
            return { messageId: `mock-${sentEmails.length}` };
          },
        }),
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

    await fetch(`${baseUrl}/api/admin/notifications/email-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        provider: "smtp",
        smtpHost: "smtp.exemplo.invalid",
        smtpUser: "noreply@exemplo.invalid",
        smtpPass: "segredo",
        fromEmail: "noreply@exemplo.invalid",
      }),
    });

    return { baseUrl, cookie, licenseHub, sentEmails };
  }

  it("Catálogo expõe 14 plataformas com Greenn e Appmax e fluxo Greenn com escuta de evento de teste funciona", async () => {
    const { baseUrl, cookie, sentEmails } = await startServer();

    const catRes = await fetch(`${baseUrl}/api/admin/integrations/platforms`, { headers: { Cookie: cookie } });
    assert.equal(catRes.status, 200);
    const catJson = await catRes.json();
    assert.equal(catJson.platforms.length, 14);
    assert.equal(catJson.platforms[0].id, "greenn");
    assert.equal(catJson.platforms[1].id, "appmax");

    // Cria integração Greenn em Modo Entrega Direta
    const createRes = await fetch(`${baseUrl}/api/admin/integrations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        platform: "greenn",
        name: "Greenn Agência 10",
        deliveryMode: "direct",
        fixedPlanTier: "agencia_10",
        fixedUpgrades: ["bonus"],
      }),
    });
    assert.equal(createRes.status, 201);
    const { integration } = await createRes.json();
    assert.match(integration.webhookUrl, /\/api\/webhooks\/greenn\/greenn-agencia-10\?token=/);

    const webhookPath = new URL(integration.webhookUrl).pathname + new URL(integration.webhookUrl).search;

    // Ping GET público
    const pingRes = await fetch(`${baseUrl}${webhookPath.split("?")[0]}`);
    assert.equal(pingRes.status, 200);

    // Ativa escuta de evento de teste
    const startListenRes = await fetch(`${baseUrl}/api/admin/integrations/${integration.id}/listen`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ action: "start" }),
    });
    assert.equal((await startListenRes.json()).listening, true);

    // Dispara payload teste real da Greenn -> NÃO deve emitir licença
    const testHook = await fetch(`${baseUrl}${webhookPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "saleUpdated",
        current_status: "paid",
        sale: { id: "GRN-TEST-1", amount: 497.0, currency: "BRL", method: "pix" },
        client: { name: "Teste Greenn", email: "greenn.teste@exemplo.invalid", cellphone: "11900000000" },
      }),
    });
    const testHookJson = await testHook.json();
    assert.equal(testHookJson.mode, "test");
    assert.equal(sentEmails.length, 0);

    // Consulta estado de escuta -> retorna fields + suggestedMapping
    const listenAfter = await (
      await fetch(`${baseUrl}/api/admin/integrations/${integration.id}/listen`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(listenAfter.listening, false);
    assert.ok(listenAfter.fields.length > 0);
    assert.equal(listenAfter.suggestedMapping.email, "client.email");
    assert.equal(listenAfter.suggestedMapping.statusField, "current_status");

    // Salva mapeamento sugerido e ativa integração
    const patchRes = await fetch(`${baseUrl}/api/admin/integrations/${integration.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        isActive: true,
        fieldMapping: listenAfter.suggestedMapping,
      }),
    });
    assert.equal(patchRes.status, 200);
    assert.equal((await patchRes.json()).integration.isActive, true);

    // Envia venda real Greenn
    const saleRes = await fetch(`${baseUrl}${webhookPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "saleUpdated",
        current_status: "paid",
        sale: { id: "GRN-REAL-1", amount: 497.0, currency: "BRL", method: "pix" },
        client: { name: "Comprador Greenn", email: "comprador.greenn@exemplo.invalid", cellphone: "11900000000" },
      }),
    });
    const saleJson = await saleRes.json();
    assert.equal(saleJson.ok, true);
    assert.equal(saleJson.action, "issued_or_updated");
    assert.match(saleJson.license_key, /^CRIA-AG10-/);
    assert.equal(sentEmails.length, 1);
    assert.match(sentEmails[0].html, /\/entrega\//);

    // Confere detalhes 360 e Magic Delivery Page pública
    const detJson = await (
      await fetch(`${baseUrl}/api/admin/licenses/${saleJson.license_key}/details`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(detJson.transactions.length, 1);
    assert.ok(detJson.deliveryUrl);

    const deliveryToken = new URL(detJson.deliveryUrl).pathname.split("/").pop();
    const pubDelJson = await (await fetch(`${baseUrl}/api/delivery/${deliveryToken}`)).json();
    assert.equal(pubDelJson.ok, true);
    assert.equal(pubDelJson.delivery.license_key, saleJson.license_key);

    const pubPage = await fetch(`${baseUrl}/entrega/${deliveryToken}`);
    assert.equal(pubPage.status, 200);
  });

  it("Appmax: quarentena pending_mapping, resolução, firstname+lastname, anti-downgrade, revogação granular de upgrade e renovação", async () => {
    const { baseUrl, cookie, licenseHub } = await startServer();

    const createRes = await fetch(`${baseUrl}/api/admin/integrations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        platform: "appmax",
        name: "Appmax Checkout",
        deliveryMode: "product_map",
      }),
    });
    const { integration } = await createRes.json();

    // Usa payload de exemplo da Appmax para sugerir mapeamento
    const sampleState = await (
      await fetch(`${baseUrl}/api/admin/integrations/${integration.id}/listen`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ action: "simulate_sample" }),
      })
    ).json();
    assert.equal(sampleState.suggestedMapping.firstName, "data.customer.firstname");
    assert.equal(sampleState.suggestedMapping.lastName, "data.customer.lastname");

    await fetch(`${baseUrl}/api/admin/integrations/${integration.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        isActive: true,
        fieldMapping: sampleState.suggestedMapping,
        rules: [
          { matchField: "product_id", matchValue: "SKU_BUMP_VIDEO", ruleAction: "add_upgrades_only", addUpgrades: ["video"], defaultAmountCents: 9700 },
          { matchField: "product_id", matchValue: "SKU_AG10", ruleAction: "grant_plan", planTier: "agencia_10", defaultAmountCents: 49700 },
        ],
      }),
    });

    const hookPath = new URL(integration.webhookUrl).pathname + new URL(integration.webhookUrl).search;

    // 1) Produto não mapeado (SKU_ILIM) -> cai em pending_mapping sem liberar licença errada
    const unmappedRes = await fetch(`${baseUrl}${hookPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "OrderPaid",
        data: {
          id: "APX-100",
          total: 997.0,
          payment_type: "pix",
          customer: { firstname: "Ana", lastname: "Paula", email: "ana.appmax@exemplo.invalid", telephone: "11900000000" },
          bundles: [{ id: "B1", name: "Ilimitada", products: [{ sku: "SKU_ILIM", name: "Agência Ilimitada" }] }],
        },
      }),
    });
    const unmappedJson = await unmappedRes.json();
    assert.equal(unmappedJson.action, "pending_mapping");

    // 2) Resolve pendência mapeando SKU_ILIM -> Agencia Ilimitada + 30 dias
    const resolveRes = await fetch(
      `${baseUrl}/api/admin/integrations/${integration.id}/resolve-pending/${unmappedJson.id}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          matchField: "product_id",
          matchValue: "SKU_ILIM",
          ruleAction: "grant_plan",
          planTier: "agencia_ilimitada",
          durationDays: 30,
          saveRule: true,
        }),
      },
    );
    const resolveJson = await resolveRes.json();
    assert.equal(resolveJson.ok, true);
    assert.match(resolveJson.result.license_key, /^CRIA-AGIL-/);
    const licKey = resolveJson.result.license_key;

    const licAfterCreate = licenseHub.findLicenseByKey(licKey);
    assert.equal(licAfterCreate.customer_name, "Ana Paula");
    assert.ok(licAfterCreate.expires_at);
    const firstExpMs = Date.parse(licAfterCreate.expires_at);

    // 3) Compra Order Bump Vídeo -> adiciona upgrade sem mudar plano
    const bumpRes = await fetch(`${baseUrl}${hookPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "OrderPaid",
        data: {
          id: "APX-101",
          total: 97.0,
          payment_type: "credit_card",
          customer: { firstname: "Ana", lastname: "Paula", email: "ana.appmax@exemplo.invalid" },
          bundles: [{ id: "B2", name: "Bump Video", products: [{ sku: "SKU_BUMP_VIDEO", name: "Pack Vídeo" }] }],
        },
      }),
    });
    assert.equal((await bumpRes.json()).action, "issued_or_updated");
    const licAfterBump = licenseHub.findLicenseByKey(licKey);
    assert.equal(licAfterBump.plan_tier, "agencia_ilimitada");
    assert.deepEqual(licAfterBump.upgrades, ["video"]);

    // 4) Compra acidental de plano inferior (SKU_AG10) -> NÃO faz downgrade de agencia_ilimitada!
    await fetch(`${baseUrl}${hookPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "OrderPaid",
        data: {
          id: "APX-102",
          total: 497.0,
          customer: { firstname: "Ana", lastname: "Paula", email: "ana.appmax@exemplo.invalid" },
          bundles: [{ id: "B3", name: "Agencia 10", products: [{ sku: "SKU_AG10", name: "Agência 10" }] }],
        },
      }),
    });
    assert.equal(licenseHub.findLicenseByKey(licKey).plan_tier, "agencia_ilimitada");

    // 5) Reembolso apenas do Order Bump (APX-101) -> remove somente 'video' e mantém licença ACTIVE
    const refBumpRes = await fetch(`${baseUrl}${hookPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "OrderRefunded",
        data: {
          id: "APX-101",
          customer: { email: "ana.appmax@exemplo.invalid" },
          bundles: [{ products: [{ sku: "SKU_BUMP_VIDEO" }] }],
        },
      }),
    });
    const refBumpJson = await refBumpRes.json();
    assert.equal(refBumpJson.action, "revoked");
    assert.equal(refBumpJson.revocationScope, "upgrade");
    const licAfterRefBump = licenseHub.findLicenseByKey(licKey);
    assert.equal(licAfterRefBump.status, "active");
    assert.deepEqual(licAfterRefBump.upgrades, []);

    // 6) Renovação com durationDays = 30 estende expires_at
    await fetch(`${baseUrl}${hookPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "OrderPaid",
        data: {
          id: "APX-103-RENEW",
          total: 997.0,
          customer: { email: "ana.appmax@exemplo.invalid" },
          bundles: [{ products: [{ sku: "SKU_ILIM" }] }],
        },
      }),
    });
    const licRenewed = licenseHub.findLicenseByKey(licKey);
    assert.ok(Date.parse(licRenewed.expires_at) > firstExpMs + 25 * 86400000);
  });

  it("Fila de Retry Automático recupera falha temporária de SMTP ao processar fila", async () => {
    const { baseUrl, cookie, licenseHub, sentEmails } = await startServer({ failEmailsOnce: true });

    const createRes = await fetch(`${baseUrl}/api/admin/licenses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        email: "retry@exemplo.invalid",
        customer_name: "Cliente Retry",
        plan_tier: "individual",
        send_email: true,
      }),
    });
    const created = await createRes.json();
    assert.equal(created.notifications.email.status, "error");
    assert.equal(sentEmails.length, 0);

    const queueJson = await (
      await fetch(`${baseUrl}/api/admin/notifications/queue`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(queueJson.queue.length, 1);
    assert.equal(queueJson.queue[0].status, "pending");

    const retryRes = await fetch(`${baseUrl}/api/admin/notifications/retry-due`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ force_now: true }),
    });
    const retryJson = await retryRes.json();
    assert.equal(retryJson.sent, 1);
    assert.equal(sentEmails.length, 1);
    assert.equal(licenseHub.findLicenseByKey(created.license.license_key).last_email_status, "sent");
  });
});
