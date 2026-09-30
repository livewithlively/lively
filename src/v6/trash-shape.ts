// v6 휴지통의 **모양**(#3778) — 감사 스냅샷(before) 한 장에서 사람이 볼 것만 추리는 순수 함수. DB 없음(trash-store 가 읽어 와 여기로 넘긴다).
//  따로 뺀 이유: 값으로 시험하려고(src/v6/trash-shape.test.ts). 스토어를 import 하면 풀이 딸려 온다.

// before 스냅샷에서 사람이 읽을 라벨 — 엔티티별 표시 필드.
export function labelOf(entity: string, before: Record<string, unknown> | null): string {
  const b = before ?? {};
  if (entity === "knowledge") return (b.title as string) || (b.name as string) || "(제목 없음)";
  if (entity === "project") return (b.name as string) || `#${b.id ?? ""}`;
  if (entity === "category") return (b.name as string) || (b.key as string) || `#${b.id ?? ""}`;
  if (entity === "source") return (b.title as string) || (b.name as string) || `자료 #${b.id ?? ""}`;
  return (b.name as string) || (b.key as string) || "";
}

// ── 미리보기(#3778) — 휴지통에서 «지우기 전에 내용을 본다». 스냅샷 전문에서 **읽을 것만** 추린다. ─────────────────
//  본문은 상한을 둔다(자료는 28k+ 전사록이 흔하다 — 판단에 필요한 것은 머리다). 공개범위 게이트는 호출자(capability)가
//  복원과 같은 근거(canRestore)로 먼저 건다 — 여기는 모양만 만든다.
export const PREVIEW_BODY_MAX = 20_000;
export interface DeletePreview {
  entity: string; key: string; title: string; body_md: string; truncated: boolean;
  kind: string | null; doc_type: string | null; updated_at: string | null; updated_by: string | null;
}
export function previewOf(entity: string, key: string, before: Record<string, unknown>): DeletePreview {
  const raw = entity === "project" ? String(before.description ?? "") : String(before.body_md ?? "");
  return {
    entity, key, title: labelOf(entity, before),
    body_md: raw.length > PREVIEW_BODY_MAX ? raw.slice(0, PREVIEW_BODY_MAX) : raw,
    truncated: raw.length > PREVIEW_BODY_MAX,
    kind: entity === "source" ? ((before.kind as string) ?? null) : null,
    doc_type: entity === "knowledge" ? ((before.type as string) ?? null) : null,
    updated_at: (before.updated_at as string) ?? null,
    updated_by: (before.updated_by as string) ?? null,
  };
}

// ── 수집해 온 자료(미러)인가 (#3778 2차) ─────────────────────────────────────────────────────────
//  슬랙·깃허브·디스코드처럼 **원본이 밖에 있는** 자료의 삭제 스냅샷은 휴지통에 세우지 않는다:
//   · 다음 수집 때 같은 외부 좌표로 다시 들어온다 — 되살리면 그 좌표 유니크에 부딪혀 실패한다(«이미 다시 들어와 있어요»).
//   · 사람이 지우는 문도 없다(자료 앱은 남의 시스템에서 온 것에 [휴지통으로]를 세우지 않는다). 그러니 이 줄들은 거의 전부 일괄 정리의 흔적이다
//     — 실측(lively-46e3, 2026-09-20): 8/31 하루에 지운 슬랙·깃허브·디스코드 자료 1,989건이 「자료 500」으로 서서 사람이 지운 파일 11건을 덮었다.
//  휴지통에 설 자료 = 글로 적어 둔 것(외부 좌표 없음) + 내 컴퓨터·프로젝트의 파일(system='local').
//  ⚠ trash-store.listDeleted 의 SQL 이 같은 판정을 한다 — 둘을 같이 고쳐라(상한은 거른 **뒤에** 걸려야 한다).
export const TRASHABLE_SOURCE_SYSTEMS: readonly string[] = ["", "local"];
export function isMirroredSourceSnapshot(before: Record<string, unknown> | null | undefined): boolean {
  const sys = String((before ?? {}).external_system ?? "");
  return !TRASHABLE_SOURCE_SYSTEMS.includes(sys);
}

/**
 * 완전 삭제(파기)가 비워야 하는 감사 축(#3778). 지식은 **두 축** — 항상-주입 섹션은 같은 문서가 entity='org_section' 으로도 감사된다
 *  (섹션 편집·삭제, org/store/sections.ts). 한 축만 비우면 «완전히 지웠다» 는 문서의 본문이 다른 축에 그대로 남는다.
 *  다른 종류는 제 축 하나 — 모르는 종류도 그 이름 그대로(넓히지 않는다: 남의 축을 비우는 쪽이 더 나쁘다).
 */
export const purgeAxesOf = (entity: string): string[] => (entity === "knowledge" ? ["knowledge", "org_section"] : [entity]);

