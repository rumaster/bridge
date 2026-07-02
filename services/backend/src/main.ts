import { createBackendApp } from "./bootstrap";

async function bootstrap(): Promise<void> {
  const app = await createBackendApp();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
