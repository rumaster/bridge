/**
 * mail-provision — провижининг почтовых ящиков self-hosted почтовика
 * (docker-mailserver) как смежной услуги (Этап M2 плана
 * `docs/plan/mail-service-selfhosted.md`).
 *
 * Обёртка над CLI `setup` внутри контейнера почтовика: заводит/удаляет/ротирует
 * ящики и (опционально) сразу подключает их как email-канал организации через
 * `POST /api/v1/channels` (Этап E0/E1). Пароли генерируются, наружу отдаются один раз
 * (в бэкенде хранятся write-only, envelope-шифрование).
 *
 * Запуск на хосте, где живёт контейнер почтовика (стенд/локально):
 *   node --import tsx scripts/mail-provision.ts <command> [args] [flags]
 *
 * Команды:
 *   add <address|localpart> [password]   создать ящик (пароль сгенерируется, если не задан)
 *   password <address> [password]        ротировать пароль ящика
 *   del <address>                        удалить ящик
 *   list                                 список ящиков
 *   quota <address> <size>               задать квоту (напр. 512M, 2G)
 *
 * Соглашение об адресах: аргумент без «@» дополняется до `<localpart>@$MAIL_DOMAIN`.
 * Ящик-на-организацию: удобно `--org <uuid>` + локальная часть вида `support`,
 * либо явный адрес. `--org` также нужен для авто-подключения канала.
 *
 * Авто-подключение канала (опционально, к `add`/`password`):
 *   --connect --org <uuid> --backend <url> --token <session> [--name <n>]
 *   Требуется сессия администратора (заголовок authorization) — как и ручное
 *   добавление канала на `:8081/channels`.
 *
 * Переменные окружения (значения по умолчанию — под стенд):
 *   MAIL_DOMAIN            домен ящиков (обязателен, если адрес без «@»)
 *   MAIL_HOST             хост IMAP/SMTP, который пропишется в креды канала (default "mailserver")
 *   MAIL_IMAP_PORT        default 143     MAIL_IMAP_TLS  default "false" (STARTTLS)
 *   MAIL_SMTP_PORT        default 587     MAIL_SMTP_TLS  default "false" (STARTTLS)
 *   MAILSERVER_CONTAINER  контейнер почтовика (default "bridge-edge-rf-mailserver-1")
 *   MAIL_FROM_NAME        необязательное display-name для From
 *   BACKEND_URL/ORG_ID/SESSION_TOKEN  дефолты для флагов --backend/--org/--token
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";

interface Flags {
  password?: string;
  org?: string;
  backend?: string;
  token?: string;
  name?: string;
  quota?: string;
  json?: boolean;
  connect?: boolean;
  imapPort?: number;
  smtpPort?: number;
  imapTls?: boolean;
  smtpTls?: boolean;
  fromName?: string;
}

function parseArgs(argv: string[]): { command: string; positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--connect") flags.connect = true;
    else if (a === "--password") flags.password = argv[++i];
    else if (a === "--org") flags.org = argv[++i];
    else if (a === "--backend") flags.backend = argv[++i];
    else if (a === "--token") flags.token = argv[++i];
    else if (a === "--name") flags.name = argv[++i];
    else if (a === "--quota") flags.quota = argv[++i];
    else if (a === "--imap-port") flags.imapPort = Number(argv[++i]);
    else if (a === "--smtp-port") flags.smtpPort = Number(argv[++i]);
    else if (a === "--imap-tls") flags.imapTls = argv[++i] !== "false";
    else if (a === "--smtp-tls") flags.smtpTls = argv[++i] !== "false";
    else if (a === "--from-name") flags.fromName = argv[++i];
    else positionals.push(a);
  }
  const [command, ...rest] = positionals;
  return { command: command ?? "", positionals: rest, flags };
}

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

/** Строгий, но shell-безопасный пароль (передаётся argv, не через shell). */
function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

function resolveAddress(input: string): string {
  if (input.includes("@")) return input;
  const domain = env("MAIL_DOMAIN");
  if (!domain) {
    throw new Error(`address "${input}" has no @ and MAIL_DOMAIN is not set`);
  }
  return `${input}@${domain}`;
}

function mailserverContainer(): string {
  return env("MAILSERVER_CONTAINER", "bridge-edge-rf-mailserver-1")!;
}

