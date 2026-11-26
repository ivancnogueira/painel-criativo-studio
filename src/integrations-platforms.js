import crypto from "node:crypto";
import { normalizePaymentMethod, parseMoneyToCents } from "./webhook-parsers.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const PLATFORMS = [
  {
    id: "greenn",
    name: "Greenn",
    category: "destaques",
    categoryLabel: "Destaques",
    description: "Vendas únicas, contratos e assinaturas da Greenn com captura de evento ao vivo.",
    color: "#16a34a",
    logo: "/logos-integracoes/greenn.svg",
    defaultAmountUnit: "decimal",
    headerAuthHint: "X-Greenn-Signature ou token na URL",
    tokenLabel: "Webhook Token da Greenn",
    tokenPlaceholder: "Cole o token configurado na Greenn",
    approveValues: ["paid", "approved", "complete", "completed", "trialing", "active"],
    revokeValues: ["refunded", "chargedback", "chargeback", "canceled", "cancelled", "refused", "unpaid", "expired"],
    renewValues: ["subscription_renewed", "renewed", "contract_renewed"],
    hints: {
      email: ["client.email", "buyer.email", "customer.email", "email"],
      name: ["client.name", "buyer.name", "customer.name", "name"],
      firstName: ["client.first_name", "customer.first_name"],
      lastName: ["client.last_name", "customer.last_name"],
      phone: ["client.cellphone", "client.phone", "buyer.cellphone", "customer.phone", "cellphone"],
      externalId: ["sale.id", "sale_id", "id", "transaction_id", "order_id"],
      status: ["current_status", "currentStatus", "sale.status", "status", "event"],
      amount: ["sale.amount", "amount", "sale.total", "total"],
      currency: ["sale.currency", "currency"],
      paymentMethod: ["sale.method", "payment_method", "sale.payment_method"],
      productId: ["product.id", "product_id", "offer.id"],
      offerName: ["product.name", "offer.name", "offer_name"],
    },
    samplePayload: {
      event: "saleUpdated",
      current_status: "paid",
      sale: {
        id: "GRN-99412",
        amount: 497.0,
        currency: "BRL",
        method: "pix",
      },
      product: {
        id: "PROD_AG10",
        name: "CriativoOS Agência 10",
      },
      client: {
        name: "Comprador Exemplo",
        email: "cliente@exemplo.invalid",
        cellphone: "+5511900000000",
      },
    },
  },
  {
    id: "appmax",
    name: "Appmax",
    category: "destaques",
    categoryLabel: "Destaques",
    description: "Checkout de alta conversão com suporte nativo a firstname + lastname, bundles e SKUs.",
    color: "#6d28d9",
    logo: "/logos-integracoes/appmax.svg",
    defaultAmountUnit: "decimal",
    headerAuthHint: "Token na URL (?token=...) ou X-Webhook-Token",
    tokenLabel: "Token do Webhook (Appmax)",
    tokenPlaceholder: "Opcional: cole o token se usar autenticação por header",
    approveValues: ["orderpaid", "orderapproved", "orderauthorized", "paid", "approved", "aprovado", "pago", "integrado"],
    revokeValues: ["orderrefunded", "ordercanceled", "orderchargeback", "refunded", "canceled", "cancelled", "chargeback", "estornado", "cancelado"],
    renewValues: ["subscriptionrenewed", "orderrenewed"],
    hints: {
      email: ["data.customer.email", "customer.email", "email"],
      name: ["data.customer.fullname", "customer.fullname", "data.customer.name", "customer.name"],
      firstName: ["data.customer.firstname", "customer.firstname", "firstname"],
      lastName: ["data.customer.lastname", "customer.lastname", "lastname"],
      phone: ["data.customer.telephone", "customer.telephone", "data.customer.phone", "customer.phone"],
      externalId: ["data.id", "order_id", "id"],
      status: ["event", "data.status", "status"],
      amount: ["data.total", "data.full_payment_amount", "total", "amount"],
      currency: ["data.currency", "currency"],
      paymentMethod: ["data.payment_type", "payment_type", "data.payment_method", "payment_method"],
      productId: ["data.bundles.0.products.0.sku", "data.bundles.0.id", "data.products.0.sku", "data.items.0.sku", "product_id"],
      offerName: ["data.bundles.0.name", "data.bundles.0.products.0.name", "data.products.0.name", "data.items.0.name", "offer_name"],
    },
    samplePayload: {
      event: "OrderPaid",
      data: {
        id: "APX-55821",
        status: "aprovado",
        total: 497.0,
        full_payment_amount: 497.0,
        payment_type: "pix",
        customer: {
          firstname: "Comprador",
          lastname: "Exemplo",
          email: "cliente@exemplo.invalid",
          telephone: "11900000000",
        },
        bundles: [
          {
            id: "BND-AG10",
            name: "CriativoOS Agência 10",
            products: [{ sku: "PROD_AG10", name: "Licença Agência 10" }],
          },
        ],
      },
    },
  },
  {
    id: "hotmart",
    name: "Hotmart",
    category: "checkouts_br",
    categoryLabel: "Checkouts BR",
    description: "Receba compras, reembolsos, chargebacks e renovações da Hotmart com Hottok.",
    color: "#f04e23",
    logo: "/logos-integracoes/hotmart.svg",
    defaultAmountUnit: "decimal",
    headerAuthHint: "X-Hotmart-Hottok ou token na URL",
    tokenLabel: "Hottok da Hotmart",
    tokenPlaceholder: "Cole o Hottok da sua conta Hotmart",
    approveValues: ["purchase_approved", "purchase_complete", "approved", "complete"],
    revokeValues: ["purchase_refunded", "purchase_chargeback", "purchase_canceled", "subscription_cancellation"],
    renewValues: ["subscription_renewed"],
    hints: {
      email: ["data.buyer.email", "buyer.email", "email"],
      name: ["data.buyer.name", "buyer.name", "name"],
      firstName: ["data.buyer.first_name"],
      lastName: ["data.buyer.last_name"],
      phone: ["data.buyer.checkout_phone", "data.buyer.phone", "buyer.phone"],
      externalId: ["data.purchase.transaction", "id", "transaction"],
      status: ["event", "data.purchase.status", "status"],
      amount: ["data.purchase.price.value", "data.purchase.full_price.value", "data.purchase.original_offer_price.value"],
      currency: ["data.purchase.price.currency_value", "data.purchase.full_price.currency_value", "currency"],
      paymentMethod: ["data.purchase.payment.type", "payment.type"],
      productId: ["data.product.id", "data.purchase.offer.code", "product.id"],
      offerName: ["data.product.name", "data.purchase.offer.code", "product.name"],
    },
    samplePayload: {
      id: "HM-EVT-001",
      event: "PURCHASE_APPROVED",
      data: {
        product: { id: "PROD_AG10", name: "CriativoOS Agência 10" },
        buyer: { email: "cliente@exemplo.invalid", name: "Comprador Exemplo", checkout_phone: "+5511900000000" },
        purchase: {
          transaction: "HP-998877",
          price: { value: 497.0, currency_value: "BRL" },
          payment: { type: "PIX" },
        },
      },
    },
  },
  {
    id: "kiwify",
    name: "Kiwify",
    category: "checkouts_br",
    categoryLabel: "Checkouts BR",
    description: "Integração com eventos da Kiwify (valores em centavos e validação de token/HMAC).",
    color: "#22c55e",
    logo: "/logos-integracoes/kiwify.svg",
    defaultAmountUnit: "cents",
    headerAuthHint: "X-Kiwify-Token / signature ou token na URL",
    tokenLabel: "Token / Secret da Kiwify",
    tokenPlaceholder: "Cole o token/secret configurado na Kiwify",
    approveValues: ["order_approved", "order_paid", "paid", "approved"],
    revokeValues: ["order_refunded", "chargeback", "subscription_canceled", "refunded"],
    renewValues: ["subscription_renewed"],
    hints: {
      email: ["Customer.email", "customer.email", "email"],
      name: ["Customer.full_name", "Customer.name", "customer.full_name", "customer.name"],
      firstName: ["Customer.first_name", "customer.first_name"],
      lastName: ["Customer.last_name", "customer.last_name"],
      phone: ["Customer.mobile", "Customer.phone", "customer.mobile", "customer.phone"],
      externalId: ["order_id", "id"],
      status: ["webhook_event_type", "order_status", "status"],
      amount: ["Commissions.charge_amount", "Commissions.product_base_price", "amount"],
      currency: ["Commissions.product_base_price_currency", "currency"],
      paymentMethod: ["payment_method"],
      productId: ["Product.product_id", "product_id"],
      offerName: ["Product.product_name", "product_name"],
    },
    samplePayload: {
      order_id: "KW-77410",
      webhook_event_type: "order_paid",
      payment_method: "pix",
      Product: { product_id: "PROD_AG10", product_name: "CriativoOS Agência 10" },
      Customer: { email: "cliente@exemplo.invalid", full_name: "Comprador Exemplo", mobile: "+5511900000000" },
      Commissions: { charge_amount: 49700, product_base_price_currency: "BRL" },
    },
  },
  {
    id: "ticto",
    name: "Ticto",
    category: "checkouts_br",
    categoryLabel: "Checkouts BR",
    description: "Webhooks v1/v2 da Ticto com suporte a pedidos, ofertas e assinaturas.",
    color: "#0ea5e9",
    logo: "/logos-integracoes/ticto.svg",
    defaultAmountUnit: "cents",
    headerAuthHint: "X-Ticto-Token ou token na URL",
    tokenLabel: "Token Secreto da Ticto",
    tokenPlaceholder: "Cole o token configurado na Ticto",
    approveValues: ["paid", "approved", "authorized", "sale_approved"],
    revokeValues: ["refunded", "chargeback", "canceled", "cancelled"],
    renewValues: ["subscription_renewed"],
    hints: {
      email: ["data.customer.email", "customer.email", "email"],
      name: ["data.customer.name", "customer.name", "name"],
      firstName: [],
      lastName: [],
      phone: ["data.customer.phone.full_number", "customer.phone", "data.customer.phone"],
      externalId: ["data.order.hash", "order.hash", "order.id", "transaction_id"],
      status: ["status", "event", "order.status"],
      amount: ["data.order.paid_amount", "order.paid_amount", "order.amount", "paid_amount"],
      currency: ["data.order.currency", "order.currency", "currency"],
      paymentMethod: ["payment_method", "order.payment_method"],
      productId: ["data.items.0.id", "item.product_id", "item.id", "product_id"],
      offerName: ["data.items.0.name", "item.offer_name", "item.name", "offer_name"],
    },
    samplePayload: {
      status: "paid",
      payment_method: "pix",
      data: {
        order: { hash: "TC-33219", paid_amount: 49700, currency: "BRL" },
        customer: { email: "cliente@exemplo.invalid", name: "Comprador Exemplo", phone: "+5511900000000" },
        items: [{ id: "PROD_AG10", name: "CriativoOS Agência 10" }],
      },
    },
  },
  {
    id: "cakto",
    name: "Cakto",
    category: "checkouts_br",
    categoryLabel: "Checkouts BR",
    description: "Receba aprovações, reembolsos e renovações da Cakto automaticamente.",
    color: "#8b5cf6",
    logo: "/logos-integracoes/cakto.svg",
    defaultAmountUnit: "decimal",
    headerAuthHint: "X-Cakto-Secret ou token na URL",
    tokenLabel: "Secret da Cakto",
    tokenPlaceholder: "Cole o secret configurado na Cakto",
    approveValues: ["purchase_approved", "paid", "approved"],
    revokeValues: ["purchase_refunded", "chargeback", "subscription_canceled", "refunded"],
    renewValues: ["subscription_renewed"],
    hints: {
      email: ["data.customer.email", "customer.email"],
      name: ["data.customer.name", "customer.name"],
      firstName: [],
      lastName: [],
      phone: ["data.customer.phone", "customer.phone"],
      externalId: ["data.transaction_id", "data.order_id", "data.id", "id"],
      status: ["event", "data.status"],
      amount: ["data.amount", "data.plan.amount", "data.offer.price"],
      currency: ["data.currency", "currency"],
      paymentMethod: ["data.paymentMethod", "data.payment.method", "data.payment_method"],
      productId: ["data.product.id", "data.plan.id", "data.offer.id"],
      offerName: ["data.product.name", "data.plan.name", "data.offer.name"],
    },
    samplePayload: {
      event: "purchase_approved",
      data: {
        transaction_id: "CK-88412",
        amount: 497.0,
        currency: "BRL",
        paymentMethod: "pix",
        product: { id: "PROD_AG10", name: "CriativoOS Agência 10" },
        customer: { email: "cliente@exemplo.invalid", name: "Comprador Exemplo", phone: "+5511900000000" },
      },
    },
  },
  {
    id: "kirvano",
    name: "Kirvano",
    category: "checkouts_br",
    categoryLabel: "Checkouts BR",
    description: "Vendas e assinaturas Kirvano com leitura automática de moeda BR e múltiplos produtos.",
    color: "#14b8a6",
    logo: "/logos-integracoes/kirvano.svg",
    defaultAmountUnit: "decimal",
    headerAuthHint: "Security-Token ou token na URL",
    tokenLabel: "Security-Token da Kirvano",
    tokenPlaceholder: "Cole o Security-Token da Kirvano",
    approveValues: ["sale_approved", "approved", "paid"],
    revokeValues: ["sale_refunded", "sale_chargeback", "refunded", "canceled"],
    renewValues: ["subscription_renewed"],
    hints: {
      email: ["customer.email", "email"],
      name: ["customer.name", "name"],
      firstName: [],
      lastName: [],
      phone: ["customer.phone_number", "customer.phone", "phone"],
      externalId: ["sale_id", "sale.id", "checkout_id", "id"],
      status: ["event", "status", "sale.status"],
      amount: ["total_price", "sale.amount", "products.0.price", "amount"],
      currency: ["sale.currency", "currency"],
      paymentMethod: ["payment_method", "sale.payment_method"],
      productId: ["products.0.id", "product.id", "product_id"],
      offerName: ["products.0.name", "product.name", "offer_name"],
    },
    samplePayload: {
      event: "SALE_APPROVED",
      sale_id: "KR-10293",
      payment_method: "PIX",
      total_price: "R$ 497,00",
      products: [{ id: "PROD_AG10", name: "CriativoOS Agência 10" }],
      customer: { email: "cliente@exemplo.invalid", name: "Comprador Exemplo", phone_number: "+5511900000000" },
    },
  },
  {
    id: "stripe",
    name: "Stripe",
    category: "pagamentos",
    categoryLabel: "Pagamentos",
    description: "Checkout Sessions, faturas recorrentes e reembolsos internacionais via Stripe.",
    color: "#635bff",
    logo: "/logos-integracoes/stripe.svg",
    defaultAmountUnit: "cents",
    headerAuthHint: "Token na URL ou Stripe-Signature",
    tokenLabel: "Signing Secret da Stripe (whsec_...)",
    tokenPlaceholder: "Cole o whsec_... da Stripe",
    approveValues: ["checkout.session.completed", "payment_intent.succeeded", "invoice.payment_succeeded"],
    revokeValues: ["charge.refunded", "customer.subscription.deleted", "charge.dispute.created"],
    renewValues: ["invoice.payment_succeeded"],
    hints: {
      email: ["data.object.customer_details.email", "data.object.customer_email", "data.object.receipt_email"],
      name: ["data.object.customer_details.name"],
      firstName: [],
      lastName: [],
      phone: ["data.object.customer_details.phone"],
      externalId: ["id", "data.object.id"],
      status: ["type"],
      amount: ["data.object.amount_total", "data.object.amount_paid", "data.object.amount"],
      currency: ["data.object.currency"],
      paymentMethod: ["data.object.payment_method_types.0", "data.object.payment_method_details.type"],
      productId: ["data.object.metadata.product_id", "data.object.metadata.price_id"],
      offerName: ["data.object.metadata.plan_name", "data.object.metadata.offer_name"],
    },
    samplePayload: {
      id: "evt_stripe_001",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_12345",
          amount_total: 49700,
          currency: "brl",
          payment_method_types: ["card"],
          customer_details: {
            email: "cliente@exemplo.invalid",
            name: "Comprador Exemplo",
            phone: "+5511900000000",
          },
          metadata: { product_id: "PROD_AG10", plan_name: "CriativoOS Agência 10" },
        },
      },
    },
  },
  {
    id: "eduzz",
    name: "Eduzz",
    category: "checkouts_br",
    categoryLabel: "Checkouts BR",
    description: "Nutror, Órbita e webhooks de faturas da Eduzz (JSON ou form-urlencoded).",
    color: "#f59e0b",
    logo: "/logos-integracoes/eduzz.svg",
    defaultAmountUnit: "decimal",
    headerAuthHint: "Token na URL (?token=...)",
    approveValues: ["3", "paid", "approved", "invoice_paid", "compra_aprovada"],
    revokeValues: ["7", "refunded", "canceled", "cancelled", "reembolsada"],
    renewValues: ["contract_renewed"],
    hints: {
      email: ["cus_email", "buyer.email", "customer.email", "data.buyer.email"],
      name: ["cus_name", "buyer.name", "customer.name"],
      firstName: [],
      lastName: [],
      phone: ["cus_cel", "cus_tel", "buyer.phone"],
      externalId: ["trans_cod", "invoice_id", "id"],
      status: ["trans_status", "event", "status"],
      amount: ["trans_value", "trans_paid", "amount"],
      currency: ["trans_currency", "currency"],
      paymentMethod: ["trans_paymentmethod", "payment_method"],
      productId: ["product_cod", "pro_cod", "product_id"],
      offerName: ["product_name", "pro_name", "offer_name"],
    },
    samplePayload: {
      event: "invoice_paid",
      trans_cod: "EDZ-44109",
      trans_status: "paid",
      trans_value: 497.0,
      trans_currency: "BRL",
      trans_paymentmethod: "pix",
      product_cod: "PROD_AG10",
      product_name: "CriativoOS Agência 10",
      cus_name: "Comprador Exemplo",
      cus_email: "cliente@exemplo.invalid",
      cus_cel: "+5511900000000",
    },
  },
  {
    id: "braip",
    name: "Braip",
    category: "checkouts_br",
    categoryLabel: "Checkouts BR",
    description: "Postbacks da Braip para pagamentos aprovados, estornos e assinaturas.",
    color: "#7c3aed",
    logo: "/logos-integracoes/braip.svg",
    defaultAmountUnit: "cents",
    headerAuthHint: "Token na URL (?token=...)",
    approveValues: ["pagamento aprovado", "aprovado", "paid", "approved", "2"],
    revokeValues: ["estornada", "cancelada", "chargeback", "refunded", "canceled", "4", "5"],
    renewValues: ["assinatura renovada"],
    hints: {
      email: ["client_email", "buyer.email", "customer.email"],
      name: ["client_name", "buyer.name", "customer.name"],
      firstName: [],
      lastName: [],
      phone: ["client_cel", "client_phone"],
      externalId: ["trans_key", "trans_id", "id"],
      status: ["trans_status", "type", "status"],
      amount: ["trans_value", "amount"],
      currency: ["currency"],
      paymentMethod: ["trans_payment", "payment_method"],
      productId: ["product_key", "plan_key", "product_id"],
      offerName: ["product_name", "plan_name"],
    },
    samplePayload: {
      type: "TRACKING_CODE_UPDATED",
      trans_key: "BRP-70211",
      trans_status: "Pagamento Aprovado",
      trans_value: 49700,
      trans_payment: "pix",
      product_key: "PROD_AG10",
      product_name: "CriativoOS Agência 10",
      client_name: "Comprador Exemplo",
      client_email: "cliente@exemplo.invalid",
      client_cel: "+5511900000000",
    },
  },
  {
    id: "perfectpay",
    name: "PerfectPay",
    category: "checkouts_br",
    categoryLabel: "Checkouts BR",
    description: "Notificações de pedidos aprovados, cancelados e planos da PerfectPay.",
    color: "#06b6d4",
    logo: "/logos-integracoes/perfectpay.svg",
    defaultAmountUnit: "decimal",
    headerAuthHint: "Token na URL (?token=...)",
    approveValues: ["approved", "authorized", "2", "10"],
    revokeValues: ["refunded", "charged_back", "canceled", "cancelled", "6", "7", "9"],
    renewValues: ["subscription_renewed"],
    hints: {
      email: ["customer.email", "email"],
      name: ["customer.full_name", "customer.name"],
      firstName: [],
      lastName: [],
      phone: ["customer.phone_number", "customer.phone"],
      externalId: ["code", "sale_code", "id"],
      status: ["sale_status_enum_key", "sale_status_detail", "status"],
      amount: ["sale_amount", "amount"],
      currency: ["currency_enum_key", "currency"],
      paymentMethod: ["payment_type_enum_key", "payment_method"],
      productId: ["product.code", "plan.code", "product_id"],
      offerName: ["product.name", "plan.name"],
    },
    samplePayload: {
      code: "PP-31920",
      sale_status_enum_key: "approved",
      sale_amount: 497.0,
      payment_type_enum_key: "pix",
      product: { code: "PROD_AG10", name: "CriativoOS Agência 10" },
      customer: { full_name: "Comprador Exemplo", email: "cliente@exemplo.invalid", phone_number: "+5511900000000" },
    },
  },
  {
    id: "yampi",
    name: "Yampi",
    category: "checkouts_br",
    categoryLabel: "Checkouts BR",
    description: "Pedidos pagos e cancelados do checkout Yampi com leitura automática de cliente e SKU.",
    color: "#ec4899",
    logo: "/logos-integracoes/yampi.svg",
    defaultAmountUnit: "decimal",
    headerAuthHint: "Token na URL (?token=...) ou X-Yampi-Hmac-SHA256",
    approveValues: ["order.paid", "paid", "approved"],
    revokeValues: ["order.cancelled", "order.refunded", "cancelled", "refunded"],
    renewValues: [],
    hints: {
      email: ["resource.customer.data.email", "customer.email", "email"],
      name: ["resource.customer.data.name", "customer.name"],
      firstName: ["resource.customer.data.first_name"],
      lastName: ["resource.customer.data.last_name"],
      phone: ["resource.customer.data.phone.full_number", "resource.customer.data.phone.number"],
      externalId: ["resource.number", "resource.id", "id"],
      status: ["event", "resource.status.data.alias"],
      amount: ["resource.value_total", "resource.total"],
      currency: ["resource.currency"],
      paymentMethod: ["resource.payments.data.0.payment.data.alias"],
      productId: ["resource.items.data.0.sku_id", "resource.items.data.0.item_sku"],
      offerName: ["resource.items.data.0.item_name", "resource.items.data.0.sku.data.title"],
    },
    samplePayload: {
      event: "order.paid",
      resource: {
        id: "YMP-81203",
        number: 81203,
        value_total: 497.0,
        customer: { data: { name: "Comprador Exemplo", email: "cliente@exemplo.invalid", phone: { full_number: "+5511900000000" } } },
        items: { data: [{ item_sku: "PROD_AG10", item_name: "CriativoOS Agência 10" }] },
      },
    },
  },
  {
    id: "cartpanda",
    name: "Cartpanda",
    category: "checkouts_br",
    categoryLabel: "Checkouts BR",
    description: "Eventos de pedidos pagos e reembolsados do checkout Cartpanda.",
    color: "#10b981",
    logo: "/logos-integracoes/cartpanda.svg",
    defaultAmountUnit: "decimal",
    headerAuthHint: "Token na URL (?token=...)",
    approveValues: ["order.paid", "paid", "approved"],
    revokeValues: ["order.refunded", "order.canceled", "refunded", "canceled"],
    renewValues: [],
    hints: {
      email: ["order.customer.email", "customer.email", "email"],
      name: ["order.customer.full_name", "order.customer.name"],
      firstName: ["order.customer.first_name"],
      lastName: ["order.customer.last_name"],
      phone: ["order.customer.phone"],
      externalId: ["order.id", "order.order_number", "id"],
      status: ["event", "order.financial_status"],
      amount: ["order.total_price", "total_price"],
      currency: ["order.currency", "currency"],
      paymentMethod: ["order.payment_type", "order.gateway"],
      productId: ["order.line_items.0.sku", "order.line_items.0.product_id"],
      offerName: ["order.line_items.0.title", "order.line_items.0.name"],
    },
    samplePayload: {
      event: "order.paid",
      order: {
        id: "CP-90123",
        financial_status: "paid",
        total_price: 497.0,
        currency: "BRL",
        payment_type: "pix",
        customer: { first_name: "Comprador", last_name: "Exemplo", email: "cliente@exemplo.invalid", phone: "+5511900000000" },
        line_items: [{ sku: "PROD_AG10", title: "CriativoOS Agência 10" }],
      },
    },
  },
  {
    id: "custom",
    name: "Webhook Personalizado",
    category: "automacao",
    categoryLabel: "Automação / API",
    description: "Para n8n, Make, Zapier, WooCommerce ou qualquer checkout próprio via mapeamento visual.",
    color: "#64748b",
    logo: "/logos-integracoes/custom.svg",
    defaultAmountUnit: "decimal",
    headerAuthHint: "Token na URL (?token=...) ou X-Webhook-Token",
    tokenLabel: "Token / Secret do Webhook",
    tokenPlaceholder: "Opcional: cole o segredo HMAC ou token de autenticação",
    approveValues: ["purchase_approved", "order_paid", "order.paid", "paid", "approved", "active"],
    revokeValues: ["purchase_refunded", "refunded", "canceled", "cancelled", "chargeback"],
    renewValues: ["subscription_renewed", "renewed"],
    hints: {
      email: ["customer.email", "buyer.email", "email"],
      name: ["customer.name", "buyer.name", "name"],
      firstName: ["customer.firstname", "customer.first_name", "first_name"],
      lastName: ["customer.lastname", "customer.last_name", "last_name"],
      phone: ["customer.phone", "buyer.phone", "phone"],
      externalId: ["transaction_id", "order_id", "id"],
      status: ["event", "event_type", "status"],
      amount: ["amount_cents", "amount", "total", "price"],
      currency: ["currency"],
      paymentMethod: ["payment_method", "method"],
      productId: ["product_id", "sku", "product.id"],
      offerName: ["offer_name", "product.name", "plan_tier"],
    },
    samplePayload: {
      event: "purchase_approved",
      transaction_id: "CUST-0001",
      amount: 497.0,
      currency: "BRL",
      payment_method: "pix",
      product_id: "PROD_AG10",
      offer_name: "CriativoOS Agência 10",
      customer: {
        name: "Comprador Exemplo",
        email: "cliente@exemplo.invalid",
        phone: "+5511900000000",
      },
    },
  },
];

