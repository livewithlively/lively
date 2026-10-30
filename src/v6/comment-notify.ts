// 댓글·언급 알림(#4180) — «누가 «어디»에 댓글을 남겼어요 / 나를 언급했어요» 를 「확인할 것」에 남긴다.
//
//  ── 왜 (회의 2026-09-21 상민·원준) ──
//  «알림은 내용이 의미 있어야 한다. 인스타그램처럼 '누가 댓글을 달았다 / 나를 태그했다'가 보여야 한다. 지금은 '3시간 전'
//  같은 것만 있어 들어갈 이유가 없다.» 종전 「확인할 것」의 이력은 ai-session 스윕의 «답을 기다려요» 뿐이었고, 사람이 사람에게
//  한 일(댓글·언급)은 데스크톱 앱의 파생 피드(notify-store.ts · 조회 시점 합성)에만 있어 화면 이력·읽음이 없었다.
//  이제 댓글이 **써지는 그 자리**(postComment · postKnowledgeComment)에서 받는 사람마다 알림 한 건을 남긴다.
//
//  ── 누가 받나 ──
//  · 언급된 사람 — 본문의 `@표시이름`·`@닉네임(쓰기로 켠 사람)`·`@아이디`. 화면(compose-mention)이 그렇게 쓰고 피드(notify-store)가
//    그렇게 읽으므로 여기도 같은 규칙이다 — 규칙이 갈리면 배너는 뜨는데 화면엔 표시가 없는 어긋남이 생긴다.
//  · 참여자 — 태스크: 만든 사람·담당·팀원(루트 프로젝트 팀원 포함) / 지식: 쓴 사람·마지막으로 고친 사람.
//  · **글쓴이 자신은 뺀다** — 자기 행위가 알림으로 돌아오면 그건 고장이다(notify-store 와 같은 규칙).
//  · 언급이 참여자 알림을 이긴다(한 사람에 한 건 — 「나를 언급했어요」).
//
//  ⚠ 실패해도 댓글은 이미 써졌다 — 알림은 best-effort 다(부르는 쪽이 fire-and-forget). 여기서 던지지 않고 남긴다.
import { itemsPool, one } from "../db/client.js";
import { logger } from "../log.js";
import { notifySystem } from "../apps/notify.js";
import { listMembers } from "../org/store.js";
import { withSubjectParticle } from "./notify-store.js";

export interface CommentEvent { author: string | null; body: string }
export interface NamedMember { id: string; display_name?: string | null; nickname?: string | null; use_nickname?: boolean | null }

/** 화면 규칙과 같은 이름(web/lib/person-name.ts) — 닉네임을 쓰기로 켠 사람만 닉네임. */
export function memberName(m: NamedMember): string {
  const nick = String(m.nickname ?? "").trim();
  if (m.use_nickname && nick) return nick;
  return String(m.display_name ?? "").trim() || m.id;
}

/**
 * (순수) 본문이 지목한 구성원 id — `@표시이름` · `@닉네임(켠 사람)` · `@아이디` 중 하나라도 들어 있으면.
 *  부분 일치를 그대로 쓴다(«@장원준님» 도 언급이다) — LIKE 로 읽는 피드(notify-store)와 같은 폭.
 */
export function mentionedMembers(body: string, members: ReadonlyArray<NamedMember>): string[] {
  const text = String(body ?? "");
  if (!text.includes("@")) return [];
  const out: string[] = [];
  for (const m of members) {
    const keys = new Set<string>([m.id, String(m.display_name ?? "").trim(), m.use_nickname ? String(m.nickname ?? "").trim() : ""].filter(Boolean));
    for (const k of keys) { if (text.includes("@" + k)) { out.push(m.id); break; } }
  }
  return out;
}

/** (순수) 받는 사람 — 글쓴이 제외·중복 제거. 언급이 참여를 이긴다(한 사람 한 건). */
export function commentRecipients(o: { author: string | null; mentioned: readonly string[]; participants: readonly string[] }): { mention: string[]; comment: string[] } {
  const me = String(o.author ?? "").trim();
  const clean = (xs: readonly string[]): string[] => [...new Set(xs.map((x) => String(x ?? "").trim()).filter((x) => x && x !== me))];
  const mention = clean(o.mentioned);
  const comment = clean(o.participants).filter((x) => !mention.includes(x));
  return { mention, comment };
}

/** (순수) 제목 — 서버가 만든다(앱·화면이 각자 조립하면 같은 사건이 자리마다 다르게 읽힌다). */
export function commentTitle(who: string, where: string, mention: boolean): string {
  const subj = withSubjectParticle(who);
  const w = String(where ?? "").trim();
  if (mention) return w ? `${subj} «${w}»에서 나를 언급했어요` : `${subj} 나를 언급했어요`;
  return w ? `${subj} «${w}»에 댓글을 남겼어요` : `${subj} 댓글을 남겼어요`;
}

