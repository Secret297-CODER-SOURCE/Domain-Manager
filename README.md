# Domain Manager

## Структура
```
backend/     — FastAPI + SQLAlchemy (PostgreSQL)
frontend/    — React (буде далі)
nginx/       — Reverse proxy
scripts/     — Скрипти деплою
```

## Швидкий старт на Ubuntu 24

```bash
# 1. Встановити Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# 2. Клонувати проект і налаштувати
cp .env.example .env
nano .env   # змінити паролі!

# 3. Запустити
bash scripts/setup.sh
```

## .env змінні
| Змінна | Опис |
|--------|------|
| POSTGRES_PASSWORD | Пароль БД |
| SECRET_KEY | JWT секрет (авто-генерується) |
| FIRST_ADMIN_USERNAME | Логін першого адміна |
| FIRST_ADMIN_PASSWORD | Пароль першого адміна |
| TELEGRAM_BOT_TOKEN | Токен TG бота (опційно) |
| TELEGRAM_CHAT_ID | Chat ID для сповіщень |

## API Endpoints
- `POST /api/auth/login` — авторизація
- `GET/POST /api/teams` — управління командами
- `GET/POST /api/cloudflare-accounts` — CF акаунти
- `POST /api/cloudflare-accounts/{id}/sync` — синхронізація доменів
- `GET /api/domains` — список доменів (фільтри: team_id, status, zone_name, search)
- `POST /api/domains/bulk-dns-update` — масова зміна DNS
- `POST /api/domains/{id}/dns` — додати DNS запис
- `GET/POST /api/keitaro/instances` — KT інстанси
- `POST /api/keitaro/assign-domain` — додати домен в групу KT
