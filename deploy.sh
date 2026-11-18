#!/usr/bin/env bash

# ==============================================================================
# Script de Deploy Automático - Painel Central Criativo AI Studio (aaPanel/Linux)
# Preserva intactos o .env (chaves/senhas) e a pasta dados/ (SQLite de licenças).
# ==============================================================================

set -u

REPO_DEFAULT="https://github.com/ivancnogueira/painel-criativo-studio.git"
APP_NAME="${PAINEL_APP_NAME:-painel-criativo-studio}"
BRANCH="${PAINEL_BRANCH:-main}"

echo "======================================================="
echo "🚀 Iniciando deploy automático do Painel Criativo Studio"
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
RESTARTED=0
AAPANEL_SCRIPT="/www/server/nodejs/vhost/scripts/${APP_NAME}.sh"
if [ -x "$AAPANEL_SCRIPT" ]; then
  echo "🔄 Reiniciando projeto Node no aaPanel ($APP_NAME)..."
  bash "$AAPANEL_SCRIPT" restart && RESTARTED=1 || true
elif command -v pm2 >/dev/null 2>&1 && pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  echo "🔄 Reiniciando processo PM2 ($APP_NAME)..."
  pm2 restart "$APP_NAME" && RESTARTED=1 || true
fi

if [ "$RESTARTED" -eq 1 ]; then
  sleep 2
  LISTEN_PORT="3009"
  if [ -f ".env" ]; then
    ENV_PORT="$(grep -E '^PORT=' .env | head -n1 | cut -d= -f2- | tr -d '"\r ' || true)"
    [ -n "$ENV_PORT" ] && LISTEN_PORT="$ENV_PORT"
  fi
  if command -v curl >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:${LISTEN_PORT}/health" >/dev/null 2>&1; then
    echo "💚 Healthcheck OK em http://127.0.0.1:${LISTEN_PORT}/health"
  else
    echo "ℹ️  Reinício solicitado. Verifique os logs no aaPanel caso esteja subindo agora."
  fi
fi

echo "======================================================="
echo "✅ Deploy do Painel concluído com sucesso!"
if [ "$RESTARTED" -eq 0 ]; then
  echo "🔄 Lembre-se de clicar em Restart no Node Project do aaPanel ($APP_NAME)."
fi
echo "======================================================="
