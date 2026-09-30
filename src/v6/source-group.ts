// 자료가 **들어온 길**(#4233, 원준 2026-09-26): 자료 한 건은 셋 중 하나에만 속한다. 판정은 이 파일 한 벌이다.
//  원준: "1. 올린 자료 2. 수집한 자료 3. 라이블리에서 만들어진 자료 이렇게 나누면 MECE한가? … 직관적으로 딱딱딱 나눠지니까."
//
//  · 올린 자료(uploaded)   = 사람이 바깥에서 가져온 파일. 자료 앱 올리기 · 세션 입력칸 첨부 · 프로젝트 폴더 · 태스크 첨부 · 온보딩.
//  · 수집한 자료(collected) = 연결한 앱(슬랙 · 디스코드 · 깃허브 …)에서 가져온 것.
//  · 라이블리에서 만든 자료 = AI가 만든 파일(made_ai) + 직접 적은 글(made_note, external_system IS NULL).
//
//  파일(external_system='local')을 올린 자료와 AI가 만든 파일로 가르는 값은 fields.entry 다(ingest/upload-entry.ts 가 올릴 때 적는다).
//  ⚠ entry 가 'generated' 인 것만 AI 파일이다. 값이 없는 옛 행 · 모르는 값은 올린 자료로 센다: 옛 행은 어느 길로 왔는지
//   기록이 없어서 가를 수 없다(업로드 요청에 세션 표시가 남지 않았다). 다음에 다시 올라올 때 그때의 값을 받는다.
//  ⚠ 아래 술어는 source 를 다시 훑지 않는 **행 안의 비교**뿐이다: 나무 집계처럼 LIMIT 없는 자리에서도 쓰이므로
//   서브쿼리를 넣지 마라(source-store.ts FOLD_REPLY 머리말의 2026-09-14 장애).

export const SOURCE_GROUPS = ["uploaded", "collected", "made_ai", "made_note"] as const;
export type SourceGroup = (typeof SOURCE_GROUPS)[number];
/** 거르개 값: 네 갈래에 「라이블리에서 만든 자료」 카드 머리(둘 다)를 더한다. */
export const SOURCE_GROUP_FILTERS = [...SOURCE_GROUPS, "made"] as const;
export type SourceGroupFilter = (typeof SOURCE_GROUP_FILTERS)[number];

export const ENTRY_GENERATED = "generated";
export const ENTRY_UPLOAD = "upload";

const AI_FILE = `(s.external_system = 'local' AND s.fields->>'entry' = '${ENTRY_GENERATED}')`;

/** 거르개 한 값 → WHERE 의 AND 항 하나('s' 별칭). 모르는 값은 null(호출부가 거르지 않는다: 입력 스키마가 먼저 막는다). */
export function sourceGroupWhere(g: string | undefined | null): string | null {
  switch (g) {
    case "uploaded": return `(s.external_system = 'local' AND s.fields->>'entry' IS DISTINCT FROM '${ENTRY_GENERATED}')`;
    case "made_ai": return AI_FILE;
    case "made_note": return `s.external_system IS NULL`;
    case "made": return `(s.external_system IS NULL OR ${AI_FILE})`;
    case "collected": return `(s.external_system IS NOT NULL AND s.external_system <> 'local')`;
    default: return null;
  }
}

/** 나무 집계의 갈래 칸: CASE 가 위에서부터 한 번만 맞으므로 가지마다 정확히 한 갈래다. */
export const SOURCE_GROUP_CASE = `CASE WHEN s.external_system IS NULL THEN 'made_note'
            WHEN ${AI_FILE} THEN 'made_ai'
            WHEN s.external_system = 'local' THEN 'uploaded'
            ELSE 'collected' END`;

/** 같은 판정의 JS 판(시험 · 화면 폴백용). SQL 과 한 규칙이다. */
export function sourceGroupOf(row: { external_system?: string | null; fields?: Record<string, unknown> | null }): SourceGroup {
  const sys = row.external_system ?? null;
  if (sys === null) return "made_note";
  if (sys === "local") return (row.fields && row.fields.entry === ENTRY_GENERATED) ? "made_ai" : "uploaded";
  return "collected";
}
