import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { createLicenseHub } from "./src/license-hub.js";
import { createSalesWebhooksRouter } from "./src/webhooks-sales.js";

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    // .env ausente
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createPainelApp(options = {}) {
  const PUBLIC_DIR = options.publicDir || path.join(__dirname, "public");
  const app = express();

  app.set("trust proxy", 1);
  app.use(
    express.json({
      limit: "4mb",
      verify: (req, _res, buf) => {
        if (req.originalUrl?.startsWith("/api/webhooks/")) {
          req.rawBody = buf.toString("utf8");
        }
      },
    }),
  );

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "criativo-ai-studio-painel", timestamp: new Date().toISOString() });
  });

  const licenseHub = createLicenseHub(options.licenseHub || {});
  const salesRouter = createSalesWebhooksRouter(licenseHub, options.salesWebhooks || {});

  app.use("/api", licenseHub.router);
  app.use("/api", salesRouter);

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
