/**
 * Согласованный тип «подключение к БД» для скриптов миграций и сидов.
 *
 * Приложения передают либо строку подключения (`DATABASE_URL`), либо
 * структурированную конфигурацию pg-клиента — оба варианта принимаются
 * `pg.Client`/`node-pg-migrate` в рантайме без преобразований.
 */

/** Структурированная конфигурация подключения к PostgreSQL (подмножество `pg.ClientConfig`). */
export interface DatabaseConnectionConfig {
  database?: string;
  user?: string;
  password?: string;
  host?: string;
  port?: number;
}

/** Единый тип подключения: строка URL либо структурированная конфигурация. */
export type DatabaseConnection = string | DatabaseConnectionConfig;
