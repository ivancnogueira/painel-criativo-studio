import {
  api, copyText, ensureStylesheet, escapeHtml, formatDateTime, formatMoney, openDrawer, openModal, showToast,
} from "./core/api.js";
import { refreshDashboardData, store } from "./core/state.js";
import { registerView } from "./core/router.js";

ensureStylesheet("/styles/views.css");

const GATEWAYS = [
  { id: "hotmart", name: "Hotmart", field: "hotmartHottok", header: "X-Hotmart-Hottok", hint: "Hottok" },
  { id: "kiwify", name: "Kiwify", field: "kiwifyToken", header: "X-Kiwify-Token", hint: "Token / Secret HMAC" },
  { id: "ticto", name: "Ticto", field: "tictoToken", header: "X-Ticto-Token", hint: "Token Secreto" },
  { id: "stripe", name: "Stripe", field: "stripeSecret", header: "Stripe-Signature", hint: "Signing Secret (whsec_...)" },
  { id: "cakto", name: "Cakto", field: "caktoSecret", header: "X-Cakto-Secret", hint: "Secret" },
  { id: "kirvano", name: "Kirvano", field: "kirvanoToken", header: "Security-Token", hint: "Token de Segurança" },
  { id: "generic", name: "Genérico HMAC-SHA256", field: "genericHmacSecret", header: "X-Webhook-Signature", hint: "Secret HMAC-SHA256" },
];

const PLAN_PRESETS = {
  individual: { product_id: "PROD_INDIVIDUAL", amount: "197.00" },
  agencia_10: { product_id: "PROD_AG10", amount: "497.00" },
  agencia_ilimitada: { product_id: "PROD_AG_ILIM", amount: "997.00" },
};

function statusBadgeHtml(d) {
  const label = d.status_label || (d.action === "issued_or_updated" ? (d.is_simulated ? "simulado" : "aprovado") : d.action === "revoked" ? "reembolso" : d.action === "error" || d.action === "auth_error" ? "erro" : "ignorado");
  const clsMap = { aprovado: "pill-active", reembolso: "pill-revoked", erro: "pill-revoked", simulado: "pill-warn", ignorado: "pill-info" };
  return `<span class="pill ${clsMap[label] || "pill-info"}">${escapeHtml(label.toUpperCase())}</span>`;
}

function buildCurlCommand(gwId, url, eventKind = "approved") {
  const ref = eventKind === "refund";
  const tx = "TX_EXEMPLO_001";
  const buyer = { email: "cliente@exemplo.invalid", name: "Cliente Exemplo", phone: "+5511900000000" };
  const samples = {
    hotmart: { h: `-H "X-Hotmart-Hottok: <SEU_TOKEN>"`, b: { id: tx, event: ref ? "PURCHASE_REFUNDED" : "PURCHASE_APPROVED", data: { product: { id: "PROD_AG10", name: "Licença Agência 10" }, buyer: { email: buyer.email, name: buyer.name, checkout_phone: buyer.phone }, purchase: { transaction: tx, price: { value: 497.0, currency_value: "BRL" }, payment: { type: "PIX" } } } } },
    kiwify: { h: `-H "X-Kiwify-Token: <SEU_TOKEN>"`, b: { order_id: tx, webhook_event_type: ref ? "order_refunded" : "order_paid", payment_method: "pix", Product: { product_id: "PROD_AG10", product_name: "Licença Agência 10" }, Customer: { email: buyer.email, full_name: buyer.name, mobile: buyer.phone }, Commissions: { charge_amount: 49700, product_base_price_currency: "BRL" } } },
    ticto: { h: `-H "X-Ticto-Token: <SEU_TOKEN>"`, b: { status: ref ? "refunded" : "paid", payment_method: "pix", order: { hash: tx, paid_amount: 49700, currency: "BRL" }, item: { product_id: "PROD_AG10", offer_name: "Licença Agência 10" }, customer: buyer } },
    stripe: { h: `-H "Stripe-Signature: t=1700000000,v1=<ASSINATURA_HMAC_SHA256>"`, b: { id: "evt_exemplo_001", type: ref ? "charge.refunded" : "checkout.session.completed", data: { object: { id: tx, amount_total: 49700, currency: "brl", payment_method_types: ["card"], customer_details: buyer, metadata: { product_id: "PROD_AG10", plan_name: "Licença Agência 10" } } } } },
    cakto: { h: `-H "X-Cakto-Secret: <SEU_TOKEN>"`, b: { event: ref ? "purchase_refunded" : "purchase_approved", data: { transaction_id: tx, amount: 497.0, currency: "BRL", paymentMethod: "pix", product: { id: "PROD_AG10", name: "Licença Agência 10" }, customer: buyer } } },
    kirvano: { h: `-H "Security-Token: <SEU_TOKEN>"`, b: { event: ref ? "SALE_REFUNDED" : "SALE_APPROVED", sale_id: tx, payment_method: "PIX", total_price: "R$ 497,00", products: [{ id: "PROD_AG10", name: "Licença Agência 10" }], customer: { email: buyer.email, name: buyer.name, phone_number: buyer.phone } } },
    generic: { h: `-H "X-Webhook-Signature: sha256=<ASSINATURA_HMAC_SHA256>"`, b: { event: ref ? "purchase_refunded" : "purchase_approved", transaction_id: tx, product_id: "PROD_AG10", offer_name: "Licença Agência 10", amount_cents: 49700, currency: "BRL", payment_method: "pix", customer: buyer } },
  };
  const cfg = samples[gwId] || samples.generic;
  return `curl -X POST "${url}" \\\n  -H "Content-Type: application/json" \\\n  ${cfg.h} \\\n  -d '${JSON.stringify(cfg.b, null, 2)}'`;
}