export function getPlatform(id) {
  const clean = String(id || "").trim().toLowerCase();
  return PLATFORMS.find((p) => p.id === clean);
}

export function getPublicPlatformsCatalog() {
  return PLATFORMS.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    categoryLabel: p.categoryLabel,
    description: p.description,
    color: p.color,
    logo: p.logo,
    defaultAmountUnit: p.defaultAmountUnit,
    headerAuthHint: p.headerAuthHint,
    tokenLabel: p.tokenLabel || "Token / Secret do Webhook",
    tokenPlaceholder: p.tokenPlaceholder || "Opcional: cole o token ou secret da plataforma",
    approveValues: p.approveValues,
    revokeValues: p.revokeValues,
    renewValues: p.renewValues,
  }));
}

export function getByPath(payload, path) {
  if (!path || payload === null || payload === undefined) return undefined;
  const parts = String(path)
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let current = payload;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

export function flattenPayload(payload, prefix = "", depth = 0, acc = []) {
  if (depth > 7 || acc.length > 350) return acc;

  if (payload === null || payload === undefined) {
    if (prefix) acc.push({ path: prefix, value: "—", type: "null" });
    return acc;
  }

  if (Array.isArray(payload)) {
    payload.slice(0, 12).forEach((item, idx) => {
      flattenPayload(item, prefix ? `${prefix}.${idx}` : String(idx), depth + 1, acc);
    });
    return acc;
  }

  if (typeof payload === "object") {
    for (const [k, v] of Object.entries(payload)) {
      flattenPayload(v, prefix ? `${prefix}.${k}` : k, depth + 1, acc);
    }
    return acc;
  }

  if (prefix) {
    acc.push({
      path: prefix,
      value: String(payload).slice(0, 140),
      type: typeof payload === "number" ? "number" : typeof payload === "boolean" ? "boolean" : "string",
    });
  }
  return acc;
}

export function emptyMapping(platform) {
  return {
    email: "",
    name: "",
    firstName: "",
    lastName: "",
    phone: "",
    externalId: "",
    statusField: "",
    amountField: "",
    amountUnit: platform?.defaultAmountUnit === "cents" ? "cents" : "decimal",
    currencyField: "",
    paymentMethodField: "",
    productIdField: "",
    offerNameField: "",
    approveValues: [...(platform?.approveValues || ["paid", "approved"])],
    revokeValues: [...(platform?.revokeValues || ["refunded", "canceled", "chargeback"])],
    renewValues: [...(platform?.renewValues || [])],
  };
}

export function normalizeMapping(raw, platform) {
  const base = emptyMapping(platform);
  if (!raw || typeof raw !== "object") return base;
  const asStr = (v) => (typeof v === "string" ? v.trim() : "");
  const asList = (v, fallback) =>
    Array.isArray(v)
      ? v.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)
      : typeof v === "string"
        ? v
            .split(",")
            .map((item) => item.trim().toLowerCase())
            .filter(Boolean)
        : fallback;

  return {
    email: asStr(raw.email),
    name: asStr(raw.name),
    firstName: asStr(raw.firstName),
    lastName: asStr(raw.lastName),
    phone: asStr(raw.phone),
    externalId: asStr(raw.externalId),
    statusField: asStr(raw.statusField),
    amountField: asStr(raw.amountField),
    amountUnit: raw.amountUnit === "cents" ? "cents" : raw.amountUnit === "decimal" ? "decimal" : base.amountUnit,
    currencyField: asStr(raw.currencyField),
    paymentMethodField: asStr(raw.paymentMethodField),
    productIdField: asStr(raw.productIdField),
    offerNameField: asStr(raw.offerNameField),
    approveValues: asList(raw.approveValues, base.approveValues),
    revokeValues: asList(raw.revokeValues, base.revokeValues),
    renewValues: asList(raw.renewValues, base.renewValues),
  };
}

