import { Module } from "@nestjs/common";

import { CommunicationCoreProxyModule } from "../communication-core/communication-core-proxy.module";
import { WebChatController } from "./web-chat.controller";
import { WebChatService } from "./web-chat.service";

@Module({
  controllers: [WebChatController],
  imports: [CommunicationCoreProxyModule],
  providers: [WebChatService],
})
export class WebChatModule {}
