import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
  Version,
} from "@nestjs/common";
import { ApiAcceptedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";

import type { AuthenticatedRequest, AuthSessionContext } from "../../common/auth/auth-context";
import { SessionAuthGuard } from "../../common/auth/session-auth.guard";
import {
  TelegramLoginStartDto,
  TelegramLoginStartResponseDto,
  TelegramLoginVerifyDto,
} from "./telegram-auth.dto";
import { TelegramAuthService } from "./telegram-auth.service";

const SESSION_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;

@ApiTags("auth")
@Controller("auth")
export class TelegramAuthController {
  constructor(private readonly telegramAuth: TelegramAuthService) {}

  @Get("session")
  @UseGuards(SessionAuthGuard)
  @Version("1")
  @ApiOperation({ summary: "Return the current authenticated session" })
  getSession(@Req() request: AuthenticatedRequest): AuthSessionContext {
    return this.telegramAuth.getSession(request.auth!);
  }

  @Post("login/telegram/start")
  @HttpCode(202)
  @Version("1")
  @ApiOperation({ summary: "Start a Telegram login and deliver a one-time code" })
  @ApiAcceptedResponse({ type: TelegramLoginStartResponseDto })
  startTelegramLogin(
    @Body() body: TelegramLoginStartDto,
    @Req() request: Request,
  ): Promise<TelegramLoginStartResponseDto> {
    return this.telegramAuth.startLogin(body, {
      ip: request.ip ?? null,
      userAgent: request.headers["user-agent"]?.toString() ?? null,
    });
  }

  @Post("login/telegram/verify")
  @HttpCode(200)
  @Version("1")
  @ApiOperation({ summary: "Verify a Telegram login code and create a session" })
  @ApiOkResponse()
  async verifyTelegramLogin(
    @Body() body: TelegramLoginVerifyDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    const result = await this.telegramAuth.verifyLogin(body, {
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
