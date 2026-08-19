import type { MessageClosedError } from "../renderer/message-authority/view-model.js";
import {
  cloneMessageAcceptedResult,
  cloneMessageAuthorityBridgeInput,
  cloneMessageAuthorityHistoryResult,
  cloneMessageRecallAcceptedResult,
  cloneMessageRevisionAcceptedResult,
  cloneMessageRevisionsQueryResult,
  isMessageHistoryV2Query,
  isMessageRecallIntent,
  isMessageReviseIntent,
  isMessageRevisionsQuery,
  isMessageSendV2Intent,
  type MessageAcceptedResult,
  type MessageAuthorityBridgeInput,
  type MessageAuthorityCommandReceipt,
  type MessageAuthorityErrorInput,
  type MessageAuthorityHistoryResult,
  type MessageAuthorityPortInput,
  type MessageHistoryV2Command,
  type MessageHistoryV2Query,
  type MessageRecallAcceptedResult,
  type MessageRecallCommand,
  type MessageRecallIntent,
  type MessageRevisionAcceptedResult,
  type MessageRevisionsCommand,
  type MessageRevisionsQuery,
  type MessageRevisionsQueryResult,
  type MessageReviseCommand,
  type MessageReviseIntent,
  type MessageSendV2Command,
  type MessageSendV2Intent,
} from "./contracts.js";

export class MessageAuthorityClientFailure extends Error {
  readonly error: MessageClosedError;

  constructor(error: MessageClosedError) {
    super(`${error.status} ${error.code}`);
    this.name = "MessageAuthorityClientFailure";
    this.error = structuredClone(error);
  }
}

export interface MessageAuthorityClientPort {
  historyV2(command: MessageHistoryV2Command): Promise<MessageAuthorityHistoryResult>;
  revisionsQuery(command: MessageRevisionsCommand): Promise<MessageRevisionsQueryResult>;
  sendV2(command: MessageSendV2Command): Promise<MessageAcceptedResult>;
  revise(command: MessageReviseCommand): Promise<MessageRevisionAcceptedResult>;
  recall(command: MessageRecallCommand): Promise<MessageRecallAcceptedResult>;
  subscribe(listener: (input: MessageAuthorityPortInput) => void): () => void;
}

export type MessageAuthorityRequestOperation =
  | "history"
  | "revisionsQuery"
  | "sendV2"
  | "revise"
  | "recall";

export interface MessageAuthorityController {
  historyV2(query: MessageHistoryV2Query): Promise<MessageAuthorityHistoryResult>;
  revisionsQuery(query: MessageRevisionsQuery): Promise<MessageRevisionsQueryResult>;
  sendV2(intent: MessageSendV2Intent): MessageAuthorityCommandReceipt;
  revise(intent: MessageReviseIntent): MessageAuthorityCommandReceipt;
  recall(intent: MessageRecallIntent): MessageAuthorityCommandReceipt;
  subscribe(listener: (input: MessageAuthorityBridgeInput) => void): () => void;
  close(): void;
}

function closedFailure(error: unknown): MessageClosedError {
  return error instanceof MessageAuthorityClientFailure
    ? error.error
    : { status: 503, code: "service_unavailable" };
}

function lockedHistory(
  requestId: string,
  roomId: string,
  error: MessageClosedError,
): MessageAuthorityHistoryResult {
  if (error.status === 401 || error.status === 403) {
    return {
      type: "room.history.v2",
      requestId,
      roomId,
      status: "locked",
      connection: {
        status: "revoked",
        scope: error.status === 401 ? "session" : "room",
        purgeCompleted: true,
      },
    };
  }
  return {
    type: "room.history.v2",
    requestId,
    roomId,
    status: "locked",
    connection: { status: "fatal", errorCode: error.code },
  };
}

function commandError(requestId: string, error: unknown): MessageAuthorityErrorInput {
  return {
    type: "message.error",
    requestId,
    ...closedFailure(error),
  };
}

function validRequestId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && value === value.trim();
}

