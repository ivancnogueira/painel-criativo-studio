import crypto from "node:crypto";

export const SUPPORTED_PROVIDERS = [
  "hotmart",
  "kiwify",
  "ticto",
  "stripe",
  "cakto",
  "kirvano",
  "generic",
];

const APPROVED_EVENTS = new Set([
  "purchase_approved",
  "purchase_complete",
  "compra_aprovada",
  "order_approved",
  "order_paid",
  "order.paid",
  "sale_approved",
  "paid",
  "approved",
  "authorized",
  "payment.succeeded",
  "checkout.session.completed",
  "invoice.payment_succeeded",
  "subscription_renewed",
]);

const REVOKED_EVENTS = new Set([
  "purchase_refunded",
  "purchase_chargeback",
  "subscription_cancellation",
  "subscription_canceled",
  "purchase_canceled",
  "compra_reembolsada",
  "refund",
  "refunded",
  "order_refunded",
  "chargeback",
  "dispute",
  "charge.refunded",
  "customer.subscription.deleted",
  "canceled",
  "cancelled",
]);

export function parseMoneyToCents(rawValue, { isIntegerCents = false } = {}) {
  if (rawValue === null || rawValue === undefined || rawValue === "") return 0;

  if (typeof rawValue === "number") {
    if (!Number.isFinite(rawValue)) return 0;
    const cents = isIntegerCents ? Math.round(rawValue) : Math.round(rawValue * 100);
    return Math.max(0, cents);
  }

  let cleaned = String(rawValue)
    .trim()
    .replace(/[R$€£\s]/gi, "")
    .replace(/^(BRL|USD|EUR)/i, "")
    .trim();

  if (!cleaned || cleaned === "-") return 0;

  if (isIntegerCents && /^\d+$/.test(cleaned)) {
    return Math.max(0, Number.parseInt(cleaned, 10));
  }

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");

  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) {
      cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      cleaned = cleaned.replace(/,/g, "");
    }
  } else if (lastComma !== -1) {
    if (/^\d{1,3}(,\d{3})+$/.test(cleaned)) {
      cleaned = cleaned.replace(/,/g, "");
    } else {
      cleaned = cleaned.replace(",", ".");
    }
  } else if (/^\d{1,3}(\.\d{3}){2,}$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, "");
  }

  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed * 100));
}

export function normalizePaymentMethod(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "pix") return "pix";
  if (
    ["credit_card", "card", "cartao", "cartão", "credit", "cartao_credito", "cartão_de_credito", "creditcard"].includes(
      value,
    )
  ) {
    return "credit_card";
  }
  if (["boleto", "billet", "bank_slip", "ticket", "boleto_bancario"].includes(value)) {
    return "boleto";
  }
  if (["debit_card", "debit", "debito", "débito", "cartao_debito"].includes(value)) {
    return "debit";
  }
  if (value === "paypal") return "paypal";
  return "other";
}

export function classifyWebhookEvent(rawEvent) {
  const norm = String(rawEvent || "").trim().toLowerCase();
  if (!norm) return "ignored";
  if (APPROVED_EVENTS.has(norm)) return "approved";
  if (REVOKED_EVENTS.has(norm)) return "revoked";
  return "ignored";
}

export function resolveProductMapping(productId, offerName, productMap = {}) {
  const cleanId = String(productId || "").trim();
  if (cleanId && productMap && productMap[cleanId]) {
    const entry = productMap[cleanId];
    return {
      planTier: entry.planTier || "individual",
      addUpgrades: Array.isArray(entry.addUpgrades) ? entry.addUpgrades : [],
      defaultAmountCents: Math.max(0, Math.round(Number(entry.defaultAmountCents) || 0)),
      currency: String(entry.currency || "BRL").toUpperCase(),
      label: entry.label ? String(entry.label) : null,
    };
  }

  const text = String(offerName || "").toLowerCase();
  const addUpgrades = [];
  if (text.includes("video") || text.includes("vídeo") || text.includes("remotion")) addUpgrades.push("video");
  if (text.includes("bonus") || text.includes("bônus")) addUpgrades.push("bonus");

  let planTier = "individual";
  if (text.includes("ilimitad")) {
    planTier = "agencia_ilimitada";
  } else if (text.includes("agencia") || text.includes("agência")) {
    planTier = "agencia_10";
  }
  return {
    planTier,
    addUpgrades,
    defaultAmountCents: 0,
    currency: "BRL",
    label: null,
  };
}