function mapToRows(productMap) {
  return Object.entries(productMap && typeof productMap === "object" ? productMap : {}).map(([productId, rule]) => ({
    productId,
    label: String(rule?.label || ""),
    planTier: rule?.planTier || "individual",
    addUpgrades: Array.isArray(rule?.addUpgrades) ? rule.addUpgrades : [],
    defaultAmountReais: rule?.defaultAmountCents ? (Number(rule.defaultAmountCents) / 100).toFixed(2) : "",
    currency: String(rule?.currency || "BRL").toUpperCase(),
  }));
}

function rowsToMap(rows) {
  const out = {};
  for (const r of rows) {
    const id = String(r.productId || "").trim();
    if (!id) continue;
    const cents = Math.max(0, Math.round((Number(String(r.defaultAmountReais || "0").replace(",", ".")) || 0) * 100));
    out[id] = {
      planTier: r.planTier || "individual",
      addUpgrades: Array.isArray(r.addUpgrades) ? r.addUpgrades : [],
      ...(cents > 0 ? { defaultAmountCents: cents } : {}),
      currency: String(r.currency || "BRL").toUpperCase(),
      ...(String(r.label || "").trim() ? { label: String(r.label).trim() } : {}),
    };
  }
  return out;
}

function openCurlModal(gw, url) {
  let currentEvent = "approved";
  openModal({
    title: `Gerador cURL — ${gw.name}`,
    subtitle: "Teste a integração enviando um payload realista com placeholder seguro.",
    width: 680,
    bodyHtml: `
      <div class="form-stack">
        <div class="row-between">
          <div class="tab-switch">
            <button type="button" class="tab-btn active" data-ev="approved">Compra Aprovada</button>
            <button type="button" class="tab-btn" data-ev="refund">Reembolso</button>
          </div>
          <button type="button" class="btn btn-primary btn-sm" id="btn-copy-curl">Copiar cURL</button>
        </div>
        <pre class="code-snippet" id="curl-preview-box">${escapeHtml(buildCurlCommand(gw.id, url, currentEvent))}</pre>
      </div>`,
    onMount: (root) => {
      const box = root.querySelector("#curl-preview-box");
      root.querySelectorAll("[data-ev]").forEach((btn) => {
        btn.addEventListener("click", () => {
          currentEvent = btn.dataset.ev;
          root.querySelectorAll("[data-ev]").forEach((b) => b.classList.toggle("active", b === btn));
          if (box) box.textContent = buildCurlCommand(gw.id, url, currentEvent);
        });
      });
      root.querySelector("#btn-copy-curl")?.addEventListener("click", () => {
        void copyText(buildCurlCommand(gw.id, url, currentEvent), `cURL ${gw.name} copiado!`);
      });
    },
  });
}

