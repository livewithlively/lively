// 범용 수집기 — 경로 추출 + 필드 매핑(#1419 T2). "코드 없이 새 소스를 붙인다"의 심장.
//
//  하는 일 하나: **임의 JSON 응답 → 우리 RawItem**. 그 변환을 코드가 아니라 **설정(문자열 경로)** 으로 적는다.
//   { title: "$.subject", body: "$.content.text", author_email: "$.creator.email" }
//
//  ⚠ 왜 JSONPath 라이브러리를 안 쓰나: 우리가 필요한 건 '한 값을 집는 경로'뿐이다(필터·와일드카드·재귀
//   하강 같은 질의는 매핑에 쓸 일이 없다). 그걸 위해 의존성을 늘리면 평가기 하나를 통째로 신뢰해야 하고,
//   그 평가기는 관리자가 화면에 친 문자열을 먹는다. 필요한 문법만 직접 구현하는 편이 작고 안전하다.
//
//  지원 문법(의도적으로 좁다):
//    $.a.b        객체 필드           ·  a.b (선두 $. 생략 가능)
//    $.a[0]       배열 인덱스          ·  $.a[-1] 뒤에서 세기
//    $.a[].b      배열 각 원소의 b     → 값이 여럿이면 목록으로(첫 값이 필요한 자리는 첫 값을 쓴다)
//    $            루트 자체
//    a\.b         점이 들어간 키(이스케이프)

/** 경로 한 조각 — 키 또는 인덱스 또는 '전개'. */
type Seg = { kind: "key"; key: string } | { kind: "index"; i: number } | { kind: "each" };

/** 경로 문자열 → 조각들. 잘못된 경로는 빈 배열이 아니라 null(=경로 자체가 틀림)로 구분한다. */
export function parsePath(path: string): Seg[] | null {
  let s = String(path ?? "").trim();
  if (!s) return null;
  if (s === "$") return [];
  if (s.startsWith("$.")) s = s.slice(2);
  else if (s.startsWith("$[")) s = s.slice(1);

  const segs: Seg[] = [];
  let buf = "";
  const flushKey = () => { if (buf) { segs.push({ kind: "key", key: buf }); buf = ""; } };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) { buf += s[++i]; continue; } // 이스케이프 — 점 든 키
    if (c === ".") { flushKey(); continue; }
    if (c === "[") {
      flushKey();
      const close = s.indexOf("]", i);
      if (close < 0) return null;
      const inner = s.slice(i + 1, close).trim();
      if (inner === "") segs.push({ kind: "each" });
      else if (/^-?\d+$/.test(inner)) segs.push({ kind: "index", i: Number(inner) });
      else if (/^['"].*['"]$/.test(inner)) segs.push({ kind: "key", key: inner.slice(1, -1) });
      else return null;
      i = close;
      continue;
    }
    buf += c;
  }
  flushKey();
  return segs;
}

/**
 * 경로로 값들을 뽑는다. `[]`(each)가 있으면 여러 값이 나올 수 있어 **항상 배열**로 돌려준다.
 *  없는 경로는 빈 배열 — 던지지 않는다(한 항목의 매핑 실패로 배치 전체를 죽이지 않는다).
 */
export function extractAll(root: unknown, path: string): unknown[] {
  const segs = parsePath(path);
  if (!segs) return [];
  let cur: unknown[] = [root];
  for (const seg of segs) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (v == null) continue;
      if (seg.kind === "key") {
        if (typeof v === "object" && !Array.isArray(v)) {
          const got = (v as Record<string, unknown>)[seg.key];
          if (got !== undefined) next.push(got);
        }
      } else if (seg.kind === "index") {
        if (Array.isArray(v)) {
          const idx = seg.i < 0 ? v.length + seg.i : seg.i;
          if (idx >= 0 && idx < v.length) next.push(v[idx]);
        }
      } else { // each
        if (Array.isArray(v)) next.push(...v);
      }
    }
    cur = next;
    if (!cur.length) break;
  }
  return cur;
}

/** 단일 값 — 첫 매치. 없으면 undefined. */
export function extractOne(root: unknown, path: string): unknown {
  return extractAll(root, path)[0];
}

/** 스칼라를 문자열로. 객체·배열은 JSON 으로 접는다(본문 매핑이 통째 객체를 가리켜도 뭐라도 남게). */
export function asText(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try { return JSON.stringify(v); } catch { return undefined; }
}

