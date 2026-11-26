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

    // Verifica no-store e injeção de BUILD_ID em HTML e JS
    const rootRes = await fetch(`${baseUrl}/`);
    assert.equal(rootRes.status, 200);
    assert.match(rootRes.headers.get("cache-control") || "", /no-store/);
    const rootHtml = await rootRes.text();
    assert.doesNotMatch(rootHtml, /__BUILD_ID__/);
    assert.match(rootHtml, /window\.__PAINEL_BUILD__/);

    const jsRes = await fetch(`${baseUrl}/js/views-webhooks.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get("cache-control") || "", /no-store/);
  });

  it("Token/Secret informado no Passo 1 gera URL limpa e autentica via header ou body (Greenn)", async () => {
    const { baseUrl, cookie } = await startServer();

    const createRes = await fetch(`${baseUrl}/api/admin/integrations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        platform: "greenn",
        name: "Greenn Token Usuario",
        deliveryMode: "direct",
        fixedPlanTier: "individual",
        headerSecret: "grn_secret_usuario_999",
      }),
    });
    assert.equal(createRes.status, 201);
    const { integration } = await createRes.json();
    assert.equal(integration.hasHeaderSecret, true);
    assert.equal(integration.authMode, "header_secret");
    assert.doesNotMatch(integration.webhookUrl, /\?token=/);

    const cleanPath = new URL(integration.webhookUrl).pathname;

    // Sem token deve retornar 401
    const unauth = await fetch(`${baseUrl}${cleanPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_status: "paid" }),
    });
    assert.equal(unauth.status, 401);

    // Escuta + header x-greenn-token captura evento de teste
    await fetch(`${baseUrl}/api/admin/integrations/${integration.id}/listen`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ action: "start" }),
    });
    const testRes = await fetch(`${baseUrl}${cleanPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-greenn-token": "grn_secret_usuario_999" },
      body: JSON.stringify({
        current_status: "paid",
        sale: { id: "GRN-T9", amount: 197.0 },
        client: { name: "Cliente Token", email: "token.greenn@exemplo.invalid" },
      }),
    });
    assert.equal(testRes.status, 200);
    assert.equal((await testRes.json()).mode, "test");

    const listenState = await (
      await fetch(`${baseUrl}/api/admin/integrations/${integration.id}/listen`, { headers: { Cookie: cookie } })
    ).json();
    await fetch(`${baseUrl}/api/admin/integrations/${integration.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ isActive: true, fieldMapping: listenState.suggestedMapping }),
    });

    // Venda real autenticando via token no body (padrão de vários checkouts)
    const saleRes = await fetch(`${baseUrl}${cleanPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "grn_secret_usuario_999",
        current_status: "paid",
        sale: { id: "GRN-REAL-9", amount: 197.0 },
        client: { name: "Cliente Token", email: "token.greenn@exemplo.invalid" },
      }),
    });
    const saleJson = await saleRes.json();
    assert.equal(saleRes.status, 200);
    assert.equal(saleJson.action, "issued_or_updated");
    assert.match(saleJson.license_key, /^CRIA-IND-/);
  });

  it("Grupo de suporte configurável aparece no e-mail de licença, no preview e no portal /api/delivery/:token", async () => {
    const { baseUrl, cookie, sentEmails } = await startServer();

    // URL inválida (javascript:) deve ser sanitizada para vazio
    const badCfgRes = await fetch(`${baseUrl}/api/admin/notifications/email-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        supportGroupUrl: "javascript:alert(1)",
        supportGroupLabel: "Comunidade VIP",
      }),
    });
    assert.equal(badCfgRes.status, 200);
    const badCfgJson = await badCfgRes.json();
    assert.equal(badCfgJson.email.supportGroupUrl, "");
    assert.equal(badCfgJson.email.supportGroupLabel, "Comunidade VIP");

    // Salva link válido do Grupo de Suporte
    const supportUrl = "https://chat.whatsapp.com/ExemploSuporte123";
    const supportLabel = "Entrar no Grupo VIP de Alunos";
    const cfgRes = await fetch(`${baseUrl}/api/admin/notifications/email-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        supportGroupUrl: supportUrl,
        supportGroupLabel: supportLabel,
      }),
    });
    assert.equal(cfgRes.status, 200);
    const cfgJson = await cfgRes.json();
    assert.equal(cfgJson.email.supportGroupUrl, supportUrl);
    assert.equal(cfgJson.email.supportGroupLabel, supportLabel);

    const getCfgRes = await fetch(`${baseUrl}/api/admin/notifications/config`, {
      headers: { Cookie: cookie },
    });
    const getCfgJson = await getCfgRes.json();
    assert.equal(getCfgJson.email.supportGroupUrl, supportUrl);
    assert.equal(getCfgJson.email.supportGroupLabel, supportLabel);

    // Emite licença manual com envio de e-mail
    const issueRes = await fetch(`${baseUrl}/api/admin/licenses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        email: "suporte.aluno@exemplo.invalid",
        customer_name: "Aluno Suporte",
        plan_tier: "individual",
        send_email: true,
      }),
    });
    assert.ok(issueRes.ok, `Esperado HTTP 2xx, recebido ${issueRes.status}`);
    const issued = await issueRes.json();
    assert.equal(sentEmails.length, 1);
    assert.match(sentEmails[0].html, /https:\/\/chat\.whatsapp\.com\/ExemploSuporte123/);
    assert.match(sentEmails[0].html, /Entrar no Grupo VIP de Alunos/);
    assert.match(sentEmails[0].text, /Entrar no Grupo VIP de Alunos: https:\/\/chat\.whatsapp\.com\/ExemploSuporte123/);

    // Preview para license_issued inclui o link; para license_revoked omite
    const prevIssued = await (
      await fetch(`${baseUrl}/api/admin/notifications/preview-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ event_type: "license_issued" }),
      })
    ).json();
    assert.match(prevIssued.html, /https:\/\/chat\.whatsapp\.com\/ExemploSuporte123/);

    const prevRevoked = await (
      await fetch(`${baseUrl}/api/admin/notifications/preview-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ event_type: "license_revoked" }),
      })
    ).json();
    assert.doesNotMatch(prevRevoked.html, /ExemploSuporte123/);

    // Portal público de entrega expõe o grupo de suporte
    const deliveryRes = await fetch(`${baseUrl}/api/delivery/${issued.license.delivery_token}`);
    assert.equal(deliveryRes.status, 200);
    const deliveryJson = await deliveryRes.json();
    assert.equal(deliveryJson.delivery.support_group_url, supportUrl);
    assert.equal(deliveryJson.delivery.support_group_label, supportLabel);
  });

  it("DELETE /api/admin/licenses/:key remove cliente, revoga acesso, zera faturamento e preserva outras licenças", async () => {
    const { baseUrl, cookie } = await startServer();

    // Cria integração Greenn ativa com venda real de R$ 197,00
    const createdIntRes = await fetch(`${baseUrl}/api/admin/integrations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        platform: "greenn",
        name: "Greenn Delecao",
        deliveryMode: "direct",
        fixedPlanTier: "individual",
        headerSecret: "grn_del_secret_123",
        isActive: true,
        fieldMapping: {
          email: "client.email",
          name: "client.name",
          statusField: "current_status",
          externalId: "sale.id",
          amountField: "sale.amount",
          paymentMethodField: "sale.method",
        },
      }),
    });
    assert.equal(createdIntRes.status, 201);
    const { integration } = await createdIntRes.json();

    const webhookPath = new URL(integration.webhookUrl).pathname;
    const saleRes = await fetch(`${baseUrl}${webhookPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-greenn-token": "grn_del_secret_123" },
      body: JSON.stringify({
        current_status: "paid",
        sale: { id: "GRN-DEL-1", amount: 197.0, method: "PIX" },
        client: { name: "Cliente Deletavel", email: "deletar.cliente@exemplo.invalid" },
      }),
    });
    assert.equal(saleRes.status, 200);
    const saleJson = await saleRes.json();
    const targetKey = saleJson.license_key;
    assert.match(targetKey, /^CRIA-IND-/);

    // Ativa uma máquina e consulta token de entrega
    const activateRes = await fetch(`${baseUrl}/api/licenses/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        license_key: targetKey,
        email: "deletar.cliente@exemplo.invalid",
        machine_id: "pc-del-01",
        hostname: "PC-TESTE",
        os_platform: "win32",
      }),
    });
    assert.equal(activateRes.status, 200);

    const detailsBefore = await (
      await fetch(`${baseUrl}/api/admin/licenses/${targetKey}/details`, { headers: { Cookie: cookie } })
    ).json();
    const deliveryToken = detailsBefore.license.delivery_token;
    assert.ok(deliveryToken);

    const salesBefore = await (
      await fetch(`${baseUrl}/api/admin/analytics/sales?range=all`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(salesBefore.kpis.grossRevenueCents, 19700);
    assert.equal(salesBefore.kpis.approvedCount, 1);
    assert.equal(salesBefore.kpis.totalLicenses, 1);

    // Deleta completamente a licença
    const delRes = await fetch(`${baseUrl}/api/admin/licenses/${encodeURIComponent(targetKey)}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    assert.equal(delRes.status, 200);
    const delJson = await delRes.json();
    assert.equal(delJson.ok, true);
    assert.equal(delJson.deleted.license_key, targetKey);
    assert.ok(delJson.deleted.removed.machines >= 1);
    assert.ok(delJson.deleted.removed.transactions >= 1);
    assert.ok(delJson.deleted.removed.webhookDeliveries >= 1);
    assert.ok(delJson.deleted.removed.notificationLogs >= 1);

    // Tudo ligado à licença deve retornar 404 e faturamento deve zerar
    const detailsAfter = await fetch(`${baseUrl}/api/admin/licenses/${targetKey}/details`, { headers: { Cookie: cookie } });
    assert.equal(detailsAfter.status, 404);

    const hbAfter = await fetch(`${baseUrl}/api/licenses/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: targetKey, machine_id: "pc-del-01" }),
    });
    assert.equal(hbAfter.status, 404);

    const deliveryAfter = await fetch(`${baseUrl}/api/delivery/${deliveryToken}`);
    assert.equal(deliveryAfter.status, 404);

    const salesAfter = await (
      await fetch(`${baseUrl}/api/admin/analytics/sales?range=all`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(salesAfter.kpis.grossRevenueCents, 0);
    assert.equal(salesAfter.kpis.netRevenueCents, 0);
    assert.equal(salesAfter.kpis.approvedCount, 0);
    assert.equal(salesAfter.kpis.totalLicenses, 0);

    // Segunda deleção deve retornar 404
    const delAgain = await fetch(`${baseUrl}/api/admin/licenses/${encodeURIComponent(targetKey)}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    assert.equal(delAgain.status, 404);

    // Cria 2 licenças manuais com valor pago para o mesmo e-mail; deletar 1 deve preservar a 2ª e seu valor
    const lic1Res = await fetch(`${baseUrl}/api/admin/licenses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        email: "duas.licencas@exemplo.invalid",
        customer_name: "Duas Licenças",
        plan_tier: "individual",
        amount_cents: 10000,
        force_new: true,
      }),
    });
    const lic2Res = await fetch(`${baseUrl}/api/admin/licenses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        email: "duas.licencas@exemplo.invalid",
        customer_name: "Duas Licenças",
        plan_tier: "agencia_10",
        amount_cents: 25000,
        force_new: true,
      }),
    });
    const lic1 = (await lic1Res.json()).license;
    const lic2 = (await lic2Res.json()).license;

    const del1Res = await fetch(`${baseUrl}/api/admin/licenses/${encodeURIComponent(lic1.license_key)}/delete`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    assert.equal(del1Res.status, 200);

    const detailsLic2 = await fetch(`${baseUrl}/api/admin/licenses/${lic2.license_key}/details`, { headers: { Cookie: cookie } });
    assert.equal(detailsLic2.status, 200);

    const salesFinal = await (
      await fetch(`${baseUrl}/api/admin/analytics/sales?range=all`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(salesFinal.kpis.grossRevenueCents, 25000);
    assert.equal(salesFinal.kpis.approvedCount, 1);
    assert.equal(salesFinal.kpis.totalLicenses, 1);
  });

  it("Deduplicação de eventos de aprovação (Appmax OrderPaid + OrderApproved) e exclusão de log financeiro preservando licença", async () => {
    const { baseUrl, cookie, sentEmails } = await startServer();

    const createdIntRes = await fetch(`${baseUrl}/api/admin/integrations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        platform: "appmax",
        name: "Appmax Dedup",
        deliveryMode: "direct",
        fixedPlanTier: "agencia_ilimitada",
        isActive: true,
        fieldMapping: {
          email: "data.customer.email",
          firstName: "data.customer.firstname",
          lastName: "data.customer.lastname",
          statusField: "event",
          externalId: "data.id",
          amountField: "data.total",
          paymentMethodField: "data.payment_type",
        },
      }),
    });
    assert.equal(createdIntRes.status, 201);
    const { integration } = await createdIntRes.json();
    const webhookUrl = new URL(integration.webhookUrl);
    const hookEndpoint = `${baseUrl}${webhookUrl.pathname}${webhookUrl.search}`;

    // 1. Primeiro evento: OrderPaid
    const paidRes = await fetch(hookEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "OrderPaid",
        data: {
          id: "134304273",
          total: 125.98,
          payment_type: "CreditCard",
          customer: { firstname: "Jose", lastname: "Barreto", email: "jose.appmax@exemplo.invalid" },
        },
      }),
    });
    assert.equal(paidRes.status, 200);
    const paidJson = await paidRes.json();
    assert.equal(paidJson.action, "issued_or_updated");
    assert.match(paidJson.license_key, /^CRIA-AGIL-/);
    assert.equal(sentEmails.length, 1);

    // 2. Segundo evento da mesma compra: OrderApproved (mesmo transactionId) -> deve deduplicar
    const approvedRes = await fetch(hookEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "OrderApproved",
        data: {
          id: "134304273",
          total: 125.98,
          payment_type: "CreditCard",
          customer: { firstname: "Jose", lastname: "Barreto", email: "jose.appmax@exemplo.invalid" },
        },
      }),
    });
    assert.equal(approvedRes.status, 200);
    const approvedJson = await approvedRes.json();
    assert.equal(approvedJson.idempotent, true);
    assert.equal(approvedJson.deduplicated, true);
    assert.equal(approvedJson.license_key, paidJson.license_key);
    assert.equal(sentEmails.length, 1);

    const salesAfterDedup = await (
      await fetch(`${baseUrl}/api/admin/analytics/sales?range=all`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(salesAfterDedup.kpis.grossRevenueCents, 12598);
    assert.equal(salesAfterDedup.kpis.approvedCount, 1);

    // 3. Envia segunda venda distinta (134304999) e testa exclusão apenas do registro financeiro preservando a licença
    const paid2Res = await fetch(hookEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "OrderPaid",
        data: {
          id: "134304999",
          total: 125.98,
          payment_type: "CreditCard",
          customer: { firstname: "Jose", lastname: "Barreto", email: "jose.appmax@exemplo.invalid" },
        },
      }),
    });
    assert.equal(paid2Res.status, 200);
    const paid2Json = await paid2Res.json();

    const salesBeforeDel = await (
      await fetch(`${baseUrl}/api/admin/analytics/sales?range=all`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(salesBeforeDel.kpis.grossRevenueCents, 25196);
    assert.equal(salesBeforeDel.kpis.approvedCount, 2);

    const delLogRes = await fetch(`${baseUrl}/api/admin/webhooks/deliveries/${encodeURIComponent(paid2Json.id)}/delete`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    assert.equal(delLogRes.status, 200);
    const delLogJson = await delLogRes.json();
    assert.equal(delLogJson.ok, true);

    const getDeletedLog = await fetch(`${baseUrl}/api/admin/webhooks/deliveries/${encodeURIComponent(paid2Json.id)}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(getDeletedLog.status, 404);

    const salesAfterDel = await (
      await fetch(`${baseUrl}/api/admin/analytics/sales?range=all`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(salesAfterDel.kpis.grossRevenueCents, 12598);
    assert.equal(salesAfterDel.kpis.approvedCount, 1);

    // A licença do cliente permanece ativa após remover o registro financeiro
    const licDetails = await (
      await fetch(`${baseUrl}/api/admin/licenses/${encodeURIComponent(paidJson.license_key)}/details`, {
        headers: { Cookie: cookie },
      })
    ).json();
    assert.equal(licDetails.license.status, "active");

    // 4. Edita o valor financeiro do registro restante de R$ 125,98 para R$ 97,00 com sincronização na licença
    const updRes = await fetch(`${baseUrl}/api/admin/webhooks/deliveries/${encodeURIComponent(paidJson.id)}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        amount_cents: 9700,
        currency: "BRL",
        payment_method: "credit_card",
        sync_license: true,
      }),
    });
    assert.equal(updRes.status, 200);
    const updJson = await updRes.json();
    assert.equal(updJson.ok, true);
    assert.equal(updJson.delivery.amount_cents, 9700);

    const salesAfterEdit = await (
      await fetch(`${baseUrl}/api/admin/analytics/sales?range=all`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(salesAfterEdit.kpis.grossRevenueCents, 9700);
    assert.equal(salesAfterEdit.kpis.netRevenueCents, 9700);

    const licAfterEdit = await (
      await fetch(`${baseUrl}/api/admin/licenses/${encodeURIComponent(paidJson.license_key)}/details`, {
        headers: { Cookie: cookie },
      })
    ).json();
    assert.equal(licAfterEdit.license.amount_cents, 9700);
    const tx134 = licAfterEdit.transactions.find((t) => t.transaction_id === "134304273");
    assert.ok(tx134);
    assert.equal(tx134.amount_cents, 9700);
  });
});
