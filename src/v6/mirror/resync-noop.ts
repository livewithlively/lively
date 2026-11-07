// 무변경 재싱크 판정 — 순수(DB 무관, 단위시험 대상). mirrorKnowledgeV6 가 «이번 싱크가 이 행에 바꿀 것이 하나도 없나» 를 묻는다.
//
//  왜: 외부 좌표 upsert 는 재싱크마다 version+1 · updated_at=now() 를 했다. 증분 커서로 바뀐 것만 다시 보내는 커넥터
//   (노션 등)에서는 문제가 아니었지만, 매 실행 전량을 다시 읽는 커넥터(domain-wiki — 삭제 전파 스윕이 전량 관측을 전제한다)
//   에서는 바뀐 것이 없어도 수천 행의 판이 10분마다 오른다. 그러면 «최근 바뀐 지식» 이 늘 미러로 가득 차고, 판 번호로
//   동시 수정을 가리는 쪽(expected_version)은 아무도 안 고친 문서에서 충돌을 본다.
//  무변경이면 미러는 last_synced_at(삭제 전파 스윕의 근거)과 수집기 표식(sync_state)만 갱신한다.
//
//  «무변경» 의 정의 = upsert 의 DO UPDATE 가 쓰는 칸이 전부 지금 값과 같다. 칸을 하나라도 빠뜨리면 그 칸의 변경이
//   조용히 버려지므로, 비교 목록은 mirror-knowledge.ts 의 DO UPDATE SET 목록과 1:1 이다(그쪽을 바꾸면 여기도 본다).

/** 지금 행에서 읽은 값(pg 가 돌려준 그대로 — 시각은 Date, jsonb 는 객체). */
export interface MirrorRowNow {
  title: string | null;
  body_md: string | null;
  injection: string | null;
  provenance: string | null;
  confidence: string | null;
  source: string | null;
  lifecycle: string | null;
  external_url: string | null;
  occurred_at: Date | string | null;
  parent_external_id: string | null;
  parent_name: string | null;
  fields: unknown;
  raw: unknown;
  sort: number | string | null;
}

/** 이번 싱크가 쓰려는 값(upsert 에 넘기는 그대로). sort=null 은 «안 바꿈»(COALESCE). */
export interface MirrorRowNext {
  title: string | null;
  body_md: string;
  source: string;
  archived: boolean;
  external_url: string | null;
  occurred_at: string | null;
  parent_external_id: string | null;
  parent_name: string | null;
  fields: unknown;
  raw: unknown;
  sort: number | null;
}

/** 키 순서와 무관한 JSON — jsonb 는 키를 자기 순서로 다시 쓰므로 그대로 stringify 하면 같은 값도 다르게 보인다. */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

function sameInstant(a: Date | string | null, b: string | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  const x = new Date(a).getTime(), y = new Date(b).getTime();
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

const n = (s: string | null | undefined): string | null => (s == null ? null : String(s));

/** 바꿀 것이 하나도 없으면 true. 보관 전파 · 보관 해제(원본이 다시 나타남)는 upsert 의 lifecycle CASE 가 맡으므로 무변경이 아니다. */
export function isNoopResync(now: MirrorRowNow, next: MirrorRowNext): boolean {
  if (next.archived || now.lifecycle === "archived") return false;
  //  upsert 가 고정값으로 되돌리는 칸 — 누가 바꿔 놓았으면(예: 저장으로 provenance 를 뒤집음) 무변경이 아니다.
  if (now.injection !== "recalled" || now.provenance !== "observed" || now.confidence !== "observed") return false;
  if (n(now.source) !== n(next.source)) return false;
  if (n(now.title) !== n(next.title) || (now.body_md ?? "") !== (next.body_md ?? "")) return false;
  if (n(now.external_url) !== n(next.external_url)) return false;
  if (!sameInstant(now.occurred_at, next.occurred_at)) return false;
  if (n(now.parent_external_id) !== n(next.parent_external_id) || n(now.parent_name) !== n(next.parent_name)) return false;
  if (next.sort != null && Number(now.sort) !== next.sort) return false;
  return canonicalJson(now.fields ?? {}) === canonicalJson(next.fields ?? {})
    && canonicalJson(now.raw ?? null) === canonicalJson(next.raw ?? null);
}
