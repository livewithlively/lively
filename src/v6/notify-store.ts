// 사람 알림 피드 (#1842) — **"마지막으로 본 뒤 나에게 온 것"만** 한 번에 준다.
//
// 왜 서버에 두나: 데스크톱 앱이 알림을 띄우려면 "나에게 온 것"을 알아야 하는데, 종전엔 그걸 아는 자리가
//  대시보드 위젯뿐이었다 — 위젯은 조회 시점에 activity·프로젝트별 코멘트·세션·검토큐를 **화면에서 합성**한다
//  (web/dash/widget-notifications.ts). 앱이 그 합성을 재현하면 ① 내 프로젝트 수만큼 요청이 나가고
//  ② 판정이 두 벌로 갈라져 화면과 배너가 서로 다른 말을 한다. 그래서 판정을 서버 한 자리로 내린다.
//
// 무엇이 알림인가 (#1571 이 좁혀 둔 정의를 그대로 쓴다):
//   **사람이 · 나를 지목해서 · 한 행위**. 셋 중 하나라도 빠지면 알림이 아니다.
//   - AI 에이전트의 작업 로그(activity)는 뺀다 — 사람의 행위가 아니다. 실측(#1571): 알림 화면의 89%가 이것이었다.
//   - 필드 변경(설명 편집·상태·마감)도 뺀다 — 나를 지목한 것이 아니다. 프로젝트 상세의 감사 피드가 담당한다.
//   남는 것은 둘: mention · comment. (담당 지정은 원준 2026-08-24 판단으로 뺐다 — 배너로 부를 만큼
//   지금 당장 해야 할 일이 아니고, 프로젝트 화면에서 확인하면 된다.)
//
// ⚠ 내가 한 일은 나에게 알리지 않는다(actor = me 는 전부 제외) — 자기 행위가 배너로 돌아오면 그건 고장이다.
import { itemsPool } from "../db/client.js";
import { q } from "../db/client.js";
import { visibleListIds, listIdPredicate, type Viewer } from "./visibility.js";

export type NotifyKind = "mention" | "comment";

export interface NotifyItem {
  /** 안정 키 — 같은 사건은 언제 조회해도 같은 값이다(앱이 이미 띄운 것을 다시 안 띄우는 근거). */
  key: string;
  kind: NotifyKind;
  ts: string;
  actor: string | null;
  actor_name: string | null;
  project_id: number | null;
  project_name: string | null;
  /** 댓글 본문(한 줄로 눌러 240자까지). */
  body: string;
  /** 이 알림이 가리키는 화면(웹 UI 해시). 만들 수 없으면 null — **가짜 링크를 만들지 않는다**(#1571 §9). */
  link: string | null;
}

/** 루트 프로젝트를 타고 올라가는 조인 — 태스크·서브태스크의 list_id 는 항상 NULL 이라 그대로 판정하면 새어 나간다(project-store 와 같은 규칙). */
const ROOT_JOIN = `
      LEFT JOIN project par ON par.id = p.parent_id
      LEFT JOIN project root ON root.id = CASE WHEN p.level='subtask' THEN par.parent_id
                                               WHEN p.level='task'    THEN par.id
                                               ELSE p.id END`;

/** 한 줄로 눌러 자른 본문 — 배너는 두어 줄만 보여준다. */
function snippet(s: unknown): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > 240 ? t.slice(0, 240) + "…" : t;
}

/**
 * 나에게 온 알림.
 *
 * @param memberId 수신자(나). 빈 값이면 아무것도 주지 않는다 — 신원 없이 남의 알림을 주는 길을 두지 않는다.
 * @param opts.since 이 시각 **이후**만(ISO). 없으면 최근 24시간 — 콜드스타트에서 과거 전체가 쏟아지지 않게 한다.
 * @param opts.displayName 멘션 표기에 쓰이는 이름(`@장원준`). 화면이 그렇게 쓰므로 여기서도 같은 규칙을 본다.
 * @param viewer 공개범위 판정 주체. `undefined` = 필터 없음(내부 경로), 그 외는 그 신원으로 건다(#1291 규약).
 */
