-- Customer webhooks (@profullstack/webhooks 0.2.1): each account's endpoints and the
-- durable outbox of deliveries to them. Generated with schemaSql('pg'); the package
-- reads and writes these through postgresStore, never through queries.js.
-- `owner` is users.id as text, with no foreign key: the package owns these tables'
-- shape and types, so they are kept exactly as schemaSql('pg') writes them.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '["*"]',
    description TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    failures INTEGER NOT NULL DEFAULT 0,
    disabled_reason TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );

CREATE INDEX IF NOT EXISTS webhook_endpoints_owner ON webhook_endpoints(owner);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at BIGINT NOT NULL,
    last_status INTEGER,
    last_error TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );

CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(status, next_at);

CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at);
