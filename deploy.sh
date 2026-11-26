#!/usr/bin/env bash

# ==============================================================================
# Script de Deploy Automático - Painel Central CriativoOS (aaPanel/Linux)
# Preserva intactos o .env (chaves/senhas) e a pasta dados/ (SQLite de licenças).
# ==============================================================================

set -u

REPO_DEFAULT="https://github.com/ivancnogueira/painel-criativo-studio.git"
APP_NAME="${PAINEL_APP_NAME:-painel-criativo-studio}"
BRANCH="${PAINEL_BRANCH:-main}"

echo "======================================================="
echo "🚀 Iniciando deploy automático do Painel CriativoOS"
echo "======================================================="

abortar_com_erro() {
  echo "❌ Erro: $1"
  exit 1
}

# 1. Configurar Git na pasta atual sem sobrescrever origin autenticado existente
CURRENT_DIR="$(pwd)"
git config --global --add safe.directory "$CURRENT_DIR" 2>/dev/null || true

if [ ! -d ".git" ]; then
  echo "📥 Inicializando repositório Git na pasta atual..."
  git init -b "$BRANCH" || abortar_com_erro "Falha ao inicializar repositório Git."
fi

if [ -n "${PAINEL_REPO_URL:-}" ]; then
  TARGET_URL="$PAINEL_REPO_URL"
elif [ -n "${GITHUB_TOKEN:-}" ]; then
  TARGET_URL="https://${GITHUB_TOKEN}@github.com/ivancnogueira/painel-criativo-studio.git"
else
  EXISTING_ORIGIN="$(git remote get-url origin 2>/dev/null || true)"
  if [ -n "$EXISTING_ORIGIN" ]; then
    TARGET_URL="$EXISTING_ORIGIN"
  else
    TARGET_URL="$REPO_DEFAULT"
  fi
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$TARGET_URL" || abortar_com_erro "Falha ao atualizar remote origin."
else
  git remote add origin "$TARGET_URL" || abortar_com_erro "Falha ao adicionar remote origin."
fi

# 2. Baixar atualizações da branch main (.env e dados/ estão no .gitignore e são preservados)
echo "📦 Baixando atualizações de origin/$BRANCH..."
git fetch origin "$BRANCH" || abortar_com_erro "Falha ao buscar dados do GitHub. Verifique acesso/rede ou GITHUB_TOKEN se o repo for privado."
git checkout -B "$BRANCH" "origin/$BRANCH" >/dev/null 2>&1 || git reset --hard "origin/$BRANCH" || abortar_com_erro "Falha ao sincronizar arquivos."
git reset --hard "origin/$BRANCH" || abortar_com_erro "Falha ao aplicar código mais recente."

