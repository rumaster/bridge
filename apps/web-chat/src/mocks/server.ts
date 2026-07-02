import { setupServer } from "msw/node";
import { webChatMockHandlers } from "./handlers";

export const server = setupServer(...webChatMockHandlers);
