import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMessageAuthoritySurface, type MessageAuthoritySurfaceActions } from "./message-authority-surface.js";
import {
  applyMessageAuthorityInput,
  beginMessageSubmission,
  createMessageAuthorityState,
  type MessageAuthorityState,
} from "./view-model.js";

function state(overrides: Partial<MessageAuthorityState> = {}): MessageAuthorityState {
  return createMessageAuthorityState({
    roomId: "room-1",
    viewerActorId: "human-viewer",
    lifecycle: "active",
    connection: { status: "online" },
    actors: [
      { actorId: "human-viewer", kind: "human", displayName: "陈默", secondaryLabel: "owner" },
      { actorId: "human-zhou-a", kind: "human", displayName: "周予", secondaryLabel: "产品" },
      { actorId: "human-zhou-b", kind: "human", displayName: "周予", secondaryLabel: "法务" },
      { actorId: "agent-search", kind: "agent", displayName: "检索员", secondaryLabel: "资料检索" },
    ],
    draft: {
      messageId: "message-local-1",
      roomId: "room-1",
      body: "请周予和检索员及另一位周予核对字段",
      mentionedTargets: [
        { id: "t1", kind: "human-request", targetActorId: "human-zhou-a", range: { startUtf16: 1, endUtf16: 3 } },
        { id: "t2", kind: "agent-invocation", targetActorId: "agent-search", range: { startUtf16: 4, endUtf16: 7 } },
        { id: "t3", kind: "human-request", targetActorId: "human-zhou-b", range: { startUtf16: 11, endUtf16: 13 } },
      ],
      replyToMessageId: "message-tombstone",
      attachments: [],
    },
    timeline: [
      {
        kind: "tombstone",
        messageId: "message-tombstone",
        roomId: "room-1",
        authorId: "human-viewer",
        createdAt: "2026-08-19T08:58:00.000Z",
        recalledAt: "2026-08-19T09:00:00.000Z",
        revisionCount: 1,
      },
      {
        kind: "human",
        messageId: "message-human",
        roomId: "room-1",
        authorId: "human-viewer",
        createdAt: "2026-08-19T09:01:00.000Z",
        body: "正文 v2",
        revision: 2,
        revisionCount: 2,
        replyToMessageId: "message-tombstone",
        mentionedTargets: [],
        attachments: [],
        targetOutcomes: [
          { targetId: "t1", targetActorId: "human-zhou-a", kind: "human-request", status: "request-created", requestIntentId: "r1" },
          { targetId: "t2", targetActorId: "agent-search", kind: "agent-invocation", status: "invocation-intent-created", invocationIntentId: "i1" },
          { targetId: "t3", targetActorId: "human-missing", kind: "human-request", status: "rejected", code: "target_not_member" },
        ],
      },
      {
        kind: "agent-final",
        messageId: "message-agent-final",
        roomId: "room-1",
        authorId: "agent-search",
        createdAt: "2026-08-19T09:02:00.000Z",
        finalBody: "原 final",
        sourceInvocationIntentId: "i1",
        sourceExecutionId: "e1",
      },
      {
        kind: "agent-final",
        messageId: "message-agent-correction",
        roomId: "room-1",
        authorId: "agent-search",
        createdAt: "2026-08-19T09:03:00.000Z",
        finalBody: "更正 final",
        sourceInvocationIntentId: "i1",
        sourceExecutionId: "e2",
        correctsMessageId: "message-agent-final",
      },
    ],
    executions: [
      { executionId: "e-running", agentId: "agent-search", sourceInvocationIntentId: "i1", status: "running" },
      { executionId: "e-completed", agentId: "agent-search", sourceInvocationIntentId: "i1", status: "completed" },
    ],
    previews: [{ executionId: "e-running", agentId: "agent-search", attemptSeq: 1, delta: "非权威片段", authoritative: false }],
    appliedEventIds: [],
    projectionGeneration: 7,
    ...overrides,
  });
}

function actions(): MessageAuthoritySurfaceActions {
  return {
    onSend: vi.fn(),
    onRetry: vi.fn(),
    onSelectMention: vi.fn(),
    onRevise: vi.fn(),
    onRecall: vi.fn(),
    onRetryRepair: vi.fn(),
    onReauthenticate: vi.fn(),
    onRefreshProjection: vi.fn(),
    onDismissReply: vi.fn(),
  };
}

afterEach(() => document.body.replaceChildren());