# Garantir permissão de execução nos scripts shell
chmod +x deploy.sh 2>/dev/null || true
chmod +x scripts/*.sh 2>/dev/null || true

# 3. Garantir diretórios persistentes e validar Node.js >= 22
mkdir -p dados logs

if ! command -v node >/dev/null 2>&1; then
  abortar_com_erro "Node.js não encontrado no PATH. Configure Node v22+ no aaPanel."
fi

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
echo "🟢 Node detectado: $(node -v)"
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  abortar_com_erro "Node.js >= 22 é obrigatório (uso nativo de node:sqlite). Versão atual: $(node -v)."
fi

# 4. Instalar dependências de produção e validar entrada
echo "⚙️  Instalando dependências de produção..."
export NODE_ENV=production
if [ -f "package-lock.json" ]; then
  npm ci --omit=dev || npm install --omit=dev || abortar_com_erro "Falha ao instalar dependências."
else
  npm install --omit=dev || abortar_com_erro "Falha ao instalar dependências."
fi

echo "🔍 Validando sintaxe de server.js..."
node --check server.js || abortar_com_erro "Falha na verificação de sintaxe do server.js."

if [ ! -f ".env" ]; then
  echo "⚠️  Atenção: arquivo .env não encontrado em $CURRENT_DIR."
  echo "   Crie o .env baseado em .env.example com ADMIN_PASSWORD, SESSION_SECRET e chaves Ed25519 antes de iniciar."
fi

# 5. Reinício automático caso gerenciador conhecido seja detectado
LISTEN_PORT="3009"
if [ -f ".env" ]; then
  ENV_PORT="$(grep -E '^PORT=' .env | head -n1 | cut -d= -f2- | tr -d '"\r ' || true)"
  [ -n "$ENV_PORT" ] && LISTEN_PORT="$ENV_PORT"
fi

stop_orphan_port_process() {
  local port="$1"
  local pids=""
  if command -v ss >/dev/null 2>&1; then
    pids="$(ss -tlnp 2>/dev/null | awk -v p=":${port}" '$4 ~ p"$" {print}' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"
  elif command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)"
  fi
  for pid in $pids; do
    [ -n "$pid" ] || continue
    local cmdline=""
    cmdline="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
    if echo "$cmdline" | grep -qi "node"; then
      echo "🧹 Encerrando processo Node antigo na porta ${port} (PID ${pid})..."
      kill -TERM "$pid" 2>/dev/null || true
      local tries=0
      while kill -0 "$pid" 2>/dev/null && [ "$tries" -lt 6 ]; do
        sleep 0.5
        tries=$((tries + 1))
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null || true
      fi
    fi
  done
}

RESTARTED=0
AAPANEL_SCRIPT="/www/server/nodejs/vhost/scripts/${APP_NAME}.sh"
if [ ! -f "$AAPANEL_SCRIPT" ] && [ -d "/www/server/nodejs/vhost/scripts" ]; then
  for candidate_script in /www/server/nodejs/vhost/scripts/*.sh; do
    [ -f "$candidate_script" ] || continue
    if grep -Fq "$CURRENT_DIR" "$candidate_script" 2>/dev/null; then
      AAPANEL_SCRIPT="$candidate_script"
      break
    fi
  done
fi
if [ -f "$AAPANEL_SCRIPT" ]; then
  PROJ_NAME="$(basename "$AAPANEL_SCRIPT" .sh)"
  PID_FILE="/www/server/nodejs/vhost/pids/${PROJ_NAME}.pid"
  echo "🔄 Reiniciando projeto Node no aaPanel (${PROJ_NAME})..."
  if [ -f "$PID_FILE" ]; then
    OLD_PID="$(tr -d '[:space:]' < "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$OLD_PID" ]; then
      pkill -TERM -P "$OLD_PID" 2>/dev/null || true
      kill -TERM "$OLD_PID" 2>/dev/null || true
    fi
  fi
  stop_orphan_port_process "$LISTEN_PORT"
  if [ "$(id -u)" -eq 0 ] && id www >/dev/null 2>&1; then
    su -s /bin/bash www -c "bash '$AAPANEL_SCRIPT'" && RESTARTED=1 || true
  else
    bash "$AAPANEL_SCRIPT" && RESTARTED=1 || true
  fi
elif command -v pm2 >/dev/null 2>&1; then
  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    echo "🔄 Reiniciando processo PM2 ($APP_NAME)..."
    pm2 restart "$APP_NAME" && RESTARTED=1 || true
  else
    PM2_MATCH="$(node -e "try{const l=JSON.parse(require('fs').readFileSync(0,'utf8'));const m=l.find(p=>p.pm2_env&&String(p.pm2_env.pm_cwd||'').replace(/\/+$/,'')===process.argv[1].replace(/\/+$/,''));if(m&&m.name)console.log(m.name);}catch{}" "$CURRENT_DIR" < <(pm2 jlist 2>/dev/null || echo '[]') 2>/dev/null || true)"
    if [ -n "$PM2_MATCH" ]; then
      echo "🔄 Reiniciando processo PM2 ($PM2_MATCH)..."
      pm2 restart "$PM2_MATCH" && RESTARTED=1 || true
    fi
  fi
fi

if [ "$RESTARTED" -eq 1 ]; then
  sleep 2
  HEALTH_JSON=""
  if command -v curl >/dev/null 2>&1; then
    HEALTH_JSON="$(curl -fsS "http://127.0.0.1:${LISTEN_PORT}/api/health" 2>/dev/null || true)"
  fi
  if [ -n "$HEALTH_JSON" ]; then
    echo "💚 Healthcheck OK em http://127.0.0.1:${LISTEN_PORT}/api/health"
    echo "   $HEALTH_JSON"
  else
    echo "ℹ️  Reinício solicitado. Verifique os logs no aaPanel caso esteja subindo agora."
  fi
fi

echo "======================================================="
echo "✅ Deploy do Painel concluído com sucesso!"
if [ "$RESTARTED" -eq 0 ]; then
  echo "⚠️  ATENÇÃO: O processo Node NÃO foi reiniciado automaticamente!"
  echo "   O código novo já está no disco, mas a API antiga continua em memória."
  echo "   👉 Abra o aaPanel -> Website -> Node Project e clique em RESTART no projeto."
fi
echo "======================================================="
