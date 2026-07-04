import {
  assertMessageStatusTransition,
  canTransitionMessageStatus,
  InvalidMessageStatusTransitionError,
  MESSAGE_STATUS,
  MESSAGE_STATUS_TRANSITIONS,
  toMessageStatus,
} from "../../src/modules/communication-core/message-status";

describe("message status state machine (C1)", () => {
  it("allows the happy-path inbound-to-delivered chain", () => {
    expect(canTransitionMessageStatus(MESSAGE_STATUS.RECEIVED, MESSAGE_STATUS.ROUTED)).toBe(true);
    expect(canTransitionMessageStatus(MESSAGE_STATUS.ROUTED, MESSAGE_STATUS.SENT)).toBe(true);
    expect(canTransitionMessageStatus(MESSAGE_STATUS.SENT, MESSAGE_STATUS.DELIVERED)).toBe(true);
  });

  it("allows failing from every non-terminal status", () => {
    expect(canTransitionMessageStatus(MESSAGE_STATUS.RECEIVED, MESSAGE_STATUS.FAILED)).toBe(true);
    expect(canTransitionMessageStatus(MESSAGE_STATUS.ROUTED, MESSAGE_STATUS.FAILED)).toBe(true);
    expect(canTransitionMessageStatus(MESSAGE_STATUS.SENT, MESSAGE_STATUS.FAILED)).toBe(true);
  });

  it("treats delivered and failed as terminal", () => {
    expect(MESSAGE_STATUS_TRANSITIONS[MESSAGE_STATUS.DELIVERED]).toEqual([]);
    expect(MESSAGE_STATUS_TRANSITIONS[MESSAGE_STATUS.FAILED]).toEqual([]);
    expect(canTransitionMessageStatus(MESSAGE_STATUS.DELIVERED, MESSAGE_STATUS.SENT)).toBe(false);
    expect(canTransitionMessageStatus(MESSAGE_STATUS.FAILED, MESSAGE_STATUS.ROUTED)).toBe(false);
  });

  it("rejects illegal skips such as received-to-sent", () => {
    expect(canTransitionMessageStatus(MESSAGE_STATUS.RECEIVED, MESSAGE_STATUS.SENT)).toBe(false);
    expect(canTransitionMessageStatus(MESSAGE_STATUS.RECEIVED, MESSAGE_STATUS.DELIVERED)).toBe(false);
    expect(canTransitionMessageStatus(MESSAGE_STATUS.ROUTED, MESSAGE_STATUS.DELIVERED)).toBe(false);
  });

  it("assertMessageStatusTransition throws a typed error for illegal edges", () => {
    expect(() =>
      assertMessageStatusTransition(MESSAGE_STATUS.RECEIVED, MESSAGE_STATUS.SENT),
    ).toThrow(InvalidMessageStatusTransitionError);

    try {
      assertMessageStatusTransition(MESSAGE_STATUS.DELIVERED, MESSAGE_STATUS.FAILED);
      throw new Error("expected assertion to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidMessageStatusTransitionError);
      const typed = error as InvalidMessageStatusTransitionError;
      expect(typed.fromStatus).toBe(MESSAGE_STATUS.DELIVERED);
      expect(typed.toStatus).toBe(MESSAGE_STATUS.FAILED);
    }
  });

  it("assertMessageStatusTransition is a no-op for legal edges", () => {
    expect(() =>
      assertMessageStatusTransition(MESSAGE_STATUS.ROUTED, MESSAGE_STATUS.SENT),
    ).not.toThrow();
  });

  it("toMessageStatus validates the enum membership", () => {
    expect(toMessageStatus("routed")).toBe(MESSAGE_STATUS.ROUTED);
    expect(() => toMessageStatus("unknown")).toThrow(/Unsupported message status/);
  });
});
