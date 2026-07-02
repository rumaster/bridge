import { createFbpEngineServer } from "./server.mjs";

const port = Number.parseInt(process.env.PORT ?? "3095", 10);
const host = process.env.HOST ?? "0.0.0.0";

const server = createFbpEngineServer();

server.listen(port, host, () => {
  console.log(`FBP Engine M0 mock listening on http://${host}:${port}`);
});