async function openDeliveryInspector(deliveryId, onAfterReplay) {
  try {
    const res = await api(`/api/admin/webhooks/deliveries/${encodeURIComponent(deliveryId)}`);
    const d = res.delivery;
    const prettyJson = JSON.stringify(d.raw_payload ?? d.summary ?? {}, null, 2);
    const metaItem = (lbl, val) => `<div class="inspector-meta-item"><div class="inspector-meta-label">${lbl}</div><div class="inspector-meta-val tabular-nums">${val}</div></div>`;
    openDrawer({
      title: `Entrega ${d.provider?.toUpperCase() || "WEBHOOK"}`,
      subtitle: d.delivery_key || d.id,
      bodyHtml: `
        <div class="inspector-meta-grid">
          ${metaItem("Status / HTTP", `${statusBadgeHtml(d)} <span class="muted">HTTP ${escapeHtml(d.http_status ?? 200)}</span>`)}
          ${metaItem("Transação", escapeHtml(d.transaction_id || "-"))}
          ${metaItem("Comprador", escapeHtml(d.buyer_email || "-"))}
          ${metaItem("Valor / Plano", `${escapeHtml(formatMoney(d.amount_cents || 0, d.currency || "BRL"))} · ${escapeHtml(d.plan_tier || "-")}`)}
          ${metaItem("Licença Emitida", escapeHtml(d.license_key || "-"))}
          ${metaItem("Replays", `${Number(d.replay_count || 0)}${d.replayed_at ? ` (${escapeHtml(formatDateTime(d.replayed_at))})` : ""}`)}
        </div>
        ${d.error_detail ? `<div class="alert alert-danger"><strong>Detalhe do erro:</strong> ${escapeHtml(d.error_detail)}</div>` : ""}
        <div class="row-between mb-8">
          <strong>Payload Bruto Recebido</strong>
          <div class="btn-row">
            <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-raw-json">Copiar JSON</button>
            <button type="button" class="btn btn-primary btn-sm" id="btn-replay-delivery">Reprocessar (Replay)</button>
          </div>
        </div>
        <pre class="json-viewer" id="inspector-json-pre">${escapeHtml(prettyJson)}</pre>`,
      onMount: (root) => {
        root.querySelector("#btn-copy-raw-json")?.addEventListener("click", () => void copyText(prettyJson, "Payload JSON copiado!"));
        const replayBtn = root.querySelector("#btn-replay-delivery");
        replayBtn?.addEventListener("click", async () => {
          replayBtn.disabled = true;
          try {
            const rp = await api(`/api/admin/webhooks/deliveries/${encodeURIComponent(d.id)}/replay`, { method: "POST" });
            showToast(`Replay concluído! Ação: ${rp.result?.action || "ok"}`, "success");
            await refreshDashboardData(["deliveries", "analytics", "licenses", "overview"]);
            if (typeof onAfterReplay === "function") await onAfterReplay();
            await openDeliveryInspector(d.id, onAfterReplay);
          } catch (err) {
            showToast(`Erro no replay: ${err.message}`, "error");
            replayBtn.disabled = false;
          }
        });
      },
    });
  } catch (err) {
    showToast(`Erro ao carregar entrega: ${err.message}`, "error");
  }
}

