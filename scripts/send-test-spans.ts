#!/usr/bin/env bun
/**
 * Sends test OTLP traces + logs to Dash0 ingress endpoint.
 * Usage: bun scripts/send-test-spans.ts
 */

const ENDPOINT = "https://ingress.europe-west4.gcp.dash0.com";
const AUTH_TOKEN = "Bearer auth_BhIxki53udVDCAUPzjP3vxwqV0BIxKYc";
const SERVICE_NAME = "my-bun-service";

const SERVICES = [
  { name: "my-bun-service", version: "1.0.0", host: "bun-server-01" },
  { name: "auth-service", version: "2.3.1", host: "auth-node-01" },
  { name: "payment-service", version: "1.5.0", host: "pay-node-01" },
  { name: "notification-service", version: "0.9.2", host: "notif-node-01" },
  { name: "inventory-service", version: "3.1.0", host: "inv-node-01" },
];

function randomHex(bytes: number): string {
  return Array.from({ length: bytes }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, "0")
  ).join("");
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function nanoTime(offsetMs: number): string {
  const now = Date.now() - offsetMs;
  const seconds = Math.floor(now / 1000);
  const nanos = (now % 1000) * 1_000_000;
  return String(BigInt(seconds) * 1_000_000_000n + BigInt(nanos));
}

// ─── OTEL attribute helpers ───

type AttrValue = string | number | boolean;
function attrs(obj: Record<string, AttrValue>) {
  return Object.entries(obj).map(([key, value]) => ({
    key,
    value:
      typeof value === "string"
        ? { stringValue: value }
        : typeof value === "number"
          ? { intValue: String(value) }
          : { boolValue: value },
  }));
}

function resourceAttrs(svc: (typeof SERVICES)[number]) {
  return [
    { key: "service.name", value: { stringValue: svc.name } },
    { key: "service.version", value: { stringValue: svc.version } },
    { key: "deployment.environment", value: { stringValue: "production" } },
    { key: "host.name", value: { stringValue: svc.host } },
    { key: "telemetry.sdk.name", value: { stringValue: "opentelemetry" } },
    { key: "telemetry.sdk.language", value: { stringValue: "javascript" } },
  ];
}

// ─── Span builder ───

type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: { code: number; message?: string };
  attributes: ReturnType<typeof attrs>;
};

function makeSpan(opts: {
  traceId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  durationMs: number;
  offsetMs: number;
  statusCode?: number;
  statusMessage?: string;
  attributes?: Record<string, AttrValue>;
}): Span {
  return {
    traceId: opts.traceId,
    spanId: randomHex(8),
    ...(opts.parentSpanId ? { parentSpanId: opts.parentSpanId } : {}),
    name: opts.name,
    kind: opts.kind,
    startTimeUnixNano: nanoTime(opts.offsetMs),
    endTimeUnixNano: nanoTime(opts.offsetMs - opts.durationMs),
    status: { code: opts.statusCode ?? 1, ...(opts.statusMessage ? { message: opts.statusMessage } : {}) },
    attributes: attrs(opts.attributes ?? {}),
  };
}

// ─── Trace generators ───

function traceGetUsers() {
  const traceId = randomHex(16);
  const root = makeSpan({
    traceId,
    name: "GET /api/users",
    kind: 2,
    durationMs: randInt(80, 350),
    offsetMs: randInt(100, 500),
    attributes: { "http.method": "GET", "http.url": "/api/users", "http.status_code": 200, "http.route": "/api/users" },
  });
  const db = makeSpan({
    traceId, parentSpanId: root.spanId, name: "SELECT users", kind: 3,
    durationMs: randInt(30, 150), offsetMs: randInt(50, 200),
    attributes: { "db.system": "postgresql", "db.statement": "SELECT id, name, email FROM users WHERE active = true LIMIT 50", "db.name": "app_db" },
  });
  const cache = makeSpan({
    traceId, parentSpanId: root.spanId, name: "redis GET user:list", kind: 3,
    durationMs: randInt(1, 8), offsetMs: randInt(90, 300),
    attributes: { "db.system": "redis", "db.statement": "GET user:list", "cache.hit": Math.random() > 0.5 },
  });
  return { service: SERVICES[0], spans: [root, db, cache], traceId };
}

