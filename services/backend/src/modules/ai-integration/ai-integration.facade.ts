import { Injectable } from "@nestjs/common";
import { ApiProperty } from "@nestjs/swagger";

export type FacadeMode = "mock";
export type FacadeStatusValue = "degraded";

export class FacadeStatusDto {
  @ApiProperty({ example: "ai" })
  name!: string;

  @ApiProperty({ example: "SVC-AI" })
  serviceId!: string;

  @ApiProperty({ enum: ["mock"], example: "mock" })
  mode!: FacadeMode;

  @ApiProperty({ enum: ["degraded"], example: "degraded" })
  status!: FacadeStatusValue;
}

@Injectable()
export class AiIntegrationFacade {
  getStatus(): FacadeStatusDto {
    return {
      mode: "mock",
      name: "ai",
      serviceId: "SVC-AI",
      status: "degraded",
    };
  }
}