/** Выполняет `setup ...` внутри контейнера почтовика; возвращает stdout. */
function setup(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      ["exec", mailserverContainer(), "setup", ...args],
      { maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stderr}`));
          return;
        }
        resolve(stdout + (stderr ?? ""));
      },
    );
  });
}

function buildEmailCredentials(address: string, password: string, flags: Flags) {
  const host = env("MAIL_HOST", "mailserver")!;
  const imapPort = flags.imapPort ?? Number(env("MAIL_IMAP_PORT", "143"));
  const smtpPort = flags.smtpPort ?? Number(env("MAIL_SMTP_PORT", "587"));
  const imapTls = flags.imapTls ?? env("MAIL_IMAP_TLS", "false") === "true";
  const smtpTls = flags.smtpTls ?? env("MAIL_SMTP_TLS", "false") === "true";
  const fromName = flags.fromName ?? env("MAIL_FROM_NAME");
  return {
    imap: { host, port: imapPort, tls: imapTls, username: address, password },
    smtp: { host, port: smtpPort, tls: smtpTls, username: address, password },
    from_email: address,
    ...(fromName ? { from_name: fromName } : {}),
  };
}

async function connectChannel(address: string, credentials: ReturnType<typeof buildEmailCredentials>, flags: Flags) {
  const backend = flags.backend ?? env("BACKEND_URL");
  const org = flags.org ?? env("ORG_ID");
  const token = flags.token ?? env("SESSION_TOKEN");
  if (!backend || !org || !token) {
    throw new Error("--connect requires --backend, --org and --token (session of an administrator)");
  }
  const body = {
    organization_id: org,
    channel_type: "email",
    name: flags.name ?? `mail:${address}`,
    email_credentials: credentials,
  };
  const response = await fetch(`${backend.replace(/\/$/, "")}/api/v1/channels`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-organization-id": org,
      authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`channel connect failed HTTP ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function printCredentials(address: string, password: string, flags: Flags, connected?: unknown) {
  const credentials = buildEmailCredentials(address, password, flags);
  if (flags.json) {
    console.log(JSON.stringify({ address, password, email_credentials: credentials, connected }, null, 2));
    return;
  }
  console.log(`\nЯщик: ${address}`);
  console.log(`Пароль: ${password}   (сохраните — повторно не показывается)`);
  console.log(`IMAP: ${credentials.imap.host}:${credentials.imap.port} tls=${credentials.imap.tls}`);
  console.log(`SMTP: ${credentials.smtp.host}:${credentials.smtp.port} tls=${credentials.smtp.tls}`);
  console.log(`From: ${credentials.from_email}`);
  if (connected) console.log(`Канал подключён: ${JSON.stringify(connected)}`);
  else if (!flags.connect) console.log(`(канал не подключён — используйте --connect или введите креды на :8081/channels)`);
}

async function main(): Promise<void> {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "add": {
      if (!positionals[0]) throw new Error("usage: add <address|localpart> [password]");
      const address = resolveAddress(positionals[0]);
      const password = positionals[1] ?? flags.password ?? generatePassword();
      await setup(["email", "add", address, password]);
      if (flags.quota) await setup(["quota", "set", address, flags.quota]);
      let connected: unknown;
      if (flags.connect) connected = await connectChannel(address, buildEmailCredentials(address, password, flags), flags);
      printCredentials(address, password, flags, connected);
      break;
    }
    case "password":
    case "rotate": {
      if (!positionals[0]) throw new Error("usage: password <address> [password]");
      const address = resolveAddress(positionals[0]);
      const password = positionals[1] ?? flags.password ?? generatePassword();
      await setup(["email", "update", address, password]);
      let connected: unknown;
      if (flags.connect) connected = await connectChannel(address, buildEmailCredentials(address, password, flags), flags);
      printCredentials(address, password, flags, connected);
      break;
    }
    case "del":
    case "delete": {
      if (!positionals[0]) throw new Error("usage: del <address>");
      const address = resolveAddress(positionals[0]);
      const out = await setup(["email", "del", "-y", address]);
      console.log(out.trim() || `удалён: ${address}`);
      break;
    }
    case "list": {
      const out = await setup(["email", "list"]);
      console.log(out.trim());
      break;
    }
    case "quota": {
      if (!positionals[0] || !positionals[1]) throw new Error("usage: quota <address> <size>");
      const address = resolveAddress(positionals[0]);
      const out = await setup(["quota", "set", address, positionals[1]]);
      console.log(out.trim() || `квота ${positionals[1]} для ${address}`);
      break;
    }
    default:
      console.error(
        "Команды: add | password | del | list | quota\n" +
          "См. шапку scripts/mail-provision.ts и deploy/mail/README.md",
      );
      process.exit(2);
  }
}

main().catch((error) => {
  console.error("mail-provision:", error instanceof Error ? error.message : error);
  process.exit(1);
});
