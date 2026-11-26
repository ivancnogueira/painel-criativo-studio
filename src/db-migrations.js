export function ensureColumns(db, tableName, columns) {
  const existing = new Set(
    db
      .prepare(`PRAGMA table_info(${tableName});`)
      .all()
      .map((col) => col.name),
  );
  for (const { name, definition } of columns) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${definition};`);
    }
  }
}

export function ensureSchemaAndMigrations(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS painel_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      is_secret INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS licenses (
      id TEXT PRIMARY KEY,
      license_key TEXT NOT NULL UNIQUE,
      customer_email TEXT NOT NULL,
      customer_name TEXT,
      customer_phone TEXT,
      plan_tier TEXT NOT NULL CHECK(plan_tier IN ('individual', 'agencia_10', 'agencia_ilimitada')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'revoked', 'expired')),
      max_servers INTEGER NOT NULL,
      max_machines INTEGER NOT NULL,
      custom_max_machines INTEGER,
      upgrades_json TEXT NOT NULL DEFAULT '[]',
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_licenses_email ON licenses(lower(customer_email));

    CREATE TABLE IF NOT EXISTS license_machines (
      id TEXT PRIMARY KEY,
      license_id TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
      machine_id TEXT NOT NULL,
      hostname TEXT NOT NULL,
      os_platform TEXT NOT NULL,
      app_version TEXT,
      first_activated_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      revoked_at TEXT,
      UNIQUE(license_id, machine_id)
    );

    CREATE INDEX IF NOT EXISTS idx_license_machines_active ON license_machines(license_id, revoked_at);

    CREATE TABLE IF NOT EXISTS license_events (
      id TEXT PRIMARY KEY,
      license_id TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_license_events_type_date ON license_events(license_id, event_type, created_at);

    CREATE TABLE IF NOT EXISTS sales_webhook_deliveries (
      delivery_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      transaction_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      buyer_email TEXT,
      buyer_phone TEXT,
      action TEXT,
      license_key TEXT,
      summary_json TEXT,
      processed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notification_logs (
      id TEXT PRIMARY KEY,
      license_id TEXT,
      license_key TEXT,
      channel TEXT NOT NULL CHECK(channel IN ('email', 'whatsapp')),
      recipient TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('sent', 'error', 'skipped')),
      detail TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notification_logs_created ON notification_logs(created_at DESC);

    CREATE TABLE IF NOT EXISTS webhook_integrations (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      url_token TEXT NOT NULL,
      auth_mode TEXT NOT NULL DEFAULT 'url_token',
      secret_setting_key TEXT,
      delivery_mode TEXT NOT NULL DEFAULT 'product_map' CHECK(delivery_mode IN ('direct', 'product_map')),
      fixed_plan_tier TEXT DEFAULT 'individual',
      fixed_upgrades_json TEXT NOT NULL DEFAULT '[]',
      fixed_duration_days INTEGER,
      field_mapping_json TEXT NOT NULL DEFAULT '{}',
      send_email INTEGER NOT NULL DEFAULT 1,
      send_whatsapp INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 0,
      listening_until TEXT,
      sample_payload_json TEXT,
      sample_headers_json TEXT,
      last_event_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wh_integrations_platform ON webhook_integrations(platform, is_active);

    CREATE TABLE IF NOT EXISTS webhook_delivery_rules (
      id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL REFERENCES webhook_integrations(id) ON DELETE CASCADE,
      match_field TEXT NOT NULL DEFAULT 'product_id' CHECK(match_field IN ('product_id', 'offer_name')),
      match_value TEXT NOT NULL,
      rule_action TEXT NOT NULL DEFAULT 'grant_plan' CHECK(rule_action IN ('grant_plan', 'add_upgrades_only', 'create_new_license', 'ignore')),
      plan_tier TEXT DEFAULT 'individual',
      add_upgrades_json TEXT NOT NULL DEFAULT '[]',
      duration_days INTEGER,
      default_amount_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'BRL',
      label TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wh_rules_integration ON webhook_delivery_rules(integration_id);

    CREATE TABLE IF NOT EXISTS license_transactions (
      id TEXT PRIMARY KEY,
      license_id TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      integration_id TEXT,
      transaction_id TEXT NOT NULL,
      product_id TEXT,
      offer_name TEXT,
      grant_type TEXT NOT NULL DEFAULT 'plan' CHECK(grant_type IN ('plan', 'upgrade', 'renewal')),
      plan_tier TEXT,
      upgrades_json TEXT NOT NULL DEFAULT '[]',
      amount_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'BRL',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_lic_tx_license ON license_transactions(license_id);
    CREATE INDEX IF NOT EXISTS idx_lic_tx_lookup ON license_transactions(provider, transaction_id);

    CREATE TABLE IF NOT EXISTS notification_queue (
      id TEXT PRIMARY KEY,
      license_id TEXT,
      license_key TEXT,
      channel TEXT NOT NULL CHECK(channel IN ('email', 'whatsapp')),
      event_type TEXT NOT NULL DEFAULT 'license_issued',
      recipient TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'failed')),
      next_retry_at TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notif_queue_due ON notification_queue(status, next_retry_at);
  `);

  ensureColumns(db, "sales_webhook_deliveries", [
    { name: "id", definition: "TEXT" },
    { name: "buyer_name", definition: "TEXT" },
    { name: "amount_cents", definition: "INTEGER DEFAULT 0" },
    { name: "currency", definition: "TEXT DEFAULT 'BRL'" },
    { name: "payment_method", definition: "TEXT" },
    { name: "plan_tier", definition: "TEXT" },
    { name: "product_id", definition: "TEXT" },
    { name: "offer_name", definition: "TEXT" },
    { name: "raw_payload_json", definition: "TEXT" },
    { name: "http_status", definition: "INTEGER DEFAULT 200" },
    { name: "error_detail", definition: "TEXT" },
    { name: "is_simulated", definition: "INTEGER DEFAULT 0" },
    { name: "replayed_at", definition: "TEXT" },
    { name: "replay_count", definition: "INTEGER DEFAULT 0" },
    { name: "integration_id", definition: "TEXT" },
    { name: "status_category", definition: "TEXT" },
  ]);

  ensureColumns(db, "licenses", [
    { name: "amount_cents", definition: "INTEGER DEFAULT 0" },
    { name: "currency", definition: "TEXT DEFAULT 'BRL'" },
    { name: "payment_method", definition: "TEXT" },
    { name: "source_provider", definition: "TEXT DEFAULT 'manual'" },
    { name: "is_simulated", definition: "INTEGER DEFAULT 0" },
    { name: "notes", definition: "TEXT" },
    { name: "delivery_token", definition: "TEXT" },
    { name: "last_email_status", definition: "TEXT" },
    { name: "last_whatsapp_status", definition: "TEXT" },
    { name: "last_delivery_at", definition: "TEXT" },
  ]);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_deliveries_id ON sales_webhook_deliveries(id) WHERE id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sales_deliveries_processed ON sales_webhook_deliveries(processed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sales_deliveries_provider_action ON sales_webhook_deliveries(provider, action);
    CREATE INDEX IF NOT EXISTS idx_sales_deliveries_integration ON sales_webhook_deliveries(integration_id, processed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_licenses_status_plan ON licenses(status, plan_tier);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_delivery_token ON licenses(delivery_token) WHERE delivery_token IS NOT NULL;

    UPDATE sales_webhook_deliveries
    SET id = lower(hex(randomblob(12)))
    WHERE id IS NULL OR id = '';

    UPDATE sales_webhook_deliveries
    SET is_simulated = 1
    WHERE COALESCE(is_simulated, 0) = 0
      AND summary_json LIKE '%"simulated":true%';

    UPDATE sales_webhook_deliveries SET http_status = 200 WHERE http_status IS NULL;
    UPDATE sales_webhook_deliveries SET currency = 'BRL' WHERE currency IS NULL OR currency = '';
    UPDATE sales_webhook_deliveries SET amount_cents = 0 WHERE amount_cents IS NULL;
    UPDATE sales_webhook_deliveries SET replay_count = 0 WHERE replay_count IS NULL;
    UPDATE sales_webhook_deliveries SET is_simulated = 0 WHERE is_simulated IS NULL;

    UPDATE licenses SET source_provider = 'manual' WHERE source_provider IS NULL OR source_provider = '';
    UPDATE licenses SET currency = 'BRL' WHERE currency IS NULL OR currency = '';
    UPDATE licenses SET amount_cents = 0 WHERE amount_cents IS NULL;
    UPDATE licenses SET is_simulated = 0 WHERE is_simulated IS NULL;
    UPDATE licenses SET delivery_token = lower(hex(randomblob(16))) WHERE delivery_token IS NULL OR delivery_token = '';
  `);
}