export async function listMyNotifications(
  memberId: string,
  opts: { since?: string | null; limit?: number; displayName?: string | null } = {},
  viewer?: Viewer,
): Promise<NotifyItem[]> {
  const me = String(memberId || "").trim();
  if (!me) return [];
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 100));
  const since = opts.since && !Number.isNaN(Date.parse(opts.since))
    ? new Date(opts.since).toISOString()
    : new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const visIds = viewer === undefined ? null : await visibleListIds(viewer);
  const visWhere = listIdPredicate("COALESCE(root.list_id, p.list_id)", visIds);
  const name = String(opts.displayName || "").trim();

  // ① 댓글 — 나를 지목한 것(멘션) 또는 내가 참여·담당한 일의 댓글.
  //  ⚠ 멘션은 본문 문자열로 본다(`@이름`·`@아이디`). 화면(widget-notifications.ts)이 쓰는 규칙과 **같아야** 한다 —
  //   여기서 다른 규칙을 쓰면 배너는 뜨는데 화면엔 멘션 표시가 없는(또는 그 반대) 어긋남이 생긴다.
  //   LIKE 의 와일드카드가 이름에 섞여도 결과가 넓어질 뿐 남의 것이 새지는 않는다(가시성·수신자 조건이 따로 선다).
  const comments = await q(itemsPool, `
    SELECT c.id, c.body, c.created_at, c.author, m.display_name,
           root.id AS project_id, root.name AS project_name,
           (($2 <> '' AND c.body LIKE '%@' || $2 || '%') OR c.body LIKE '%@' || $1 || '%') AS mentioned
      FROM task_comment c
      JOIN project p ON p.id = c.task_id
      ${ROOT_JOIN}
      LEFT JOIN org_member m ON m.id = c.author
     WHERE c.created_at > $3::timestamptz
       AND c.author IS DISTINCT FROM $1
       AND ${visWhere}
       AND (
         ($2 <> '' AND c.body LIKE '%@' || $2 || '%') OR c.body LIKE '%@' || $1 || '%'
         OR EXISTS (SELECT 1 FROM project_member pm WHERE pm.project_id = root.id AND pm.member_id = $1)
         OR root.assignee = $1 OR p.assignee = $1
         OR EXISTS (SELECT 1 FROM task_assignee ta WHERE ta.task_id = p.id AND ta.member_id = $1)
       )
     ORDER BY c.created_at DESC
     LIMIT $4`, [me, name, since, limit]);

  const items: NotifyItem[] = [];
  for (const c of comments) {
    const pid = c.project_id ?? null;
    items.push({
      key: "comment:" + c.id,
      kind: c.mentioned ? "mention" : "comment",
      ts: new Date(c.created_at).toISOString(),
      actor: c.author ?? null,
      actor_name: c.display_name ?? null,
      project_id: pid,
      project_name: c.project_name ?? null,
      body: snippet(c.body),
      link: pid ? "#/projects2/p/" + pid : null,
    });
  }
  items.sort((x, y) => Date.parse(y.ts) - Date.parse(x.ts));
  return items.slice(0, limit);
}

/**
 * 배너 문구 — 서버가 만든다. 앱·화면이 각자 문장을 조립하면 같은 사건이 자리마다 다르게 읽힌다.
 *  주격조사는 받침으로 판정한다(#1571 §6: 외부 행위자 이름이 영문이라 'Charles이'가 실제로 나왔다).
 */
export function notifyText(it: NotifyItem): { title: string; body: string } {
  const who = (it.actor_name || it.actor || "누군가").trim();
  const last = who.charCodeAt(who.length - 1);
  const hangul = last >= 0xac00 && last <= 0xd7a3;
  const subj = who + (hangul ? ((last - 0xac00) % 28 ? "이" : "가") : "가");   // 한글이 아니면 '가'(영문 이름)
  const where = it.project_name ? ` · ${it.project_name}` : "";
  if (it.kind === "mention") return { title: `${subj} 나를 언급했어요${where}`, body: it.body || "(내용 없음)" };
  return { title: `${subj} 댓글을 남겼어요${where}`, body: it.body || "(내용 없음)" };
}