export function suggestMapping(payload, platform) {
  const mapping = emptyMapping(platform);
  const fields = flattenPayload(payload);
  if (fields.length === 0) return mapping;

  const paths = new Set(fields.map((f) => f.path));
  const pick = (hints = []) => hints.find((h) => paths.has(h)) || "";

  if (platform?.hints) {
    mapping.email = pick(platform.hints.email);
    mapping.name = pick(platform.hints.name);
    mapping.firstName = pick(platform.hints.firstName);
    mapping.lastName = pick(platform.hints.lastName);
    mapping.phone = pick(platform.hints.phone);
    mapping.externalId = pick(platform.hints.externalId);
    mapping.statusField = pick(platform.hints.status);
    mapping.amountField = pick(platform.hints.amount);
    mapping.currencyField = pick(platform.hints.currency);
    mapping.paymentMethodField = pick(platform.hints.paymentMethod);
    mapping.productIdField = pick(platform.hints.productId);
    mapping.offerNameField = pick(platform.hints.offerName);
  }

  const lastSegment = (path) => String(path.split(".").pop() || "").toLowerCase();
  const findBy = (test) => fields.find((f) => test(f, lastSegment(f.path)))?.path || "";

  if (!mapping.email) {
    mapping.email =
      fields.find((f) => f.type === "string" && EMAIL_RE.test(f.value.trim()))?.path ||
      findBy((_f, last) => last.includes("email") || last === "mail");
  }
  if (!mapping.name && !mapping.firstName) {
    mapping.name = findBy((_f, last) => ["name", "nome", "fullname", "full_name", "client_name"].includes(last));
  }
  if (!mapping.firstName) {
    mapping.firstName = findBy((_f, last) => ["firstname", "first_name"].includes(last));
  }
  if (!mapping.lastName) {
    mapping.lastName = findBy((_f, last) => ["lastname", "last_name"].includes(last));
  }
  if (!mapping.phone) {
    mapping.phone = findBy((_f, last) =>
      ["cellphone", "phone", "telephone", "telefone", "celular", "whatsapp", "mobile", "phone_number", "checkout_phone"].includes(last),
    );
  }
  if (!mapping.statusField) {
    mapping.statusField = findBy((_f, last) =>
      ["current_status", "status", "sale_status", "event", "event_type", "type", "financial_status"].includes(last),
    );
  }
  if (!mapping.externalId) {
    mapping.externalId = findBy((_f, last) => ["sale_id", "transaction_id", "transaction", "order_id", "hash", "id"].includes(last));
  }
  if (!mapping.amountField) {
    mapping.amountField = findBy((_f, last) =>
      ["amount_cents", "amount_total", "paid_amount", "charge_amount", "amount", "total", "total_price", "price", "value"].includes(last),
    );
  }
  if (mapping.amountField && mapping.amountField.toLowerCase().includes("cents")) {
    mapping.amountUnit = "cents";
  }
  if (!mapping.currencyField) {
    mapping.currencyField = findBy((_f, last) => ["currency", "currency_value"].includes(last));
  }
  if (!mapping.paymentMethodField) {
    mapping.paymentMethodField = findBy((_f, last) => ["payment_method", "paymentmethod", "payment_type", "method"].includes(last));
  }
  if (!mapping.productIdField) {
    mapping.productIdField = findBy((_f, last) => ["product_id", "sku", "product_cod", "product_key"].includes(last));
  }
  if (!mapping.offerNameField) {
    mapping.offerNameField = findBy((_f, last) => ["offer_name", "product_name", "plan_name", "title"].includes(last));
  }

  return mapping;
}

