# DNS/PTR для домена почтовика (Этап M3)

Записи для публикации, чтобы `lissac-games.online` мог отправлять/принимать почту
через self-hosted почтовик (`docs/plan/mail-service-selfhosted.md`, Этап M3).

> **Статус: боевая доставка отложена.** На текущем стенде (`85.120.252.39`)
> исходящий порт **25 заблокирован** и **PTR = `bridge.`** (не FQDN) — прямая
> доставка в интернет невозможна без relay или разблокировки провайдером.
> Эти DNS-записи — предварительная подготовка (публикуются заранее, живая
> доставка включается позже: relay для исходящего + корректный PTR). DKIM-ключ
> уже сгенерирован (`deploy/mail/config/opendkim/keys/lissac-games.online/`,
> приватная часть не коммитится).

## Модель отправки: relay через транзакционный SMTP (основная)

Выбор сделан по итогам разведки стенда:

- **Исходящий порт 25 закрыт** (типично для облаков/хостингов) → прямая доставка
  «полным self-hosted MTA» по MX **невозможна** без разблокировки провайдером
  (которую часто не дают).
- Поэтому **основная модель отправки — relay**: наш Postfix принимает письмо от
  клиента (edge-gateway → 587 внутри docker-сети), **подписывает его DKIM
  локально** (OpenDKIM-milter, ключ домена) и **релеит наружу через транзакционный
  SMTP-провайдер** (587 STARTTLS / 465 implicit-TLS с хорошей репутацией IP).
  Порт 25 при этом не нужен для исходящего.
- Включается переменными `MAIL_RELAY_HOST/PORT/USER/PASSWORD` в `.env.rf`
  (пусто = relay выключен, прямая доставка по MX; см. `.env.rf.example` и
  план §5.M3). DKIM подписывается **до** передачи в relay, поэтому **DMARC
  проходит по DKIM-alignment независимо от IP и SPF relay-хоста** — это ключевой
  момент: репутацию и SPF обеспечивает relay-провайдер, а доменную аутентификацию
  (`d=lissac-games.online`) — наша DKIM-подпись.

> **Полный MTA (прямая доставка по MX) остаётся возможным**, если провайдер IP
> откроет исходящий 25 и поставит корректный PTR (см. ниже). Тогда
> `MAIL_RELAY_HOST` оставить пустым — конфиг тот же, DNS те же.

## DNS-записи (добавить у DNS-провайдера домена)

Предполагается, что почтовым хостом станет `mail.lissac-games.online`. **Замените
IP `85.120.252.39` на адрес фактического почтового хоста, если он другой** (сейчас
сам домен указывает на `13.60.43.104`).

```dns
; A-запись хоста почтовика
mail.lissac-games.online.            IN A     85.120.252.39

; MX — входящая почта домена идёт на хост почтовика
lissac-games.online.                 IN MX 10 mail.lissac-games.online.

; SPF — разрешаем отправку с MX-хоста(ов). При relay через транзакционный SMTP
; добавьте include провайдера (пример ниже) ИЛИ оставьте envelope-домен на
; провайдере (тогда SPF считает провайдер, DMARC проходит по DKIM — см. §SPF).
lissac-games.online.                 IN TXT   "v=spf1 mx -all"
; ── ВАРИАНТ ДЛЯ RELAY с нашим envelope-доменом (замените include на домен relay):
; lissac-games.online.               IN TXT   "v=spf1 mx include:_spf.<relay-провайдер> -all"

; DMARC — карантин недоверенного, отчёты на postmaster
_dmarc.lissac-games.online.          IN TXT   "v=DMARC1; p=quarantine; rua=mailto:postmaster@lissac-games.online"

; DKIM (selector mail, RSA-2048) — публичная часть сгенерированного ключа
mail._domainkey.lissac-games.online. IN TXT   "v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5B3HF6Es0YQbNbEZ2Mq2RUDNF+EvMOp0z0R4qV2JanDgGv3Ys4Fo6FtRjGjOXpSpf5Xbv9PMsuMGts/ujedsGjWPDzeuo5xZGLPrVyJIR/8EFyaJYNGs3LtCNS1cLAR0pgtovm5XyekXken7gvTsKmTTilVGddiGn98tU/VvgO43EcpPdNrjTaWqROfWNKfBgST3gWlNpmx11mWlvdgugJ6rX2qa3KXOm1BPIzCJ7XulbSBFavhHgblge44MYIlphW8uqbJQOtAXzkArfyZ0kPjLU2ww+r9dt6o3C1hua/AfJzKpJ1ovv45CiIiYF6Dl4D+dRsMuu2oS/16B7SePYQIDAQAB"
```

> **DKIM и длина TXT.** Значение длиннее 255 символов — многие DNS-панели сами
> нарежут его на чанки; если требуется вручную, разбейте `p=...` на строки по
> ≤255 символов в кавычках. Каноничный исходник — `mail.txt` рядом с ключом.

## SPF/DKIM/DMARC alignment при relay

DMARC проходит (`dmarc=pass`), если хотя бы одно из двух **выровнено** (aligned)
с доменом из заголовка `From:` (`lissac-games.online`):

