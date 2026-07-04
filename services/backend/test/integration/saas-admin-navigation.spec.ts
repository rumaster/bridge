import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { configureBackendApp } from "../../src/bootstrap";
import { PgDatabase } from "../../src/common/database/database.service";

const ORG_ID = "30000000-0000-4000-8000-000000000101";
const ADMIN_ID = "30000000-0000-4000-8000-000000000201";
const ADMIN_TOKEN = "brs_saas_admin_navigation";

describe("SaaS Admin navigation API surface", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PgDatabase)
      .useValue(createNavigationDatabaseStub())
      .compile();

    app = moduleRef.createNestApplication();
    configureBackendApp(app, { installSwaggerUi: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("serves Knowledge Base documents through the menu endpoint", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/knowledge/documents")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual([
          expect.objectContaining({
            id: "30000000-0000-4000-8000-000000000701",
            organization_id: ORG_ID,
            title: "FAQ возвратов",
            status: "indexed",
          }),
        ]);
      });
  });

  it("serves Workflow list through the menu endpoint", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/workflows")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("x-organization-id", ORG_ID)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual([
          expect.objectContaining({
            id: "30000000-0000-4000-8000-000000000801",
            organization_id: ORG_ID,
            name: "Распределение обращений",
            status: "active",
            enabled: true,
          }),
        ]);
      });
  });
});

function createNavigationDatabaseStub(): Pick<PgDatabase, "withTenant"> {
  return {
    async withTenant(_organizationId, callback) {
      return callback({
        async query(text: string) {
          if (text.includes("FROM auth_sessions")) {
            return {
              rowCount: 1,
              rows: [
                {
                  display_name: "SaaS Admin",
                  expires_at: new Date("2099-01-01T00:00:00.000Z"),
                  id: "30000000-0000-4000-8000-000000000901",
                  issued_at: new Date("2026-07-04T10:00:00.000Z"),
                  organization_id: ORG_ID,
                  organization_name: "Tenant A",
                  organization_status: "active",
                  revoked_at: null,
                  role_bindings: [
                    { role: "administrator", organizationId: ORG_ID },
                    { role: "manager", organizationId: ORG_ID },
                  ],
                  roles: ["administrator", "manager"],
                  telegram_username: "admin_demo",
                  user_id: ADMIN_ID,
                  user_status: "active",
                },
              ],
            };
          }

          if (text.includes("FROM knowledge_documents")) {
            return {
              rowCount: 1,
              rows: [
                {
                  created_at: new Date("2026-07-04T10:01:00.000Z"),
                  id: "30000000-0000-4000-8000-000000000701",
                  indexed_at: new Date("2026-07-04T10:02:00.000Z"),
                  organization_id: ORG_ID,
                  source: "manual://returns",
                  status: "indexed",
                  title: "FAQ возвратов",
                  updated_at: new Date("2026-07-04T10:02:00.000Z"),
                },
              ],
            };
          }

          if (text.includes("FROM workflows")) {
            return {
              rowCount: 1,
              rows: [
                {
                  created_at: new Date("2026-07-04T10:03:00.000Z"),
                  default_version_id: "30000000-0000-4000-8000-000000000811",
                  id: "30000000-0000-4000-8000-000000000801",
                  name: "Распределение обращений",
                  organization_id: ORG_ID,
                  status: "active",
                  updated_at: new Date("2026-07-04T10:04:00.000Z"),
                },
              ],
            };
          }

          return { rowCount: 0, rows: [] };
        },
      } as never);
    },
  };
}
