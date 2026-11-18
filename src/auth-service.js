import crypto from "node:crypto";

const SESSION_COOKIE_NAME = "criativo_painel_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 8;
const LOCK_WINDOW_MS = 10 * 60 * 1000;

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.startsWith("scrypt:")) return false;
  const [, salt, hexKey] = storedHash.split(":");
  if (!salt || !hexKey) return false;
  const derived = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hexKey, "hex");
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of String(cookieHeader).split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function createAuthService({ db, adminToken = "", sessionSecret = "", adminEmail = "", adminPassword = "" }) {
  const secret =
    sessionSecret ||
    process.env.SESSION_SECRET ||
    crypto.createHash("sha256").update(adminToken || `fallback-${process.cwd()}`).digest("hex");

  const loginAttempts = new Map();

  // Garante que existe ao menos 1 usuário admin no SQLite (sem sobrescrever senha já alterada na UI)
  function ensureInitialAdmin() {
    const countRow = db.prepare(`SELECT COUNT(*) AS total FROM admin_users;`).get();
    if (Number(countRow?.total || 0) > 0) return;

    const seedEmail = String(adminEmail || process.env.ADMIN_EMAIL || "admin@criativoaistudio.com.br")
      .trim()
      .toLowerCase();
    const seedPass = String(adminPassword || process.env.ADMIN_PASSWORD || "");
    if (!seedPass) return;

    db.prepare(
      `INSERT INTO admin_users (id, email, name, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?);`,
    ).run(
      crypto.randomUUID(),
      seedEmail,
      "Administrador",
      hashPassword(seedPass),
      new Date().toISOString(),
      new Date().toISOString(),
    );
  }

  ensureInitialAdmin();

  function signSessionToken(user) {
    const payload = {
      uid: user.id,
      email: user.email,
      name: user.name,
      exp: Date.now() + SESSION_TTL_MS,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const sig = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
    return `${encoded}.${sig}`;
  }

  function verifySessionToken(token) {
    if (!token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [encoded, sig] = parts;
    const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
    if (!timingSafeEqualStr(sig, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      if (!payload || typeof payload.exp !== "number" || Date.now() > payload.exp) {
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  function authenticateCredentials(email, password, clientIp = "unknown") {
    const key = String(clientIp || "unknown");
    const attempt = loginAttempts.get(key) || { count: 0, resetAt: Date.now() + LOCK_WINDOW_MS };
    if (Date.now() > attempt.resetAt) {
      attempt.count = 0;
      attempt.resetAt = Date.now() + LOCK_WINDOW_MS;
    }
    if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
      return { ok: false, status: 429, error: "too_many_attempts", message: "Muitas tentativas de login. Aguarde alguns minutos." };
    }

    const cleanEmail = String(email || "").trim().toLowerCase();
    const user = db
      .prepare(`SELECT id, email, name, password_hash FROM admin_users WHERE lower(email) = ?;`)
      .get(cleanEmail);

    const envEmail = String(adminEmail || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    const envPass = String(adminPassword || process.env.ADMIN_PASSWORD || "");

    let validUser = null;
    if (user && verifyPassword(password, user.password_hash)) {
      validUser = user;
    } else if (!user && envEmail && envPass && cleanEmail === envEmail && timingSafeEqualStr(String(password || ""), envPass)) {
      // Fallback caso o usuário admin tenha sido adicionado ao .env após o primeiro boot
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO admin_users (id, email, name, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?);`,
      ).run(id, envEmail, "Administrador", hashPassword(envPass), now, now);
      validUser = { id, email: envEmail, name: "Administrador" };
    }

    if (!validUser) {
      attempt.count += 1;
      loginAttempts.set(key, attempt);
      return { ok: false, status: 401, error: "invalid_credentials", message: "E-mail ou senha inválidos." };
    }

    loginAttempts.delete(key);
    const token = signSessionToken(validUser);
    return {
      ok: true,
      token,
      user: { id: validUser.id, email: validUser.email, name: validUser.name },
    };
  }

  function getSessionFromRequest(req) {
    const authHeader = String(req.headers.authorization || "");
    if (authHeader.startsWith("Bearer ")) {
      const bearer = authHeader.slice(7).trim();
      if (adminToken && timingSafeEqualStr(bearer, adminToken)) {
        return { kind: "bearer_token", email: "api@criativoaistudio.com.br", name: "API Admin" };
      }
      const fromJwt = verifySessionToken(bearer);
      if (fromJwt) return { kind: "session", ...fromJwt };
    }

    const cookies = parseCookies(req.headers.cookie);
    const cookieTok = cookies[SESSION_COOKIE_NAME];
    if (cookieTok) {
      const decoded = verifySessionToken(cookieTok);
      if (decoded) return { kind: "session", ...decoded };
    }
    return null;
  }

  function requireAdmin(req, res, next) {
    const session = getSessionFromRequest(req);
    if (!session) {
      return res.status(401).json({ error: "unauthorized", message: "Sessão expirada ou não autenticada." });
    }
    req.adminSession = session;
    return next();
  }

  function setSessionCookie(res, token, req) {
    const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
    const attrs = [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (isHttps) attrs.push("Secure");
    res.setHeader("Set-Cookie", attrs.join("; "));
  }

  function clearSessionCookie(res) {
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
  }

  function updatePassword(email, currentPassword, newPassword) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    const user = db
      .prepare(`SELECT id, email, password_hash FROM admin_users WHERE lower(email) = ?;`)
      .get(cleanEmail);
    if (!user) return { ok: false, error: "not_found", message: "Usuário administrador não encontrado." };
    if (!verifyPassword(currentPassword, user.password_hash)) {
      return { ok: false, error: "wrong_password", message: "Senha atual incorreta." };
    }
    if (!newPassword || String(newPassword).length < 8) {
      return { ok: false, error: "weak_password", message: "A nova senha deve ter no mínimo 8 caracteres." };
    }
    db.prepare(`UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?;`).run(
      hashPassword(newPassword),
      new Date().toISOString(),
      user.id,
    );
    return { ok: true };
  }

  return {
    authenticateCredentials,
    getSessionFromRequest,
    requireAdmin,
    setSessionCookie,
    clearSessionCookie,
    updatePassword,
  };
}