- **DKIM alignment** — подпись `d=lissac-games.online` совпадает с `From:`.
  Наш OpenDKIM подписывает письмо **локально, до передачи в relay**, поэтому это
  выполняется **всегда, независимо от relay-провайдера и его IP**. Это основной
  путь прохождения DMARC при relay.
- **SPF alignment** — IP отправителя разрешён SPF-записью домена `From:` **и**
  envelope-домен (`MAIL FROM`) совпадает с `From:`.

Два рабочих варианта при relay:

1. **Envelope на домене провайдера (проще).** Relay отправляет с `MAIL FROM`
   своего домена → SPF считается по провайдеру (обычно `pass`, но **не aligned**
   с нашим `From:`). DMARC всё равно `pass` — за счёт DKIM alignment. SPF-запись
   домена можно оставить `v=spf1 mx -all`.
2. **Envelope на нашем домене (нужен SPF include).** Если relay шлёт с нашим
   `MAIL FROM`, обязательно добавить в SPF `include:` провайдера (иначе `-all`
   даст SPF `fail`). Тогда выровнены и SPF, и DKIM.

> Итог: при relay достаточно корректной **DKIM-подписи** для `dmarc=pass`. SPF
> `include` — только если хотите SPF alignment и шлёте с нашего envelope-домена.

## PTR (reverse DNS) — заявка провайдеру IP

Провайдер `85.120.252.39` должен поставить:

```
85.120.252.39  →  mail.lissac-games.online
```

PTR обязан **прямо-подтверждаться** (FCrDNS): `mail.lissac-games.online` должен
резолвиться обратно в `85.120.252.39`. Без корректного PTR крупные провайдеры
(Gmail/Yandex) отклоняют или спамят почту.

> **PTR при relay.** Для **исходящей** почты через relay PTR нашего хоста **не на
> пути доставки** — получатель видит IP relay-провайдера (у него свой корректный
> PTR). PTR нашего хоста нужен для **входящего MX** (приём почты) и для прямой
> доставки по MX (если 25 откроют). То есть при relay-модели некорректный PTR
> `bridge.` блокирует только приём/прямую отправку, но не relay-отправку.

## Проверка после публикации

```bash
dig +short lissac-games.online MX
dig +short lissac-games.online TXT              # SPF
dig +short mail._domainkey.lissac-games.online TXT   # DKIM
dig +short _dmarc.lissac-games.online TXT       # DMARC
dig +short -x 85.120.252.39                     # PTR → mail.lissac-games.online
```

Затем (когда решён исходящий транспорт — relay или разблокировка 25) —
контрольная отправка на <https://www.mail-tester.com> и проверка в Gmail
(SPF `pass`, DKIM `pass`, DMARC `pass`, письмо во «Входящих», не в спаме).

## Что ещё нужно для включения боевой доставки (когда будет инфраструктура)

Подготовлено в коде/конфиге (готово к включению переменными):
- relay-транспорт Postfix (`MAIL_RELAY_*` в `.env.rf`/compose);
- продовые тумблеры (RSPAMD/OPENDKIM/OPENDMARC/FAIL2BAN/SSL_TYPE) — через env;
- DKIM-ключ и все DNS-записи (этот файл).

Оставшиеся **внешние** действия (вне кода, у владельца инфраструктуры):

1. **Исходящий транспорт** — одно из (relay — основная модель):
   - **relay-креды у транзакционного SMTP-провайдера** (587/465 с хорошей
     репутацией IP): завести аккаунт, получить host/порт/логин/пароль, вписать в
     `MAIL_RELAY_HOST/PORT/USER/PASSWORD`. Postfix подпишет DKIM локально и
     срелеит — обходит заблокированный 25;
   - ЛИБО разблокировка исходящего 25 провайдером IP (часто отказывают) — тогда
     `MAIL_RELAY_HOST` пуст, прямая доставка по MX.
2. **Продовые тумблеры почтовика** (сейчас выключены, M1): `MAIL_ENABLE_RSPAMD=1`,
   `MAIL_ENABLE_OPENDKIM=1`, `MAIL_ENABLE_OPENDMARC=1`, `MAIL_ENABLE_FAIL2BAN=1`,
   `MAIL_SSL_TYPE=letsencrypt` (или свой сертификат) — в `.env.rf`.
3. **Публикация DNS-записей** (MX/A/SPF/DKIM/DMARC выше) у DNS-провайдера домена
   `lissac-games.online` — доступ к зоне у владельца домена. При relay с нашим
   envelope-доменом — добавить `include:` relay-провайдера в SPF.
4. **PTR** `85.120.252.39 → mail.lissac-games.online` у провайдера IP (нужен для
   входящего MX; для relay-отправки — не на пути, см. выше).
5. **TLS-сертификат** для `mail.lissac-games.online` (Let's Encrypt: нужен
   доступный 80/443 либо DNS-01), если `SSL_TYPE=letsencrypt`.
6. **Публикация портов** входящего MX `25` (и `465/587/993` для клиентов), если
   почтовик должен ещё и **принимать** внешнюю почту; для чистого relay-исхода
   публикация не требуется.
