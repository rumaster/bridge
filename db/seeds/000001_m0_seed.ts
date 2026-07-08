import {
  DEMO_ORGANIZATION_SEED,
  ROLE_SEEDS,
  SEEDED_ADMIN_ROLE_BINDING_SEED,
  SEEDED_ADMIN_USER_SEED,
} from "../../packages/testing/src/db/m0-seed-data.js";
import { SEEDED_WORKFLOW_DEFINITIONS } from "./workflow-definitions/stage2-workflows.js";
import { SEEDED_WORKFLOW_SUBSCHEMAS } from "./workflow-definitions/stage4-subschemas.js";

export async function seed(client) {
  await client.query("BEGIN");

  try {
    for (const role of ROLE_SEEDS) {
      await client.query(
        `
          INSERT INTO roles (id, code, scope, description, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)
          ON CONFLICT (code) DO UPDATE SET
            id = EXCLUDED.id,
            scope = EXCLUDED.scope,
            description = EXCLUDED.description,
            updated_at = EXCLUDED.updated_at
        `,
        [
          role.id,
          role.code,
          role.scope,
          role.description,
          role.created_at,
          role.updated_at,
        ],
      );
    }

    await client.query(
      `
        INSERT INTO organizations (
          id,
          name,
          description,
          timezone,
          locale,
          status,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          timezone = EXCLUDED.timezone,
          locale = EXCLUDED.locale,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at
      `,
      [
        DEMO_ORGANIZATION_SEED.id,
        DEMO_ORGANIZATION_SEED.name,
        DEMO_ORGANIZATION_SEED.description,
        DEMO_ORGANIZATION_SEED.timezone,
        DEMO_ORGANIZATION_SEED.locale,
        DEMO_ORGANIZATION_SEED.status,
        DEMO_ORGANIZATION_SEED.created_at,
        DEMO_ORGANIZATION_SEED.updated_at,
      ],
    );

    await client.query(
      `
        INSERT INTO users (
          id,
          organization_id,
          telegram_username,
          telegram_id,
          email,
          display_name,
          status,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)
        ON CONFLICT (id) DO UPDATE SET
          organization_id = EXCLUDED.organization_id,
          telegram_username = EXCLUDED.telegram_username,
          telegram_id = EXCLUDED.telegram_id,
          email = EXCLUDED.email,
          display_name = EXCLUDED.display_name,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at
      `,
      [
        SEEDED_ADMIN_USER_SEED.id,
        SEEDED_ADMIN_USER_SEED.organization_id,
        SEEDED_ADMIN_USER_SEED.telegram_username,
        SEEDED_ADMIN_USER_SEED.telegram_id,
        SEEDED_ADMIN_USER_SEED.email,
        SEEDED_ADMIN_USER_SEED.display_name,
        SEEDED_ADMIN_USER_SEED.status,
        SEEDED_ADMIN_USER_SEED.created_at,
        SEEDED_ADMIN_USER_SEED.updated_at,
      ],
    );

    await client.query(
      `
        INSERT INTO user_roles (user_id, role_id, organization_id, created_at)
        VALUES ($1, $2, $3, $4::timestamptz)
        ON CONFLICT (user_id, role_id, organization_id) DO UPDATE SET
          created_at = EXCLUDED.created_at
      `,
      [
        SEEDED_ADMIN_ROLE_BINDING_SEED.user_id,
        SEEDED_ADMIN_ROLE_BINDING_SEED.role_id,
        SEEDED_ADMIN_ROLE_BINDING_SEED.organization_id,
        SEEDED_ADMIN_ROLE_BINDING_SEED.created_at,
      ],
    );

    await seedWorkflowSubschemas(client);
    await seedWorkflowDefinitions(client);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seedWorkflowSubschemas(client) {
  for (const subschema of SEEDED_WORKFLOW_SUBSCHEMAS) {
    await client.query(
      `
        INSERT INTO workflow_subschemas (
          id,
          organization_id,
          slug,
          name,
          schema,
          status,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz, $8::timestamptz)
        ON CONFLICT (organization_id, slug) DO UPDATE SET
          name = EXCLUDED.name,
          schema = EXCLUDED.schema,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at
      `,
      [
        subschema.id,
        subschema.organization_id,
        subschema.slug,
        subschema.name,
        JSON.stringify(subschema.schema),
        subschema.status,
        subschema.created_at,
        subschema.updated_at,
      ],
    );
  }
}

async function seedWorkflowDefinitions(client) {
  for (const workflow of SEEDED_WORKFLOW_DEFINITIONS) {
    await client.query(
      `
        INSERT INTO workflows (
          id,
          organization_id,
          name,
          status,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at
        WHERE workflows.organization_id = EXCLUDED.organization_id
      `,
      [
        workflow.id,
        workflow.organization_id,
        workflow.name,
        workflow.status,
        workflow.created_at,
        workflow.updated_at,
      ],
    );

    for (const version of workflow.versions) {
      await client.query(
        `
          INSERT INTO workflow_versions (
            id,
            organization_id,
            workflow_id,
            version_no,
            schema,
            created_by,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz)
          ON CONFLICT DO NOTHING
        `,
        [
          version.id,
          workflow.organization_id,
          workflow.id,
          version.version_no,
          JSON.stringify(version.schema),
          version.created_by,
          version.created_at,
        ],
      );
    }

    await client.query(
      `
        UPDATE workflows
        SET default_version_id = $3,
            updated_at = $4::timestamptz
        WHERE id = $1 AND organization_id = $2
      `,
      [
        workflow.id,
        workflow.organization_id,
        workflow.default_version_id,
        workflow.updated_at,
      ],
    );
  }
}
