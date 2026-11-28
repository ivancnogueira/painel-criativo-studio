import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPainelApp } from "../server.js";

async function startTempPainel() {
  const dir = mkdtempSync(join(tmpdir(), "painel-relay-test-"));
  const { app, licenseHub } = createPainelApp({
    licenseHub: { dataDir: dir },
  });
  const server = await new Promise((resolveStart) => {
    const srv = app.listen(0, "127.0.0.1", () => resolveStart(srv));
  });
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    licenseHub,
    async close() {
      await new Promise((r) => server.close(() => r()));
      licenseHub.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("DM47-03 Painel Relay: registra canal com licenca ativa, responde hub.challenge, enfileira raw e apaga no ACK sem guardar tokens Meta", async () => {
  const painel = await startTempPainel();
  try {
    const lic = painel.licenseHub.issueOrUpdateLicenseFromSale({
      provider: "manual",
      transactionId: "tx-relay-01",
      email: "cliente@exemplo.invalid",
      customerName: "Cliente Exemplo",
      planTier: "individual",
      durationDays: 365,
    });
    const licenseKey = lic.license_key;

    // 1. Registra canal autenticado pela licenca
    const regRes = await fetch(`${painel.baseUrl}/api/relay/meta/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: licenseKey }),
    });
    assert.equal(regRes.status, 200);
    const regJson = await regRes.json();
    assert.equal(regJson.ok, true);
    assert.ok(regJson.channel_id.startsWith("mrelay_"));
    assert.ok(regJson.channel_secret.startsWith("rsec_"));

    // Licenca invalida deve falhar
    const badReg = await fetch(`${painel.baseUrl}/api/relay/meta/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: "CHAVE-INEXISTENTE" }),
    });
    assert.equal(badReg.status, 404);

    // 2. Handshake Meta hub.challenge
    const challengeRes = await fetch(
      `${painel.baseUrl}${regJson.webhook_url_path}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(regJson.verify_token)}&hub.challenge=123456789`
    );
    assert.equal(challengeRes.status, 200);
    assert.equal(await challengeRes.text(), "123456789");

    // 3. Ingestao Meta preservando rawBody e assinatura
    const samplePayload = JSON.stringify({ object: "instagram", entry: [{ id: "1", changes: [] }] });
    const hookRes = await fetch(`${painel.baseUrl}${regJson.webhook_url_path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      body: samplePayload,
    });
    assert.equal(hookRes.status, 200);
    const hookJson = await hookRes.json();
    assert.equal(hookJson.ok, true);

    // 4. Pull autenticado + ACK apagando da fila
    const pullRes = await fetch(`${painel.baseUrl}/api/relay/meta/pull`, {
      headers: {
        "x-relay-channel-id": regJson.channel_id,
        "x-relay-secret": regJson.channel_secret,
      },
    });
    const pullJson = await pullRes.json();
    assert.equal(pullJson.items.length, 1);
    assert.equal(pullJson.items[0].raw_body, samplePayload);
    assert.equal(pullJson.items[0].signature_header, "sha256=deadbeef");

    const ackRes = await fetch(`${painel.baseUrl}/api/relay/meta/ack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-relay-channel-id": regJson.channel_id,
        "x-relay-secret": regJson.channel_secret,
      },
      body: JSON.stringify({ ids: [pullJson.items[0].id] }),
    });
    const ackJson = await ackRes.json();
    assert.equal(ackJson.deleted, 1);

    const pullAfter = await fetch(`${painel.baseUrl}/api/relay/meta/pull`, {
      headers: {
        "x-relay-channel-id": regJson.channel_id,
        "x-relay-secret": regJson.channel_secret,
      },
    });
    const pullAfterJson = await pullAfter.json();
    assert.equal(pullAfterJson.items.length, 0);

    // Garante ausencia de colunas de segredos Meta nas tabelas do Relay
    const cols = painel.licenseHub.db
      .prepare("PRAGMA table_info(meta_relay_channels);")
      .all()
      .map((c) => c.name);
    assert.equal(cols.some((c) => /access_token|app_secret/i.test(c)), false);
  } finally {
    await painel.close();
  }
});