function tracePostOrders() {
  const traceId = randomHex(16);
  const root = makeSpan({
    traceId, name: "POST /api/orders", kind: 2,
    durationMs: randInt(200, 600), offsetMs: randInt(300, 700), statusCode: 2,
    attributes: { "http.method": "POST", "http.url": "/api/orders", "http.status_code": 500, "http.route": "/api/orders", "error": true },
  });
  const validate = makeSpan({
    traceId, parentSpanId: root.spanId, name: "validate order", kind: 1,
    durationMs: randInt(5, 25), offsetMs: randInt(280, 650),
    attributes: { "order.items_count": randInt(1, 10) },
  });
  const payment = makeSpan({
    traceId, parentSpanId: root.spanId, name: "POST stripe.com/v1/charges", kind: 3,
    durationMs: randInt(150, 500), offsetMs: randInt(250, 600), statusCode: 2,
    attributes: { "http.method": "POST", "http.url": "https://api.stripe.com/v1/charges", "http.status_code": 502, "error.message": "Payment gateway timeout" },
  });
  return { service: SERVICES[2], spans: [root, validate, payment], traceId };
}

function traceSlowAnalytics() {
  const traceId = randomHex(16);
  const dur = randInt(2500, 5000);
  const root = makeSpan({
    traceId, name: "GET /api/dashboard/analytics", kind: 2,
    durationMs: dur, offsetMs: dur + 300,
    attributes: { "http.method": "GET", "http.url": "/api/dashboard/analytics", "http.status_code": 200, "http.route": "/api/dashboard/analytics" },
  });
  const agg = makeSpan({
    traceId, parentSpanId: root.spanId, name: "SELECT aggregate_metrics", kind: 3,
    durationMs: dur - 400, offsetMs: dur,
    attributes: { "db.system": "clickhouse", "db.statement": "SELECT toStartOfHour(ts) as hour, count(*), avg(duration) FROM events GROUP BY hour", "db.name": "analytics" },
  });
  const cacheW = makeSpan({
    traceId, parentSpanId: root.spanId, name: "redis SET dashboard:cache", kind: 3,
    durationMs: randInt(3, 12), offsetMs: 350,
    attributes: { "db.system": "redis", "db.statement": "SET dashboard:cache", "cache.ttl": 300 },
  });
  return { service: SERVICES[0], spans: [root, agg, cacheW], traceId };
}

function traceAuthLogin() {
  const traceId = randomHex(16);
  const success = Math.random() > 0.3;
  const root = makeSpan({
    traceId, name: "POST /auth/login", kind: 2,
    durationMs: randInt(100, 400), offsetMs: randInt(200, 600),
    statusCode: success ? 1 : 2,
    attributes: { "http.method": "POST", "http.url": "/auth/login", "http.status_code": success ? 200 : 401, "http.route": "/auth/login" },
  });
  const lookup = makeSpan({
    traceId, parentSpanId: root.spanId, name: "SELECT user_credentials", kind: 3,
    durationMs: randInt(20, 80), offsetMs: randInt(150, 400),
    attributes: { "db.system": "postgresql", "db.statement": "SELECT id, password_hash FROM users WHERE email = $1", "db.name": "auth_db" },
  });
  const jwt = makeSpan({
    traceId, parentSpanId: root.spanId, name: "sign JWT", kind: 1,
    durationMs: randInt(2, 10), offsetMs: randInt(100, 200),
    attributes: { "jwt.algorithm": "RS256", "jwt.ttl_seconds": 3600 },
  });
  return { service: SERVICES[1], spans: [root, lookup, jwt], traceId };
}

function traceAuthVerify() {
  const traceId = randomHex(16);
  const root = makeSpan({
    traceId, name: "POST /auth/verify", kind: 2,
    durationMs: randInt(10, 50), offsetMs: randInt(20, 100),
    attributes: { "http.method": "POST", "http.url": "/auth/verify", "http.status_code": 200, "http.route": "/auth/verify" },
  });
  const verify = makeSpan({
    traceId, parentSpanId: root.spanId, name: "verify JWT", kind: 1,
    durationMs: randInt(1, 8), offsetMs: randInt(10, 50),
    attributes: { "jwt.algorithm": "RS256", "jwt.valid": true },
  });
  return { service: SERVICES[1], spans: [root, verify], traceId };
}

