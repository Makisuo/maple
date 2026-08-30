#!/usr/bin/env bash
# Start Maple Cloud (API on celld + docker Postgres/ClickHouse) without wrangler.
# See docs/celld-self-host.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CELLD_VERSION="${CELLD_VERSION:-v0.4.0}"
TOOLS_DIR="$ROOT/.tools"
CELLD_BIN="${CELLD_BIN:-$TOOLS_DIR/celld}"
API_PORT="${API_PORT:-3472}"
WEB_PORT="${WEB_PORT:-3471}"
ELECTRIC_PORT="${ELECTRIC_PORT:-3476}"
ALERTING_PORT="${ALERTING_PORT:-8788}"
PG_PROXY_PORT="${PG_PROXY_PORT:-5498}"
PG_PORT="${PG_PORT:-5499}"
START_WEB="${START_WEB:-1}"
START_ELECTRIC="${START_ELECTRIC:-1}"
START_ALERTING="${START_ALERTING:-1}"
ENV_FILE="${ENV_FILE:-$ROOT/.env.local}"
VARS_FILE="$TOOLS_DIR/celld-vars.env"
PIDS=()

log() { printf 'celld-dev: %s\n' "$*"; }
die() { printf 'celld-dev: %s\n' "$*" >&2; exit 1; }

cleanup() {
	local pid
	for pid in "${PIDS[@]+"${PIDS[@]}"}"; do
		kill "$pid" 2>/dev/null || true
	done
}
trap cleanup EXIT INT TERM

port_pids() {
	lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true
}

port_cmd() {
	local pid=$1
	ps -p "$pid" -o args= 2>/dev/null || true
}

is_listening() {
	[[ -n "$(port_pids "$1")" ]]
}

wait_for_port() {
	local port=$1
	local label=$2
	local attempts=${3:-40}
	local i
	for ((i = 0; i < attempts; i++)); do
		if is_listening "$port"; then return 0; fi
		sleep 0.25
	done
	die "timed out waiting for $label on :$port"
}

wait_for_port_soft() {
	local port=$1
	local attempts=${2:-80}
	local i
	for ((i = 0; i < attempts; i++)); do
		if is_listening "$port"; then return 0; fi
		sleep 0.25
	done
	return 1
}

free_port_from() {
	local port=$1
	local i
	for ((i = 0; i < 20; i++)); do
		if ! is_listening "$port"; then
			printf '%s\n' "$port"
			return 0
		fi
		port=$((port + 1))
	done
	die "could not find a free port near $1"
}

stop_ours_on_port() {
	local port=$1
	local pid cmd
	for pid in $(port_pids "$port"); do
		cmd=$(port_cmd "$pid")
		if [[ "$cmd" == *wrangler* && ( "$cmd" == *maple-api* || "$cmd" == *apps/api* || "$cmd" == *wrangler.jsonc* ) ]]; then
			log "stopping maple wrangler on :$port (pid $pid)"
			kill "$pid" 2>/dev/null || true
			sleep 0.4
		elif [[ "$cmd" == *pg-ws-proxy* ]]; then
			log "reusing pg-ws-proxy on :$port (pid $pid)"
			return 1
		elif [[ "$cmd" == *celld* ]]; then
			log "stopping previous celld on :$port (pid $pid)"
			kill "$pid" 2>/dev/null || true
			sleep 0.4
		fi
	done
	return 0
}

read_env_value() {
	local key=$1
	local file=$2
	[[ -f "$file" ]] || return 0
	awk -F= -v k="$key" '
		$0 ~ /^[[:space:]]*#/ { next }
		$0 ~ /^[[:space:]]*$/ { next }
		index($0, "=") == 0 { next }
		{
			name = $1
			sub(/^[[:space:]]+/, "", name)
			sub(/[[:space:]]+$/, "", name)
			if (name == k) {
				val = substr($0, index($0, "=") + 1)
				sub(/\r$/, "", val)
				if (val ~ /^".*"$/) val = substr(val, 2, length(val) - 2)
				else if (val ~ /^'\''.*'\''$/) val = substr(val, 2, length(val) - 2)
				print val
			}
		}
	' "$file" | tail -n 1
}

