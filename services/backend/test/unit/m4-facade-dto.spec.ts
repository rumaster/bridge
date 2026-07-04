import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";

import {
  CreateBroadcastRequestDto,
  StartBroadcastRequestDto,
} from "../../src/modules/broadcast-facade/broadcast-facade.dto";
import {
  ListNotificationsQueryDto,
  UpdateNotificationSettingsRequestDto,
} from "../../src/modules/notification-facade/notification-facade.dto";

describe("M4 facade DTO validators", () => {
  it("accepts a valid C8 create-broadcast payload", async () => {
    const dto = plainToInstance(CreateBroadcastRequestDto, {
      name: "Июльская рассылка",
      template: {
        type: "text",
        body: "Здравствуйте, {{client.name}}",
        variables: ["client.name"],
      },
      filter: {
        mode: "all",
        channels: ["web_chat"],
      },
      schedule: {
        mode: "manual",
      },
      rate_limit: {
        messages_per_minute: 120,
        strategy: "fixed",
      },
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it("rejects a scheduled C8 start without scheduled_for", async () => {
    const dto = plainToInstance(StartBroadcastRequestDto, {
      mode: "scheduled",
    });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toContain("scheduled_for");
  });

  it("accepts a valid C10 notification query", async () => {
    const dto = plainToInstance(ListNotificationsQueryDto, {
      status: "new",
      category: "critical",
      limit: "25",
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.limit).toBe(25);
  });

  it("rejects an empty C10 notification settings update", async () => {
    const dto = plainToInstance(UpdateNotificationSettingsRequestDto, {
      settings: [],
    });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toContain("settings");
  });
});