function traceNotificationSend() {
  const traceId = randomHex(16);
  const channel = pick(["email", "sms", "push"]);
  const failed = Math.random() > 0.8;
  const root = makeSpan({
    traceId, name: `POST /notifications/send`, kind: 2,
    durationMs: randInt(200, 1200), offsetMs: randInt(300, 1500),
    statusCode: failed ? 2 : 1,
    attributes: { "http.method": "POST", "http.url": "/notifications/send", "http.status_code": failed ? 503 : 202, "http.route": "/notifications/send", "notification.channel": channel },
  });
  const enqueue = makeSpan({
    traceId, parentSpanId: root.spanId, name: "rabbitmq publish notification", kind: 4,
    durationMs: randInt(5, 30), offsetMs: randInt(200, 800),
    attributes: { "messaging.system": "rabbitmq", "messaging.destination": `notifications.${channel}`, "messaging.operation": "publish" },
  });
  const deliver = makeSpan({
    traceId, parentSpanId: root.spanId, name: `deliver ${channel}`, kind: 3,
    durationMs: randInt(100, 800), offsetMs: randInt(150, 700),
    statusCode: failed ? 2 : 1,
    attributes: { "notification.channel": channel, "notification.recipient": `user_${randInt(1000, 9999)}`, ...(failed ? { "error.message": `${channel} provider unavailable` } : {}) },
  });
  return { service: SERVICES[3], spans: [root, enqueue, deliver], traceId };
}

function traceInventoryCheck() {
  const traceId = randomHex(16);
  const root = makeSpan({
    traceId, name: "GET /inventory/check", kind: 2,
    durationMs: randInt(50, 200), offsetMs: randInt(100, 400),
    attributes: { "http.method": "GET", "http.url": "/inventory/check", "http.status_code": 200, "http.route": "/inventory/check" },
  });
  const db = makeSpan({
    traceId, parentSpanId: root.spanId, name: "SELECT inventory_items", kind: 3,
    durationMs: randInt(20, 100), offsetMs: randInt(80, 300),
    attributes: { "db.system": "postgresql", "db.statement": "SELECT sku, quantity FROM inventory WHERE sku = ANY($1)", "db.name": "inventory_db" },
  });
  const cache = makeSpan({
    traceId, parentSpanId: root.spanId, name: "redis MGET inventory:*", kind: 3,
    durationMs: randInt(1, 5), offsetMs: randInt(90, 350),
    attributes: { "db.system": "redis", "db.statement": "MGET inventory:sku:*", "cache.hit": Math.random() > 0.4 },
  });
  return { service: SERVICES[4], spans: [root, db, cache], traceId };
}

function traceInventoryUpdate() {
  const traceId = randomHex(16);
  const root = makeSpan({
    traceId, name: "PUT /inventory/update", kind: 2,
    durationMs: randInt(80, 300), offsetMs: randInt(150, 500),
    attributes: { "http.method": "PUT", "http.url": "/inventory/update", "http.status_code": 200, "http.route": "/inventory/update" },
  });
  const db = makeSpan({
    traceId, parentSpanId: root.spanId, name: "UPDATE inventory SET quantity", kind: 3,
    durationMs: randInt(30, 120), offsetMs: randInt(100, 350),
    attributes: { "db.system": "postgresql", "db.statement": "UPDATE inventory SET quantity = quantity - $1 WHERE sku = $2", "db.name": "inventory_db" },
  });
  const publish = makeSpan({
    traceId, parentSpanId: root.spanId, name: "kafka publish inventory.updated", kind: 4,
    durationMs: randInt(5, 25), offsetMs: randInt(60, 200),
    attributes: { "messaging.system": "kafka", "messaging.destination": "inventory.updated", "messaging.operation": "publish" },
  });
  return { service: SERVICES[4], spans: [root, db, publish], traceId };
}