ensure_celld() {
	local version_ok=0
	if [[ -x "$CELLD_BIN" ]] && "$CELLD_BIN" --version 2>/dev/null | grep -q "0.4.0"; then
		version_ok=1
	elif command -v celld >/dev/null 2>&1 && celld --version 2>/dev/null | grep -q "0.4.0"; then
		CELLD_BIN="$(command -v celld)"
		version_ok=1
	fi
	if [[ "$version_ok" -eq 1 ]]; then
		log "using $CELLD_BIN ($("$CELLD_BIN" --version 2>/dev/null | head -n 1))"
		return 0
	fi
	local asset="celld-aarch64-apple-darwin.gz"
	local url="https://github.com/denoland/celld/releases/download/${CELLD_VERSION}/${asset}"
	log "installing celld ${CELLD_VERSION} → $CELLD_BIN"
	mkdir -p "$TOOLS_DIR"
	curl -fsSL "$url" | gzip -dc > "$CELLD_BIN"
	chmod +x "$CELLD_BIN"
	"$CELLD_BIN" --version >/dev/null
}

ensure_esbuild() {
	if command -v esbuild >/dev/null 2>&1; then return 0; fi
	mkdir -p "$TOOLS_DIR"
	cat > "$TOOLS_DIR/esbuild" <<'EOF'
#!/usr/bin/env bash
exec bun x --yes esbuild "$@"
EOF
	chmod +x "$TOOLS_DIR/esbuild"
	PATH="$TOOLS_DIR:$PATH"
	export PATH
	"$TOOLS_DIR/esbuild" --version >/dev/null || die "esbuild is required on PATH for celld"
	log "esbuild → $TOOLS_DIR/esbuild (bun x)"
}

write_vars_file() {
	mkdir -p "$TOOLS_DIR"
	local required=(
		TINYBIRD_HOST
		TINYBIRD_TOKEN
		MAPLE_INGEST_KEY_ENCRYPTION_KEY
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY
		MAPLE_ROOT_PASSWORD
	)
	local optional=(
		MAPLE_SHARE_TOKEN_HMAC_KEY
		CLICKHOUSE_PASSWORD
		CLICKHOUSE_USER
		CLICKHOUSE_DATABASE
		CLICKHOUSE_PROVIDER
		MAPLE_AUTH_MODE
		MAPLE_DEFAULT_ORG_ID
		INTERNAL_SERVICE_TOKEN
		SD_INTERNAL_TOKEN
		MAPLE_ORG_ID_OVERRIDE
		MAPLE_APP_BASE_URL
	)
	local key value
	: > "$VARS_FILE"
	for key in "${required[@]}"; do
		value="$(read_env_value "$key" "$ENV_FILE")"
		[[ -n "$value" ]] || die "missing $key in $ENV_FILE (required for celld Env)"
		printf '%s=%s\n' "$key" "$value" >> "$VARS_FILE"
	done
	for key in "${optional[@]}"; do
		value="$(read_env_value "$key" "$ENV_FILE")"
		if [[ -n "$value" ]]; then
			printf '%s=%s\n' "$key" "$value" >> "$VARS_FILE"
		fi
	done
	printf 'CLICKHOUSE_URL=%s\n' "${CLICKHOUSE_URL:-http://127.0.0.1:8123}" >> "$VARS_FILE"
	printf 'CLICKHOUSE_PROVIDER=%s\n' "${CLICKHOUSE_PROVIDER:-clickhouse}" >> "$VARS_FILE"
	printf 'MAPLE_PG_URL=%s\n' "${MAPLE_PG_URL:-postgres://maple:maple@127.0.0.1:${PG_PORT}/maple}" >> "$VARS_FILE"
	printf 'MAPLE_PG_WS_PROXY=%s\n' "${MAPLE_PG_WS_PROXY:-ws://127.0.0.1:${PG_PROXY_PORT}}" >> "$VARS_FILE"
	printf 'MAPLE_APP_BASE_URL=%s\n' "${MAPLE_APP_BASE_URL:-http://127.0.0.1:${WEB_PORT}}" >> "$VARS_FILE"
	printf 'ELECTRIC_URL=%s\n' "${ELECTRIC_URL:-http://127.0.0.1:3473}" >> "$VARS_FILE"
	printf 'MAPLE_ALERTING_ALLOW_NONPROD=%s\n' "1" >> "$VARS_FILE"
	log "wrote $VARS_FILE"
}

