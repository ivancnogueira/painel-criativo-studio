#!/usr/bin/env bash
set -euo pipefail

# Instalador e Pareador Automático em 1 Linha (CRIATIVO_CLAIM via stdin)
# Uso padrão gerado pelo App Desktop:
#   { echo CRIATIVO_CLAIM=CRV_...; curl -fsSL https://<HUB>/api/releases/install-server.sh; } | sudo bash -s

HUB_URL="${CRIATIVO_HUB_URL:-https://[SEU_DOMINIO_HUB]}"
SERVER_NAME="${CRIATIVO_SERVER_NAME:-Servidor VPS}"
SERVER_PORT="${CRIATIVO_SERVER_PORT:-3000}"
CUSTOM_DOMAIN=""
CLAIM_SECRET="${CRIATIVO_CLAIM:-}"
unset CRIATIVO_CLAIM || true

# Lê CRIATIVO_CLAIM=... apenas se não veio por execução inline do pipe/ambiente
if [[ -z "$CLAIM_SECRET" && ! -t 0 && -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]:-}" ]]; then
  if IFS= read -r FIRST_LINE; then
    if [[ "$FIRST_LINE" == CRIATIVO_CLAIM=* ]]; then
      CLAIM_SECRET="${FIRST_LINE#CRIATIVO_CLAIM=}"
      CLAIM_SECRET="${CLAIM_SECRET%%[[:space:]]*}"
    fi
  fi
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) SERVER_NAME="${2:-$SERVER_NAME}"; shift 2 ;;
    --hub-url) HUB_URL="${2:-$HUB_URL}"; shift 2 ;;
    --port) SERVER_PORT="${2:-$SERVER_PORT}"; shift 2 ;;
    --domain) CUSTOM_DOMAIN="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Erro: execute como root (ex.: | sudo bash -s)."
  exit 1
fi

APP_USER="criativo"
APP_DIR="/opt/criativo-ai-studio-online"
DATA_DIR="/var/lib/criativo"
ENV_DIR="/etc/criativo"
ENV_FILE="$ENV_DIR/criativo.env"

safe_apt_update() {
  apt-get -o Acquire::AllowReleaseInfoChange=true -o Acquire::AllowReleaseInfoChange::Label=true update -y >/dev/null 2>&1 \
    || apt-get --allow-releaseinfo-change update -y >/dev/null 2>&1 \
    || true
}

echo "==> [1/5] Verificando dependências base e Node.js 22..."
export DEBIAN_FRONTEND=noninteractive
safe_apt_update
apt-get install -y --no-install-recommends ca-certificates curl tar openssl ffmpeg sqlite3 gnupg build-essential >/dev/null

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 22 ]]; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get -o Dir::Etc::sourcelist="sources.list.d/nodesource.list" -o Dir::Etc::sourceparts="-" -o APT::Get::List-Cleanup="0" update -y >/dev/null 2>&1 || safe_apt_update
  apt-get install -y --no-install-recommends nodejs >/dev/null
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi

mkdir -p "$APP_DIR" "$DATA_DIR" "$ENV_DIR" /run/criativo

echo "==> [2/5] Obtendo pacote mais recente do Criativo AI Studio Online..."
if [[ -f "./produto.json" && -d "./apps/daemon" ]]; then
  cp -a ./. "$APP_DIR"/
else
  TMP_TAR="$(mktemp /tmp/criativo-vps-XXXXXX.tar.gz)"
  TMP_EXTRACT="$(mktemp -d /tmp/criativo-extract-XXXXXX)"
  GITHUB_FALLBACK_TAR="https://github.com/ivancnogueira/criativo-studio/archive/refs/heads/main.tar.gz"
  DOWNLOADED="false"
  if [[ "$HUB_URL" != *"[SEU_DOMINIO_HUB]"* ]]; then
    if curl -fsSL "${HUB_URL%/}/api/releases/download/latest/vps-tarball" -o "$TMP_TAR" 2>/dev/null; then
      DOWNLOADED="true"
    fi
  fi
  if [[ "$DOWNLOADED" != "true" ]]; then
    echo "    -> Pacote direto do Hub indisponível no momento; baixando repositório principal..."
    curl -fsSL "$GITHUB_FALLBACK_TAR" -o "$TMP_TAR"
  fi
  tar -xzf "$TMP_TAR" -C "$TMP_EXTRACT"
  if [[ -f "$TMP_EXTRACT/package.json" ]]; then
    cp -a "$TMP_EXTRACT"/. "$APP_DIR"/
  else
    TOP_SUBDIR="$(find "$TMP_EXTRACT" -mindepth 1 -maxdepth 1 -type d | head -n 1 || true)"
    if [[ -n "$TOP_SUBDIR" && -f "$TOP_SUBDIR/package.json" ]]; then
      cp -a "$TOP_SUBDIR"/. "$APP_DIR"/
    else
      cp -a "$TMP_EXTRACT"/. "$APP_DIR"/
    fi
  fi
  rm -rf "$TMP_TAR" "$TMP_EXTRACT"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR" /run/criativo
