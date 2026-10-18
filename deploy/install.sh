#!/usr/bin/env bash
# Veta Messenger — one-command installer for the server that already runs Veta.
#
#   curl -fsSL https://raw.githubusercontent.com/Abd-na/Test/claude/fervent-ride-xm2fik/deploy/install.sh | bash
#
# Safe to run again: it updates the code and keeps the existing .env.
# Every question can be answered ahead of time with an environment variable
# (VETA_ENV, DOMAIN, COUNTRY_CODE, LE_EMAIL, DB_HOST, DB_PORT, DB_DATABASE,
# DB_USERNAME, DB_PASSWORD, SKIP_WEB=1, SKIP_PM2_STARTUP=1, ASSUME_YES=1).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Abd-na/Test.git}"
BRANCH="${BRANCH:-claude/fervent-ride-xm2fik}"
APP_DIR="${APP_DIR:-/opt/veta-messenger}"
PORT="${PORT:-3100}"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  • %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die() { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

# read from the terminal even when the script itself comes from a pipe
ask() {
  local prompt="$1" default="${2:-}" answer=""
  if [[ -r /dev/tty ]]; then
    read -r -p "  ? ${prompt}${default:+ [${default}]}: " answer </dev/tty || true
  fi
  printf '%s' "${answer:-$default}"
}
ask_secret() {
  local prompt="$1" answer=""
  if [[ -r /dev/tty ]]; then
    read -r -s -p "  ? ${prompt}: " answer </dev/tty || true
    printf '\n' >/dev/tty
  fi
  printf '%s' "$answer"
}
confirm() {
  [[ "${ASSUME_YES:-0}" == "1" ]] && return 0
  local a
  a="$(ask "$1 (y/n)" "${2:-y}")"
  [[ "$a" =~ ^[Yy] || "$a" == "نعم" || "$a" == "ن" ]]
}

# quote a value for .env (Node's parser: single quotes are literal)
env_quote() {
  local v="$1"
  if [[ "$v" != *"'"* ]]; then printf "'%s'" "$v"
  elif [[ "$v" != *'"'* && "$v" != *'\'* ]]; then printf '"%s"' "$v"
  else printf '`%s`' "$v"; fi
}

SUDO=""
if [[ $EUID -ne 0 ]]; then
  command -v sudo >/dev/null || die "Run as root or install sudo"
  SUDO="sudo"
  bold "قد يُطلب منك كلمة مرور sudo / sudo password may be requested"
  $SUDO -v
fi
RUN_USER="$(id -un)"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"

command -v apt-get >/dev/null || die "This installer supports Ubuntu/Debian (apt). Follow README.md for other systems."

# ---------------------------------------------------------------- 1. packages
bold "1/7  الحزم الأساسية / Base packages"
missing=()
for p in git curl openssl ca-certificates; do command -v "$p" >/dev/null || missing+=("$p"); done
if ((${#missing[@]})); then
  $SUDO apt-get update -qq
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" >/dev/null
fi
info "git, curl, openssl ✓"

node_ok() {
  command -v node >/dev/null || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=12)?0:1)'
}
if ! node_ok; then
  info "Installing Node.js 22 LTS"
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash - >/dev/null
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
fi
node_ok || die "Node.js 20.12+ is required"
info "Node $(node -v) ✓"

# ---------------------------------------------------------------- 2. code
bold "2/7  الكود / Code → ${APP_DIR}"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch -q origin "$BRANCH"
  git -C "$APP_DIR" checkout -q "$BRANCH"
  git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
  info "updated to $(git -C "$APP_DIR" rev-parse --short HEAD)"
else
  $SUDO mkdir -p "$APP_DIR"
  $SUDO chown "$RUN_USER":"$(id -gn)" "$APP_DIR"
  git clone -q --branch "$BRANCH" --depth 1 "$REPO_URL" "$APP_DIR"
  info "cloned $(git -C "$APP_DIR" rev-parse --short HEAD)"
fi
cd "$APP_DIR/server"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
info "dependencies installed ✓"

# ---------------------------------------------------------------- 3. .env
bold "3/7  الإعدادات / Configuration"
env_get() { # env_get FILE KEY -> value, parsed like Laravel/phpdotenv (quotes, \" escapes, comments)
  node - "$1" "$2" <<'JS'
const [file, key] = process.argv.slice(2)
const line = require('fs').readFileSync(file, 'utf8').split(/\r?\n/).reverse()
  .find((l) => l.replace(/^\s*export\s+/, '').trimStart().startsWith(`${key}=`))
if (line) {
  let v = line.slice(line.indexOf('=') + 1).trim()
  if (v.length > 1 && v[0] === '"' && v.at(-1) === '"') v = v.slice(1, -1).replace(/\\(["\\$])/g, '$1')
  else if (v.length > 1 && v[0] === "'" && v.at(-1) === "'") v = v.slice(1, -1)
  else v = v.replace(/\s+#.*$/, '')
  process.stdout.write(v)
}
JS
}

CREATED_ENV=0
ADMIN_PASSWORD_PLAIN=""
set_env() { # set_env KEY VALUE (in-place, keeps everything else)
  if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else printf '%s=%s\n' "$1" "$2" >>.env; fi
}
if [[ -f .env ]]; then
  info "keeping existing server/.env"
  if [[ -n "${DOMAIN:-}" ]]; then
    set_env PUBLIC_URL "https://${DOMAIN}"
    set_env HOST 127.0.0.1
    info "domain set to ${DOMAIN}"
  fi
else
  CREATED_ENV=1
  # Find Veta's Laravel .env to reuse its database credentials
  VETA_ENV="${VETA_ENV:-}"
  if [[ -z "$VETA_ENV" ]]; then
    for f in /var/www/*/.env /var/www/*/*/.env /home/*/*/.env /srv/*/.env; do
      [[ -r "$f" ]] && grep -q '^DB_DATABASE=' "$f" 2>/dev/null && { VETA_ENV="$f"; break; }
    done
    VETA_ENV="$(ask "مسار ملف .env الخاص بفيتا / Path to Veta's .env (empty = enter DB manually)" "$VETA_ENV")"
  fi
  if [[ -n "$VETA_ENV" && ! -r "$VETA_ENV" ]]; then
    VETA_ENV_TMP="$(mktemp)"
    $SUDO cat "$VETA_ENV" >"$VETA_ENV_TMP" 2>/dev/null || die "Cannot read $VETA_ENV"
    VETA_ENV="$VETA_ENV_TMP"
  fi
  if [[ -n "$VETA_ENV" ]]; then
    DB_HOST="${DB_HOST:-$(env_get "$VETA_ENV" DB_HOST)}"
    DB_PORT="${DB_PORT:-$(env_get "$VETA_ENV" DB_PORT)}"
    DB_DATABASE="${DB_DATABASE:-$(env_get "$VETA_ENV" DB_DATABASE)}"
    DB_USERNAME="${DB_USERNAME:-$(env_get "$VETA_ENV" DB_USERNAME)}"
    DB_PASSWORD="${DB_PASSWORD:-$(env_get "$VETA_ENV" DB_PASSWORD)}"
    info "database settings read from Veta: ${DB_USERNAME}@${DB_HOST}:${DB_PORT:-3306}/${DB_DATABASE}"
    [[ -n "${VETA_ENV_TMP:-}" ]] && rm -f "$VETA_ENV_TMP"
  fi
  DB_HOST="${DB_HOST:-$(ask "DB host" 127.0.0.1)}"
  DB_PORT="${DB_PORT:-3306}"
  DB_DATABASE="${DB_DATABASE:-$(ask "DB name (Veta's database)" veta)}"
  DB_USERNAME="${DB_USERNAME:-$(ask "DB user")}"
  DB_PASSWORD="${DB_PASSWORD-$(ask_secret "DB password")}"
  [[ "$DB_HOST" == "localhost" ]] && DB_HOST=127.0.0.1

  DOMAIN="${DOMAIN-$(ask "النطاق الفرعي للمنصة / Subdomain for the platform, e.g. msg.veta.com (empty = use server IP)")}"
  COUNTRY_CODE="${COUNTRY_CODE:-$(ask "رمز الدولة للأرقام المحلية / Country code for local numbers" 964)}"

  if [[ -n "$DOMAIN" ]]; then
    PUBLIC_URL="https://${DOMAIN}"
    LISTEN_HOST=127.0.0.1
  else
    IP="$(curl -fsS -m 5 https://api.ipify.org || hostname -I | awk '{print $1}')"
    PUBLIC_URL="http://${IP}:${PORT}"
    LISTEN_HOST=0.0.0.0
    warn "No domain: the platform will be reachable on ${PUBLIC_URL} without HTTPS"
  fi

  ADMIN_PASSWORD_PLAIN="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
  umask 077
  cat >.env <<EOF
NODE_ENV=production
HOST=${LISTEN_HOST}
PORT=${PORT}
PUBLIC_URL=${PUBLIC_URL}
TRUST_PROXY=1
LOG_LEVEL=info

APP_NAME=Veta
APP_SECRET=$(openssl rand -hex 32)
ADMIN_PASSWORD=${ADMIN_PASSWORD_PLAIN}

DB_HOST=${DB_HOST}
DB_PORT=${DB_PORT}
DB_DATABASE=${DB_DATABASE}
DB_USERNAME=${DB_USERNAME}
DB_PASSWORD=$(env_quote "$DB_PASSWORD")

DEFAULT_COUNTRY_CODE=${COUNTRY_CODE}
EOF
  umask 022
  info "server/.env created (chmod 600)"
fi
PORT="$(sed -n 's/^PORT=//p' .env)"
PORT="${PORT:-3100}"

# ---------------------------------------------------------------- 4. database
bold "4/7  قاعدة البيانات / Database (tables prefixed vm_)"
node --input-type=module -e "
import { migrate, pool } from './src/lib/db.js'
try { await migrate(); console.log('  • connected and migrated ✓') }
catch (e) { console.error('  ✗ ' + e.message); process.exitCode = 1 }
finally { await pool.end() }
" || die "Database check failed. Fix DB_* in ${APP_DIR}/server/.env (the user needs CREATE TABLE rights) and run the installer again."

# ---------------------------------------------------------------- 5. process manager
bold "5/7  التشغيل الدائم / PM2"
if ! command -v pm2 >/dev/null; then
  $SUDO npm install -g pm2 --no-audit --no-fund --loglevel=error >/dev/null
fi
if pm2 describe veta-messenger >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --update-env >/dev/null
  info "restarted"
else
  pm2 start ecosystem.config.cjs >/dev/null
  info "started"
fi
pm2 save >/dev/null
if [[ "${SKIP_PM2_STARTUP:-0}" != "1" ]]; then
  $SUDO env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$RUN_USER" --hp "$RUN_HOME" >/dev/null
  info "starts automatically after reboot ✓"
fi

for _ in $(seq 1 30); do
  curl -fsS -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null || { pm2 logs veta-messenger --lines 40 --nostream; die "The app did not start (logs above)"; }
info "health check ✓"

# ---------------------------------------------------------------- 6. web server
bold "6/7  الويب / Web server"
DOMAIN_FROM_ENV="$(sed -n 's#^PUBLIC_URL=https://##p' .env)"
if [[ "${SKIP_WEB:-0}" == "1" ]]; then
  info "skipped (SKIP_WEB=1)"
elif [[ -z "$DOMAIN_FROM_ENV" ]]; then
  if command -v ufw >/dev/null && $SUDO ufw status | grep -q "Status: active"; then
    $SUDO ufw allow "${PORT}/tcp" >/dev/null && info "ufw: opened port ${PORT}"
  fi
  warn "No domain configured; skipping Nginx/SSL. Later: point a subdomain here and run  DOMAIN=msg.example.com bash ${APP_DIR}/deploy/install.sh"
else
  D="$DOMAIN_FROM_ENV"
  if systemctl is-active --quiet apache2 && ! systemctl is-active --quiet nginx; then
    info "Apache detected → reverse proxy vhost"
    $SUDO a2enmod -q proxy proxy_http headers >/dev/null
    $SUDO tee /etc/apache2/sites-available/veta-messenger.conf >/dev/null <<EOF
<VirtualHost *:80>
    ServerName ${D}
    ProxyPreserveHost On
    ProxyTimeout 90
    RequestHeader set X-Forwarded-Proto "http"
    ProxyPass / http://127.0.0.1:${PORT}/ timeout=90
    ProxyPassReverse / http://127.0.0.1:${PORT}/
    LimitRequestBody 41943040
</VirtualHost>
EOF
    $SUDO a2ensite -q veta-messenger >/dev/null
    $SUDO apache2ctl configtest && $SUDO systemctl reload apache2
    WEB=apache
  else
    command -v nginx >/dev/null || $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx >/dev/null
    sed "s/msg.veta.example.com/${D}/g; s/127.0.0.1:3100/127.0.0.1:${PORT}/g" "$APP_DIR/deploy/nginx.conf" |
      $SUDO tee /etc/nginx/sites-available/veta-messenger >/dev/null
    $SUDO ln -sf /etc/nginx/sites-available/veta-messenger /etc/nginx/sites-enabled/veta-messenger
    $SUDO nginx -t && $SUDO systemctl reload nginx
    WEB=nginx
  fi
  info "${WEB} serves http://${D} ✓"

  if $SUDO test -d "/etc/letsencrypt/live/${D}"; then
    info "SSL certificate already exists ✓"
  elif confirm "إصدار شهادة SSL مجانية الآن؟ (يجب أن يشير ${D} إلى هذا السيرفر) / Issue a free SSL certificate now?" y; then
    LE_EMAIL="${LE_EMAIL:-$(ask "Email for Let's Encrypt (optional)")}"
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot "python3-certbot-${WEB}" >/dev/null
    email_args=(--register-unsafely-without-email)
    [[ -n "$LE_EMAIL" ]] && email_args=(-m "$LE_EMAIL")
    if $SUDO certbot "--${WEB}" -d "$D" --non-interactive --agree-tos --redirect "${email_args[@]}"; then
      info "HTTPS ✓"
    else
      warn "certbot failed (is the DNS record for ${D} pointing here?). Run later: sudo certbot --${WEB} -d ${D}"
    fi
  fi
fi

# ---------------------------------------------------------------- 7. API key
bold "7/7  مفتاح API / API key"
API_KEY=""
if [[ "$CREATED_ENV" == "1" ]] || confirm "Create a new API key?" n; then
  API_KEY="$(npm run -s key:create -- "Veta app" | sed -n 's/.*VETA_MESSENGER_KEY=//p')"
fi

URL="$(sed -n 's/^PUBLIC_URL=//p' .env)"
bold "✓ تم التثبيت / Installed"
cat <<EOF

  لوحة التحكم / Dashboard : ${URL}
EOF
[[ -n "$ADMIN_PASSWORD_PLAIN" ]] && echo "  كلمة مرور المدير / Admin password : ${ADMIN_PASSWORD_PLAIN}"
if [[ -n "$API_KEY" ]]; then
  cat <<EOF

  أضف هذا إلى ملف .env الخاص بفيتا / Add to Veta's .env:

    VETA_MESSENGER_URL=${URL}
    VETA_MESSENGER_KEY=${API_KEY}

  (المفتاح يظهر مرة واحدة فقط / shown only once)
EOF
fi
cat <<EOF

  السجلات / Logs   : pm2 logs veta-messenger
  التحديث / Update : bash ${APP_DIR}/deploy/install.sh
  الإعدادات        : ${APP_DIR}/server/.env  (ثم / then: pm2 reload veta-messenger --update-env)

EOF
