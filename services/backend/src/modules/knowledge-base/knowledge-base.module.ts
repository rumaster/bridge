import { Module } from "@nestjs/common";

import { KnowledgeBaseController } from "./knowledge-base.controller";
import { KnowledgeBaseService } from "./knowledge-base.service";
import { KnowledgeEmbeddingService } from "./knowledge-embedding.service";

@Module({
  controllers: [KnowledgeBaseController],
  providers: [KnowledgeBaseService, KnowledgeEmbeddingService],
})
export class KnowledgeBaseModule {}