function traceMultiService() {
  const traceId = randomHex(16);
  const offsetBase = randInt(500, 1500);
  // Gateway
  const gateway = makeSpan({
    traceId, name: "POST /api/checkout", kind: 2,
    durationMs: randInt(600, 1800), offsetMs: offsetBase + 1800,
    attributes: { "http.method": "POST", "http.url": "/api/checkout", "http.status_code": 200, "http.route": "/api/checkout" },
  });
  // Auth verify (child)
  const auth = makeSpan({
    traceId, parentSpanId: gateway.spanId, name: "POST /auth/verify", kind: 3,
    durationMs: randInt(10, 40), offsetMs: offsetBase + 1750,
    attributes: { "http.method": "POST", "http.url": "/auth/verify", "http.status_code": 200, "peer.service": "auth-service" },
  });
  // Inventory check (child)
  const inv = makeSpan({
    traceId, parentSpanId: gateway.spanId, name: "GET /inventory/check", kind: 3,
    durationMs: randInt(50, 200), offsetMs: offsetBase + 1600,
    attributes: { "http.method": "GET", "http.url": "/inventory/check", "http.status_code": 200, "peer.service": "inventory-service" },
  });
  // Payment (child)
  const pay = makeSpan({
    traceId, parentSpanId: gateway.spanId, name: "POST /payments/charge", kind: 3,
    durationMs: randInt(200, 600), offsetMs: offsetBase + 1200,
    attributes: { "http.method": "POST", "http.url": "/payments/charge", "http.status_code": 200, "peer.service": "payment-service" },
  });
  // Notification (child)
  const notif = makeSpan({
    traceId, parentSpanId: gateway.spanId, name: "POST /notifications/send", kind: 3,
    durationMs: randInt(50, 300), offsetMs: offsetBase + 600,
    attributes: { "http.method": "POST", "http.url": "/notifications/send", "http.status_code": 202, "peer.service": "notification-service" },
  });
  return { service: SERVICES[0], spans: [gateway, auth, inv, pay, notif], traceId };
}

// ─── Log generator ───

type LogRecord = {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: ReturnType<typeof attrs>;
  traceId?: string;
  spanId?: string;
};

