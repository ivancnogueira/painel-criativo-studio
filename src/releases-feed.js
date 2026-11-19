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

function sanitizeExternalHttpsUrl(rawUrl) {
  if (typeof rawUrl !== "string") return undefined;
  const trimmed = rawUrl.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizeArtifacts(rawArtifacts) {
  if (!Array.isArray(rawArtifacts)) return [];
  return rawArtifacts
    .filter((a) => a && typeof a.filename === "string" && typeof a.sha256 === "string")
    .map((a) => {
      const externalUrl = sanitizeExternalHttpsUrl(a.external_url);
      const installMode =
        a.install_mode === "hot_bundle" || a.install_mode === "native_installer"
          ? a.install_mode
          : undefined;
      return {
        platform: a.platform || "vps-tarball",
        arch: a.arch || "x64",
        filename: path.basename(String(a.filename)),
        sha256: String(a.sha256).trim().toLowerCase(),
        size_bytes: Number(a.size_bytes) || 0,
        download_path: a.download_path || "",
        ...(externalUrl ? { external_url: externalUrl } : {}),
        ...(installMode ? { install_mode: installMode } : {}),
      };
    });
}

function inferPlatformFromAssetName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".exe") || lower.endsWith(".msi")) {
    return { platform: "win32", arch: lower.includes("arm64") ? "arm64" : "x64", install_mode: "native_installer" };
  }
  if (lower.endsWith(".dmg") || (lower.endsWith(".zip") && (lower.includes("mac") || lower.includes("darwin")))) {
    return {
      platform: "darwin",
      arch: lower.includes("universal") ? "universal" : lower.includes("arm64") ? "arm64" : "x64",
      install_mode: "native_installer",
    };
  }
  if (lower.endsWith(".appimage") || lower.endsWith(".deb")) {
    return { platform: "linux", arch: lower.includes("arm64") ? "arm64" : "x64", install_mode: "native_installer" };
  }
  if (lower.endsWith(".json") && lower.includes("update")) {
    return { platform: "vps-tarball", arch: "universal", install_mode: "hot_bundle" };
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    return { platform: "vps-tarball", arch: "x64", install_mode: "native_installer" };
  }
  return null;
}

function parseSha256SumsText(text) {
  const map = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (m) {
      map.set(path.basename(m[2].trim()), m[1].toLowerCase());
    }
  }
  return map;
}

