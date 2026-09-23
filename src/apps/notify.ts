// 앱 알림 발송(#1891) — 판정(notify-policy, 순수)과 저장(org/store/app-notifications) 사이의 배선.
//
// 여기가 유일한 발송 관문이다. 앱이 직접 스토어를 부르지 않고 이 함수를 지나야 권한·정규화·중복 억제가 걸린다.
import { getActiveGrant, getApp } from "../org/store/apps.js";
import * as store from "../org/store/app-notifications.js";
import { parseAppManifest } from "./manifest.js";
import {
  decideNotifyAllowed, normalizeActor, normalizeKind, normalizeNotification, shouldSuppressDuplicate, type NotifyDenial, type NotifyKind,
} from "./notify-policy.js";

export type NotifyResult =
  | { ok: true; notification: store.AppNotificationRow }
  | { ok: true; suppressed: true }                 // 중복 억제 — 실패가 아니다
  | { ok: false; denial: NotifyDenial | "notify-app-inactive" };

/**
 * 제품 자신이 보내는 알림의 app_id(#4180) — 댓글·언급·리브의 답은 어느 앱의 일도 아니다.
 *  실제 앱 행이 아니므로 앱 관문(활성·매니페스트·grant)을 지나지 않는다 — 그 관문이 막는 것은 **남의 앱**이 사용자
 *  이름으로 배너를 띄우는 일이고, 여기는 서버 코드만 부른다(앱 토큰 경로 app_notify 는 notifyMember 만 탄다).
 */
export const SYSTEM_NOTIFY_APP = "lively";

/**
 * 앱이 한 멤버에게 알림을 보낸다.
 *
 * ⚠ 앱 활성 여부를 **발송 시점에 다시 본다** — 설치 당시 권한이 있었어도 그 뒤 앱이 꺼지거나 grant 가
 *  철회됐으면 알림도 멈춰야 한다(worker 예산 관문과 같은 규율: 코어가 grant 를 재검한다).
 */
export async function notifyMember(input: {
  appId: string | null | undefined;
  memberId: string;
  title?: unknown; body?: unknown; href?: unknown; dedupe_key?: unknown;
  now?: number;
  /**
   * 같은 dedupe_key 를 다시 울리지 않는 간격(ms). 없으면 정책 기본값(60초 — 하네스 상태 떨림 방어).
   *  #4051 — 주기 잡이 보내는 알림(«사람 없이 도는 작업이 멈췄어요»)은 10분마다 같은 사실을 되풀이하므로 길게 준다.
   *  ⚠ **서버 코드만** 넘긴다 — 앱 토큰 경로(app_notify)는 이 값을 받지 않는다(앱이 억제를 풀 수 없게).
   */
  cooldownMs?: number;
  /**
   * 종류(#4180) — 「확인할 것」 렌즈가 이걸로 거른다. **서버 코드만** 넘긴다(앱 토큰 경로는 늘 'app'):
   *  ai-session 스윕이 'session' 을 넘겨 대기 알림을 배너 전용으로 만든다. 모르는 값은 'app'.
   */
  kind?: NotifyKind;
  /** 이 알림을 만든 사람(구성원 id) — 사람이 한 일(댓글·언급)에만. */
  actor?: string | null;
}): Promise<NotifyResult> {
  if (!input.appId) return { ok: false, denial: "notify-app-required" };

  const app = await getApp(input.appId);
  if (!app || !app.enabled || app.status !== "active") return { ok: false, denial: "notify-app-inactive" };

  let declares = false;
  try { declares = parseAppManifest(app.manifest).permissions.notifications === true; }
  catch { declares = false; }   // 매니페스트를 못 읽으면 권한 없음으로 본다(fail-closed)

  const isBuiltin = (app.source as { kind?: string } | null)?.kind === "builtin";
  const denial = decideNotifyAllowed({
    appId: input.appId,
    declaresNotifications: declares,
    // 빌트인은 grant 를 안 보므로 조회 자체를 건너뛴다(부질없는 DB 왕복 + 없어도 되는 실패 지점).
    hasActiveGrant: isBuiltin ? true : !!(await getActiveGrant(input.appId, input.memberId)),
    isBuiltin,
  });
  if (denial) return { ok: false, denial };

  const norm = normalizeNotification(input);
  if (!norm.ok) return { ok: false, denial: norm.denial };

  return sendNormalized(input.appId, input.memberId, norm.value, {
    kind: normalizeKind(input.kind), actor: normalizeActor(input.actor), now: input.now, cooldownMs: input.cooldownMs,
  });
}

/**
 * 제품 자신이 한 사람에게 알림을 보낸다(#4180) — 댓글·언급(사람이 나를 지목한 것)·리브의 답.
 *  앱 관문은 없지만 **정규화·href 검증·중복 억제**는 앱 알림과 같은 길을 지난다 — 배너·화면이 같은 모양을 받아야 한다.
 *  종류는 필수다(app·session 은 여기로 못 온다 — 그건 앱과 스윕의 것이다).
 */
export async function notifySystem(input: {
  kind: Exclude<NotifyKind, "app" | "session">;
  memberId: string;
  title?: unknown; body?: unknown; href?: unknown; dedupe_key?: unknown;
  actor?: string | null;
  now?: number;
  cooldownMs?: number;
}): Promise<NotifyResult> {
  if (!input.memberId) return { ok: false, denial: "notify-app-required" };
  const norm = normalizeNotification(input);
  if (!norm.ok) return { ok: false, denial: norm.denial };
  return sendNormalized(SYSTEM_NOTIFY_APP, input.memberId, norm.value, {
    kind: input.kind, actor: normalizeActor(input.actor), now: input.now, cooldownMs: input.cooldownMs,
  });
}

/** 두 발송 경로의 공통 꼬리 — 중복 억제 판정 뒤 저장. 여기가 유일한 INSERT 자리다. */
async function sendNormalized(
  appId: string, memberId: string,
  v: { title: string; body: string | null; href: string | null; dedupeKey: string | null },
  o: { kind: NotifyKind; actor: string | null; now?: number; cooldownMs?: number },
): Promise<NotifyResult> {
  const now = o.now ?? Date.now();
  if (v.dedupeKey) {
    const last = await store.lastSentAtMs(appId, memberId, v.dedupeKey);
    if (shouldSuppressDuplicate(v.dedupeKey, last, now, o.cooldownMs)) return { ok: true, suppressed: true };
  }
  return {
    ok: true,
    notification: await store.insertNotification({
      appId, memberId, title: v.title, body: v.body, href: v.href, dedupeKey: v.dedupeKey, kind: o.kind, actor: o.actor,
    }),
  };
}
