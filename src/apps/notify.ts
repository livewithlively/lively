// 앱 알림 발송(#1891) — 판정(notify-policy, 순수)과 저장(org/store/app-notifications) 사이의 배선.
//
// 여기가 유일한 발송 관문이다. 앱이 직접 스토어를 부르지 않고 이 함수를 지나야 권한·정규화·중복 억제가 걸린다.
import { getActiveGrant, getApp } from "../org/store/apps.js";
import * as store from "../org/store/app-notifications.js";
import { parseAppManifest } from "./manifest.js";
import {
  decideNotifyAllowed, normalizeNotification, shouldSuppressDuplicate, type NotifyDenial,
} from "./notify-policy.js";

export type NotifyResult =
  | { ok: true; notification: store.AppNotificationRow }
  | { ok: true; suppressed: true }                 // 중복 억제 — 실패가 아니다
  | { ok: false; denial: NotifyDenial | "notify-app-inactive" };

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

  const now = input.now ?? Date.now();
  if (norm.value.dedupeKey) {
    const last = await store.lastSentAtMs(input.appId, input.memberId, norm.value.dedupeKey);
    if (shouldSuppressDuplicate(norm.value.dedupeKey, last, now)) return { ok: true, suppressed: true };
  }

  return {
    ok: true,
    notification: await store.insertNotification({
      appId: input.appId, memberId: input.memberId,
      title: norm.value.title, body: norm.value.body, href: norm.value.href, dedupeKey: norm.value.dedupeKey,
    }),
  };
}