const LOG_TEMPLATES: Array<{
  severity: number;
  severityText: string;
  messageGen: () => string;
  attrsGen: () => Record<string, AttrValue>;
  service: number;
}> = [
  {
    severity: 9, severityText: "INFO",
    messageGen: () => `User ${randInt(1000, 9999)} logged in successfully`,
    attrsGen: () => ({ "user.id": `user_${randInt(1000, 9999)}`, "auth.method": pick(["password", "oauth", "sso"]) }),
    service: 1,
  },
  {
    severity: 9, severityText: "INFO",
    messageGen: () => `Request processed in ${randInt(10, 500)}ms`,
    attrsGen: () => ({ "http.method": pick(["GET", "POST", "PUT"]), "http.route": pick(["/api/users", "/api/orders", "/api/products"]), "http.status_code": 200 }),
    service: 0,
  },
  {
    severity: 13, severityText: "WARN",
    messageGen: () => `Rate limit approaching for tenant ${randomHex(4)} (${randInt(80, 99)}% used)`,
    attrsGen: () => ({ "tenant.id": randomHex(4), "rate_limit.current": randInt(800, 990), "rate_limit.max": 1000 }),
    service: 0,
  },
  {
    severity: 17, severityText: "ERROR",
    messageGen: () => `Failed to connect to database: connection refused after ${randInt(3, 10)} retries`,
    attrsGen: () => ({ "db.system": "postgresql", "db.name": pick(["app_db", "auth_db", "inventory_db"]), "error.type": "ConnectionRefused", "retry.count": randInt(3, 10) }),
    service: 0,
  },
  {
    severity: 17, severityText: "ERROR",
    messageGen: () => `Payment processing failed: ${pick(["Card declined", "Insufficient funds", "Gateway timeout", "Invalid card number"])}`,
    attrsGen: () => ({ "payment.provider": "stripe", "payment.amount": randInt(500, 50000), "error.type": pick(["CardDeclined", "InsufficientFunds", "GatewayTimeout"]) }),
    service: 2,
  },
  {
    severity: 9, severityText: "INFO",
    messageGen: () => `Order #${randInt(10000, 99999)} created with ${randInt(1, 8)} items, total $${(randInt(1000, 50000) / 100).toFixed(2)}`,
    attrsGen: () => ({ "order.id": `ORD-${randInt(10000, 99999)}`, "order.items_count": randInt(1, 8), "order.total_cents": randInt(1000, 50000) }),
    service: 0,
  },
  {
    severity: 13, severityText: "WARN",
    messageGen: () => `Slow query detected: ${randInt(2000, 15000)}ms on ${pick(["users", "orders", "events", "inventory"])} table`,
    attrsGen: () => ({ "db.system": "postgresql", "db.duration_ms": randInt(2000, 15000), "db.table": pick(["users", "orders", "events", "inventory"]) }),
    service: 0,
  },
  {
    severity: 5, severityText: "DEBUG",
    messageGen: () => `Cache ${pick(["hit", "miss"])} for key ${pick(["user:list", "dashboard:cache", "session:", "inventory:sku:"])}${randInt(100, 999)}`,
    attrsGen: () => ({ "cache.backend": "redis", "cache.key_prefix": pick(["user:", "dashboard:", "session:", "inventory:"]) }),
    service: 0,
  },
  {
    severity: 9, severityText: "INFO",
    messageGen: () => `Email notification sent to user_${randInt(1000, 9999)} (template: ${pick(["welcome", "order_confirmation", "password_reset", "shipping_update"])})`,
    attrsGen: () => ({ "notification.channel": "email", "notification.template": pick(["welcome", "order_confirmation", "password_reset"]) }),
    service: 3,
  },
  {
    severity: 17, severityText: "ERROR",
    messageGen: () => `SMS delivery failed: ${pick(["Invalid phone number", "Provider rate limit", "Network timeout"])} for user_${randInt(1000, 9999)}`,
    attrsGen: () => ({ "notification.channel": "sms", "error.type": pick(["InvalidNumber", "RateLimit", "NetworkTimeout"]) }),
    service: 3,
  },
  {
    severity: 9, severityText: "INFO",
    messageGen: () => `Inventory updated: SKU-${randInt(1000, 9999)} quantity ${pick(["increased", "decreased"])} by ${randInt(1, 50)}`,
    attrsGen: () => ({ "inventory.sku": `SKU-${randInt(1000, 9999)}`, "inventory.change": randInt(-50, 50) }),
    service: 4,
  },
  {
    severity: 13, severityText: "WARN",
    messageGen: () => `Low stock alert: SKU-${randInt(1000, 9999)} has only ${randInt(1, 5)} units remaining`,
    attrsGen: () => ({ "inventory.sku": `SKU-${randInt(1000, 9999)}`, "inventory.quantity": randInt(1, 5), "alert.type": "low_stock" }),
    service: 4,
  },
  {
    severity: 21, severityText: "FATAL",
    messageGen: () => `Out of memory: heap limit reached (${randInt(900, 1024)}MB / 1024MB) — restarting process`,
    attrsGen: () => ({ "process.memory_mb": randInt(900, 1024), "process.pid": randInt(1000, 9999), "error.type": "OutOfMemory" }),
    service: 0,
  },
  {
    severity: 9, severityText: "INFO",
    messageGen: () => `Health check passed: all ${randInt(3, 8)} dependencies healthy (latency: ${randInt(1, 50)}ms)`,
    attrsGen: () => ({ "health.status": "healthy", "health.dependencies_count": randInt(3, 8) }),
    service: 0,
  },
  {
    severity: 17, severityText: "ERROR",
    messageGen: () => `JWT verification failed: ${pick(["Token expired", "Invalid signature", "Malformed token"])}`,
    attrsGen: () => ({ "auth.error": pick(["TokenExpired", "InvalidSignature", "MalformedToken"]), "http.status_code": 401 }),
    service: 1,
  },
];

function makeLog(opts: { traceId?: string; spanId?: string; offsetMs: number; template: (typeof LOG_TEMPLATES)[number] }): LogRecord {
  return {
    timeUnixNano: nanoTime(opts.offsetMs),
    severityNumber: opts.template.severity,
    severityText: opts.template.severityText,
    body: { stringValue: opts.template.messageGen() },
    attributes: attrs(opts.template.attrsGen()),
    ...(opts.traceId ? { traceId: opts.traceId } : {}),
    ...(opts.spanId ? { spanId: opts.spanId } : {}),
  };
}

