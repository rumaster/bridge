import { Body, Controller, Headers, Post, UseGuards, Version } from "@nestjs/common";
import { ApiCreatedResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { Roles } from "../../common/auth/roles.decorator";
import { RolesGuard } from "../../common/auth/roles.guard";
import { SessionAuthGuard } from "../../common/auth/session-auth.guard";
import { ORGANIZATION_ID_HEADER, getRequiredOrganizationId } from "../../common/request-context";
import { OrderMailboxRequestDto, OrderMailboxResponseDto } from "./integration-gateway.dto";
import { IntegrationGatewayFacade } from "./integration-gateway.facade";

/**
 * «Bridge Mail» — заказ управляемого почтового ящика организацией (Этап M5,
 * docs/plan/mail-service-selfhosted.md). Administrator заказывает ящик из админки;
 * backend через провижининг-агента создаёт его на почтовике и сразу подключает как
 * email-канал (без ручного ввода кред).
 */
@ApiTags("mail")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("administrator")
@Controller("mail")
export class MailController {
  constructor(private readonly integrationGateway: IntegrationGatewayFacade) {}

  @Post("mailboxes")
  @Version("1")
  @ApiOperation({ summary: "Order a managed Bridge Mail mailbox and connect it as an email channel" })
  @ApiCreatedResponse({ type: OrderMailboxResponseDto })
  async orderMailbox(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Body() dto: OrderMailboxRequestDto,
  ): Promise<OrderMailboxResponseDto> {
    const result = await this.integrationGateway.provisionManagedMailbox({
      organization_id: getRequiredOrganizationId(organizationIdHeader),
      local_part: dto.local_part,
      name: dto.name,
    });
    return { address: result.address, channel: result.channel };
  }
}
