import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { createLicenseHub } from "./src/license-hub.js";
import { createSalesWebhooksRouter } from "./src/webhooks-sales.js";
import { createIntegrationsWebhooksRouter } from "./src/webhooks-integrations.js";

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    // .env ausente
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version || "1.0.4";
  } catch {
    return "1.0.4";
  }
})();

export function createPainelApp(options = {}) {
  const PUBLIC_DIR = options.publicDir || path.join(__dirname, "public");
  const app = express();

  app.set("trust proxy", 1);
  const captureWebhookRawBody = (req, _res, buf) => {
    if (req.originalUrl?.startsWith("/api/webhooks/")) {
      req.rawBody = buf.toString("utf8");
    }
  };
  app.use(express.json({ limit: "4mb", verify: captureWebhookRawBody }));
  app.use(express.urlencoded({ extended: true, limit: "4mb", verify: captureWebhookRawBody }));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", version: PKG_VERSION, service: "criativo-ai-studio-painel", timestamp: new Date().toISOString() });
  });

  const licenseHub = createLicenseHub(options.licenseHub || {});
  const salesRouter = createSalesWebhooksRouter(licenseHub, options.salesWebhooks || {});
  const integrationsRouter = createIntegrationsWebhooksRouter(licenseHub, options.integrations || {});

  app.use("/api", licenseHub.router);
  app.use("/api", integrationsRouter);
  app.use("/api", salesRouter);

  app.get("/api/delivery/:token", (req, res) => {
    const token = String(req.params.token || "").trim();
    if (!token) return res.status(400).json({ error: "missing_token" });
    const row = licenseHub.db.prepare(`SELECT * FROM licenses WHERE delivery_token = ? LIMIT 1;`).get(token);
    if (!row) return res.status(404).json({ error: "not_found" });
    const lic = licenseHub.findLicenseByKey(row.license_key);
    const devices = licenseHub.listActiveDevices(row.id);
    const emailCfg = licenseHub.emailDispatcher.getPublicConfig();
    const catalog = licenseHub.getPlanCatalog();
    const planMeta = catalog[lic.plan_tier] || { nome_exibicao: lic.plan_tier };
    return res.json({
      ok: true,
      delivery: {
        license_key: lic.license_key,
        customer_name: lic.customer_name || "",
        customer_email: lic.customer_email,
        plan_tier: lic.plan_tier,
        plan_name: planMeta.nome_exibicao,
        status: lic.status,
        max_servers: lic.max_servers,
        max_machines: lic.custom_max_machines ?? lic.max_machines,
        active_machines: devices.length,
        upgrades: lic.upgrades,
        expires_at: lic.expires_at,
        download_links: emailCfg.downloadLinks,
      },
    });
  });

  app.get("/entrega/:token", (_req, res) => {
    const entregaPath = path.join(PUBLIC_DIR, "entrega.html");
    if (fs.existsSync(entregaPath)) {
      return res.sendFile(entregaPath);
    }
    return res.status(404).json({ error: "delivery_page_not_found" });
  });

  if (fs.existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR, { maxAge: "1h" }));
  }

  app.get("*", (req, res) => {
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ error: "not_found" });
    }
    if (
      req.path.startsWith("/js/") ||
      req.path.startsWith("/styles/") ||
      /\.(js|mjs|css|map|png|svg|ico|webp|jpg|jpeg|woff2?)$/i.test(req.path)
    ) {
      return res.status(404).json({ error: "asset_not_found" });
    }
    const indexPath = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    return res.status(404).json({ error: "ui_not_found" });
  });

  return { app, licenseHub };
}

const isEntryPoint =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isEntryPoint) {
  const { app } = createPainelApp({
    licenseHub: {
      enableAutoGithubSync: process.env.PAINEL_DISABLE_AUTO_RELEASE_SYNC !== "1",
    },
  });
  const PORT = Number(process.env.PORT) || 3009;
  const HOST = process.env.HOST || "0.0.0.0";
  app.listen(PORT, HOST, () => {
    console.log(`[Criativo Painel] Servidor ativo em http://${HOST}:${PORT}`);
  });
}
