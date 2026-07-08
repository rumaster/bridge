import { Injectable } from "@nestjs/common";

import { PgDatabase } from "../../common/database/database.service";
import type { Queryable } from "../../common/database/database.service";
import {
  WorkflowSubschemaResponseDto,
  WorkflowSubschemaRow,
  mapWorkflowSubschema,
} from "./workflow.dto";

@Injectable()
export class WorkflowSubschemaService {
  constructor(private readonly database: PgDatabase) {}

  async listSubschemas(organizationId: string): Promise<WorkflowSubschemaResponseDto[]> {
    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<WorkflowSubschemaRow>(
        `
          SELECT id, organization_id, slug, name, schema, status, created_at, updated_at
          FROM workflow_subschemas
          WHERE organization_id = $1
          ORDER BY name ASC, slug ASC
        `,
        [organizationId],
      );

      return result.rows.map(mapWorkflowSubschema);
    });
  }

  async findMissingActiveSlugs(
    client: Queryable,
    organizationId: string,
    slugs: string[],
  ): Promise<string[]> {
    if (slugs.length === 0) {
      return [];
    }

    const result = await client.query<{ slug: string }>(
      `
        SELECT slug
        FROM workflow_subschemas
        WHERE organization_id = $1
          AND status = 'active'
          AND slug = ANY($2::text[])
      `,
      [organizationId, slugs],
    );
    const found = new Set(result.rows.map((row) => row.slug));
    return slugs.filter((slug) => !found.has(slug));
  }
}