function readPhoneValue(raw) {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string" || typeof raw === "number") return String(raw).trim();
  if (typeof raw === "object") {
    return String(raw.full_number || `${raw.ddi || ""}${raw.ddd || ""}${raw.number || ""}`).trim();
  }
  return "";
}

export function extractWithMapping(payload, rawMapping, platform) {
  const mapping = normalizeMapping(rawMapping, platform);
  const rawEmail = mapping.email ? getByPath(payload, mapping.email) : "";
  const buyerEmail = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";

  const directName = mapping.name ? String(getByPath(payload, mapping.name) ?? "").trim() : "";
  const firstPart = mapping.firstName ? String(getByPath(payload, mapping.firstName) ?? "").trim() : "";
  const lastPart = mapping.lastName ? String(getByPath(payload, mapping.lastName) ?? "").trim() : "";
  const combinedName = [firstPart, lastPart].filter(Boolean).join(" ").trim();
  const buyerName = combinedName || directName;

  const buyerPhone = mapping.phone ? readPhoneValue(getByPath(payload, mapping.phone)) : "";
  const rawTx = mapping.externalId ? getByPath(payload, mapping.externalId) : "";
  const transactionId = rawTx !== undefined && rawTx !== null ? String(rawTx).trim() : "";

  const rawStatus = mapping.statusField ? getByPath(payload, mapping.statusField) : null;
  const eventName = rawStatus === null || rawStatus === undefined ? "webhook_event" : String(rawStatus).trim();
  const normStatus = eventName.toLowerCase();

  let eventAction = "approve";
  if (mapping.statusField) {
    if (mapping.renewValues.includes(normStatus)) eventAction = "renew";
    else if (mapping.approveValues.includes(normStatus)) eventAction = "approve";
    else if (mapping.revokeValues.includes(normStatus)) eventAction = "revoke";
    else eventAction = "ignore";
  }

  const rawAmount = mapping.amountField ? getByPath(payload, mapping.amountField) : 0;
  const amountCents = parseMoneyToCents(rawAmount, { isIntegerCents: mapping.amountUnit === "cents" });

  const rawCurrency = mapping.currencyField ? getByPath(payload, mapping.currencyField) : "BRL";
  const currency = String(rawCurrency || "BRL").trim().toUpperCase() || "BRL";

  const rawMethod = mapping.paymentMethodField ? getByPath(payload, mapping.paymentMethodField) : null;
  const paymentMethod = normalizePaymentMethod(rawMethod);

  const rawProdId = mapping.productIdField ? getByPath(payload, mapping.productIdField) : "";
  const productId = rawProdId !== undefined && rawProdId !== null ? String(rawProdId).trim() : "";

  const rawOffer = mapping.offerNameField ? getByPath(payload, mapping.offerNameField) : "";
  const offerName = rawOffer !== undefined && rawOffer !== null ? String(rawOffer).trim() : "";

  return {
    emailValid: Boolean(buyerEmail && EMAIL_RE.test(buyerEmail)),
    buyerEmail,
    buyerName,
    buyerPhone,
    transactionId,
    eventName,
    eventAction,
    amountCents,
    currency,
    paymentMethod,
    productId,
    offerName,
  };
}

export function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function generateUrlToken(length = 28) {
  const raw = crypto.randomBytes(Math.ceil(length * 0.75)).toString("base64url");
  return raw.slice(0, length);
}