export function detectProvider(req) {
  const queryProvider = String(req.query?.provider || "").trim().toLowerCase();
  if (queryProvider) return queryProvider;

  const h = req.headers || {};
  if (h["x-hotmart-hottok"]) return "hotmart";
  if (h["stripe-signature"]) return "stripe";
  if (h["x-kiwify-signature"] || h["x-kiwify-token"]) return "kiwify";
  if (h["x-ticto-token"]) return "ticto";
  if (h["x-cakto-secret"]) return "cakto";
  if (h["security-token"] || h["x-kirvano-token"]) return "kirvano";
  if (h["x-webhook-signature"] || h["x-signature-sha256"]) return "generic";

  if (req.body?.secret && req.body?.data) return "cakto";
  return String(req.body?.provider || "").trim().toLowerCase();
}

function verifyStripeSignature(rawBody, headerValue, secret, timingSafeEqualString) {
  if (!secret || !headerValue || !rawBody) return false;
  let timestamp = "";
  const v1Signatures = [];
  for (const segment of String(headerValue).split(",")) {
    const idx = segment.indexOf("=");
    if (idx <= 0) continue;
    const k = segment.slice(0, idx).trim();
    const v = segment.slice(idx + 1).trim();
    if (k === "t" && !timestamp) timestamp = v;
    if (k === "v1" && v) v1Signatures.push(v);
  }
  if (!timestamp || v1Signatures.length === 0) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex")
    .toLowerCase();
  return v1Signatures.some((sig) => timingSafeEqualString(sig.toLowerCase(), expected));
}

export function verifyProviderSignature({ provider, req, secrets, timingSafeEqualString }) {
  const h = req.headers || {};
  const body = req.body || {};
  const rawBody = typeof req.rawBody === "string" ? req.rawBody : JSON.stringify(body);

  if (provider === "hotmart") {
    const hottok = String(h["x-hotmart-hottok"] || body.hottok || "");
    if (!secrets.hotmart || !timingSafeEqualString(hottok, secrets.hotmart)) {
      return { ok: false, error: "invalid_hotmart_hottok" };
    }
    return { ok: true };
  }

  if (provider === "kiwify") {
    const sig = String(h["x-kiwify-signature"] || req.query?.signature || body.signature || "").toLowerCase();
    const tok = String(h["x-kiwify-token"] || body.token || "");
    const hmacOk =
      Boolean(secrets.kiwify && rawBody && sig) &&
      timingSafeEqualString(sig, crypto.createHmac("sha1", secrets.kiwify).update(rawBody).digest("hex").toLowerCase());
    const tokenOk = Boolean(secrets.kiwify && tok) && timingSafeEqualString(tok, secrets.kiwify);
    if (!hmacOk && !tokenOk) {
      return { ok: false, error: "invalid_kiwify_signature" };
    }
    return { ok: true };
  }

  if (provider === "ticto") {
    const tok = String(h["x-ticto-token"] || body.token || "");
    if (!secrets.ticto || !timingSafeEqualString(tok, secrets.ticto)) {
      return { ok: false, error: "invalid_ticto_token" };
    }
    return { ok: true };
  }

  if (provider === "stripe") {
    if (!verifyStripeSignature(rawBody, h["stripe-signature"], secrets.stripe, timingSafeEqualString)) {
      return { ok: false, error: "invalid_stripe_signature" };
    }
    return { ok: true };
  }

  if (provider === "cakto") {
    const sec = String(h["x-cakto-secret"] || body.secret || "");
    if (!secrets.cakto || !timingSafeEqualString(sec, secrets.cakto)) {
      return { ok: false, error: "invalid_cakto_secret" };
    }
    return { ok: true };
  }

  if (provider === "kirvano") {
    const tok = String(h["security-token"] || h["x-kirvano-token"] || body.token || "");
    if (!secrets.kirvano || !timingSafeEqualString(tok, secrets.kirvano)) {
      return { ok: false, error: "invalid_kirvano_token" };
    }
    return { ok: true };
  }

  if (provider === "generic") {
    const rawHeader = String(h["x-webhook-signature"] || h["x-signature-sha256"] || "").trim();
    const providedHex = rawHeader.replace(/^sha256=/i, "").trim().toLowerCase();
    if (!secrets.generic || !rawBody || !providedHex) {
      return { ok: false, error: "invalid_generic_signature" };
    }
    const expectedHex = crypto.createHmac("sha256", secrets.generic).update(rawBody).digest("hex").toLowerCase();
    if (!timingSafeEqualString(providedHex, expectedHex)) {
      return { ok: false, error: "invalid_generic_signature" };
    }
    return { ok: true };
  }

  return { ok: false, error: "unsupported_provider" };
}

