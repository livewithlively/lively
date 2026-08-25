// 앱 알림 능력(#1891) — 앱이 쏘고(app_notify), 사람이 보고(me_notifications), 읽음 처리한다(me_notifications_read).
//
// 축이 둘로 갈린다:
//  · **발송**은 앱 principal 이 한다 — `user.appId` 가 있어야 하고(앱 토큰), 권한·grant 를 notify.ts 가 재검한다.
//  · **조회·읽음**은 사람이 한다 — 그 멤버 것만 보이고, id 를 알아도 남의 알림은 못 건드린다(스토어가 member 조건 고정).
import { z } from "zod";
import type { LivelyUser } from "../context.js";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { notifyMember } from "../apps/notify.js";
import * as store from "../org/store/app-notifications.js";

const actorOf = (user: LivelyUser): string => user?.userId || user?.email || "unknown";

const notifyInput = {
  title: z.string().describe("알림 제목 — 필수. 길면 잘린다(120자)"),
  body: z.string().optional().describe("한 줄 설명(400자까지)"),
  href: z.string().optional().describe("누르면 갈 곳 — **우리 화면 안 상대경로만**(`#/…` 또는 `/…`). 외부 URL 은 버려지고 알림만 남는다"),
  dedupe_key: z.string().optional().describe("같은 key 를 60초 안에 다시 쏘면 새 알림을 만들지 않는다(상태 떨림 방어). 비우면 억제 없음"),
  member_id: z.string().optional().describe("받을 사람. 생략하면 이 앱 토큰의 주인(보통 이것이 맞다)"),
};

const appNotify: Capability = {
  name: "app_notify",
  title: "앱 알림 보내기",
  description:
    "이 앱이 사용자에게 알림을 보낸다(#1891). 매니페스트에 permissions.notifications 를 선언하고 그 멤버의 동의(grant)가 있어야 한다 — 둘 중 하나라도 없으면 거부(fail-closed). "
    + "중복 억제: 같은 dedupe_key 를 60초 안에 다시 보내면 새 알림을 만들지 않고 suppressed 로 답한다(실패가 아니다). "
    + "href 는 우리 화면 안 상대경로만 받는다 — 외부 URL 은 버리고 알림 자체는 살린다(알림 클릭이 곧 피싱 경로가 되지 않게).",
  scope: null,
  input: notifyInput,
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/app-notifications"], parse: (req) => ({ ...((req.body ?? {}) as Record<string, unknown>) }) }] },
  handler: async (input: z.infer<z.ZodObject<typeof notifyInput>>, user: LivelyUser) => {
    // 받는 사람은 기본이 토큰 주인이다. 남에게 보내는 것은 지금 열지 않는다 —
    //  "앱이 아무에게나 배너를 띄운다"는 표면을 열기 전에 그 권한 모델부터 정해야 한다.
    const target = actorOf(user);
    if (input.member_id && input.member_id !== target) {
      throw new HttpError(403, "지금은 이 앱 토큰의 주인에게만 알림을 보낼 수 있습니다");
    }
    const r = await notifyMember({ appId: user?.appId ?? null, memberId: target, ...input });
    if (!r.ok) {
      const status = r.denial === "notify-title-required" ? 400 : 403;
      throw new HttpError(status, r.denial);
    }
    return "suppressed" in r ? { ok: true, suppressed: true } : { ok: true, notification: r.notification };
  },
};

const listInput = {
  limit: z.number().int().optional().describe("최대 건수(기본 100, 최대 500)"),
  unread_only: z.boolean().optional().describe("안 읽은 것만"),
};

const meNotifications: Capability = {
  name: "me_notifications",
  title: "내가 받은 알림",
  description: "내 알림 이력(최신순)과 안 읽은 개수. 앱이 보낸 알림이 여기 쌓이고, inbox 앱이 이걸 그린다(#1891).",
  scope: null,
  input: listInput,
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/me/notifications"], parse: (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    return { limit: q.limit ? Number(q.limit) : undefined, unread_only: q.unread_only === "true" };
  } }] },
  handler: async (input: z.infer<z.ZodObject<typeof listInput>>, user: LivelyUser) => {
    const me = actorOf(user);
    return {
      notifications: await store.listNotifications(me, { limit: input.limit, unreadOnly: input.unread_only }),
      unread: await store.unreadCount(me),
    };
  },
};

const readInput = {
  ids: z.array(z.string()).optional().describe("읽음 처리할 알림 id. 생략하면 **안 읽은 것 전부**"),
};

const meNotificationsRead: Capability = {
  name: "me_notifications_read",
  title: "알림 읽음 처리",
  description: "내 알림을 읽음으로 표시한다. ids 를 주면 그것만, 생략하면 안 읽은 것 전부. 남의 알림은 id 를 알아도 건드릴 수 없다.",
  scope: null,
  input: readInput,
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/me/notifications/read"], parse: (req) => ({ ...((req.body ?? {}) as Record<string, unknown>) }) }] },
  handler: async (input: z.infer<z.ZodObject<typeof readInput>>, user: LivelyUser) => {
    const me = actorOf(user);
    return { ok: true, marked: await store.markRead(me, input.ids) };
  },
};

export const appNotificationCapabilities: Capability[] = [appNotify, meNotifications, meNotificationsRead];