registerView("webhooks", {
  async render(root, ctx) {
    const state = store.get();
    const cfg = state.webhooksConfig || { urls: {}, secretsConfigured: {}, productMap: {} };
    let builderMode = "visual";
    let productRows = mapToRows(cfg.productMap);
    if (!productRows.length) {
      productRows = [{ productId: "PROD_AG10", label: "Agência 10", planTier: "agencia_10", addUpgrades: [], defaultAmountReais: "497.00", currency: "BRL" }];
    }
    let filterProvider = "";
    let filterStatus = "";
    let filterQ = "";
    let currentDeliveries = state.deliveries || [];

    root.innerHTML = `
      <div class="view-stack">
        <div class="view-header">
          <div>
            <h1>Central Profissional de Webhooks</h1>
            <p class="muted">7 gateways suportados, construtor visual de produtos, simulador financeiro e replay em 1 clique.</p>
          </div>
        </div>

        <section class="panel-card">
          <div class="card-header row-between">
            <div>
              <h2>Gateways & Tokens de Autenticação</h2>
              <p class="muted">Deixe o campo de token em branco para preservar o segredo já salvo no Cofre AES-256-GCM.</p>
            </div>
            <button type="button" class="btn btn-primary" id="btn-save-wh-all">Salvar Configurações & Mapeamento</button>
          </div>
          <div class="gateway-grid">
            ${GATEWAYS.map((gw) => {
              const url = cfg.urls?.[gw.id] || `${window.location.origin}/api/webhooks/sales?provider=${gw.id}`;
              const isOk = Boolean(cfg.secretsConfigured?.[gw.id]);
              return `
                <div class="gateway-card">
                  <div class="gateway-card-head">
                    <span class="gateway-name">${escapeHtml(gw.name)}</span>
                    <span class="status-indicator ${isOk ? "ok" : "pending"}">${isOk ? "Configurado" : "Pendente"}</span>
                  </div>
                  <div class="gateway-url-row">
                    <input type="text" readonly value="${escapeHtml(url)}" aria-label="URL ${escapeHtml(gw.name)}" />
                    <button type="button" class="btn btn-secondary btn-sm" data-copy-url="${escapeHtml(url)}">Copiar</button>
                  </div>
                  <label class="field">
                    <span>${escapeHtml(gw.hint)} (${escapeHtml(gw.header)})</span>
                    <input type="password" data-secret-field="${escapeHtml(gw.field)}" placeholder="${isOk ? "•••••••• (mantém atual)" : "Cole o token/secret"}" />
                  </label>
                  <div class="row-between">
                    <span class="muted">Assinatura / Token</span>
                    <button type="button" class="btn btn-ghost btn-sm" data-curl-gw="${escapeHtml(gw.id)}">Gerar cURL de Teste</button>
                  </div>
                </div>`;
            }).join("")}
          </div>

          <hr class="divider" />
          <div class="row-between mb-8">
            <div>
              <h3>Mapeamento de Produtos → Planos & Preços</h3>
              <p class="muted">Sincronização bidirecional entre Construtor Visual e JSON Avançado (fallback de preço automático).</p>
            </div>
            <div class="btn-row">
              <div class="tab-switch">
                <button type="button" class="tab-btn active" id="tab-map-visual">Construtor Visual</button>
                <button type="button" class="tab-btn" id="tab-map-json">JSON Avançado</button>
              </div>
              <button type="button" class="btn btn-secondary btn-sm" id="btn-add-product-row">+ Adicionar Produto</button>
            </div>
          </div>
          <div id="wh-builder-visual" class="product-map-list"></div>
          <div id="wh-builder-json" class="hidden">
            <textarea id="wh-product-map-json" class="mono-input" rows="8"></textarea>
          </div>
        </section>

        <section class="panel-card" id="wh-sim-card">
          <div class="card-header row-between">
            <div>
              <h2>Simulador Ponta a Ponta</h2>
              <p class="muted">Dispare compras simuladas (<code>is_simulated=1</code>) para validar planos, valor e mensageria.</p>
            </div>
            <div class="btn-row">
              <button type="button" class="btn btn-ghost btn-sm" data-preset="individual">Preset Individual</button>
              <button type="button" class="btn btn-ghost btn-sm" data-preset="agencia_10">Preset Agência 10</button>
              <button type="button" class="btn btn-ghost btn-sm" data-preset="agencia_ilimitada">Preset Ilimitada</button>
            </div>
          </div>
          <form id="wh-sim-form" class="form-stack">
            <div class="grid-3">
              <label class="field"><span>Gateway</span>
                <select id="sim-provider">${GATEWAYS.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join("")}</select>
              </label>
              <label class="field"><span>Evento</span>
                <select id="sim-event"><option value="PURCHASE_APPROVED">PURCHASE_APPROVED (Aprovação)</option><option value="PURCHASE_REFUNDED">PURCHASE_REFUNDED (Reembolso)</option></select>
              </label>
              <label class="field"><span>Plano Forçado (opcional)</span>
                <select id="sim-plan"><option value="">Usar Mapeamento do Produto</option><option value="individual">Individual</option><option value="agencia_10">Agência 10</option><option value="agencia_ilimitada">Agência Ilimitada</option></select>
              </label>
            </div>
            <div class="grid-3">
              <label class="field"><span>E-mail do Comprador *</span><input type="email" id="sim-email" required placeholder="cliente@exemplo.invalid" /></label>
              <label class="field"><span>Nome do Comprador</span><input type="text" id="sim-name" placeholder="Comprador Exemplo" /></label>
              <label class="field"><span>WhatsApp (opcional)</span><input type="text" id="sim-phone" placeholder="+5511900000000" /></label>
            </div>
            <div class="grid-3">
              <label class="field"><span>Product ID</span><input type="text" id="sim-product-id" value="PROD_INDIVIDUAL" /></label>
              <label class="field"><span>Valor (R$) & Moeda</span>
                <div class="btn-row" style="flex-wrap:nowrap">
                  <input type="number" id="sim-amount" step="0.01" min="0" value="197.00" />
                  <select id="sim-currency" style="width:92px"><option value="BRL">BRL</option><option value="USD">USD</option><option value="EUR">EUR</option></select>
                </div>
              </label>
              <label class="field"><span>Método de Pagamento</span>
                <select id="sim-payment"><option value="pix">PIX</option><option value="credit_card">Cartão de Crédito</option><option value="boleto">Boleto</option></select>
              </label>
            </div>
            <div class="btn-row"><button type="submit" class="btn btn-primary">Simular Webhook Agora</button></div>
          </form>
        </section>

        <section class="panel-card">
          <div class="card-header row-between">
            <div><h2>Log de Entregas & Inspetor</h2><p class="muted">Clique em qualquer entrega para abrir o Drawer Inspetor e reprocessar em 1 clique.</p></div>
            <div class="toolbar-row">
              <input type="search" id="del-filter-q" class="toolbar-search" placeholder="Buscar e-mail, transação ou chave..." />
              <select id="del-filter-provider" class="filter-select">
                <option value="">Todos os gateways</option>
                ${GATEWAYS.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join("")}
              </select>
              <select id="del-filter-status" class="filter-select">
                <option value="">Todos os status</option><option value="aprovado">Aprovado</option><option value="reembolso">Reembolso</option><option value="simulado">Simulado</option><option value="ignorado">Ignorado</option><option value="erro">Erro / 401</option>
              </select>
            </div>
          </div>
          <div class="table-scroll">
            <table class="data-table">
              <thead><tr><th>Gateway</th><th>Evento / Transação</th><th>Comprador</th><th>Plano & Valor</th><th>Status</th><th>Data</th><th>Ação</th></tr></thead>
              <tbody id="wh-deliveries-tbody"></tbody>
            </table>
          </div>
        </section>
      </div>`;

    const visualBox = root.querySelector("#wh-builder-visual");
    const jsonBox = root.querySelector("#wh-builder-json");
    const jsonTextarea = root.querySelector("#wh-product-map-json");
    const syncJsonFromRows = () => { if (jsonTextarea) jsonTextarea.value = JSON.stringify(rowsToMap(productRows), null, 2); };

    function renderVisualRows() {
      if (!visualBox) return;
      visualBox.innerHTML = productRows.map((row, idx) => `
        <div class="product-map-row" data-row-idx="${idx}">
          <input type="text" data-col="productId" value="${escapeHtml(row.productId)}" placeholder="Product ID" />
          <input type="text" data-col="label" value="${escapeHtml(row.label)}" placeholder="Label / Oferta" />
          <select data-col="planTier">
            <option value="individual" ${row.planTier === "individual" ? "selected" : ""}>Individual</option>
            <option value="agencia_10" ${row.planTier === "agencia_10" ? "selected" : ""}>Agência 10</option>
            <option value="agencia_ilimitada" ${row.planTier === "agencia_ilimitada" ? "selected" : ""}>Agência Ilimitada</option>
          </select>
          <div class="product-map-upgrades">
            <label><input type="checkbox" data-upg="bonus" ${row.addUpgrades.includes("bonus") ? "checked" : ""} /> Bônus</label>
            <label><input type="checkbox" data-upg="video" ${row.addUpgrades.includes("video") ? "checked" : ""} /> Vídeo</label>
          </div>
          <input type="number" step="0.01" min="0" data-col="defaultAmountReais" value="${escapeHtml(row.defaultAmountReais)}" placeholder="Preço R$" />
          <select data-col="currency">
            <option value="BRL" ${row.currency === "BRL" ? "selected" : ""}>BRL</option>
            <option value="USD" ${row.currency === "USD" ? "selected" : ""}>USD</option>
            <option value="EUR" ${row.currency === "EUR" ? "selected" : ""}>EUR</option>
          </select>
          <button type="button" class="btn btn-danger btn-sm" data-remove-row="${idx}" title="Remover regra">✕</button>
        </div>`).join("");

      visualBox.querySelectorAll(".product-map-row").forEach((el) => {
        const idx = Number(el.dataset.rowIdx);
        el.querySelectorAll("[data-col]").forEach((inp) => inp.addEventListener("input", () => { productRows[idx][inp.dataset.col] = inp.value; syncJsonFromRows(); }));
        el.querySelectorAll("[data-upg]").forEach((chk) => chk.addEventListener("change", () => {
          const set = new Set(productRows[idx].addUpgrades || []);
          chk.checked ? set.add(chk.dataset.upg) : set.delete(chk.dataset.upg);
          productRows[idx].addUpgrades = [...set];
          syncJsonFromRows();
        }));
        el.querySelector("[data-remove-row]")?.addEventListener("click", () => { productRows.splice(idx, 1); renderVisualRows(); syncJsonFromRows(); });
      });
    }

    renderVisualRows();
    syncJsonFromRows();

    root.querySelector("#tab-map-visual")?.addEventListener("click", () => {
      if (builderMode === "visual") return;
      try {
        productRows = mapToRows(JSON.parse(jsonTextarea.value || "{}"));
        renderVisualRows();
        builderMode = "visual";
        visualBox.classList.remove("hidden");
        jsonBox.classList.add("hidden");
        root.querySelector("#tab-map-visual")?.classList.add("active");
        root.querySelector("#tab-map-json")?.classList.remove("active");
      } catch (err) { showToast(`JSON inválido: ${err.message}`, "error"); }
    });

    root.querySelector("#tab-map-json")?.addEventListener("click", () => {
      if (builderMode === "json") return;
      syncJsonFromRows();
      builderMode = "json";
      visualBox.classList.add("hidden");
      jsonBox.classList.remove("hidden");
      root.querySelector("#tab-map-json")?.classList.add("active");
      root.querySelector("#tab-map-visual")?.classList.remove("active");
    });

    root.querySelector("#btn-add-product-row")?.addEventListener("click", () => {
      productRows.push({ productId: "", label: "", planTier: "individual", addUpgrades: [], defaultAmountReais: "", currency: "BRL" });
      if (builderMode === "json") root.querySelector("#tab-map-visual")?.click();
      else { renderVisualRows(); syncJsonFromRows(); }
    });

    root.querySelectorAll("[data-copy-url]").forEach((b) => b.addEventListener("click", () => void copyText(b.dataset.copyUrl, "URL do webhook copiada!")));
    root.querySelectorAll("[data-curl-gw]").forEach((b) => {
      const gw = GATEWAYS.find((g) => g.id === b.dataset.curlGw);
      b.addEventListener("click", () => openCurlModal(gw, cfg.urls?.[gw.id] || `${window.location.origin}/api/webhooks/sales?provider=${gw.id}`));
    });

    root.querySelector("#btn-save-wh-all")?.addEventListener("click", async () => {
      let productMapObj;
      try { productMapObj = builderMode === "json" ? JSON.parse(jsonTextarea.value || "{}") : rowsToMap(productRows); }
      catch (err) { return showToast(`JSON de produtos inválido: ${err.message}`, "error"); }
      const payload = { productMap: productMapObj };
      root.querySelectorAll("[data-secret-field]").forEach((inp) => { if (inp.value.trim()) payload[inp.dataset.secretField] = inp.value.trim(); });
      try {
        await api("/api/admin/webhooks/config", { method: "PUT", body: JSON.stringify(payload) });
        showToast("Webhooks e mapeamento salvos com segurança!", "success");
        await refreshDashboardData(["webhooksConfig"]);
      } catch (err) { showToast(`Erro ao salvar configuração: ${err.message}`, "error"); }
    });

    root.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
      const p = PLAN_PRESETS[b.dataset.preset];
      if (!p) return;
      root.querySelector("#sim-plan").value = b.dataset.preset;
      root.querySelector("#sim-product-id").value = p.product_id;
      root.querySelector("#sim-amount").value = p.amount;
    }));

    root.querySelector("#wh-sim-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = {
        provider: root.querySelector("#sim-provider").value,
        event_type: root.querySelector("#sim-event").value,
        plan_tier: root.querySelector("#sim-plan").value || null,
        email: root.querySelector("#sim-email").value.trim(),
        name: root.querySelector("#sim-name").value.trim() || "Comprador Exemplo",
        phone: root.querySelector("#sim-phone").value.trim(),
        product_id: root.querySelector("#sim-product-id").value.trim(),
        amount_cents: Math.max(0, Math.round(Number(root.querySelector("#sim-amount").value || 0) * 100)),
        currency: root.querySelector("#sim-currency").value,
        payment_method: root.querySelector("#sim-payment").value,
      };
      try {
        const res = await api("/api/admin/webhooks/simulate", { method: "POST", body: JSON.stringify(body) });
        showToast(`Simulação executada: ${res.action}${res.license_key ? ` · ${res.license_key}` : ""}`, "success");
        await refreshDashboardData(["analytics", "deliveries", "licenses", "overview"]);
        await loadDeliveries();
      } catch (err) { showToast(`Erro na simulação: ${err.message}`, "error"); }
    });

    const tbody = root.querySelector("#wh-deliveries-tbody");
    function renderDeliveriesRows(rows) {
      if (!tbody) return;
      if (!rows.length) { tbody.innerHTML = `<tr><td colspan="7" class="muted">Nenhuma entrega encontrada para os filtros atuais.</td></tr>`; return; }
      tbody.innerHTML = rows.map((d) => `
        <tr class="delivery-row-clickable" data-delivery-id="${escapeHtml(d.id || d.delivery_key)}">
          <td><strong>${escapeHtml(String(d.provider || "").toUpperCase())}</strong></td>
          <td><div>${escapeHtml(d.event_name || "-")}</div><div class="muted tabular-nums">${escapeHtml(d.transaction_id || "-")}</div></td>
          <td><div>${escapeHtml(d.buyer_name || "-")}</div><div class="muted">${escapeHtml(d.buyer_email || "-")}</div></td>
          <td class="tabular-nums"><div>${escapeHtml(d.plan_tier || "-")}</div><div class="muted">${escapeHtml(formatMoney(d.amount_cents || 0, d.currency || "BRL"))}</div></td>
          <td>${statusBadgeHtml(d)} <span class="muted">HTTP ${escapeHtml(d.http_status ?? 200)}</span></td>
          <td class="muted tabular-nums">${escapeHtml(formatDateTime(d.processed_at))}</td>
          <td><button type="button" class="btn btn-secondary btn-sm">Inspecionar</button></td>
        </tr>`).join("");
      tbody.querySelectorAll("[data-delivery-id]").forEach((tr) => tr.addEventListener("click", () => void openDeliveryInspector(tr.dataset.deliveryId, loadDeliveries)));
    }

    async function loadDeliveries() {
      const qs = new URLSearchParams({ limit: "60" });
      if (filterProvider) qs.set("provider", filterProvider);
      if (filterStatus) qs.set("status", filterStatus);
      if (filterQ) qs.set("q", filterQ);
      try {
        const res = await api(`/api/admin/webhooks/deliveries?${qs.toString()}`);
        currentDeliveries = res.deliveries || [];
        renderDeliveriesRows(currentDeliveries);
      } catch (err) { showToast(`Erro ao filtrar entregas: ${err.message}`, "error"); }
    }

    renderDeliveriesRows(currentDeliveries);
    let searchTimer = null;
    root.querySelector("#del-filter-q")?.addEventListener("input", (e) => {
      filterQ = e.target.value.trim();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => void loadDeliveries(), 260);
    });
    root.querySelector("#del-filter-provider")?.addEventListener("change", (e) => { filterProvider = e.target.value; void loadDeliveries(); });
    root.querySelector("#del-filter-status")?.addEventListener("change", (e) => { filterStatus = e.target.value; void loadDeliveries(); });
    if (ctx.params?.focus === "simulate") { root.querySelector("#wh-sim-card")?.scrollIntoView({ behavior: "smooth", block: "start" }); root.querySelector("#sim-email")?.focus(); }
    const inspectId = ctx.params?.inspectDeliveryId || ctx.params?.deliveryId;
    if (inspectId) void openDeliveryInspector(inspectId, loadDeliveries);
  },
});
