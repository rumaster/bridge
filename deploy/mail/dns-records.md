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

## DNS-записи (добавить у DNS-провайдера домена)

Предполагается, что почтовым хостом станет `mail.lissac-games.online`. **Замените
IP `85.120.252.39` на адрес фактического почтового хоста, если он другой** (сейчас
сам домен указывает на `13.60.43.104`).

```dns
; A-запись хоста почтовика
mail.lissac-games.online.            IN A     85.120.252.39

; MX — входящая почта домена идёт на хост почтовика
lissac-games.online.                 IN MX 10 mail.lissac-games.online.

; SPF — разрешаем отправку только с MX-хоста(ов); -all = жёсткий отказ прочим
lissac-games.online.                 IN TXT   "v=spf1 mx -all"

; DMARC — карантин недоверенного, отчёты на postmaster
_dmarc.lissac-games.online.          IN TXT   "v=DMARC1; p=quarantine; rua=mailto:postmaster@lissac-games.online"

; DKIM (selector mail, RSA-2048) — публичная часть сгенерированного ключа
mail._domainkey.lissac-games.online. IN TXT   "v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5B3HF6Es0YQbNbEZ2Mq2RUDNF+EvMOp0z0R4qV2JanDgGv3Ys4Fo6FtRjGjOXpSpf5Xbv9PMsuMGts/ujedsGjWPDzeuo5xZGLPrVyJIR/8EFyaJYNGs3LtCNS1cLAR0pgtovm5XyekXken7gvTsKmTTilVGddiGn98tU/VvgO43EcpPdNrjTaWqROfWNKfBgST3gWlNpmx11mWlvdgugJ6rX2qa3KXOm1BPIzCJ7XulbSBFavhHgblge44MYIlphW8uqbJQOtAXzkArfyZ0kPjLU2ww+r9dt6o3C1hua/AfJzKpJ1ovv45CiIiYF6Dl4D+dRsMuu2oS/16B7SePYQIDAQAB"
```

> **DKIM и длина TXT.** Значение длиннее 255 символов — многие DNS-панели сами
> нарежут его на чанки; если требуется вручную, разбейте `p=...` на строки по
> ≤255 символов в кавычках. Каноничный исходник — `mail.txt` рядом с ключом.

## PTR (reverse DNS) — заявка провайдеру IP

Провайдер `85.120.252.39` должен поставить:

```
85.120.252.39  →  mail.lissac-games.online
```

PTR обязан **прямо-подтверждаться** (FCrDNS): `mail.lissac-games.online` должен
резолвиться обратно в `85.120.252.39`. Без корректного PTR крупные провайдеры
(Gmail/Yandex) отклоняют или спамят почту.

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

1. **Исходящий транспорт** — одно из:
   - relay через транзакционный SMTP (587/465 с хорошей репутацией IP) —
     Postfix на хосте подписывает DKIM и релеит; обходит заблокированный 25;
   - разблокировка исходящего 25 провайдером (часто отказывают).
2. **Продовые тумблеры почтовика** (сейчас выключены, M1): `MAIL_ENABLE_RSPAMD=1`,
   `MAIL_ENABLE_OPENDKIM=1`, `MAIL_ENABLE_OPENDMARC=1`, `MAIL_ENABLE_FAIL2BAN=1`,
   `MAIL_SSL_TYPE=letsencrypt` (или свой сертификат) — в `.env.rf`.
3. **Публикация портов** `25/465/587/993` наружу и открытый входящий 25 для MX.
4. **TLS-сертификат** для `mail.lissac-games.online` (Let's Encrypt: нужен
   доступный 80/443 или DNS-01).
