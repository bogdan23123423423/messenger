# Настройка моста SynvaSupport ↔ sonreaaivpn@gmail.com

Разовая настройка в четыре шага: KV + деплой воркера → Resend (отправка) →
Google OAuth (чтение твоих ответов) → секреты → вставить URL/ключ в Synva.

## 0. Что понадобится
- Аккаунт Cloudflare (бесплатного плана достаточно).
- Node.js на компьютере, откуда будешь деплоить.
- Аккаунт на resend.com (бесплатный тариф — 100 писем/день).
- Google-аккаунт sonreaaivpn@gmail.com под рукой (нужно будет один раз войти).

## 1. Деплой воркера

```bash
cd worker
npm install
npx wrangler login          # откроется браузер, авторизуй Cloudflare
npx wrangler kv namespace create SUPPORT_KV
```

Команда выведет что-то вроде:
```
{ binding = "SUPPORT_KV", id = "a1b2c3d4..." }
```
Скопируй `id` в `wrangler.toml`, в поле `id` у `kv_namespaces`.

```bash
npx wrangler deploy
```

В выводе будет URL воркера вида `https://synva-support.ТВОЙ-АККАУНТ.workers.dev`
— он понадобится в шаге 4.

## 2. Resend (исходящая почта: юзер → sonreaaivpn@gmail.com)

1. Зарегистрируйся на https://resend.com
2. API Keys → Create API Key → тип **Sending access** → скопируй ключ (`re_...`).
3. Для теста можно сразу слать через `onboarding@resend.dev` (уже стоит в
   `wrangler.toml` по умолчанию) — но Resend в этом режиме шлёт письма
   только на тот адрес, которым ты зарегистрировался в Resend. Если
   sonreaaivpn@gmail.com — это и есть твой аккаунт в Resend, для теста
   подойдёт. Для полноценной работы на любой адрес:
   - Domains → Add Domain → добавь поддомен, например `mail.securelinevpn.online`.
   - Пропиши у себя в DNS (REG.RU) TXT/DKIM/MX записи, которые покажет Resend.
   - После верификации поменяй `FROM_EMAIL` в `wrangler.toml`, например:
     `FROM_EMAIL = "Synva Support <support@mail.securelinevpn.online>"`
   - `npx wrangler deploy` ещё раз, чтобы применить новую переменную.

## 3. Google OAuth (входящая почта: твой ответ в Gmail → чат)

Нужен, чтобы воркер раз в минуту мог прочитать твои ответы в
sonreaaivpn@gmail.com через официальный Gmail API (без паролей и IMAP).

1. https://console.cloud.google.com → создай новый проект (любое имя,
   например "Synva Support").
2. APIs & Services → Library → найди **Gmail API** → Enable.
3. APIs & Services → OAuth consent screen:
   - User Type: **External**
   - Название приложения — любое, например "Synva Support Bridge"
   - Добавь sonreaaivpn@gmail.com в Test users
   - **Важно:** пока статус приложения "Testing", выданный refresh-токен
     живёт всего 7 дней — придётся периодически переавторизовываться. Чтобы
     получить постоянный токен, на вкладке consent screen нажми **Publish
     App** (перевести в статус "In production"). Верификация от Google для
     этого не обязательна, если пользователей мало — при входе просто
     увидишь предупреждение "Google hasn't verified this app", жми
     Advanced → Go to Synva Support Bridge (unsafe). Это нормально: ты
     авторизуешь свой собственный воркер под своим же аккаунтом.
4. APIs & Services → Credentials → Create Credentials → **OAuth client ID**
   → Application type: **Desktop app** → создай, сохрани **Client ID** и
   **Client Secret**.
5. Получение refresh-токена через OAuth Playground:
   - Открой https://developers.google.com/oauthplayground
   - Шестерёнка (⚙️) справа сверху → включи **Use your own OAuth credentials**
     → вставь Client ID и Client Secret из шага 4.
   - В поле "Input your own scopes" вставь: `https://mail.google.com/`
     (нужен полный доступ, а не readonly — иначе воркер не сможет отмечать
     письма прочитанными и будет обрабатывать их повторно).
   - Authorize APIs → войди как sonreaaivpn@gmail.com → если увидишь "This
     app isn't verified" → Advanced → Go to Synva Support Bridge (unsafe) →
     Allow.
   - Step 2 → Exchange authorization code for tokens → скопируй **Refresh
     token**.

## 4. Секреты воркера

```bash
cd worker
npx wrangler secret put CLIENT_KEY
# вставь любую длинную случайную строку — тот же ключ пойдёт в Synva ниже

npx wrangler secret put RESEND_API_KEY
# ключ re_... из шага 2

npx wrangler secret put GMAIL_CLIENT_ID
npx wrangler secret put GMAIL_CLIENT_SECRET
npx wrangler secret put GMAIL_REFRESH_TOKEN
# три значения из шага 3
```

## 5. Подключить к Synva

В `index.html` найди блок `SUPPORT_CONFIG` и подставь свои значения:

```js
const SUPPORT_CONFIG = {
  WORKER_URL: 'https://synva-support.ТВОЙ-АККАУНТ.workers.dev', // из шага 1
  CLIENT_KEY: 'та-же-строка-что-и-в-CLIENT_KEY-выше',
  POLL_INTERVAL_MS: 15000,
  SUPPORT_EMAIL: 'sonreaaivpn@gmail.com'
};
```

## 6. Проверка

1. Зарегистрируй нового юзера в Synva → должен появиться чат SynvaSupport.
2. Напиши туда что-нибудь → в течение секунд письмо должно прийти на
   sonreaaivpn@gmail.com (тема вида `Synva • username [tid:xxxxx]`).
3. Ответь на это письмо прямо в Gmail (не меняя тему).
4. Подожди до минуты (cron воркера) → в чате SynvaSupport должен появиться
   твой ответ как входящее сообщение.

## Ограничения, о которых стоит знать

- **Не меняй тему письма при ответе** — по ней воркер понимает, к какому
  чату/юзеру относится ответ. Если тема потеряется, ответ не долетит.
- Из подписи письма (цитаты, история переписки) вырезается эвристикой —
  в редких случаях в чат может попасть лишний хвост текста.
- `X-Synva-Key` в `SUPPORT_CONFIG.CLIENT_KEY` виден любому, кто откроет
  исходный код страницы (это статический HTML-файл, иначе никак). Троттлинг
  на воркере (20 сообщений / 10 минут на threadId) — базовая защита от
  спама, не защита от целенаправленной атаки.
- Медиа-сообщения (фото/видео/голос/видео-кружки), отправленные в
  SynvaSupport, на почту не пересылаются — только текст.
- Cron Cloudflare не может быть чаще раза в минуту — быстрее ответ прийти
  не может даже теоретически.