describe("J-02/J-03/J-04 message authority DOM", () => {
  it("renders duplicate mention names as separate stable actor choices", () => {
    const root = document.createElement("main");
    renderMessageAuthoritySurface(root, state(), actions());
    const choices = [...root.querySelectorAll<HTMLElement>("[data-mention-actor-id^='human-zhou']")];
    expect(choices).toHaveLength(2);
    expect(choices.map((choice) => choice.dataset.mentionActorId))
      .toEqual(["human-zhou-a", "human-zhou-b"]);
    expect(choices[0]?.getAttribute("aria-label")).toContain("产品");
    expect(choices[1]?.getAttribute("aria-label")).toContain("法务");
  });

  it("renders tombstone replies, revisions, finals and corrections without leaking recalled body", () => {
    const root = document.createElement("main");
    renderMessageAuthoritySurface(root, state(), actions());
    expect(root.querySelector("[data-reply-banner]")?.textContent).toContain("引用消息已撤回");
    expect(root.querySelector("[data-message-id='message-tombstone']")?.textContent).toContain("消息已撤回");
    expect(root.querySelector("[data-message-id='message-human']")?.textContent).toContain("已编辑 · v2");
    expect(root.querySelector("[data-message-id='message-agent-final']")?.textContent).toContain("FINAL");
    expect(root.querySelector("[data-message-id='message-agent-correction']")?.textContent).toContain("CORRECTION");
    expect(root.textContent).not.toContain("撤回前秘密正文");
  });

  it("uses distinct target outcome wording and does not call intent registration completion", () => {
    const root = document.createElement("main");
    renderMessageAuthoritySurface(root, state(), actions());
    const message = root.querySelector("[data-message-id='message-human']");
    expect(message?.textContent).toContain("请求意图已登记");
    expect(message?.textContent).toContain("Agent调用意图已登记");
    expect(message?.textContent).toContain("目标不可用");
    expect(message?.textContent).not.toContain("Agent已完成");
  });

  it("renders every durable target outcome directly from a matching ACK before the event arrives", () => {
    const root = document.createElement("main");
    const submitting = beginMessageSubmission(state(), "request-ack-1");
    const accepted = applyMessageAuthorityInput(submitting, {
      type: "message.accepted",
      requestId: "request-ack-1",
      messageId: "message-local-1",
      persistedAt: "2026-08-19T09:04:00.000Z",
      targetOutcomes: [
        { targetId: "t1", targetActorId: "human-zhou-a", kind: "human-request", status: "request-created", requestIntentId: "r1" },
        { targetId: "t2", targetActorId: "agent-search", kind: "agent-invocation", status: "invocation-intent-created", invocationIntentId: "i1" },
        { targetId: "t3", targetActorId: "human-zhou-b", kind: "human-request", status: "rejected", code: "target_not_member" },
      ],
    });
    renderMessageAuthoritySurface(root, accepted, actions());
    const receipt = root.querySelector("[data-submission-status='accepted']");
    expect(receipt?.querySelectorAll("[data-ack-target-id]")).toHaveLength(3);
    expect(receipt?.textContent).toContain("请求意图已登记");
    expect(receipt?.textContent).toContain("Agent调用意图已登记");
    expect(receipt?.textContent).toContain("目标不可用");
    expect(receipt?.textContent).not.toContain("Agent已完成");
  });

  it("emits a local send intent from the keyboard without manufacturing an ACK", () => {
    const root = document.createElement("main");
    const handlers = actions();
    renderMessageAuthoritySurface(root, state(), handlers);
    root.querySelector<HTMLTextAreaElement>("[data-message-composer]")?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }),
    );
    expect(handlers.onSend).toHaveBeenCalledOnce();
    expect(root.textContent).not.toContain("消息已保存");
  });

  it("separates durable execution/final from preview and never live-announces token chunks", () => {
    const root = document.createElement("main");
    renderMessageAuthoritySurface(root, state(), actions());
    expect(root.querySelector("[data-execution-id='e-running']")?.textContent).toContain("Agent执行中");
    expect(root.querySelector("[data-execution-id='e-completed']")?.textContent).toContain("Agent已完成");
    const preview = root.querySelector("[data-agent-preview]");
    expect(preview?.textContent).toContain("PREVIEW · 非权威 · 可丢弃");
    expect(preview?.getAttribute("aria-live")).toBe("off");
    expect(root.querySelectorAll("[aria-live='polite']")).toHaveLength(1);
  });

  it("exposes edit/recall only on the current author's active Human message", () => {
    const root = document.createElement("main");
    renderMessageAuthoritySurface(root, state(), actions());
    expect(root.querySelector("[data-message-id='message-human'] [data-action='revise-message']")).not.toBeNull();
    expect(root.querySelector("[data-message-id='message-human'] [data-action='recall-message']")).not.toBeNull();
    expect(root.querySelector("[data-message-id='message-agent-final'] [data-action='revise-message']")).toBeNull();
    expect(root.querySelector("[data-message-id='message-tombstone'] [data-action='recall-message']")).toBeNull();
  });
});