// ─── Senders ───

async function sendSpans(spans: Span[], svc: (typeof SERVICES)[number]) {
  const body = {
    resourceSpans: [{
      resource: { attributes: resourceAttrs(svc) },
      scopeSpans: [{
        scope: { name: "@opentelemetry/instrumentation-http", version: "0.52.0" },
        spans,
      }],
    }],
  };
  const res = await fetch(`${ENDPOINT}/v1/traces`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: AUTH_TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

async function sendLogs(logs: LogRecord[], svc: (typeof SERVICES)[number]) {
  const body = {
    resourceLogs: [{
      resource: { attributes: resourceAttrs(svc) },
      scopeLogs: [{
        scope: { name: "my-bun-logger", version: "1.0.0" },
        logRecords: logs,
      }],
    }],
  };
  const res = await fetch(`${ENDPOINT}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: AUTH_TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

// ─── Main ───

async function main() {
  console.log("Sending test traces + logs to Dash0...\n");

  // Generate diverse traces
  const traceGenerators = [
    traceGetUsers, traceGetUsers, traceGetUsers, traceGetUsers, traceGetUsers,
    tracePostOrders, tracePostOrders, tracePostOrders,
    traceSlowAnalytics, traceSlowAnalytics,
    traceAuthLogin, traceAuthLogin, traceAuthLogin, traceAuthLogin,
    traceAuthVerify, traceAuthVerify, traceAuthVerify, traceAuthVerify, traceAuthVerify,
    traceNotificationSend, traceNotificationSend, traceNotificationSend,
    traceInventoryCheck, traceInventoryCheck, traceInventoryCheck,
    traceInventoryUpdate, traceInventoryUpdate,
    traceMultiService, traceMultiService, traceMultiService,
  ];

  let traceCount = 0;
  let spanCount = 0;

  // Send traces
  for (const gen of traceGenerators) {
    const { service, spans } = gen();
    const res = await sendSpans(spans, service);
    const ok = res.status < 300;
    traceCount++;
    spanCount += spans.length;
    if (!ok) console.log(`[FAIL] trace to ${service.name}: ${res.status} ${res.body}`);
  }
  console.log(`Traces: sent ${traceCount} traces (${spanCount} spans) across ${SERVICES.length} services`);

  // Generate logs — some correlated with traces, some standalone
  const allLogs: Map<number, LogRecord[]> = new Map();
  for (let i = 0; i < SERVICES.length; i++) allLogs.set(i, []);

  // Standalone logs (not tied to a trace)
  for (let i = 0; i < 60; i++) {
    const tmpl = pick(LOG_TEMPLATES);
    const log = makeLog({ offsetMs: randInt(0, 60_000), template: tmpl });
    allLogs.get(tmpl.service)!.push(log);
  }

  // Correlated logs (tied to a trace)
  for (let i = 0; i < 15; i++) {
    const { traceId, spans, service } = pick(traceGenerators)();
    // don't send spans again, just use the IDs for log correlation
    const rootSpan = spans[0];
    const tmpl = pick(LOG_TEMPLATES.filter((t) => t.service === SERVICES.indexOf(service)));
    if (tmpl) {
      const log = makeLog({ traceId, spanId: rootSpan.spanId, offsetMs: randInt(0, 30_000), template: tmpl });
      allLogs.get(SERVICES.indexOf(service))!.push(log);
    }
  }

  let logCount = 0;
  for (const [svcIdx, logs] of allLogs) {
    if (logs.length === 0) continue;
    const res = await sendLogs(logs, SERVICES[svcIdx]);
    const ok = res.status < 300;
    logCount += logs.length;
    if (!ok) console.log(`[FAIL] logs to ${SERVICES[svcIdx].name}: ${res.status} ${res.body}`);
  }
  console.log(`Logs:   sent ${logCount} log records across ${SERVICES.length} services`);

  console.log(`\nDone! Total: ${traceCount} traces, ${spanCount} spans, ${logCount} logs`);
  console.log("Services:", SERVICES.map((s) => s.name).join(", "));
}

main();