apply_clickhouse_schema() {
	local user password database
	user="$(read_env_value CLICKHOUSE_USER "$ENV_FILE")"
	password="$(read_env_value CLICKHOUSE_PASSWORD "$ENV_FILE")"
	database="$(read_env_value CLICKHOUSE_DATABASE "$ENV_FILE")"
	user="${user:-maple}"
	password="${password:-maple}"
	database="${database:-default}"
	log "applying clickhouse schema"
	bun run --cwd packages/clickhouse-cli start apply \
		--url=http://localhost:8123 \
		--user="$user" \
		--password="$password" \
		--database="$database"
}

ensure_data_plane() {
	if [[ "${CELLD_SKIP_DATA_PLANE:-0}" == "1" ]]; then
		log "skipping docker data plane (CELLD_SKIP_DATA_PLANE=1)"
		return 0
	fi
	log "ensuring docker postgres/electric + clickhouse"
	bun db:up
	bun ch:up
	wait_for_port "$PG_PORT" "postgres"
	wait_for_port 8123 "clickhouse"
	log "applying postgres migrations"
	bun db:migrate:local
	ensure_electric_publication
	apply_clickhouse_schema
}

# 0009 wraps CREATE PUBLICATION in WHEN OTHERS, so drizzle can mark it applied
# with an empty/partial publication. ELECTRIC_MANUAL_TABLE_PUBLISHING=true then
# 503s shapes for unpublished tables. Heal membership idempotently.
ensure_electric_publication() {
	log "ensuring electric_publication_default tables"
	docker compose -f docker-compose.development.yml exec -T postgres psql -U maple -d maple <<'SQL'
DO $$ 
DECLARE
	t text;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'electric_publication_default') THEN
		CREATE PUBLICATION electric_publication_default;
	END IF;
	FOREACH t IN ARRAY ARRAY['dashboards','alert_rules','alert_rule_states','alert_incidents','alert_destinations','api_keys'] LOOP
		EXECUTE format('ALTER TABLE %I REPLICA IDENTITY FULL', t);
		IF NOT EXISTS (
			SELECT 1 FROM pg_publication_tables
			WHERE pubname = 'electric_publication_default' AND schemaname = 'public' AND tablename = t
		) THEN
			EXECUTE format('ALTER PUBLICATION electric_publication_default ADD TABLE %I', t);
		END IF;
	END LOOP;
END $$;
SQL
}

start_proxy() {
	if is_listening "$PG_PROXY_PORT"; then
		local pid cmd
		pid="$(port_pids "$PG_PROXY_PORT" | head -n 1)"
		cmd="$(port_cmd "$pid")"
		if [[ "$cmd" == *pg-ws-proxy* ]]; then
			log "pg-ws-proxy already on :$PG_PROXY_PORT"
			return 0
		fi
		log ":$PG_PROXY_PORT is busy; picking another listen port"
		PG_PROXY_PORT="$(free_port_from $((PG_PROXY_PORT + 1)))"
	fi
	log "starting pg-ws-proxy on :$PG_PROXY_PORT → 127.0.0.1:$PG_PORT"
	bun "$ROOT/scripts/pg-ws-proxy.ts" --listen "127.0.0.1:${PG_PROXY_PORT}" --target "127.0.0.1:${PG_PORT}" &
	PIDS+=("$!")
	wait_for_port "$PG_PROXY_PORT" "pg-ws-proxy"
}

claim_api_port() {
	if ! is_listening "$API_PORT"; then return 0; fi
	if stop_ours_on_port "$API_PORT"; then
		if is_listening "$API_PORT"; then
			log ":$API_PORT still in use; picking another API port"
			API_PORT="$(free_port_from $((API_PORT + 1)))"
			log "API will listen on :$API_PORT — set VITE_API_BASE_URL=http://localhost:${API_PORT}"
		fi
	fi
}