su -s /bin/bash "$APP_USER" -c "cd '$APP_DIR' && npm install --include=dev --no-audit --no-fund && npm run build && npm run build --workspace=apps/web && node scripts/configurar-local.mjs --sem-build"

echo "==> [3/5] Configurando Cofre e Token de Acesso Seguro..."
MASTER_KEY="$(openssl rand -hex 32)"
ACCESS_TOKEN="$(openssl rand -hex 32)"
if [[ -f "$ENV_FILE" ]]; then
  # Preserva cofre existente se reinstalação
  grep -q "^CRIATIVO_SERVER_ACCESS_TOKEN=" "$ENV_FILE" && ACCESS_TOKEN="$(grep '^CRIATIVO_SERVER_ACCESS_TOKEN=' "$ENV_FILE" | cut -d= -f2-)" || echo "CRIATIVO_SERVER_ACCESS_TOKEN=$ACCESS_TOKEN" >> "$ENV_FILE"
else
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=$SERVER_PORT
HOST=0.0.0.0
CRIATIVO_DB_PATH=$DATA_DIR/criativo.db
CRIATIVO_USER_DATA_DIR=$DATA_DIR
CRIATIVO_SOCKET_PATH=/run/criativo/control.sock
CRIATIVO_VAULT_KEY=$MASTER_KEY
CRIATIVO_SERVER_ACCESS_TOKEN=$ACCESS_TOKEN
CRIATIVO_LICENSE_HUB_URL=$HUB_URL
EOF
  chmod 600 "$ENV_FILE"
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
fi

echo "==> [4/5] Registrando serviço systemd (criativo.service)..."
cat > /etc/systemd/system/criativo.service <<EOF
[Unit]
Description=Criativo AI Studio Online Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $APP_DIR/apps/daemon/dist/server/daemon-server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable criativo.service
systemctl restart criativo.service

for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${SERVER_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "==> [5/5] Pareando servidor à sua conta..."
if [[ -n "$CLAIM_SECRET" ]]; then
  PUBLIC_IP="$(curl -4 -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
  HOST_URL="http://${PUBLIC_IP}:${SERVER_PORT}"
  if [[ -n "$CUSTOM_DOMAIN" ]]; then
    HOST_URL="https://${CUSTOM_DOMAIN}"
  fi
  VPS_MACHINE_ID="$(cat /etc/machine-id 2>/dev/null || hostname)"

  REDEEM_JSON="$(printf '{"claim_secret":"%s","claim_token":"%s","server_name":"%s","host_url":"%s","base_url":"%s","public_ip":"%s","remote_ip":"%s","server_port":%s,"server_api_token":"%s","access_token":"%s","vps_machine_id":"%s"}' \
    "$CLAIM_SECRET" "$CLAIM_SECRET" "$SERVER_NAME" "$HOST_URL" "$HOST_URL" "$PUBLIC_IP" "$PUBLIC_IP" "$SERVER_PORT" "$ACCESS_TOKEN" "$ACCESS_TOKEN" "$VPS_MACHINE_ID")"

  curl -fsS -X POST "${HUB_URL%/}/api/server-claims/redeem" \
    -H "Content-Type: application/json" \
    -d "$REDEEM_JSON" >/dev/null 2>&1 \
    || curl -fsS -X POST "${HUB_URL%/}/api/servers/claims/redeem" \
      -H "Content-Type: application/json" \
      -d "$REDEEM_JSON" >/dev/null
  echo "Criativo AI Studio conectado à sua conta com sucesso."
else
  echo "Instalação concluída. Nenhum CRIATIVO_CLAIM informado."
fi