export function createMessageAuthorityController(options: {
  readonly client: MessageAuthorityClientPort;
  readonly createRequestId: (operation: MessageAuthorityRequestOperation) => string;
}): MessageAuthorityController {
  const listeners = new Set<(input: MessageAuthorityBridgeInput) => void>();
  let closed = false;

  const requestId = (operation: MessageAuthorityRequestOperation): string => {
    const value = options.createRequestId(operation);
    if (!validRequestId(value)) throw new TypeError("Message Authority requestId is invalid");
    return value;
  };
  const publish = (input: MessageAuthorityBridgeInput): void => {
    if (closed) return;
    const safe = cloneMessageAuthorityBridgeInput(input);
    for (const listener of listeners) listener(structuredClone(safe));
  };

  const unsubscribePort = options.client.subscribe((input) => {
    try {
      publish(input);
    } catch {
      // A malformed transport application is ignored and cannot cross the IPC boundary.
    }
  });

  const finish = <TResult extends
    MessageAcceptedResult | MessageRevisionAcceptedResult | MessageRecallAcceptedResult>(
    pending: Promise<TResult>,
    id: string,
    validate: (value: unknown) => TResult,
  ): void => {
    void pending.then((value) => {
      const result = validate(value);
      if (result.requestId !== id) {
        publish(commandError(id, new TypeError("response correlation")));
        return;
      }
      publish(result);
    }).catch((error: unknown) => publish(commandError(id, error)));
  };

  const receipt = (id: string): MessageAuthorityCommandReceipt => Object.freeze({ requestId: id });

  return Object.freeze({
    async historyV2(query: MessageHistoryV2Query) {
      if (closed) throw new TypeError("Message Authority controller is closed");
      if (!isMessageHistoryV2Query(query)) {
        throw new TypeError("Invalid Message Authority history query");
      }
      const id = requestId("history");
      try {
        const result = cloneMessageAuthorityHistoryResult(await options.client.historyV2({
          ...query,
          requestId: id,
        }));
        if (result.requestId !== id || result.roomId !== query.roomId) {
          throw new TypeError("Message Authority history response correlation failed");
        }
        return result;
      } catch (error: unknown) {
        if (error instanceof TypeError && error.message.includes("correlation")) throw error;
        return lockedHistory(id, query.roomId, closedFailure(error));
      }
    },
    async revisionsQuery(query: MessageRevisionsQuery) {
      if (closed) throw new TypeError("Message Authority controller is closed");
      if (!isMessageRevisionsQuery(query)) {
        throw new TypeError("Invalid Message Authority revisions query");
      }
      const id = requestId("revisionsQuery");
      try {
        const result = cloneMessageRevisionsQueryResult(await options.client.revisionsQuery({
          ...query,
          requestId: id,
        }));
        if (result.requestId !== id ||
            (result.type === "message.revisions" &&
              (result.roomId !== query.roomId || result.messageId !== query.messageId))) {
          throw new TypeError("Message Authority revisions response correlation failed");
        }
        return result;
      } catch (error: unknown) {
        if (error instanceof TypeError && error.message.includes("correlation")) throw error;
        return commandError(id, error);
      }
    },
    sendV2(intent: MessageSendV2Intent) {
      if (closed) throw new TypeError("Message Authority controller is closed");
      if (!isMessageSendV2Intent(intent)) {
        throw new TypeError("Invalid Message Authority send intent");
      }
      const id = requestId("sendV2");
      finish(options.client.sendV2({ ...intent, requestId: id }), id, cloneMessageAcceptedResult);
      return receipt(id);
    },
    revise(intent: MessageReviseIntent) {
      if (closed) throw new TypeError("Message Authority controller is closed");
      if (!isMessageReviseIntent(intent)) {
        throw new TypeError("Invalid Message Authority revise intent");
      }
      const id = requestId("revise");
      finish(
        options.client.revise({ ...intent, requestId: id }),
        id,
        cloneMessageRevisionAcceptedResult,
      );
      return receipt(id);
    },
    recall(intent: MessageRecallIntent) {
      if (closed) throw new TypeError("Message Authority controller is closed");
      if (!isMessageRecallIntent(intent)) {
        throw new TypeError("Invalid Message Authority recall intent");
      }
      const id = requestId("recall");
      finish(
        options.client.recall({ ...intent, requestId: id }),
        id,
        cloneMessageRecallAcceptedResult,
      );
      return receipt(id);
    },
    subscribe(listener: (input: MessageAuthorityBridgeInput) => void) {
      if (closed) throw new TypeError("Message Authority controller is closed");
      if (typeof listener !== "function") {
        throw new TypeError("Message Authority listener is invalid");
      }
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribePort();
      listeners.clear();
    },
  });
}

export function createUnavailableMessageAuthorityClientPort(): MessageAuthorityClientPort {
  const unavailable = (): Promise<never> => Promise.reject(
    new MessageAuthorityClientFailure({ status: 503, code: "dependency_unavailable" }),
  );
  return Object.freeze({
    historyV2: unavailable,
    revisionsQuery: unavailable,
    sendV2: unavailable,
    revise: unavailable,
    recall: unavailable,
    subscribe: () => () => undefined,
  });
}
