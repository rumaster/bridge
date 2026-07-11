import { Injectable } from "@nestjs/common";

import { PgDatabase } from "../database/database.service";
import {
  type ChannelSecretDatabase,
  type ChannelSecretEnvelope,
  ChannelSecretCipher,
  ChannelSecretStore,
} from "./channel-secret.store";

/**
 * DI-обёртка над {@link ChannelSecretStore} (DR-03, дорожная карта
 * mock-to-production, Этап T0 плана
 * `docs/plan/telegram-channel-production.md`).
 *
 * Назначение — включить envelope-хранилище секретов каналов в рантайм backend,
 * чтобы этапы T1 (сохранение токена при подключении канала) и T2 (резолв токена
 * на исходящей доставке) могли его инжектить. Сам код шифрования и SQL остаётся в
 * {@link ChannelSecretStore}; здесь только wiring, ленивая инициализация и
 * фиксация формата `credentials_ref`.
 *
 * Ленивость по образцу {@link RedisInfrastructureService}: ключ
 * `CHANNEL_SECRET_ENCRYPTION_KEY` читается только при первом обращении, а не в
 * конструкторе, чтобы отсутствие ключа в dev/CI не роняло bootstrap AppModule
 * (интеграционные spec поднимают весь AppModule без этого ключа).
 *
 * Доступ к таблице `channels` защищён RLS (`channels_tenant_isolation`, FORCE,
 * см. `db/migrations/20260703124000000_m2_schema.sql`). Чтение и запись секрета —
 * доверенная внутренняя операция ядра: запросы уже сужены параметрами
 * `organization_id`/`credentials_ref`, поэтому они выполняются в контексте
 * platform operator, чтобы RLS канала не блокировал резолв секрета на стороне
 * backend (аналогично системным операциям).
 */
@Injectable()
export class ChannelSecretService {
  private store?: ChannelSecretStore;
  private cipher?: ChannelSecretCipher;

  constructor(private readonly database: PgDatabase) {}

  /** Настроен ли envelope-ключ шифрования секретов каналов. */
  isConfigured(): boolean {
    return Boolean(process.env.CHANNEL_SECRET_ENCRYPTION_KEY?.trim());
  }

  /**
   * Зашифровать plaintext-секрет в AES-256-GCM envelope без записи в БД.
   * Используется, когда строка `channels` вставляется вместе с
   * `credentials_envelope` в одном запросе (атомарно, без отдельного UPDATE).
   */
  encrypt(plaintext: string): ChannelSecretEnvelope {
    return this.getCipher().encrypt(plaintext);
  }

  /**
   * Каноническая ссылка на секрет канала:
   * `secret://<channel_type>/<organization_id>/<label>` (для Telegram —
   * `secret://telegram/<organization_id>/main`). В таблице `channels` хранится
   * только эта ссылка (`credentials_ref`), сам токен — в `credentials_envelope`.
   */
  buildCredentialsRef({
    channelType,
    organizationId,
    label = "main",
  }: {
    channelType: string;
    organizationId: string;
    label?: string;
  }): string {
    return `secret://${channelType}/${organizationId}/${normalizeLabel(label)}`;
  }

  /** Зашифровать и сохранить plaintext-секрет канала в `channels.credentials_envelope`. */
  putChannelSecret(input: {
    channelId: string;
    organizationId: string;
    plaintext: string;
  }): Promise<ChannelSecretEnvelope> {
    return this.getStore().putChannelSecret(input);
  }

  /** Разрешить `credentials_ref` в расшифрованный секрет канала (или null). */
  resolveChannelSecret(input: {
    credentialsRef: string;
    organizationId?: string;
  }): Promise<string | null> {
    return this.getStore().resolveChannelSecret(input);
  }

  private getStore(): ChannelSecretStore {
    if (!this.store) {
      this.store = new ChannelSecretStore(this.createOperatorScopedDatabase(), this.getCipher());
    }

    return this.store;
  }

  private getCipher(): ChannelSecretCipher {
    if (!this.cipher) {
      this.cipher = ChannelSecretCipher.fromEnv();
    }

    return this.cipher;
  }

  private createOperatorScopedDatabase(): ChannelSecretDatabase {
    const database = this.database;

    return {
      async query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
        // Доверенный внутренний доступ к секретам каналов: выполняем как platform
        // operator, чтобы RLS `channels` не блокировал запрос; сужение по
        // organization_id/credentials_ref уже задано параметрами запроса.
        const result = await database.withTenant(
          "",
          (client) => client.query<T>(text, values),
          { isPlatformOperator: true },
        );

        return { rowCount: result.rowCount, rows: result.rows };
      },
    };
  }
}

function normalizeLabel(label: string): string {
  const trimmed = label.trim();
  return trimmed === "" ? "main" : trimmed;
}