start_web() {
	[[ "$START_WEB" == "1" ]] || return 0
	if is_listening "$WEB_PORT"; then
		log "web already listening on :$WEB_PORT"
		return 0
	fi
	log "starting vite web on :$WEB_PORT against API :$API_PORT"
	(
		cd "$ROOT"
		export VITE_API_BASE_URL="http://localhost:${API_PORT}"
		export VITE_MAPLE_AUTH_MODE="${VITE_MAPLE_AUTH_MODE:-self_hosted}"
		bun --filter=@maple/web dev:app
	) &
	PIDS+=("$!")
}

# 0 = start a new celld, 1 = reuse existing celld, 2 = skip (port busy)
claim_worker_port() {
	local port=$1
	local label=$2
	if ! is_listening "$port"; then return 0; fi
	local pid cmd
	pid="$(port_pids "$port" | head -n 1)"
	cmd="$(port_cmd "$pid")"
	if [[ "$cmd" == *celld* ]]; then
		log "$label already on :$port (pid $pid)"
		return 1
	fi
	if [[ "$cmd" == *wrangler* ]]; then
		log "stopping wrangler on :$port so $label can bind (pid $pid)"
		kill "$pid" 2>/dev/null || true
		sleep 0.4
		return 0
	fi
	log ":$port is busy; skipping $label"
	return 2
}

start_worker_celld() {
	local dir=$1
	local port=$2
	local label=$3
	local required=${4:-0}
	local logfile="$TOOLS_DIR/${label}.celld.log"
	local claim=0
	claim_worker_port "$port" "$label" || claim=$?
	if [[ "$claim" -eq 1 ]]; then return 0; fi
	if [[ "$claim" -eq 2 ]]; then
		[[ "$required" -eq 1 ]] && die "cannot bind $label on :$port"
		return 0
	fi
	log "starting $label celld on :$port"
	(
		cd "$ROOT/$dir"
		export CELLD_VARS_FILE="$VARS_FILE"
		export PATH="$TOOLS_DIR:$PATH"
		exec "$CELLD_BIN" dev wrangler.celld.jsonc --port "$port"
	) >"$logfile" 2>&1 &
	PIDS+=("$!")
	if wait_for_port_soft "$port" 80; then
		log "$label ready on :$port"
		return 0
	fi
	log "$label did not bind :$port (see $logfile)"
	if [[ "$required" -eq 1 ]]; then
		tail -n 40 "$logfile" >&2 || true
		die "$label celld failed to start"
	fi
}

start_electric() {
	[[ "$START_ELECTRIC" == "1" ]] || return 0
	start_worker_celld "apps/electric-sync" "$ELECTRIC_PORT" "electric-sync" 1
}

start_alerting() {
	[[ "$START_ALERTING" == "1" ]] || return 0
	# Alerting is scheduled-only (fetch is 404). Env rabbit holes must not
	# take down api+electric; wrangler.celld.jsonc is still present.
	start_worker_celld "apps/alerting" "$ALERTING_PORT" "alerting" 0
}

ensure_data_plane
ensure_celld
ensure_esbuild
start_proxy
claim_api_port
write_vars_file
start_electric
start_alerting
start_web

log "celld API      → http://127.0.0.1:${API_PORT}"
log "electric-sync  → http://127.0.0.1:${ELECTRIC_PORT} (own celld project)"
log "alerting       → http://127.0.0.1:${ALERTING_PORT} (scheduled; fetch 404)"
log "health         → GET /health and GET /.well-known/celld/health"
log "web            → http://127.0.0.1:${WEB_PORT} (START_WEB=0 to skip)"
export CELLD_VARS_FILE="$VARS_FILE"
export PATH="$TOOLS_DIR:$PATH"
cd "$ROOT/apps/api"
"$CELLD_BIN" dev wrangler.celld.jsonc --port "$API_PORT" --logs
