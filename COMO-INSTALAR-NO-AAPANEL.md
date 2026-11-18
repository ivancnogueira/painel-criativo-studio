# 🚀 Como Instalar o Painel Central no aaPanel (`painel.criativoaistudio.com.br`)

Este servidor é 100% independente da Landing Page e funciona em Node.js ≥ 22 (usando SQLite nativo `node:sqlite`, sem compilação de módulos nativos).

---

## 📋 Passo a Passo no aaPanel

### 1. Criar o Subdomínio e o Projeto Node
1. No menu lateral do aaPanel, vá em **Website** ➔ **Node project** ➔ **Add Node Project**.
2. Preencha:
   - **Path (Diretório):** `/www/wwwroot/painel-criativo-studio` (após clonar `https://github.com/ivancnogueira/painel-criativo-studio.git`)
   - **Name:** `painel-criativo-studio`
   - **Run Opt:** `start` (ou arquivo `server.js`)
   - **Node Version:** `v22.x` (obrigatório `>= 22.0.0` por conta de `node:sqlite`)
   - **Port:** `3009`
   - **Domain:** `painel.criativoaistudio.com.br` (Lembre-se de criar o registro DNS Tipo `A` apontando `painel` para o IP da sua VPS!)

### 2. Configurar as Variáveis de Ambiente (`.env`)
Na pasta raiz do projeto (`/www/wwwroot/painel-criativo-studio/.env`), crie o arquivo `.env` a partir de `.env.example` com:
- `ADMIN_EMAIL` e `ADMIN_PASSWORD` (seu login e senha iniciais)
- `SESSION_SECRET`, `CRIATIVO_ADMIN_TOKEN`, `PAINEL_VAULT_KEY`
- `CRIATIVO_LICENSE_PUBLIC_KEY_PEM` e `CRIATIVO_LICENSE_PRIVATE_KEY_PEM` (par oficial Ed25519 compatível com o App Desktop)

> **Importante:** Nunca envie o arquivo `.env` nem a pasta `dados/` para o GitHub.

### 3. Instalar Dependências, Iniciar ou Atualizar Automático (`deploy.sh`)
Na pasta do projeto na VPS (`/www/wwwroot/painel-criativo-studio`), você pode rodar diretamente o script automático de deploy (tanto na primeira instalação após criar o `.env`, quanto via **Webhook de Deploy Automático** do aaPanel):
```bash
curl -fsSL https://raw.githubusercontent.com/ivancnogueira/painel-criativo-studio/main/deploy.sh -o deploy.sh
chmod +x deploy.sh
./deploy.sh
```
> **Segurança:** O `deploy.sh` baixa o código mais recente da branch `main`, instala dependências com `--omit=dev`, **preserva intactos** o seu `.env` e a pasta `dados/` (banco SQLite) e tenta reiniciar automaticamente o projeto Node no aaPanel/PM2.

Se preferir fazer manualmente na primeira vez:
```bash
npm install --omit=dev
```
Depois clique em **Start** (ou **Restart**) no Node Project Manager do aaPanel e ative o **SSL (Let's Encrypt)** com **Force HTTPS** em **Settings ➔ SSL**.

### 4. Acessar o Painel
Acesse **`https://painel.criativoaistudio.com.br`**, entre com seu e-mail e senha configurados no `.env` e configure:
1. **E-mail SMTP** (ou Resend) na aba **E-mail & WhatsApp**.
2. **Webhooks Hotmart / Kiwify / Ticto / Stripe** na aba **Webhooks de Checkout**.
3. **Meta WhatsApp Cloud API Oficial** quando desejar tirar do modo Standby.
