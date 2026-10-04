// 세션 이력 앱 «작업 일지»(#4553, 원준 2026-10-04) — 순수 규칙. DB 를 쓰지 않는다(저장 경로는 session-journal-store.ts).
//
//  ── 무엇을 정하나 ──
//   작업 기록(activity)은 **박스**(실행 세션 id)에 붙고, 세션 이력의 한 줄은 **대화**(uuid)다. 한 박스는 살면서 대화를 여러 번
//   갈아탄다(/clear · resume · 포크 — org_session_conv). 그래서 «이 작업 기록은 어느 대화의 것인가» 를 정해야 한다.
//   박스에 붙은 기록을 그 박스의 모든 대화에 실으면 같은 한 일이 여러 줄에 겹쳐 서고, 주간 합계가 부풀려진다.
//
//  ── 규칙 ──
//   ① 기록의 세션 id 가 대화 uuid 그 자체면 그 대화다(박스 없이 도는 하네스).
//   ② 아니면 그 박스가 돌린 대화들을 «처음 본 때» 순으로 세우고, 기록 시각 **이전에 시작한 것 중 가장 늦은 대화**에 붙인다.
//      기록이 첫 대화보다 이르면 첫 대화, 시각이 없으면 마지막 대화.
//   ③ 박스가 돌린 대화를 하나도 모르면 붙이지 않는다(추측으로 남의 줄에 싣지 않는다).
//   결과는 대화 uuid 다 — 그 대화가 지금 보는 목록(기간·휴지통)에 없으면 호출부가 버린다. 목록에 없는 대화의 기록을
//   목록에 있는 형제 대화로 끌어오지 않는다.

/** 박스 ↔ 대화 한 쌍. first_seen = 그 박스가 그 대화를 처음 돌린 때(모르면 null — 가장 이른 것으로 본다). */
export interface JournalBoxLink { box_id: string; conv_uuid: string; first_seen: string | null }
/** 작업 기록 한 건의 좌표 — box = activity.session_id(박스 id 또는 대화 uuid), at = 기록 시각. */
export interface JournalActRef { id: number; box: string; at: string | null }

const msOf = (iso: string | null): number => {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
};

/**
 * 작업 기록마다 그 기록이 속한 대화 uuid. 못 정한 기록은 결과에 없다.
 *  convIds = 대화 uuid 로 알려진 것(규칙 ①의 판정 — 박스 id 와 대화 uuid 는 꼴이 겹치지 않지만 꼴로 가르지 않는다).
 */
export function assignActivities(links: JournalBoxLink[], acts: JournalActRef[], convIds: ReadonlySet<string>): Map<number, string> {
  const byBox = new Map<string, Array<{ conv: string; at: number }>>();
  for (const l of links) {
    if (!l.box_id || !l.conv_uuid) continue;
    const arr = byBox.get(l.box_id) ?? [];
    const at = msOf(l.first_seen);
    const cur = arr.find((x) => x.conv === l.conv_uuid);
    //  같은 쌍이 두 번 오면(대화 사슬 표 + 박스의 «지금 대화» 폴백) 시각을 아는 쪽이 이긴다.
    if (cur) { if (Number.isNaN(cur.at) && !Number.isNaN(at)) cur.at = at; }
    else arr.push({ conv: l.conv_uuid, at });
    byBox.set(l.box_id, arr);
  }
  //  시각 모름(NaN)은 맨 앞 — «가장 이른 것» 으로 본다. 같은 시각이면 들어온 순서를 지킨다.
  for (const arr of byBox.values()) arr.sort((a, b) => (Number.isNaN(a.at) ? -Infinity : a.at) - (Number.isNaN(b.at) ? -Infinity : b.at));

  const out = new Map<number, string>();
  for (const a of acts) {
    if (convIds.has(a.box)) { out.set(a.id, a.box); continue; }
    const convs = byBox.get(a.box);
    if (!convs || !convs.length) continue;
    const at = msOf(a.at);
    if (Number.isNaN(at)) { out.set(a.id, convs[convs.length - 1]!.conv); continue; }
    let pick = convs[0]!;
    for (const c of convs) { if (Number.isNaN(c.at) || c.at <= at) pick = c; else break; }
    out.set(a.id, pick.conv);
  }
  return out;
}

/** 일지 기간 — since ≤ 마지막 활동 < until. 둘 다 ISO 로 읽히는 것만 받는다(못 읽으면 null = 그쪽 끝 없음). */
export function parseJournalRange(since: unknown, until: unknown): { since: string | null; until: string | null } {
  const iso = (v: unknown): string | null => {
    if (v == null || v === "") return null;
    const t = Date.parse(String(v));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  };
  return { since: iso(since), until: iso(until) };
}

/** 한 번에 주는 일지 줄 상한 — 넘으면 truncated 로 말한다. */
export const JOURNAL_MAX = 500;
export const clampJournalLimit = (v: unknown): number => Math.min(Math.max(Math.floor(Number(v)) || 200, 1), JOURNAL_MAX);