export function createReleasesFeedRouter(hubApi, options = {}) {
  const db = hubApi.db;
  ensureReleasesTables(db);
  const releasesDir = options.releasesDir || path.resolve(process.cwd(), "releases");
  const fetchImpl = options.fetchImpl || globalThis.fetch;

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

  function publishRelease({ version, channel = "stable", changelog_markdown = "", min_compatible_version = null, artifacts = [], hot_bundle = null }) {
    const cleanVer = String(version || "").trim().replace(/^v/i, "").replace(/[^a-zA-Z0-9._-]/g, "");
    if (!cleanVer) throw new Error("Versão da release é obrigatória.");
    const cleanChannel = channel === "beta" ? "beta" : "stable";

    let mergedArtifacts = Array.isArray(artifacts) ? [...artifacts] : [];
    if (hot_bundle) {
      let bundleObj = hot_bundle;
      if (typeof bundleObj === "string") {
        bundleObj = JSON.parse(bundleObj);
      }
      if (!bundleObj || typeof bundleObj !== "object" || Array.isArray(bundleObj)) {
        throw new Error("Hot-bundle inválido: informe um JSON válido de atualização.");
      }
      if (!bundleObj.version) {
        bundleObj = { ...bundleObj, version: cleanVer };
      }
      const bundleFilename = `criativo-update-${cleanVer}.json`;
      const verDir = path.resolve(releasesDir, cleanVer);
      fs.mkdirSync(verDir, { recursive: true });
      const bundlePath = path.resolve(verDir, bundleFilename);
      const bundleText = JSON.stringify(bundleObj, null, 2);
      const bundleBuf = Buffer.from(bundleText, "utf8");
      fs.writeFileSync(bundlePath, bundleBuf);
      const bundleSha = crypto.createHash("sha256").update(bundleBuf).digest("hex");

      const hotEntries = [
        { platform: "win32", arch: "x64" },
        { platform: "darwin", arch: "universal" },
        { platform: "linux", arch: "x64" },
        { platform: "vps-tarball", arch: "x64" },
      ].map((target) => ({
        platform: target.platform,
        arch: target.arch,
        filename: bundleFilename,
        sha256: bundleSha,
        size_bytes: bundleBuf.length,
        download_path: `/api/releases/download/${cleanVer}/${bundleFilename}`,
        install_mode: "hot_bundle",
      }));

      const hotPlatforms = new Set(hotEntries.map((h) => h.platform));
      mergedArtifacts = [
        ...hotEntries,
        ...mergedArtifacts.filter((a) => !hotPlatforms.has(a.platform)),
      ];
    }

    const normalized = normalizeArtifacts(mergedArtifacts).map((art) => ({
      ...art,
      download_path: art.download_path || `/api/releases/download/${cleanVer}/${art.filename}`,
    }));
    if (normalized.length === 0) {
      throw new Error("Informe pelo menos um artefato válido com filename e sha256 (ou publique um Hot-Bundle JSON).");
    }
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

  router.post("/admin/releases/import-github", hubApi.requireAdmin, async (req, res) => {
    try {
      const rawRepo = String(req.body?.repo || "")
        .trim()
        .replace(/^https?:\/\/github\.com\//i, "")
        .replace(/\.git$/i, "")
        .replace(/\/+$/, "");
      if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(rawRepo)) {
        return res.status(400).json({ error: "Informe o repositório no formato owner/repo ou URL do GitHub." });
      }
      const rawTag = String(req.body?.tag || "").trim();
      const apiUrl = rawTag
        ? `https://api.github.com/repos/${rawRepo}/releases/tags/${encodeURIComponent(rawTag)}`
        : `https://api.github.com/repos/${rawRepo}/releases/latest`;

      const ghRes = await fetchImpl(apiUrl, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Criativo-AI-Studio-Painel/1.0",
        },
      });
      if (!ghRes.ok) {
        return res.status(ghRes.status === 404 ? 404 : 502).json({
          error: `GitHub API retornou HTTP ${ghRes.status} ao consultar ${rawRepo}.`,
        });
      }
      const ghData = await ghRes.json();
      const version = String(ghData.tag_name || "").replace(/^v/i, "").trim();
      const channel = ghData.prerelease ? "beta" : "stable";
      const changelogMarkdown = String(ghData.body || "").trim();
      const assets = Array.isArray(ghData.assets) ? ghData.assets : [];

      const shaMap = new Map();
      const checksumAsset = assets.find((a) =>
        /^(sha256sums(\.txt)?|checksums(\.txt)?|.*\.sha256)$/i.test(String(a?.name || ""))
      );
      if (checksumAsset?.browser_download_url) {
        try {
          const sumRes = await fetchImpl(checksumAsset.browser_download_url, {
            headers: { "User-Agent": "Criativo-AI-Studio-Painel/1.0" },
          });
          if (sumRes.ok) {
            const sumText = await sumRes.text();
            for (const [k, v] of parseSha256SumsText(sumText)) {
              shaMap.set(k, v);
            }
          }
        } catch {
          // Segue sem mapa de checksums se o download auxiliar falhar
        }
      }

      const artifacts = [];
      for (const asset of assets) {
        const inferred = inferPlatformFromAssetName(asset?.name);
        if (!inferred) continue;
        const cleanName = path.basename(String(asset.name));
        const sha = shaMap.get(cleanName) || "";
        artifacts.push({
          platform: inferred.platform,
          arch: inferred.arch,
          filename: cleanName,
          sha256: sha,
          size_bytes: Number(asset.size) || 0,
          external_url: sanitizeExternalHttpsUrl(asset.browser_download_url),
          install_mode: inferred.install_mode,
        });
      }

      return res.json({
        ok: true,
        draft: {
          version,
          channel,
          changelog_markdown: changelogMarkdown,
          artifacts,
          tag_name: ghData.tag_name || null,
          html_url: ghData.html_url || null,
        },
      });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return { router, publishRelease, getLatestRelease, listReleases };
}
