**[English](README.md)** · Русский

# Короче (Long Story Short)

> 4 см: больше не нужно · *4cm that's all you need*

Небольшой самостоятельный сервис коротких ссылок. Работает на [4cm.su](https://4cm.su). Лицензия MIT.


## Возможности
- Два домена на одном процессе: короткий (`4cm.su`) отдаёт только редиректы, панель (`web.4cm.su`) — управление ссылками.
- Неизвестный или просроченный код → страница 404 со статусом 404 (без редиректа).
- Вход через **VK ID**, открытая регистрация. У каждого пользователя свои ссылки, чужие недоступны.
- Свои коды, теги, срок действия («с» и «до»), редактирование, QR (SVG/PNG).
- Статистика: счётчики, график по дням, источники; боты и предпросмотры считаются отдельно. IP-адреса не хранятся.
- Название страницы подставляется автоматически (с защитой от запросов во внутреннюю сеть).
- Быстро и легко: Node 22, Fastify, SQLite; ссылки лежат в памяти, переходы пишутся пачками. Фронтенд без сборки.
- Защита от злоупотреблений: лимит ссылок на пользователя, лимит создания в час, возможность отключить пользователя.

## Установка
Нужен Node.js 22+ и обратный прокси (nginx) с HTTPS для двух доменов.

```bash
git clone <repo> /opt/koroche && cd /opt/koroche
npm ci --omit=dev
cp .env.example /etc/koroche.env      # заполнить, chmod 600
cp deploy/koroche.service /etc/systemd/system/   # поправить пользователя/пути
systemctl enable --now koroche
```
Пример nginx — `deploy/nginx.conf.example`.

### VK ID
1. На [id.vk.com/business](https://id.vk.com/business) создайте приложение типа «Веб».
2. Базовый домен — домен панели, доверенный Redirect URL — `https://<домен панели>/auth/callback`.
3. ID приложения укажите в `VK_CLIENT_ID`. Секрет не нужен (Authorization Code + PKCE).

### Настройки (переменные окружения)
| Переменная | Назначение | По умолчанию |
|---|---|---|
| `SESSION_SECRET` | ключ подписи сессий, ≥32 символов (обязательно) | — |
| `SHORT_HOST`, `PANEL_HOST` | домены коротких ссылок и панели | `4cm.su`, `web.4cm.su` |
| `SCHEME` | `https` или `http` | `https` |
| `VK_CLIENT_ID` | ID приложения VK ID | — |
| `DB_PATH` | файл SQLite | `./data/koroche.sqlite` |
| `PORT`, `LISTEN` | порт и адрес | `3010`, `127.0.0.1` |
| `MAX_LINKS_PER_USER` | лимит ссылок на пользователя | `1000` |
| `TZ_OFFSET_HOURS` | часовой пояс для графиков | `3` |
| `LEGACY_OWNER_VK_ID` | владелец ссылок, созданных до появления пользователей (разовая миграция) | — |

Страницы `server/public/site` (лендинг, 404) написаны под 4cm.su — замените тексты и картинку `404.jpg` на свои.

## Управление пользователями
```bash
DB_PATH=/var/lib/koroche/koroche.sqlite node scripts/users.js list
node scripts/users.js disable <vk-id>     # ссылки перестают работать, вход закрыт
node scripts/users.js enable <vk-id>
node scripts/users.js transfer <от-vk-id> <кому-vk-id> [код ...]   # передать ссылки
```
Изменения подхватываются сервисом в течение минуты.

## Перенос из Shlink
```bash
node scripts/import-shlink.js <shlink.sqlite> <koroche.sqlite> <vk-id владельца>
```
Коды, даты создания и переходы сохраняются (флаг бота берётся из Shlink). Повторный запуск докачивает только новые переходы.

## Разработка
```bash
npm install
cp .env.example .env     # DEV_LOGIN=1, SCHEME=http, SHORT_HOST=short.localhost, PANEL_HOST=panel.localhost, SHORT_ORIGIN/PANEL_ORIGIN с портом
npm run dev              # вход без VK: http://panel.localhost:3010/auth/dev
```

## Лицензия
[MIT](LICENSE)

## Резервные копии
`deploy/koroche-backup.{service,timer}` ежедневно делают консистентный снимок SQLite (`scripts/backup.js`: копия, gzip, хранятся последние 14). Включение: `systemctl enable --now koroche-backup.timer`. Восстановление: остановить сервис, распаковать снимок (`gunzip`) поверх `DB_PATH`, запустить сервис.
