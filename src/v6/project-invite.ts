// 프로젝트 초대(#5598) — 비공개(초대제 · 초안) 프로젝트에 사람을 넣을 때의 규칙과 알림.
//
//  비공개 프로젝트에서는 **팀원(project_member)이 곧 볼 수 있는 사람**이다(v6/visibility.ts). 그래서 팀원을 넣는 일이 «초대» 다.
//  세션의 초대(terminal/session-invite.ts, #3870)와 같은 모양으로 맞춘다 — 새로 들어온 사람에게만 알림 한 건, 누르면 그 프로젝트.
//
//  ── 누가 무엇을 하나 ──
//  · 넣기(초대): 그 프로젝트를 보는 사람 누구나(만든 사람 · 팀원). 세션에 초대하면 프로젝트에도 들어오므로(session-state.ts
//    syncPrivateInviteMembers) 팀원의 초대를 여기서만 막는 것은 뜻이 없다.
//  · 빼기: 만든 사람은 누구든, 그 밖의 사람은 **자기 자신만**(나가기). 초대받은 사람이 다른 사람을 내보내지 못한다.
//  · 공개 범위 바꾸기(초대제 ↔ 전체 공개): 만든 사람만(project-store.setProjectAccess).
//  공개 프로젝트의 팀원은 종전대로다(누구나 넣고 뺀다 — 거기서 팀원은 볼 수 있는 사람이 아니라 담당자다).
import { logger } from "../log.js";
import { notifySystem } from "../apps/notify.js";
import { listMembers } from "../org/store.js";
import { memberName, type NamedMember } from "./comment-notify.js";
import { withSubjectParticle } from "./notify-store.js";

/** 같은 프로젝트에 같은 사람을 다시 넣어도 알림을 다시 울리지 않는 간격(세션 초대와 같은 값). */
export const PROJECT_INVITE_NOTIFY_COOLDOWN_MS = 10 * 60_000;

const clean = (xs: unknown): string[] =>
  Array.isArray(xs) ? [...new Set(xs.map((x) => String(x ?? "").trim()).filter(Boolean))] : [];

/** (순수) 이 프로젝트가 «만든 사람과 팀원만 보는» 상태인가 — v6/visibility.ts privateProjectSql 과 같은 말. */
export function isPrivateProject(p: { draft?: boolean | null; invite_only?: boolean | null } | null | undefined): boolean {
  return !!p && (p.draft === true || p.invite_only === true);
}

/** (순수) 이번 저장으로 **새로 들어온** 사람 — 다음 명단에서 이미 보던 사람(만든 사람 · 이전 팀원)과 저장한 사람을 뺀다. */
export function newProjectInvitees(prev: readonly string[] | null | undefined, next: readonly string[] | null | undefined, owner: string | null, actor: string | null): string[] {
  const before = new Set(clean(prev));
  return clean(next).filter((id) => !before.has(id) && id !== owner && id !== actor);
}

/**
 * (순수) 팀원 저장을 거절할 사유 — 없으면 null. 비공개 프로젝트에서 만든 사람이 아닌 사람이 **남을** 빼려 할 때만 거절한다.
 *  공개 프로젝트 · 만든 사람 · 자기 자신만 빼는 저장(나가기) · 넣기만 하는 저장은 통과.
 */
export function memberEditRefusal(o: { private: boolean; owner: string | null; actor: string | null; prev: readonly string[]; next: readonly string[] }): string | null {
  if (!o.private) return null;
  if (o.actor && o.owner === o.actor) return null;
  const next = new Set(clean(o.next));
  const removedOthers = clean(o.prev).filter((id) => !next.has(id) && id !== o.actor);
  return removedOthers.length ? "초대한 사람을 빼는 것은 이 프로젝트를 만든 사람만 할 수 있습니다" : null;
}

/** (순수) 알림 문구 — 서버가 만든다(화면 · 앱 · 배너가 같은 문장을 받는다). */
export function projectInviteNotifyText(who: string, name: string): { title: string; body: string } {
  const subj = withSubjectParticle(who);
  const nm = String(name ?? "").replace(/\s+/g, " ").trim();
  return {
    title: nm ? `${subj} «${nm}» 프로젝트에 나를 초대했어요` : `${subj} 프로젝트에 나를 초대했어요`,
    body: "눌러서 이 프로젝트를 열어요 — 본문 · 태스크 · 파일을 함께 볼 수 있어요.",
  };
}

/** 프로젝트 화면 주소 — 댓글 알림(comment-notify.ts)이 여는 것과 같다. */
export const projectHref = (id: number): string => `#/projects2/p/${Number(id)}`;

/** 새로 초대된 사람들에게 알림을 남긴다. 보낸 수를 돌려준다(억제 · 실패는 세지 않는다). 던지지 않는다. */
export async function notifyProjectInvitees(o: { projectId: number; name: string; actor: string | null; invitees: readonly string[] }): Promise<number> {
  if (!o.invitees.length) return 0;
  const members = await listMembers().catch(() => [] as NamedMember[]);
  const actor = members.find((m) => m.id === o.actor);
  const text = projectInviteNotifyText(actor ? memberName(actor) : (o.actor || "누군가"), o.name);
  let n = 0;
  for (const memberId of o.invitees) {
    const res = await notifySystem({
      kind: "invite", memberId, actor: o.actor, title: text.title, body: text.body, href: projectHref(o.projectId),
      dedupe_key: `project-invite:${o.projectId}:${memberId}`, cooldownMs: PROJECT_INVITE_NOTIFY_COOLDOWN_MS,
    }).catch((err) => { logger.warn({ err, memberId, project: o.projectId }, "프로젝트 초대 알림 실패(비치명)"); return null; });
    if (res?.ok && !("suppressed" in res)) n++;
  }
  return n;
}
