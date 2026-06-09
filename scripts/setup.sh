#!/bin/bash
set -e
echo "=== Domain Manager Setup ==="
if [ ! -f .env ]; then
    cp .env.example .env
    SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    sed -i "s/CHANGE_ME_RANDOM_SECRET_64_CHARS/$SECRET/" .env
    echo "✅ .env created — відредагуй паролі перед запуском!"
else
    echo "✅ .env already exists"
fi
docker compose build
docker compose up -d
echo ""
echo "=== Done ==="
echo "API Docs: http://YOUR_SERVER_IP/api/docs"
