import {
  api,
  copyText,
  ensureStylesheet,
  escapeHtml,
  formatDateTime,
  showToast,
} from "./core/api.js";
import { refreshDashboardData, store } from "./core/state.js";
import { registerView } from "./core/router.js";

ensureStylesheet("/styles/views.css");

function buildNativeArtifactsFromInputs(root) {
  const entries = [
    { platform: "win32", arch: "x64", urlId: "#rel-win-url", shaId: "#rel-win-sha" },
    { platform: "darwin", arch: "universal", urlId: "#rel-mac-url", shaId: "#rel-mac-sha" },
    { platform: "linux", arch: "x64", urlId: "#rel-lin-url", shaId: "#rel-lin-sha" },
  ];
  const out = [];
  for (const item of entries) {
    const url = root.querySelector(item.urlId)?.value.trim();
    const sha = root.querySelector(item.shaId)?.value.trim().toLowerCase();
    if (url && sha) {
      let filename = `${item.platform}-installer`;
      try {
        filename = new URL(url).pathname.split("/").pop() || filename;
      } catch {
        // Fallback simples
      }
      out.push({
        platform: item.platform,
        arch: item.arch,
        filename,
        sha256: sha,
        external_url: url,
        install_mode: "native_installer",
      });
    }
  }
  return out;
}

