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
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

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
  port?: number;
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
    else if (a === "--port") flags.port = Number(argv[++i]);
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

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/**
 * HTTP-агент провижининга (Этап M5). Крутится на хосте с доступом к почтовику и
 * принимает запросы от backend (`POST /api/v1/mail/mailboxes` → сюда):
 *   POST   /provision  { local_part | address, password?, quota? } → { address, password, email_credentials }
 *   DELETE /provision  { address }                                 → { address, deleted:true }
 *   GET    /health
 * Защита — общий токен `MAIL_PROVISION_TOKEN` (Bearer). Без токена агент ОТКРЫТ —
 * задавайте токен в проде.
 */
function serveAgent(flags: Flags): void {
  const port = flags.port ?? Number(env("MAIL_PROVISION_PORT", "3300"));
  const token = env("MAIL_PROVISION_TOKEN");
  // Fail-fast: агент управляет ящиками и слушает по сети (в compose порт
  // публикуется на хост для backend App-стороны). Открытый запуск без токена —
  // footgun, поэтому по умолчанию запрещаем. Осознанный открытый режим (только в
  // изолированной сети) — MAIL_PROVISION_ALLOW_OPEN=1. Guard рантаймовый (не в
  // compose через ${..:?}), иначе он ломал бы обычный RF-`up` без профиля mail.
  if (!token && env("MAIL_PROVISION_ALLOW_OPEN") !== "1") {
    throw new Error(
      "mail-provision serve: не задан MAIL_PROVISION_TOKEN. Агент управляет " +
        "ящиками и доступен по сети — задайте общий Bearer-токен. Для осознанного " +
        "открытого запуска в изолированной сети: MAIL_PROVISION_ALLOW_OPEN=1.",
    );
  }
  const server = createServer((req, res) => {
    void handleAgentRequest(req, res, token, flags);
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(
      `mail-provision agent на :${port} (domain=${env("MAIL_DOMAIN") ?? "?"}, auth=${token ? "token" : "OPEN"})`,
    );
  });
}

async function handleAgentRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string | undefined,
  flags: Flags,
): Promise<void> {
  const send = (code: number, obj: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  try {
    const url = (req.url ?? "/").split("?")[0];
    // /health — без авторизации (liveness-проба).
    if (req.method === "GET" && url === "/health") {
      send(200, { ok: true });
      return;
    }
    if (token) {
      const auth = req.headers["authorization"];
      const provided = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (provided !== token) {
        send(401, { error: "unauthorized" });
        return;
      }
    }
    const body = await readJsonBody(req);
    if (req.method === "POST" && url === "/provision") {
      const input = String(body.local_part ?? body.localpart ?? body.address ?? "").trim();
      if (!input) {
        send(400, { error: "local_part is required" });
        return;
      }
      const address = resolveAddress(input);
      const password =
        typeof body.password === "string" && body.password ? body.password : generatePassword();
      await setup(["email", "add", address, password]);
      if (body.quota) await setup(["quota", "set", address, String(body.quota)]);
      send(200, { address, password, email_credentials: buildEmailCredentials(address, password, flags) });
      return;
    }
    if (req.method === "DELETE" && url === "/provision") {
      const address = resolveAddress(String(body.address ?? body.local_part ?? "").trim());
      await setup(["email", "del", "-y", address]);
      send(200, { address, deleted: true });
      return;
    }
    send(404, { error: "not found" });
  } catch (error) {
    send(500, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function main(): Promise<void> {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "serve": {
      serveAgent(flags);
      await new Promise(() => {}); // держим процесс живым
      break;
    }
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
        "Команды: add | password | del | list | quota | serve\n" +
          "См. шапку scripts/mail-provision.ts и deploy/mail/README.md",
      );
      process.exit(2);
  }
}

main().catch((error) => {
  console.error("mail-provision:", error instanceof Error ? error.message : error);
  process.exit(1);
});