/**
 * 시각 정규화 → ISO8601. 커서 전진이 이 값에 걸려 있어 **못 읽으면 조용히 넘기지 않고 undefined** 로 둔다
 *  (엉뚱한 시각으로 커서를 밀면 그 구간이 영영 안 읽힌다 — 조용한 유실).
 *  받는 모양: ISO 문자열 · epoch 초/밀리초(숫자 또는 숫자문자열) · Date 파싱 가능한 문자열.
 */
export function asIso(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "number" || (typeof v === "string" && /^\d{9,14}$/.test(v.trim()))) {
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    // 10자리=초, 13자리=밀리초. 그 사이는 자릿수로 판정한다(2001년 이후 epoch 초는 10자리).
    const ms = String(Math.trunc(n)).length <= 10 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof v === "string") {
    const d = new Date(v.trim());
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

/** 관리자가 화면에서 정의하는 '응답의 어느 값이 우리의 무엇인가' 표. 전부 선택(빈 값 = 매핑 안 함). */
export interface FieldMap {
  /** 필수 — 이 소스 안에서 항목을 고유하게 가리키는 값. 멱등 upsert 의 열쇠라 없으면 항목을 버린다. */
  external_id?: string;
  title?: string;
  body?: string;
  url?: string;
  occurred_at?: string;
  updated_at?: string;
  author_id?: string;
  author_name?: string;
  author_email?: string;
  container_ref?: string;
  container_name?: string;
  parent_external_id?: string;
  /** 추가 보존 필드 — { 우리키: 경로 }. RawItem.fields 로 들어간다(#735 메타 유실 방지 계승). */
  extra?: Record<string, string>;
}

export interface MapItemOpts {
  system: string;
  instance?: string;
  /** provenance.category — 기본 'collab_tool'. */
  category?: string;
  /** RawItem.type — 기본 'note'. */
  type?: import("../../items/store.js").RawItem["type"];
  /** external_url 상대경로를 절대화할 베이스(선택). */
  baseUrl?: string;
}

/**
 * 응답 항목 1건 → RawItem. **external_id 가 없으면 null** — 멱등 키가 없는 항목은 적재할 수 없다
 *  (매번 새 행이 되거나 남의 행을 덮는다). 호출자가 세어 '몇 건이 매핑 실패였는지' 보고한다.
 */
export function mapToRawItem(
  raw: unknown, map: FieldMap, opts: MapItemOpts,
): import("../../items/store.js").RawItem | null {
  const pick = (p?: string): unknown => (p && p.trim() ? extractOne(raw, p) : undefined);
  const pickText = (p?: string): string | undefined => asText(pick(p));

  const externalId = pickText(map.external_id);
  if (!externalId) return null;

  let url = pickText(map.url);
  if (url && opts.baseUrl && !/^https?:\/\//i.test(url)) {
    try { url = new URL(url, opts.baseUrl).toString(); } catch { /* 조립 실패면 원문 유지 */ }
  }

  const fields: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(map.extra ?? {})) {
    const v = pick(p);
    if (v !== undefined) fields[k] = v;
  }
  // 채널명은 증류·지식화 맥락의 핵심이라 fields 에도 남긴다(#735 와 같은 이유 — id만 남으면 맥락이 죽는다).
  const containerName = pickText(map.container_name);
  if (containerName) fields.container_name = containerName;

  const occurred = asIso(pick(map.occurred_at));
  const updated = asIso(pick(map.updated_at));

  return {
    type: opts.type ?? "note",
    provenance: {
      category: opts.category ?? "collab_tool",
      system: opts.system,
      instance: opts.instance,
      external_id: externalId,
      external_url: url,
    },
    actor: {
      external_id: pickText(map.author_id),
      display_name: pickText(map.author_name),
      email: pickText(map.author_email),
    },
    container_ref: pickText(map.container_ref),
    container_name: containerName,
    parent_external_id: pickText(map.parent_external_id),
    title: pickText(map.title),
    body: pickText(map.body),
    occurred_at: occurred,
    // updated_at 이 없으면 occurred 로 폴백 — 커서는 updated ?? occurred 를 보므로 둘 다 비면 그 항목은
    //  커서를 전진시키지 못한다(매 run 재수집). 하나라도 있으면 진행이 된다.
    updated_at: updated ?? occurred,
    fields: Object.keys(fields).length ? fields : undefined,
    raw,
  };
}
