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

