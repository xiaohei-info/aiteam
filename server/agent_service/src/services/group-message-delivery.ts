import type { ImageContent } from "@earendil-works/pi-ai";
import type { AuthenticatedCaller } from "../http/auth.js";

export interface GroupMessageSource {
  type: "human" | "employee";
  id: string;
  displayName?: string;
}

export interface GroupMessageCommand {
  conversationId: string;
  source: GroupMessageSource;
  targetEmployeeIds: string[];
  text: string;
  images?: ImageContent[];
  logicalMessageId: string;
  idempotencyKey?: string;
  toolCallId?: string;
  caller?: AuthenticatedCaller;
}

export interface GroupMessageReply {
  employeeId: string;
  entryId?: string;
  text: string;
}

export interface GroupMessageDeliveryResult {
  deliveryId: string;
  replies: GroupMessageReply[];
}

/**
 * The one local delivery seam for human @mentions and Pi employee mentions.
 * SessionHost owns authorization/session lifecycle; this class only provides
 * deterministic fan-out and one result shape for both callers.
 */
export class GroupMessageDeliveryService {
  constructor(
    private readonly deliverTarget: (
      command: GroupMessageCommand,
      employeeId: string,
    ) => Promise<GroupMessageReply>,
  ) {}

  async deliver(command: GroupMessageCommand): Promise<GroupMessageDeliveryResult> {
    const targets = [...new Set(command.targetEmployeeIds)];
    if (targets.length === 0) throw new Error("At least one group message target is required");
    if (targets.includes(command.source.id)) throw new Error("An employee cannot mention itself");
    const replies = await Promise.all(targets.map((employeeId) => this.deliverTarget(command, employeeId)));
    return {
      deliveryId: command.idempotencyKey ?? command.logicalMessageId,
      replies,
    };
  }
}
