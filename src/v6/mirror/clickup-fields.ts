// ClickUp 필드/상태 순수 매핑 + 3-way 머지 원시함수(#1313 R20 — connector-mirror.ts 에서 verbatim 이관).
//  DB/IO 무의존 leaf — connector-mirror.js 배럴이 그대로 재수출하므로 소비자(list-store·R7 테스트) import 는 무변.

// 정규 카테고리 → CHECK 유효 네이티브 status 투영(UI 호환). 역(네이티브→카테고리)=project-store.categoryOf.
//  네이티브 status CHECK 엔 canceled 가 없어 done 으로 투영 — 원본은 status_raw/status_category 에 보존(무손실).
export function nativeStatusOf(category: string): string {
  switch (category) {
    case "done": return "done";
    case "canceled": return "done";
    case "started": return "in_progress";
    default: return "todo"; // backlog | unstarted
  }
}

// 필드별 3-way 머지(#6d). base=마지막 합의값, ours=현 DB, theirs=인입(ClickUp). null/undefined 정규화 비교.
//  theirs==base → ours(외부 불변, 우리 편집 보존) · ours==base → theirs(우리 불변, 외부 편집 채택) ·
//  양쪽 변경(충돌) → ours(우리 DB=master 최종 타이브레이크). base 미상(NULL)이면 ours==NULL 일 때만 theirs
//  (미설정 필드는 외부값 채택 — 레거시 행의 신규 필드 백필 경로).
export function merge3<T>(base: T | null | undefined, ours: T | null | undefined, theirs: T | null | undefined): T | null {
  const b = base ?? null, o = ours ?? null, t = theirs ?? null;
  if (o === t) return o;   // 둘이 같음
  if (t === b) return o;   // theirs 불변 → ours 유지
  if (o === b) return t;   // ours 불변 → theirs 채택
  return o;                // 충돌 → ours(우리 DB 타이브레이크)
}

// 집합 3-way 머지(태그 등 이름 집합) — result = (ours − (base−theirs)) ∪ (theirs−base).
//  외부 추가는 들어오고, 외부 삭제는 우리가 재추가하지 않은 것만 빠진다. 충돌 없는 결정적 수렴.
export function mergeSet(base: string[] | null | undefined, ours: string[], theirs: string[]): string[] {
  const b = new Set(base ?? []), t = new Set(theirs);
  const removedByThem = [...b].filter((x) => !t.has(x));
  const addedByThem = theirs.filter((x) => !b.has(x));
  const out = new Set(ours.filter((x) => !removedByThem.includes(x)));
  for (const x of addedByThem) out.add(x);
  return [...out];
}

// ms epoch(문자열/숫자) → 'YYYY-MM-DD'(KST — 조직 표준시. 원본 ms 는 fields 백스톱에 병존).
export function msToKstDate(ms?: unknown): string | null {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const kst = new Date(n + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

// ClickUp 커스텀필드 타입 → 우리 task_field 타입(task-field-store FIELD_TYPES). 미지 타입은 text(+원본 config 보존).
export function mapClickUpFieldType(t?: string | null): string {
  switch (t) {
    case "text": case "short_text": return "text";
    case "textarea": return "textarea";
    case "number": return "number";
    case "money": case "currency": return "money";
    case "date": return "date";
    case "drop_down": return "dropdown";
    case "labels": return "labels";
    case "checkbox": return "checkbox";
    case "url": return "website";
    case "email": return "email";
    case "phone": return "phone";
    case "emoji": case "rating": return "rating";
    case "manual_progress": return "progress";
    case "automatic_progress": return "progress_auto";
    case "tasks": case "list_relationship": return "relationship";
    case "location": return "location";
    default: return "text";
  }
}

// ClickUp type_config → 우리 config(dropdown/labels options=[{id,label,color}], money currency, rating max).
export function mapClickUpFieldConfig(t: string | null | undefined, tc: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  const options = Array.isArray(tc?.options) ? tc!.options as Array<Record<string, unknown>> : [];
  if (t === "drop_down" || t === "labels") {
    cfg.options = options.map((o) => ({
      id: String(o.id ?? o.orderindex ?? o.name ?? ""),
      label: String(o.name ?? o.label ?? ""),
      color: (o.color as string | null) ?? null,
    }));
  }
  if (t === "money") cfg.currency = (tc?.currency_type as string) ?? "USD";
  if (t === "emoji" || t === "rating") cfg.max = Number(tc?.count ?? 5) || 5;
  cfg.clickup = { type: t ?? null, type_config: tc ?? null }; // 원본 정의 백스톱
  return cfg;
}

// ClickUp 필드값 → 우리 value(JSONB). 타입별 디코드, 실패는 원본 그대로(JSONB 수용 — 손실 0).
export function mapClickUpFieldValue(t: string | null | undefined, value: unknown, tc: Record<string, unknown> | null | undefined): unknown {
  if (value === undefined || value === null) return null;
  try {
    const options = Array.isArray(tc?.options) ? tc!.options as Array<Record<string, unknown>> : [];
    const optId = (v: unknown): string | null => {
      const byId = options.find((o) => String(o.id) === String(v));
      if (byId) return String(byId.id);
      const byIdx = options.find((o) => Number(o.orderindex) === Number(v));
      return byIdx ? String(byIdx.id ?? byIdx.orderindex) : null;
    };
    switch (t) {
      case "drop_down": return optId(value) ?? value;
      case "labels": return Array.isArray(value) ? value.map((v) => optId(v) ?? String(v)) : value;
      case "checkbox": return value === true || value === "true";
      case "number": case "money": case "emoji": case "rating": {
        const n = Number(value); return Number.isFinite(n) ? n : value;
      }
      case "date": return msToKstDate(value) ?? value;
      case "users": return Array.isArray(value)
        ? (value as Array<Record<string, unknown>>).map((u) => String(u?.username ?? u?.email ?? u?.id ?? "")).filter(Boolean).join(", ")
        : value;
      case "manual_progress": case "automatic_progress": {
        const pc = (value as Record<string, unknown>)?.percent_complete ?? (value as Record<string, unknown>)?.current ?? value;
        const n = Number(pc); return Number.isFinite(n) ? Math.round(n) : value;
      }
      default: return typeof value === "string" ? value : value;
    }
  } catch { return value; }
}