registerView("releases", {
  async render(root) {
    let releases = store.get().releases || [];

    root.innerHTML = `
      <div class="view-stack">
        <div class="view-header">
          <div>
            <h1>Releases & Versões</h1>
            <p class="muted">Importe releases do GitHub, publique links nativos (.exe, .dmg, .AppImage) ou Hot-Bundles JSON.</p>
          </div>
        </div>

        <section class="panel-card">
          <div class="card-header">
            <h2>Importador Rápido do GitHub Release</h2>
            <p class="muted">Preenche automaticamente versão, changelog, assets e hashes SHA-256.</p>
          </div>
          <div class="grid-3">
            <label class="field">
              <span>Repositório (owner/repo)</span>
              <input type="text" id="gh-repo" placeholder="exemplo-org/criativo-app" />
            </label>
            <label class="field">
              <span>Tag (vazia = latest)</span>
              <input type="text" id="gh-tag" placeholder="v1.0.1" />
            </label>
            <div class="field" style="justify-content:flex-end">
              <span>&nbsp;</span>
              <button type="button" class="btn btn-secondary" id="btn-import-gh">Importar do GitHub</button>
            </div>
          </div>
        </section>

        <section class="panel-card">
          <div class="card-header">
            <h2>Publicar Nova Release</h2>
          </div>
          <form id="rel-publish-form" class="form-stack">
            <div class="grid-3">
              <label class="field">
                <span>Versão *</span>
                <input type="text" id="rel-version" required placeholder="1.0.1" />
              </label>
              <label class="field">
                <span>Canal</span>
                <select id="rel-channel">
                  <option value="stable">Stable (Produção)</option>
                  <option value="beta">Beta</option>
                </select>
              </label>
              <label class="field">
                <span>Versão Mínima Compatível</span>
                <input type="text" id="rel-min-ver" placeholder="1.0.0" />
              </label>
            </div>

            <label class="field">
              <span>Changelog (Markdown)</span>
              <textarea id="rel-changelog" rows="3" placeholder="- Melhorias de estabilidade e desempenho..."></textarea>
            </label>

            <div class="grid-2">
              <label class="field">
                <span>Windows (.exe) URL HTTPS</span>
                <input type="url" id="rel-win-url" placeholder="https://github.com/exemplo/releases/Setup.exe" />
              </label>
              <label class="field">
                <span>Windows SHA-256</span>
                <input type="text" id="rel-win-sha" class="mono-input" placeholder="64 caracteres hexadecimais" />
              </label>
            </div>
            <div class="grid-2">
              <label class="field">
                <span>macOS (.dmg) URL HTTPS</span>
                <input type="url" id="rel-mac-url" placeholder="https://github.com/exemplo/releases/App.dmg" />
              </label>
              <label class="field">
                <span>macOS SHA-256</span>
                <input type="text" id="rel-mac-sha" class="mono-input" placeholder="64 caracteres hexadecimais" />
              </label>
            </div>
            <div class="grid-2">
              <label class="field">
                <span>Linux (.AppImage) URL HTTPS</span>
                <input type="url" id="rel-lin-url" placeholder="https://github.com/exemplo/releases/App.AppImage" />
              </label>
              <label class="field">
                <span>Linux SHA-256</span>
                <input type="text" id="rel-lin-sha" class="mono-input" placeholder="64 caracteres hexadecimais" />
              </label>
            </div>

            <div class="grid-2">
              <label class="field">
                <span>JSON Avançado de Artefatos (opcional)</span>
                <textarea id="rel-artifacts-json" class="mono-input" rows="5" placeholder="[]"></textarea>
              </label>
              <div class="form-stack">
                <label class="field">
                  <span>Hot-Bundle JSON (arquivo .json opcional)</span>
                  <input type="file" id="rel-hot-file" accept=".json,application/json" />
                </label>
                <label class="field">
                  <span>Ou cole o Hot-Bundle JSON</span>
                  <textarea id="rel-hot-json" class="mono-input" rows="3" placeholder='{"version":"1.0.1","files":{}}'></textarea>
                </label>
              </div>
            </div>

            <div class="btn-row">
              <button type="submit" class="btn btn-primary">Publicar Release</button>
            </div>
          </form>
        </section>

        <section class="panel-card">
          <div class="card-header">
            <h2>Timeline de Releases Publicadas (<span id="rel-count-label" class="tabular-nums">${releases.length}</span>)</h2>
          </div>
          <div class="release-timeline" id="rel-timeline-list"></div>
        </section>
      </div>
    `;

    const timeline = root.querySelector("#rel-timeline-list");
    const countEl = root.querySelector("#rel-count-label");

    function renderTimeline(list) {
      if (countEl) countEl.textContent = String(list.length);
      if (!timeline) return;
      if (!list.length) {
        timeline.innerHTML = `<p class="muted">Nenhuma release publicada ainda.</p>`;
        return;
      }
      timeline.innerHTML = list
        .map((rel) => {
          const arts = Array.isArray(rel.artifacts) ? rel.artifacts : [];
          return `
            <article class="release-item">
              <span class="release-dot"></span>
              <div class="row-between">
                <div>
                  <strong>v${escapeHtml(rel.version)}</strong>
                  <span class="pill ${rel.channel === "beta" ? "pill-warn" : "pill-active"}">${escapeHtml(rel.channel || "stable")}</span>
                  ${rel.min_compatible_version ? `<span class="muted">mín. v${escapeHtml(rel.min_compatible_version)}</span>` : ""}
                </div>
                <span class="muted tabular-nums">${escapeHtml(formatDateTime(rel.published_at))}</span>
              </div>
              ${rel.changelog_markdown ? `<p class="muted mt-8">${escapeHtml(rel.changelog_markdown)}</p>` : ""}
              <div class="release-artifacts">
                ${arts
                  .map((a) => `
                    <span class="artifact-chip">
                      <span>${escapeHtml(a.platform || "-")}/${escapeHtml(a.arch || "-")} · ${escapeHtml(a.filename || "")}</span>
                      ${a.sha256 ? `<button type="button" class="btn btn-ghost btn-sm" data-copy-sha="${escapeHtml(a.sha256)}">SHA</button>` : ""}
                    </span>
                  `)
                  .join("")}
              </div>
            </article>
          `;
        })
        .join("");

      timeline.querySelectorAll("[data-copy-sha]").forEach((btn) => {
        btn.addEventListener("click", () => void copyText(btn.dataset.copySha, "SHA-256 copiado!"));
      });
    }

    renderTimeline(releases);

    root.querySelector("#rel-hot-file")?.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      root.querySelector("#rel-hot-json").value = text;
      showToast(`Arquivo ${file.name} carregado no Hot-Bundle!`, "success");
    });

    root.querySelector("#btn-import-gh")?.addEventListener("click", async () => {
      const repo = root.querySelector("#gh-repo").value.trim();
      const tag = root.querySelector("#gh-tag").value.trim();
      if (!repo) return showToast("Informe o repositório owner/repo.", "error");
      try {
        const res = await api("/api/admin/releases/import-github", { method: "POST", body: JSON.stringify({ repo, tag }) });
        const d = res.draft || {};
        root.querySelector("#rel-version").value = d.version || "";
        root.querySelector("#rel-channel").value = d.channel === "beta" ? "beta" : "stable";
        root.querySelector("#rel-changelog").value = d.changelog_markdown || "";
        root.querySelector("#rel-artifacts-json").value = JSON.stringify(d.artifacts || [], null, 2);
        showToast(`Release v${d.version || "?"} importada para revisão!`, "success");
      } catch (err) {
        showToast(`Erro ao importar GitHub: ${err.message}`, "error");
      }
    });

    root.querySelector("#rel-publish-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      let parsedArtifacts = [];
      const rawJson = root.querySelector("#rel-artifacts-json").value.trim();
      if (rawJson) {
        try {
          parsedArtifacts = JSON.parse(rawJson);
        } catch (err) {
          return showToast(`JSON de artefatos inválido: ${err.message}`, "error");
        }
      }
      const nativeArts = buildNativeArtifactsFromInputs(root);
      const mergedArtifacts = [...nativeArts, ...(Array.isArray(parsedArtifacts) ? parsedArtifacts : [])];
      const hotText = root.querySelector("#rel-hot-json").value.trim();

      const body = {
        version: root.querySelector("#rel-version").value.trim(),
        channel: root.querySelector("#rel-channel").value,
        min_compatible_version: root.querySelector("#rel-min-ver").value.trim() || null,
        changelog_markdown: root.querySelector("#rel-changelog").value.trim(),
        artifacts: mergedArtifacts,
        ...(hotText ? { hot_bundle: hotText } : {}),
      };
      try {
        await api("/api/admin/releases", { method: "POST", body: JSON.stringify(body) });
        showToast(`Release v${body.version} publicada!`, "success");
        await refreshDashboardData(["releases"]);
        releases = store.get().releases || [];
        renderTimeline(releases);
      } catch (err) {
        showToast(`Erro ao publicar release: ${err.message}`, "error");
      }
    });
  },
});
