export const $ = (id) => document.getElementById(id);

let unauthorizedHandler = null;

export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = typeof fn === "function" ? fn : null;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function api(url, opts = {}) {
  const res = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.includes("/api/auth/login")) {
    if (unauthorizedHandler) unauthorizedHandler();
    throw new Error("Sessão expirada. Faça login novamente.");
  }
  if (!res.ok) {
    throw new Error(data.message || data.error || `Erro HTTP ${res.status}`);
  }
  return data;
}

export function showToast(msg, variant = "info") {
  const box = $("toast-box");
  if (!box) return;
  const item = document.createElement("div");
  item.className = `toast-item toast-${variant}`;
  item.textContent = String(msg ?? "");
  box.appendChild(item);
  setTimeout(() => {
    item.remove();
  }, 4000);
}

export async function copyText(text, label = "Copiado!") {
  if (!text && text !== 0) return;
  await navigator.clipboard.writeText(String(text));
  showToast(label, "success");
}

export function formatMoney(cents, currency = "BRL") {
  const safeCurrency = /^[A-Z]{3}$/.test(String(currency || "").toUpperCase())
    ? String(currency).toUpperCase()
    : "BRL";
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: safeCurrency,
    }).format((Number(cents) || 0) / 100);
  } catch {
    return `R$ ${((Number(cents) || 0) / 100).toFixed(2).replace(".", ",")}`;
  }
}

export function formatDateTime(iso) {
  if (!iso) return "-";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "-";
  return dt.toLocaleString("pt-BR");
}

export function formatRelativeTime(iso) {
  if (!iso) return "";
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return "agora";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `há ${diffHours} h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays <= 7) return `há ${diffDays} d`;
  return new Date(ts).toLocaleDateString("pt-BR");
}

export function setButtonLoading(btn, loading, loadingLabel = "Processando...") {
  if (!btn) return;
  if (loading) {
    if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = loadingLabel;
  } else {
    btn.disabled = false;
    if (btn.dataset.origHtml) {
      btn.innerHTML = btn.dataset.origHtml;
      delete btn.dataset.origHtml;
    }
  }
}

export function confirmDialog({
  title = "Confirmar ação",
  message = "Tem certeza que deseja continuar?",
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(ok);
    };
    openModal({
      title,
      width: 440,
      bodyHtml: `
        <div class="form-stack">
          <p style="margin:0;color:var(--text-secondary);font-size:13.5px;line-height:1.55;">${escapeHtml(message)}</p>
          <div class="btn-row" style="justify-content:flex-end;margin-top:6px;">
            <button type="button" class="btn btn-ghost" id="confirm-dlg-cancel">${escapeHtml(cancelLabel)}</button>
            <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" id="confirm-dlg-ok">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>`,
      onMount: (root) => {
        root.querySelector("#confirm-dlg-cancel")?.addEventListener("click", () => finish(false));
        root.querySelector("#confirm-dlg-ok")?.addEventListener("click", () => finish(true));
        $("btn-close-modal")?.addEventListener("click", () => finish(false));
        $("modal-backdrop")?.addEventListener("click", (e) => {
          if (e.target.id === "modal-backdrop") finish(false);
        });
      },
    });
  });
}

export function ensureStylesheet(href) {
  if (!href) return;
  const existing = document.querySelector(`link[rel="stylesheet"][data-base-href="${href}"]`);
  if (existing) return;
  const build = window.__PAINEL_BUILD__ && window.__PAINEL_BUILD__ !== "__BUILD_ID__" ? window.__PAINEL_BUILD__ : "2.0.0";
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.dataset.baseHref = href;
  link.href = `${href}${href.includes("?") ? "&" : "?"}v=${encodeURIComponent(build)}`;
  document.head.appendChild(link);
}

let activeKeyListener = null;

function bindEscapeClose(closeFn) {
  if (activeKeyListener) document.removeEventListener("keydown", activeKeyListener);
  activeKeyListener = (e) => {
    if (e.key === "Escape") closeFn();
  };
  document.addEventListener("keydown", activeKeyListener);
}

function unbindEscapeClose() {
  if (activeKeyListener) {
    document.removeEventListener("keydown", activeKeyListener);
    activeKeyListener = null;
  }
}

export function closeModal() {
  const root = $("modal-root");
  if (root) root.innerHTML = "";
  unbindEscapeClose();
}

export function openModal({ title = "", subtitle = "", bodyHtml = "", width = 560, onMount = null } = {}) {
  const root = $("modal-root");
  if (!root) return;
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-dialog" role="dialog" aria-modal="true" style="max-width:${Number(width) || 560}px">
        <div class="overlay-header">
          <div>
            <h3>${escapeHtml(title)}</h3>
            ${subtitle ? `<p class="muted">${escapeHtml(subtitle)}</p>` : ""}
          </div>
          <button type="button" class="icon-btn" id="btn-close-modal" aria-label="Fechar">✕</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
      </div>
    </div>
  `;
  $("btn-close-modal")?.addEventListener("click", closeModal);
  $("modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "modal-backdrop") closeModal();
  });
  bindEscapeClose(closeModal);
  if (typeof onMount === "function") onMount(root);
}

export function closeDrawer() {
  const root = $("drawer-root");
  if (root) root.innerHTML = "";
  unbindEscapeClose();
}

export function openDrawer({ title = "", subtitle = "", bodyHtml = "", onMount = null } = {}) {
  const root = $("drawer-root");
  if (!root) return;
  root.innerHTML = `
    <div class="drawer-backdrop" id="drawer-backdrop">
      <aside class="drawer-panel" role="dialog" aria-modal="true">
        <div class="overlay-header">
          <div>
            <h3>${escapeHtml(title)}</h3>
            ${subtitle ? `<p class="muted">${escapeHtml(subtitle)}</p>` : ""}
          </div>
          <button type="button" class="icon-btn" id="btn-close-drawer" aria-label="Fechar">✕</button>
        </div>
        <div class="drawer-body">${bodyHtml}</div>
      </aside>
    </div>
  `;
  $("btn-close-drawer")?.addEventListener("click", closeDrawer);
  $("drawer-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "drawer-backdrop") closeDrawer();
  });
  bindEscapeClose(closeDrawer);
  if (typeof onMount === "function") onMount(root);
}