/** 본문 발췌 — 한 줄로 눌러 200자. */
export function snippet(s: unknown, max = 200): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** 루트 프로젝트를 타고 올라가는 조인 — 태스크·서브태스크의 팀원은 루트에 있다(notify-store ROOT_JOIN 과 같은 규칙). */
const ROOT_JOIN = `
      LEFT JOIN project par ON par.id = p.parent_id
      LEFT JOIN project root ON root.id = CASE WHEN p.level='subtask' THEN par.parent_id
                                               WHEN p.level='task'    THEN par.id
                                               ELSE p.id END`;

async function fanOut(o: { author: string | null; body: string; where: string; href: string; mentioned: string[]; participants: string[]; key: string }): Promise<number> {
  const members = await listMembers().catch(() => [] as NamedMember[]);
  const byId = new Map(members.map((m) => [m.id, m]));
  const author = o.author ? byId.get(o.author) : undefined;
  const who = author ? memberName(author) : (o.author || "누군가");
  const r = commentRecipients({ author: o.author, mentioned: o.mentioned, participants: o.participants });
  const body = snippet(o.body);
  let n = 0;
  const send = async (memberId: string, mention: boolean): Promise<void> => {
    const res = await notifySystem({
      kind: mention ? "mention" : "comment", memberId, actor: o.author,
      title: commentTitle(who, o.where, mention), body, href: o.href,
      dedupe_key: `${o.key}:${memberId}`,
    }).catch((err) => { logger.warn({ err, memberId }, "댓글 알림 실패(비치명)"); return null; });
    if (res?.ok && !("suppressed" in res)) n++;
  };
  for (const id of r.mention) await send(id, true);
  for (const id of r.comment) await send(id, false);
  return n;
}

/** 태스크(프로젝트·태스크·서브태스크) 댓글 → 언급된 사람 + 참여자(만든 사람·담당·팀원). */
export async function notifyTaskComment(taskId: number, ev: CommentEvent, commentId?: number | null): Promise<number> {
  const row = await one(itemsPool, `
    SELECT p.id, p.name, p.created_by, p.assignee, root.id AS root_id, root.name AS root_name, root.created_by AS root_created_by, root.assignee AS root_assignee,
           ARRAY(SELECT pm.member_id FROM project_member pm WHERE pm.project_id = root.id) AS root_members,
           ARRAY(SELECT pm.member_id FROM project_member pm WHERE pm.project_id = p.id) AS members,
           ARRAY(SELECT ta.member_id FROM task_assignee ta WHERE ta.task_id = p.id) AS assignees
      FROM project p ${ROOT_JOIN}
     WHERE p.id = $1`, [taskId]);
  if (!row) return 0;
  const members = await listMembers().catch(() => [] as NamedMember[]);
  const participants: string[] = [
    row.created_by, row.assignee, row.root_created_by, row.root_assignee,
    ...(Array.isArray(row.root_members) ? row.root_members : []),
    ...(Array.isArray(row.members) ? row.members : []),
    ...(Array.isArray(row.assignees) ? row.assignees : []),
  ].filter((x): x is string => typeof x === "string" && !!x);
  return fanOut({
    author: ev.author, body: ev.body, where: String(row.name || ""),
    //  태스크 상세(댓글 피드가 있는 화면) — 활동 화면(activity-view)이 태스크를 여는 것과 같은 주소.
    href: `#/projects2/p/${Number(row.id)}`,
    mentioned: mentionedMembers(ev.body, members), participants,
    key: `comment:task:${taskId}:${commentId ?? Date.now()}`,
  });
}

/** 지식(위키 문서) 댓글 → 언급된 사람 + 쓴 사람·마지막으로 고친 사람. */
export async function notifyKnowledgeComment(name: string, ev: CommentEvent, commentId?: number | null): Promise<number> {
  const row = await one(itemsPool, `SELECT name, title, author, updated_by FROM knowledge WHERE name = $1`, [name]);
  if (!row) return 0;
  const members = await listMembers().catch(() => [] as NamedMember[]);
  const participants = [row.author, row.updated_by].filter((x): x is string => typeof x === "string" && !!x);
  return fanOut({
    author: ev.author, body: ev.body, where: String(row.title || row.name || ""),
    href: `#/k/${encodeURIComponent(String(row.name))}`,
    mentioned: mentionedMembers(ev.body, members), participants,
    key: `comment:knowledge:${name}:${commentId ?? Date.now()}`,
  });
}
