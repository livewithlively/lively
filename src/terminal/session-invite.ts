// 세션 초대의 두 끝 — 초대 알림 · 초대받은 사람의 나가기 (#3870, 원준 2026-10-14).
//
//  신고: «초대가 되면 그 초대된 세션의 링크와 초대됐다는 사실에 대한 안내를 초대받은 사람에게 알림으로 보낼 수 있도록»
//        «내가 초대받은 뒤에 나갈 수가 있나? … 만든 사람은 나가는 경로 없어야 되고, 초대받은 사람에 한해서 나갈 수 있도록»
//
//  ── 알림 ──
//  · 받는 사람은 **이번 저장으로 새로 들어온 사람만**이다(newInvitees). 이미 있던 사람에게 다시 보내면 명단을 고칠 때마다
//    같은 알림이 쌓인다 — 저장할 때마다 화면이 명단 전체를 보내므로(share-session.ts) 차이는 서버가 잰다.
//  · 받는 사람마다 한 건, 종류는 'invite' — 「확인할 것」 에 서고(inInbox) 배너로도 뜬다. 누르면 그 세션(#/s/<id>).
//  · 같은 사람을 짧게 넣었다 뺐다 다시 넣어도 한 번만 — dedupe 키(세션·사람)와 INVITE_NOTIFY_COOLDOWN_MS.
//  · 알림 실패는 초대 실패가 아니다(best-effort) — 초대는 이미 저장됐다. 남기고 넘어간다.
//
//  ── 나가기 ──
//  · 초대받은 사람만(leaveRefusal) — 만든 사람에겐 길이 없다(화면도 단추를 안 세운다). 남의 명단을 고치는 일이라
//    **실행은 주인 이름으로** 한다(복제·옮기기 #1182 와 같은 규율): 명단에서 나 하나만 뺀다.
import { logger } from "../log.js";
import { notifySystem } from "../apps/notify.js";
import { listMembers } from "../org/store.js";
import { memberName, type NamedMember } from "../v6/comment-notify.js";
import { withSubjectParticle } from "../v6/notify-store.js";

/** 같은 세션에 같은 사람을 다시 초대해도 알림을 다시 울리지 않는 간격 — 넣었다 뺐다 하는 손놀림이 알림 여럿이 되지 않게. */
export const INVITE_NOTIFY_COOLDOWN_MS = 10 * 60_000;

const clean = (xs: unknown): string[] =>
  Array.isArray(xs) ? [...new Set(xs.map((x) => String(x ?? "").trim()).filter(Boolean))] : [];

/**
 * (순수) 이번 저장으로 **새로 들어온** 사람 — 다음 명단에서 이전 명단 · 주인 · 저장한 사람을 뺀다.
 *  이전 명단을 모르면(null) 다음 명단 전부를 새로 본다 — 모른다고 알림을 삼키면 초대받은 사람이 영영 모른다.
 *  그 경우의 되풀이는 dedupe(세션·사람)가 막는다.
 */
export function newInvitees(prev: readonly string[] | null | undefined, next: readonly string[] | null | undefined, owner: string, actor: string): string[] {
  const before = new Set(clean(prev));
  return clean(next).filter((id) => !before.has(id) && id !== owner && id !== actor);
}

/** (순수) 알림 문구 — 서버가 만든다(화면·앱·배너가 같은 문장을 받는다). */
export function inviteNotifyText(who: string, label: string): { title: string; body: string } {
  const subj = withSubjectParticle(who);
  const name = String(label ?? "").replace(/\s+/g, " ").trim();
  return {
    title: name ? `${subj} «${name}» 세션에 나를 초대했어요` : `${subj} 세션에 나를 초대했어요`,
    body: "눌러서 이 세션을 열어요 — 함께 보고 이어서 쓸 수 있어요.",
  };
}

/** 세션 화면 주소 — 사이드바 줄 · ⌘K 가 여는 것과 같다. */
export const sessionHref = (id: string): string => "#/s/" + encodeURIComponent(id);

/**
 * 새로 초대된 사람들에게 알림을 남긴다. 보낸 수를 돌려준다(억제·실패는 세지 않는다). 던지지 않는다.
 */
export async function notifySessionInvitees(o: { sessionId: string; label: string; actor: string; invitees: readonly string[] }): Promise<number> {
  if (!o.invitees.length) return 0;
  const members = await listMembers().catch(() => [] as NamedMember[]);
  const actor = members.find((m) => m.id === o.actor);
  const text = inviteNotifyText(actor ? memberName(actor) : (o.actor || "누군가"), o.label);
  let n = 0;
  for (const memberId of o.invitees) {
    const res = await notifySystem({
      kind: "invite", memberId, actor: o.actor, title: text.title, body: text.body, href: sessionHref(o.sessionId),
      dedupe_key: `invite:${o.sessionId}:${memberId}`, cooldownMs: INVITE_NOTIFY_COOLDOWN_MS,
    }).catch((err) => { logger.warn({ err, memberId, session: o.sessionId }, "세션 초대 알림 실패(비치명)"); return null; });
    if (res?.ok && !("suppressed" in res)) n++;
  }
  return n;
}

/** (순수) 나가기를 거절할 사유 — 없으면 null. 만든 사람 · 명단에 없는 사람 · 행 없음. */
export function leaveRefusal(st: { owner: string; invites?: readonly string[] | null } | null | undefined, me: string): { status: number; message: string } | null {
  if (!st) return { status: 404, message: "세션을 찾을 수 없어요." };
  if (st.owner === me) return { status: 403, message: "만든 사람은 세션에서 나갈 수 없어요 — 그만 쓰려면 보관하거나 휴지통으로 보내세요." };
  if (!clean(st.invites).includes(me)) return { status: 409, message: "이 세션에 초대받은 상태가 아니에요." };
  return null;
}

/** (순수) 나 하나만 뺀 명단 — 다른 사람의 자리·순서는 그대로. */
export function invitesWithout(invites: readonly string[] | null | undefined, me: string): string[] {
  return clean(invites).filter((id) => id !== me);
}
