import { Body, Controller, Get, HttpCode, Param, Post, Req, Res, Version } from "@nestjs/common";
import {
  ApiAcceptedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import type { Request, Response } from "express";

import {
  RegistrationStartDto,
  RegistrationStartResponseDto,
  RegistrationStatusResponseDto,
  RegistrationVerifyDto,
} from "./registration.dto";
import { RegistrationService } from "./registration.service";

const SESSION_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;

/**
 * Публичная самостоятельная регистрация администратора организации (SVC-ADMIN
 * /register). Все три маршрута неаутентифицированы по определению: организации и
 * пользователя ещё не существует.
 */
@ApiTags("auth")
@Controller("auth/register")
export class RegistrationController {
  constructor(private readonly registration: RegistrationService) {}

  @Post("start")
  @HttpCode(202)
  @Version("1")
  @ApiOperation({
    summary: "Start a self-service organization registration and return the bot deep link",
  })
  @ApiAcceptedResponse({ type: RegistrationStartResponseDto })
  startRegistration(
    @Body() body: RegistrationStartDto,
    @Req() request: Request,
  ): Promise<RegistrationStartResponseDto> {
    return this.registration.startRegistration(body, {
      ip: request.ip ?? null,
      userAgent: request.headers["user-agent"]?.toString() ?? null,
    });
  }

  @Get("status/:requestId")
  @Version("1")
  @ApiOperation({ summary: "Poll a registration request until the Telegram code is delivered" })
  @ApiParam({ example: "00000000-0000-4000-8000-000000000501", name: "requestId" })
  @ApiOkResponse({ type: RegistrationStatusResponseDto })
  getStatus(@Param("requestId") requestId: string): Promise<RegistrationStatusResponseDto> {
    return this.registration.getStatus(requestId);
  }

  @Post("verify")
  @HttpCode(200)
  @Version("1")
  @ApiOperation({
    summary: "Verify the registration code, create the organization and sign the administrator in",
  })
  @ApiOkResponse()
  async verifyRegistration(
    @Body() body: RegistrationVerifyDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    const result = await this.registration.verifyRegistration(body, {
      ip: request.ip ?? null,
      userAgent: request.headers["user-agent"]?.toString() ?? null,
    });

    if (typeof result.token === "string") {
      response.setHeader(
        "set-cookie",
        `bridge_session=${encodeURIComponent(
          result.token,
        )}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
      );
    }

    return result;
  }
}