describe("J-02/J-07 operation, error and recovery DOM", () => {
  it("keeps submitting local, disables duplicate send, and announces no success", () => {
    const root = document.createElement("main");
    renderMessageAuthoritySurface(root, beginMessageSubmission(state(), "request-1"), actions());
    expect(root.querySelector<HTMLButtonElement>("[data-action='send-message']")?.disabled).toBe(true);
    expect(root.querySelector("[data-submission-status]")?.textContent).toContain("正在提交");
    expect(root.textContent).not.toContain("消息已保存");
  });

  it.each([
    [{ status: 400, code: "invalid_message" }, "修改消息"],
    [{ status: 401, code: "unauthenticated" }, "重新认证"],
    [{ status: 403, code: "room_forbidden" }, "返回 Room 列表"],
    [{ status: 404, code: "reply_target_not_found" }, "移除或重新选择引用"],
    [{ status: 409, code: "message_version_conflict" }, "载入最新版本"],
    [{ status: 410, code: "protocol_upgrade_required" }, "升级客户端"],
    [{ status: 429, code: "rate_limited", retryAfterSeconds: 12 }, "12 秒后重试"],
    [{ status: 503, code: "service_unavailable" }, "重试发送"],
  ] as const)("renders $0.status/$0.code with a non-colour recovery action", (error, recovery) => {
    const root = document.createElement("main");
    const base = beginMessageSubmission(state(), "request-1");
    const failed = {
      ...base,
      submission: error.status === 429 || error.status === 503
        ? { status: "retryable-failure" as const, requestId: "request-1", payload: base.draft, error }
        : { status: "nonretryable-failure" as const, requestId: "request-1", payload: base.draft, error },
    };
    document.body.append(root);
    renderMessageAuthoritySurface(root, createMessageAuthorityState(failed), actions());
    const alert = root.querySelector<HTMLElement>("[data-message-error]");
    expect(alert?.textContent).toContain(String(error.status));
    expect(alert?.textContent).toContain(error.code);
    expect(alert?.textContent).toContain(recovery);
    expect(document.activeElement).toBe(alert);
  });

  it("keeps the old complete timeline in offline, repairing, and repair-failed states", () => {
    const root = document.createElement("main");
    for (const connection of [
      { status: "offline", asOf: "2026-08-19T08:00:00.000Z" },
      { status: "repairing", watermark: 91 },
      { status: "repair-failed", errorCode: "snapshot_checksum_mismatch" },
    ] as const) {
      renderMessageAuthoritySurface(root, state({ connection }), actions());
      expect(root.querySelector("[data-message-id='message-human']")).not.toBeNull();
      expect(root.querySelector<HTMLButtonElement>("[data-action='send-message']")?.disabled).toBe(true);
      expect(root.querySelector("[data-connection-banner]")?.textContent).toMatch(/离线|repair/i);
    }
    renderMessageAuthoritySurface(root, state({
      connection: { status: "revoked", scope: "room", purgeCompleted: true },
    }), actions());
    expect(root.querySelector("[data-message-id]")).toBeNull();
    expect(root.textContent).not.toContain("正文 v2");
  });

  it("disables the composer in an archived Room and explains the authority source", () => {
    const root = document.createElement("main");
    renderMessageAuthoritySurface(root, state({ lifecycle: "archived" }), actions());
    expect(root.querySelector<HTMLTextAreaElement>("[data-message-composer]")?.disabled).toBe(true);
    expect(root.querySelector("[data-connection-banner]")?.textContent).toContain("ARCHIVED");
    expect(root.querySelector("[data-connection-banner]")?.textContent).toContain("projection");
  });
});

describe("FT-16 layout and accessibility contract", () => {
  it("defines 1440×900/840×560 reflow, zoom-safe wrapping, focus and reduced motion", () => {
    const css = readFileSync(resolve(import.meta.dirname, "message-authority.css"), "utf8");
    expect(css).toContain("max-inline-size: 100%");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toMatch(/@media\s*\(max-width:\s*52\.5rem\)/u);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
    expect(css).toContain("animation-duration: 0.01ms");
    expect(css).toContain(":focus-visible");
    expect(css).not.toMatch(/display:\s*none[^}]*data-action/u);
  });

  it("uses textual authority marks and a finite status region", () => {
    const root = document.createElement("main");
    renderMessageAuthoritySurface(root, state({ reducedMotion: true }), actions());
    expect(root.querySelector("[data-motion='reduced']")).not.toBeNull();
    expect(root.textContent).toContain("TOMBSTONE");
    expect(root.textContent).toContain("FINAL");
    expect(root.textContent).toContain("CORRECTION");
    expect(root.querySelectorAll("[role='status']")).toHaveLength(1);
  });
});
