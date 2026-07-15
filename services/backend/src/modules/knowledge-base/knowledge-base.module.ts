import { Module } from "@nestjs/common";

import { InternalKnowledgeSearchController } from "./internal-knowledge.controller";
import { KnowledgeBaseController } from "./knowledge-base.controller";
import { KnowledgeBaseService } from "./knowledge-base.service";
import { KnowledgeEmbeddingService } from "./knowledge-embedding.service";
import { KnowledgeSearchController } from "./knowledge-search.controller";

@Module({
  controllers: [
    KnowledgeBaseController,
    KnowledgeSearchController,
    InternalKnowledgeSearchController,
  ],
  providers: [KnowledgeBaseService, KnowledgeEmbeddingService],
})
export class KnowledgeBaseModule {}
