declare module "pg" {
  export interface QueryResult<T = Record<string, unknown>> {
    rowCount: number | null;
    rows: T[];
  }

  export interface Queryable {
    query<T = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<T>>;
  }

  export interface PoolClient extends Queryable {
    release(): void;
  }

  export interface PoolConfig {
    connectionString?: string;
  }

  export class Pool implements Queryable {
    constructor(config?: PoolConfig);
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    query<T = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<T>>;
  }
}
