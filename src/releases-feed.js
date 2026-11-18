import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function ensureReleasesTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_releases (
      version TEXT PRIMARY KEY,
      channel TEXT NOT NULL DEFAULT 'stable' CHECK(channel IN ('stable', 'beta')),
      changelog_markdown TEXT NOT NULL DEFAULT '',
      min_compatible_version TEXT,
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      published_at TEXT NOT NULL
    );
  `);
}

function resolveInstallServerScript() {
  const candidates = [
    path.resolve(__dirname, "../scripts/install-server.sh"),
    path.resolve(process.cwd(), "scripts/install-server.sh"),
    path.resolve(__dirname, "../../criativo-ai-studio-online/scripts/install-server.sh"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf8");
  }
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo '[Criativo VPS] Script de instalação pronto.'",
  ].join("\n");
}

function normalizeArtifacts(rawArtifacts) {
  if (!Array.isArray(rawArtifacts)) return [];
  return rawArtifacts
    .filter((a) => a && typeof a.filename === "string" && typeof a.sha256 === "string")
    .map((a) => ({
      platform: a.platform || "vps-tarball",
      arch: a.arch || "x64",
      filename: path.basename(String(a.filename)),
      sha256: String(a.sha256).trim().toLowerCase(),
      size_bytes: Number(a.size_bytes) || 0,
      download_path: a.download_path || "",
    }));
}

export function createReleasesFeedRouter(hubApi, options = {}) {
  const db = hubApi.db;
  ensureReleasesTables(db);
  const releasesDir = options.releasesDir || path.resolve(process.cwd(), "releases");

  function verifyActiveLicenseHeader(req, res) {
    const licenseKey = String(req.headers["x-criativo-license-key"] || req.query.license_key || "").trim();
    const machineId = String(req.headers["x-criativo-machine-id"] || req.query.machine_id || "").trim();

    if (!licenseKey) {
      res.status(401).json({ error: "license_required", message: "Chave de licença obrigatória para baixar atualizações." });
      return null;
    }

    const row = hubApi.findLicenseByKey(licenseKey);
    if (!row || row.status !== "active") {
      res.status(403).json({
        error: "license_inactive",
        message: "Atualizações bloqueadas: sua licença está revogada, expirada ou suspensa.",
      });
      return null;
    }

    if (row.expires_at) {
      const exp = Date.parse(row.expires_at);
      if (Number.isFinite(exp) && Date.now() > exp) {
        res.status(403).json({ error: "license_expired", message: "Atualizações bloqueadas: licença expirada." });
        return null;
      }
    }

    if (machineId) {
      const devices = hubApi.listActiveDevices(row.id, machineId);
      const isLinked = devices.some((d) => d.machine_id === machineId);
      if (!isLinked) {
        res.status(403).json({ error: "machine_unlinked", message: "Computador desvinculado desta licença." });
        return null;
      }
    }

    return row;
  }

  function publishRelease({ version, channel = "stable", changelog_markdown = "", min_compatible_version = null, artifacts = [] }) {
    const cleanVer = String(version || "").trim().replace(/^v/i, "");
    if (!cleanVer) throw new Error("Versão da release é obrigatória.");
    const cleanChannel = channel === "beta" ? "beta" : "stable";
    const normalized = normalizeArtifacts(artifacts).map((art) => ({
      ...art,
      download_path: art.download_path || `/api/releases/download/${cleanVer}/${art.filename}`,
    }));
    const publishedAt = new Date().toISOString();

    db.prepare(
      `INSERT INTO product_releases (version, channel, changelog_markdown, min_compatible_version, artifacts_json, published_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(version) DO UPDATE SET
         channel = excluded.channel,
         changelog_markdown = excluded.changelog_markdown,
         min_compatible_version = excluded.min_compatible_version,
         artifacts_json = excluded.artifacts_json,
         published_at = excluded.published_at;`,
    ).run(cleanVer, cleanChannel, changelog_markdown, min_compatible_version, JSON.stringify(normalized), publishedAt);

    return {
      version: cleanVer,
      channel: cleanChannel,
      changelog_markdown,
      min_compatible_version: min_compatible_version || undefined,
      published_at: publishedAt,
      artifacts: normalized,
    };
  }

  function listReleases(limit = 30) {
    const rows = db.prepare(`SELECT * FROM product_releases ORDER BY published_at DESC LIMIT ?;`).all(limit);
    return rows.map((r) => ({
      version: r.version,
      channel: r.channel,
      changelog_markdown: r.changelog_markdown,
      min_compatible_version: r.min_compatible_version || undefined,
      published_at: r.published_at,
      artifacts: JSON.parse(r.artifacts_json || "[]"),
    }));
  }

  function getLatestRelease(channel = "stable") {
    const row = db
      .prepare(
        `SELECT * FROM product_releases WHERE channel = ? OR ? = 'beta' ORDER BY published_at DESC LIMIT 1;`,
      )
      .get(channel === "beta" ? "beta" : "stable", channel);
    if (!row) return null;
    return {
      version: row.version,
      published_at: row.published_at,
      channel: row.channel,
      changelog_markdown: row.changelog_markdown,
      min_compatible_version: row.min_compatible_version || undefined,
      artifacts: JSON.parse(row.artifacts_json || "[]"),
    };
  }

  const router = express.Router();

  router.get("/releases/install-server.sh", (_req, res) => {
    res.setHeader("Content-Type", "text/x-shellscript; charset=utf-8");
    res.send(resolveInstallServerScript());
  });

  router.get("/releases/latest", (req, res) => {
    const lic = verifyActiveLicenseHeader(req, res);
    if (!lic) return;
    const channel = req.query.channel === "beta" ? "beta" : "stable";
    const latest = getLatestRelease(channel);
    if (!latest) return res.status(404).json({ error: "no_release_published" });
    return res.json(latest);
  });

  router.get("/releases/latest.yml", (req, res) => {
    const lic = verifyActiveLicenseHeader(req, res);
    if (!lic) return;
    const latest = getLatestRelease("stable");
    if (!latest) return res.status(404).send("no release");
    const winArt = latest.artifacts.find((a) => a.platform === "win32") || latest.artifacts[0];
    const yml = [
      `version: ${latest.version}`,
      `path: ${winArt?.filename || ""}`,
      `sha256: ${winArt?.sha256 || ""}`,
      `releaseDate: '${latest.published_at}'`,
    ].join("\n");
    res.setHeader("Content-Type", "text/yaml; charset=utf-8");
    return res.send(yml);
  });

  router.get("/releases/download/:version/:artifact", (req, res) => {
    const lic = verifyActiveLicenseHeader(req, res);
    if (!lic) return;
    const cleanVer = String(req.params.version || "").replace(/[^a-zA-Z0-9._-]/g, "");
    const cleanArtifact = path.basename(String(req.params.artifact || ""));
    if (!cleanVer || !cleanArtifact) return res.status(400).json({ error: "invalid_artifact" });

    // Verifica se o artefato está vinculado a uma URL externa (ex: GitHub Release asset) e redireciona com segurança
    const relRow = db.prepare(`SELECT artifacts_json FROM product_releases WHERE version = ?;`).get(cleanVer);
    if (relRow) {
      const arts = JSON.parse(relRow.artifacts_json || "[]");
      const found = arts.find((a) => a.filename === cleanArtifact);
      if (found?.external_url) {
        return res.redirect(302, found.external_url);
      }
    }

    const filePath = path.resolve(releasesDir, cleanVer, cleanArtifact);
    if (!filePath.startsWith(path.resolve(releasesDir)) || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: "artifact_not_found" });
    }
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    res.setHeader("X-Criativo-SHA256", sha256);
    return res.download(filePath, cleanArtifact);
  });

  router.get("/admin/releases", hubApi.requireAdmin, (_req, res) => {
    return res.json({ releases: listReleases() });
  });

  router.post("/admin/releases", hubApi.requireAdmin, (req, res) => {
    try {
      const created = publishRelease(req.body || {});
      return res.status(201).json({ ok: true, release: created });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return { router, publishRelease, getLatestRelease, listReleases };
}