function extractPhone(phoneInput) {
  if (!phoneInput) return "";
  if (typeof phoneInput === "string") return phoneInput;
  if (typeof phoneInput === "object") {
    return String(phoneInput.full_number || `${phoneInput.ddi || ""}${phoneInput.ddd || ""}${phoneInput.number || ""}`);
  }
  return "";
}

export function parseWebhookPayload(provider, body = {}) {
  const b = body && typeof body === "object" ? body : {};

  if (provider === "hotmart") {
    const purchase = b.data?.purchase || {};
    const buyer = b.data?.buyer || {};
    const product = b.data?.product || {};
    const rawAmount = purchase.price?.value ?? purchase.full_price?.value ?? purchase.original_offer_price?.value;
    return {
      eventName: String(b.event || "").toUpperCase(),
      transactionId: String(purchase.transaction || b.id || ""),
      buyerEmail: String(buyer.email || ""),
      buyerName: String(buyer.name || ""),
      buyerPhone: String(buyer.checkout_phone || buyer.phone || ""),
      productId: String(product.id || ""),
      offerName: String(product.name || purchase.offer?.code || ""),
      amountCents: parseMoneyToCents(rawAmount),
      currency: String(purchase.price?.currency_value || purchase.full_price?.currency_value || b.currency || "BRL").toUpperCase(),
      paymentMethod: normalizePaymentMethod(purchase.payment?.type),
    };
  }

  if (provider === "kiwify") {
    const comm = b.Commissions || b.commissions || {};
    const cust = b.Customer || b.customer || {};
    const prod = b.Product || b.product || {};
    const hasCents = comm.charge_amount !== undefined || comm.product_base_price !== undefined;
    const rawAmount = hasCents ? (comm.charge_amount ?? comm.product_base_price) : (b.amount ?? b.order_amount);
    return {
      eventName: String(b.webhook_event_type || b.order_status || "").toLowerCase(),
      transactionId: String(b.order_id || ""),
      buyerEmail: String(cust.email || ""),
      buyerName: String(cust.full_name || cust.name || ""),
      buyerPhone: String(cust.mobile || cust.phone || ""),
      productId: String(prod.product_id || b.product_id || ""),
      offerName: String(prod.product_name || b.product_name || ""),
      amountCents: parseMoneyToCents(rawAmount, { isIntegerCents: hasCents }),
      currency: String(comm.product_base_price_currency || b.currency || "BRL").toUpperCase(),
      paymentMethod: normalizePaymentMethod(b.payment_method),
    };
  }

  if (provider === "ticto") {
    const order = b.order || b.data?.order || {};
    const customer = b.customer || b.data?.customer || {};
    const item = b.item || b.data?.items?.[0] || b.product || {};
    const rawAmount = order.paid_amount ?? order.amount ?? item.amount ?? b.paid_amount ?? b.amount;
    return {
      eventName: String(b.status || b.event || order.status || "").toLowerCase(),
      transactionId: String(order.hash || order.id || b.transaction_id || ""),
      buyerEmail: String(customer.email || ""),
      buyerName: String(customer.name || ""),
      buyerPhone: extractPhone(customer.phone),
      productId: String(item.product_id || item.id || b.product_id || ""),
      offerName: String(item.offer_name || b.offer_name || item.name || ""),
      amountCents: parseMoneyToCents(rawAmount, { isIntegerCents: true }),
      currency: String(order.currency || b.currency || "BRL").toUpperCase(),
      paymentMethod: normalizePaymentMethod(b.payment_method || order.payment_method),
    };
  }

  if (provider === "stripe") {
    const obj = b.data?.object || {};
    const rawAmount = obj.amount_total ?? obj.amount_paid ?? obj.amount_refunded ?? obj.amount;
    return {
      eventName: String(b.type || "").toLowerCase(),
      transactionId: String(b.id || obj.id || ""),
      buyerEmail: String(obj.customer_details?.email || obj.customer_email || obj.receipt_email || ""),
      buyerName: String(obj.customer_details?.name || ""),
      buyerPhone: String(obj.customer_details?.phone || ""),
      productId: String(obj.metadata?.product_id || ""),
      offerName: String(obj.metadata?.plan_name || ""),
      amountCents: parseMoneyToCents(rawAmount, { isIntegerCents: true }),
      currency: String(obj.currency || "brl").toUpperCase(),
      paymentMethod: normalizePaymentMethod(obj.payment_method_types?.[0] || obj.payment_method_details?.type),
    };
  }

  if (provider === "cakto") {
    const data = b.data || {};
    const rawAmount = data.amount ?? data.plan?.amount ?? data.offer?.price ?? b.amount;
    return {
      eventName: String(b.event || data.status || "").toLowerCase(),
      transactionId: String(data.transaction_id || data.order_id || data.id || data.subscription_id || b.id || ""),
      buyerEmail: String(data.customer?.email || ""),
      buyerName: String(data.customer?.name || ""),
      buyerPhone: extractPhone(data.customer?.phone),
      productId: String(data.product?.id || data.plan?.id || ""),
      offerName: String(data.product?.name || data.plan?.name || ""),
      amountCents: parseMoneyToCents(rawAmount),
      currency: String(data.currency || b.currency || "BRL").toUpperCase(),
      paymentMethod: normalizePaymentMethod(data.paymentMethod || data.payment?.method || data.payment_method),
    };
  }

  if (provider === "kirvano") {
    const customer = b.customer || {};
    const firstProd = Array.isArray(b.products) ? b.products[0] || {} : b.product || {};
    const rawAmount = b.sale?.amount ?? b.total_price ?? firstProd.price ?? b.amount;
    return {
      eventName: String(b.event || b.status || b.sale?.status || "").toLowerCase(),
      transactionId: String(b.sale_id || b.sale?.id || b.checkout_id || b.id || ""),
      buyerEmail: String(customer.email || ""),
      buyerName: String(customer.name || ""),
      buyerPhone: String(customer.phone_number || customer.phone || ""),
      productId: String(firstProd.id || b.product_id || ""),
      offerName: String(firstProd.name || b.offer_name || ""),
      amountCents: parseMoneyToCents(rawAmount),
      currency: String(b.sale?.currency || b.currency || "BRL").toUpperCase(),
      paymentMethod: normalizePaymentMethod(b.sale?.payment_method || b.payment_method),
    };
  }

  // generic
  const customer = b.customer || b.buyer || {};
  const hasIntCents = b.amount_cents !== undefined && b.amount_cents !== null && b.amount_cents !== "";
  const rawAmount = hasIntCents ? b.amount_cents : (b.amount ?? b.price ?? b.value);
  return {
    eventName: String(b.event || b.event_type || b.status || "").toLowerCase(),
    transactionId: String(b.transaction_id || b.order_id || b.id || ""),
    buyerEmail: String(customer.email || b.email || ""),
    buyerName: String(customer.name || b.name || ""),
    buyerPhone: extractPhone(customer.phone || b.phone),
    productId: String(b.product_id || b.product?.id || ""),
    offerName: String(b.offer_name || b.product?.name || b.plan_tier || ""),
    amountCents: parseMoneyToCents(rawAmount, { isIntegerCents: hasIntCents }),
    currency: String(b.currency || "BRL").toUpperCase(),
    paymentMethod: normalizePaymentMethod(b.payment_method),
  };
}
