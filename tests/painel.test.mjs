import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { canonicalizePayload } from "../src/license-hub.js";
import { createPainelApp } from "../server.js";

describe("Painel Central de Licenças, Auth, Webhooks & Mensageria Oficial", () => {
  const tempDirs = [];
  const cleanupFns = [];

  after(async () => {
    for (const fn of cleanupFns) {
      await fn();
    }
    for (const d of tempDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function startTestServer() {
    const dir = mkdtempSync(join(tmpdir(), "painel-test-"));
    tempDirs.push(dir);
    const generated = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const keys = {
      publicKeyPem: generated.publicKey,
      privateKeyPem: generated.privateKey,
    };

    const sentEmails = [];
    const sentWhatsApps = [];
    const releasesDir = join(dir, "releases");

    const mockTransportFactory = () => ({
      sendMail: async (mail) => {
        sentEmails.push(mail);
        return { messageId: `mock-${Date.now()}` };
      },
    });

    const mockFetch = async (url, init = {}) => {
      const urlStr = String(url);
      if (urlStr.startsWith("https://api.github.com/repos/criativo/demo/releases")) {
        return new Response(
          JSON.stringify({
            tag_name: "v1.2.0",
            prerelease: false,
            body: "- Atualização automática importada",
            assets: [
              {
                name: "CriativoAIStudio-Setup-1.2.0.exe",
                size: 123456,
                browser_download_url: "https://github.com/criativo/demo/releases/download/v1.2.0/CriativoAIStudio-Setup-1.2.0.exe",
              },
              {
                name: "SHA256SUMS.txt",
                size: 128,
                browser_download_url: "https://github.com/criativo/demo/releases/download/v1.2.0/SHA256SUMS.txt",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (urlStr.endsWith("/SHA256SUMS.txt")) {
        return new Response(
          `${"a".repeat(64)}  CriativoAIStudio-Setup-1.2.0.exe\n`,
          { status: 200, headers: { "Content-Type": "text/plain" } }
        );
      }
      sentWhatsApps.push({ url: urlStr, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.mock123" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const { app, licenseHub } = createPainelApp({
      licenseHub: {
        dbPath: join(dir, "painel.db"),
        releasesDir,
        privateKeyPem: keys.privateKeyPem,
        publicKeyPem: keys.publicKeyPem,
        adminEmail: "dono@criativo.test",
        adminPassword: "SenhaForte!2026",
        adminToken: "tok_test_admin",
        sessionSecret: "sess_secret_test",
        emailTransportFactory: mockTransportFactory,
        fetchImpl: mockFetch,
      },
      salesWebhooks: {
        hotmartHottok: "hot_secret_123",
      },
    });

    return new Promise((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const baseUrl = `http://127.0.0.1:${addr.port}`;
        cleanupFns.push(async () => {
          licenseHub.close();
          await new Promise((r) => server.close(r));
        });
        resolve({ baseUrl, keys, licenseHub, sentEmails, sentWhatsApps });
      });
    });
  }

  it("Bloco 1 — Autenticação Login/Senha com cookie HMAC, bloqueio sem sessão e criação manual com envio de E-mail + Standby WhatsApp", async () => {
    const { baseUrl, sentEmails, keys } = await startTestServer();

    // Sem sessão deve retornar 401
    const unauthRes = await fetch(`${baseUrl}/api/admin/licenses`);
    assert.equal(unauthRes.status, 401);

    // Login errado deve retornar 401
    const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dono@criativo.test", password: "errada" }),
    });
    assert.equal(badLogin.status, 401);

    // Login correto gera cookie
    const okLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dono@criativo.test", password: "SenhaForte!2026" }),
    });
    assert.equal(okLogin.status, 200);
    const rawCookie = okLogin.headers.get("set-cookie");
    assert.ok(rawCookie && rawCookie.includes("criativo_painel_session="));
    const cookie = rawCookie.split(";")[0];

    // Configura SMTP no painel
    const saveEmailRes = await fetch(`${baseUrl}/api/admin/notifications/email-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        provider: "smtp",
        smtpHost: "smtp.exemplo.test",
        smtpPort: 465,
        smtpSecure: true,
        smtpUser: "noreply@criativo.test",
        smtpPass: "segredo-smtp",
        fromEmail: "noreply@criativo.test",
      }),
    });
    assert.equal(saveEmailRes.status, 200);

    // Cria licença manualmente pedindo E-mail + WhatsApp (WhatsApp está em standby!)
    const createRes = await fetch(`${baseUrl}/api/admin/licenses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        email: "cliente1@empresa.test",
        customer_name: "Maria Silva",
        customer_phone: "11988887777",
        plan_tier: "agencia_10",
        upgrades: ["bonus"],
        send_email: true,
        send_whatsapp: true,
      }),
    });
    assert.equal(createRes.status, 201);
    const createdJson = await createRes.json();
    assert.match(createdJson.license.license_key, /^CRIA-AG10-/);
    assert.equal(createdJson.notifications.email.ok, true);
    assert.equal(createdJson.notifications.whatsapp.status, "skipped");
    assert.equal(sentEmails.length, 1);
    assert.match(sentEmails[0].html, new RegExp(createdJson.license.license_key));

    // Ativa a licença gerada simulando o App Desktop e valida assinatura Ed25519
    const actRes = await fetch(`${baseUrl}/api/licenses/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        license_key: createdJson.license.license_key,
        email: "cliente1@empresa.test",
        machine_id: "pc-maria-01",
        hostname: "PC-MARIA",
        os_platform: "win32",
      }),
    });
    assert.equal(actRes.status, 200);
    const actJson = await actRes.json();
    assert.equal(actJson.certificate.payload.plan_tier, "agencia_10");
    const sigValid = crypto.verify(
      null,
      Buffer.from(canonicalizePayload(actJson.certificate.payload), "utf8"),
      keys.publicKeyPem,
      Buffer.from(actJson.certificate.signature, "base64url"),
    );
    assert.equal(sigValid, true);
  });

  it("Bloco 2 — Webhook Hotmart cria licença automaticamente, extrai WhatsApp e dispara E-mail + Meta Cloud API Oficial quando ativada", async () => {
    const { baseUrl, sentEmails, sentWhatsApps } = await startTestServer();

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dono@criativo.test", password: "SenhaForte!2026" }),
    });
    const cookie = loginRes.headers.get("set-cookie").split(";")[0];

    // Configura SMTP + Meta Cloud API Oficial
    await fetch(`${baseUrl}/api/admin/notifications/email-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        provider: "smtp",
        smtpHost: "smtp.exemplo.test",
        smtpUser: "noreply@criativo.test",
        smtpPass: "segredo",
        fromEmail: "noreply@criativo.test",
      }),
    });

    const waSave = await fetch(`${baseUrl}/api/admin/notifications/whatsapp-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        provider: "cloud_api",
        cloudPhoneNumberId: "9988776655",
        cloudAccessToken: "EAAG_TOKEN_TEST",
        sendMode: "template",
        templateName: "criativo_entrega_licenca",
        templateLang: "pt_BR",
      }),
    });
    assert.equal(waSave.status, 200);

    // Dispara webhook real simulado da Hotmart
    const whRes = await fetch(`${baseUrl}/api/webhooks/sales?provider=hotmart`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hotmart-Hottok": "hot_secret_123",
      },
      body: JSON.stringify({
        event: "PURCHASE_APPROVED",
        data: {
          purchase: { transaction: "HP-998877" },
          buyer: {
            email: "lucas.agencia@exemplo.test",
            name: "Lucas Oliveira",
            checkout_phone: "(11) 99988-7766",
          },
          product: { id: "PROD_AG_ILIM", name: "CriativoOS Agência Ilimitada + Vídeo" },
        },
      }),
    });
    assert.equal(whRes.status, 200);
    const whJson = await whRes.json();
    assert.equal(whJson.action, "issued_or_updated");
    assert.match(whJson.license_key, /^CRIA-AGIL-/);

    assert.equal(sentEmails.length, 1);
    assert.equal(sentWhatsApps.length, 1);
    assert.match(sentWhatsApps[0].url, /9988776655\/messages$/);
    assert.equal(sentWhatsApps[0].body.to, "5511999887766");
    assert.equal(sentWhatsApps[0].body.type, "template");
    assert.equal(sentWhatsApps[0].body.template.name, "criativo_entrega_licenca");
  });

  it("Bloco 3 — Releases: preserva external_url, publica Hot-Bundle com SHA-256 automático e importa release do GitHub", async () => {
    const { baseUrl } = await startTestServer();

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dono@criativo.test", password: "SenhaForte!2026" }),
    });
    const cookie = loginRes.headers.get("set-cookie").split(";")[0];

    // Cria licença ativa para consultar feed
    const licRes = await fetch(`${baseUrl}/api/admin/licenses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        email: "update@criativo.test",
        customer_name: "Cliente Update",
        plan_tier: "individual",
        send_email: false,
      }),
    });
    const licJson = await licRes.json();
    const licenseKey = licJson.license.license_key;

    // 1) Importar release do GitHub (mockada) + SHA256SUMS.txt
    const ghImport = await fetch(`${baseUrl}/api/admin/releases/import-github`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ repo: "criativo/demo" }),
    });
    assert.equal(ghImport.status, 200);
    const ghJson = await ghImport.json();
    assert.equal(ghJson.draft.version, "1.2.0");
    assert.equal(ghJson.draft.artifacts[0].sha256, "a".repeat(64));
    assert.match(ghJson.draft.artifacts[0].external_url, /^https:\/\/github\.com\/criativo\/demo\//);

    // 2) Publicar release com external_url preservada e conferir redirecionamento 302
    const pubExt = await fetch(`${baseUrl}/api/admin/releases`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        version: ghJson.draft.version,
        channel: ghJson.draft.channel,
        changelog_markdown: ghJson.draft.changelog_markdown,
        artifacts: ghJson.draft.artifacts,
      }),
    });
    assert.equal(pubExt.status, 201);
    const redirRes = await fetch(
      `${baseUrl}/api/releases/download/1.2.0/${ghJson.draft.artifacts[0].filename}`,
      {
        headers: { "X-Criativo-License-Key": licenseKey },
        redirect: "manual",
      }
    );
    assert.equal(redirRes.status, 302);
    assert.equal(redirRes.headers.get("location"), ghJson.draft.artifacts[0].external_url);

    // 3) Publicar Hot-Bundle JSON com cálculo automático de SHA-256 e entrega direta
    const pubHot = await fetch(`${baseUrl}/api/admin/releases`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        version: "1.2.1",
        channel: "stable",
        changelog_markdown: "- Hot-bundle v1.2.1",
        hot_bundle: {
          format: "criativo-update-bundle-v1",
          version: "1.2.1",
          files: [{ path: "apps/web/dist/index.html", base64: Buffer.from("<html>ok</html>").toString("base64") }],
        },
      }),
    });
    assert.equal(pubHot.status, 201);
    const hotData = await pubHot.json();
    assert.equal(hotData.release.artifacts.length, 4);
    assert.equal(hotData.release.artifacts[0].install_mode, "hot_bundle");
    assert.match(hotData.release.artifacts[0].sha256, /^[a-f0-9]{64}$/);

    const dlHot = await fetch(`${baseUrl}/api/releases/download/1.2.1/criativo-update-1.2.1.json`, {
      headers: { "X-Criativo-License-Key": licenseKey },
    });
    assert.equal(dlHot.status, 200);
    assert.equal(dlHot.headers.get("x-criativo-sha256"), hotData.release.artifacts[0].sha256);
    const downloadedBundle = await dlHot.json();
    assert.equal(downloadedBundle.version, "1.2.1");
  });

  it("Bloco 4 — Sync automático do GitHub atualiza o banco e os links dinâmicos de download no E-mail", async () => {
    const { baseUrl, licenseHub } = await startTestServer();

    const synced = await licenseHub.syncLatestReleaseFromGithub({ repo: "criativo/demo" });
    assert.equal(synced.ok, true);
    assert.equal(synced.release.version, "1.2.0");
    assert.equal(synced.release.artifacts[0].sha256, "a".repeat(64));

    const emailCfg = licenseHub.emailDispatcher.getPublicConfig();
    assert.equal(
      emailCfg.downloadLinks.windows,
      "https://github.com/criativo/demo/releases/download/v1.2.0/CriativoAIStudio-Setup-1.2.0.exe"
    );

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dono@criativo.test", password: "SenhaForte!2026" }),
    });
    const cookie = loginRes.headers.get("set-cookie").split(";")[0];

    const syncRes = await fetch(`${baseUrl}/api/releases/sync-webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ repo: "criativo/demo" }),
    });
    assert.equal(syncRes.status, 200);
    const syncJson = await syncRes.json();
    assert.equal(syncJson.ok, true);
    assert.equal(syncJson.release.version, "1.2.0");

    const listAdminRes = await fetch(`${baseUrl}/api/admin/releases`, {
      headers: { Cookie: cookie },
    });
    assert.equal(listAdminRes.status, 200);
    const listAdminJson = await listAdminRes.json();
    assert.ok(typeof listAdminJson.default_github_repo === "string");
    assert.equal(typeof listAdminJson.auto_sync_enabled, "boolean");

    const syncAdminRes = await fetch(`${baseUrl}/api/admin/releases/sync-github`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ repo: "criativo/demo" }),
    });
    assert.equal(syncAdminRes.status, 200);
    const syncAdminJson = await syncAdminRes.json();
    assert.equal(syncAdminJson.ok, true);
    assert.equal(syncAdminJson.release.version, "1.2.0");
  });
});
