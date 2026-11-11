// 외부 미러 지식의 내용 쓰기 가드 — 순수 판정(DB·HTTP 무관). 핸들러가 이걸 태우고 400 으로 옮긴다.
//
//  왜: 미러(외부 좌표가 있는 행)의 제목 · 본문은 원본이 진실이다. 커넥터 재싱크가 title · body_md 를 원본 값으로
//   통째로 덮으므로(v6/mirror/mirror-knowledge.ts), 여기서 고친 내용은 다음 싱크에 **조용히** 사라진다 — 저장은
//   성공으로 응답했는데 내용이 없어지는, 가장 헷갈리는 실패다. edit · append · fields · 이동은 이미 막혀 있었는데
//   통째 저장(knowledge_save replace)과 제목 갱신(knowledge_set_title)이 비어 있었다(lifecycle-guard.ts 주석이 그 구멍을
//   적어 둔다 — replace 로 provenance 를 'authored' 로 뒤집을 수도 있었다). 웹 화면은 미러에 편집 버튼을 숨기지만
//   UI 숨김은 안내일 뿐 규칙이 아니다.
//
//  ⚠ 미러의 표식은 provenance 가 아니라 **external_system** 이다(lifecycle-guard.ts 와 같은 판단). 에이전트가
//   knowledge_save 로 직접 쓴 observed 기록(외부 관찰 메모)에는 좌표가 없고 어느 싱크도 덮지 않는다 — 그건 막지 않는다.
//  ⚠ 카테고리 · 연결 · WIKI 핀 · 검색 제외는 이 가드 대상이 아니다. 재싱크가 건드리지 않는 우리 쪽 메타라 살아남는다.

export interface MirrorGuardRow {
  external_system?: string | null;
  external_url?: string | null;
}

/** 막아야 하면 사람이 읽을 사유, 통과면 null. what = 무엇을 하려 했나(문구용). */
export function denyMirrorContentWrite(row: MirrorGuardRow | null | undefined, what: "save" | "title"): string | null {
  const system = String(row?.external_system ?? "").trim();
  if (!system) return null;
  const act = what === "title" ? "제목을 바꿀" : "본문·제목을 고칠";
  const where = row?.external_url ? ` 원본: ${row.external_url}` : "";
  return `외부 미러 지식(${system})은 라이블리에서 ${act} 수 없습니다 — 다음 재싱크가 원본 내용으로 통째로 덮어 고친 내용이 사라집니다. `
    + `원본에서 고치세요.${where} 해석·판단은 별도 지식(authored)으로 쓰고 knowledge_link 로 이 지식에 이으세요.`;
}
