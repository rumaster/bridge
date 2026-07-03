import { ServiceUnavailableException, Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";
import type { PoolClient, QueryResult } from "pg";

export interface Queryable {
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

export interface TenantTransactionOptions {
  isPlatformOperator?: boolean;
}

@Injectable()
export class PgDatabase implements OnModuleDestroy {
  private pool?: Pool;

  async query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    return this.getPool().query<T>(text, values);
  }

  async withTenant<T>(
    organizationId: string,
    callback: (client: PoolClient) => Promise<T>,
    options: TenantTransactionOptions = {},
  ): Promise<T> {
    const client = await this.getPool().connect();

    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.current_organization_id', $1, true), set_config('app.is_platform_operator', $2, true)",
        [organizationId, String(options.isPlatformOperator ?? false)],
      );

      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }

  private getPool(): Pool {
    if (this.pool) {
      return this.pool;
    }

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new ServiceUnavailableException({
        code: "DATABASE_UNAVAILABLE",
        description: "DATABASE_URL is not configured",
        humanMessage: "База данных Backend API недоступна.",
      });
    }

    this.pool = new Pool({ connectionString });
    return this.pool;
  }
}
