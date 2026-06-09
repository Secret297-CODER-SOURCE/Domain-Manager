#!/bin/bash
set -e

DOMAIN="domain-manage.tech"
APP_DIR="/opt/otp"

echo "=== Domain Manager — Production Deploy ==="
echo "Domain: $DOMAIN | Dir: $APP_DIR"
cd "$APP_DIR"

# ── 1. Check .env ─────────────────────────────────────────────────────────────
if [ ! -f ".env" ]; then
    cp ".env.example" ".env"
    SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    sed -i "s/change_me_very_long_random_secret_key_here/$SECRET/" ".env"
    echo ""
    echo "⚠️  .env створено — ОБОВ'ЯЗКОВО відредагуй перед продовженням:"
    echo "   nano $APP_DIR/.env"
    echo ""
    read -p "Натисни Enter після редагування .env..."
fi

# ── 2. Install Docker if needed ───────────────────────────────────────────────
if ! command -v docker &> /dev/null; then
    echo "→ Встановлення Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
fi

# ── 3. Install certbot if needed ──────────────────────────────────────────────
if ! command -v certbot &> /dev/null; then
    echo "→ Встановлення certbot..."
    apt-get update -qq && apt-get install -y -qq certbot
fi

# ── 4. Build frontend ─────────────────────────────────────────────────────────
echo "→ Білд фронтенду..."
docker run --rm \
    -v "$APP_DIR/frontend":/app \
    -w /app \
    node:20-alpine \
    sh -c "npm install --silent && npm run build"
echo "✅ Frontend build готовий"

# ── 5. Get SSL cert (first time only) ─────────────────────────────────────────
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    echo "→ Отримання SSL для $DOMAIN (перший запуск)..."
    mkdir -p /var/www/certbot

    # Запускаємо nginx з HTTP-only конфігом для challenge
    docker run -d --name tmp_nginx_ssl \
        -p 80:80 \
        -v "$APP_DIR/nginx/nginx.init.conf":/etc/nginx/nginx.conf:ro \
        -v /var/www/certbot:/var/www/certbot \
        nginx:alpine
    sleep 3

    certbot certonly --webroot \
        -w /var/www/certbot \
        -d "$DOMAIN" \
        -d "www.$DOMAIN" \
        --non-interactive \
        --agree-tos \
        --email "admin@$DOMAIN"

    docker stop tmp_nginx_ssl && docker rm tmp_nginx_ssl
    echo "✅ SSL сертифікат отримано"
else
    echo "✅ SSL сертифікат вже є"
fi

# ── 6. Start / update services ────────────────────────────────────────────────
echo "→ Запуск контейнерів..."
docker compose -f docker-compose.prod.yml build backend
docker compose -f docker-compose.prod.yml up -d

echo ""
echo "✅ Деплой завершено!"
echo "   https://$DOMAIN"
echo ""
echo "Корисні команди:"
echo "  Логи:        docker compose -f $APP_DIR/docker-compose.prod.yml logs -f"
echo "  Перезапуск:  docker compose -f $APP_DIR/docker-compose.prod.yml restart"
echo "  Бекап БД:    bash $APP_DIR/scripts/backup-db.sh"
