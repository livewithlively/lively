// 새 셸(v2) 개인화(#2460) — 멤버별 «사람이 고른 것»의 정본.
//
// ── 왜 서버가 정본이어야 하나 ────────────────────────────────────────────────
// 좌측 목록의 **내용**은 이미 서버 정본이다(세션·app_instance). 그런데 그 목록을 사람이 어떻게
//  정리해 뒀는지 — 무엇을 고정했고, 무엇을 × 로 치웠고, 어떤 축으로 묶었고, 무엇을 접어 뒀는지 —
//  는 전부 이 브라우저의 localStorage 에만 있었다. 그래서:
//   · 브라우저를 바꾸거나 앱↔브라우저를 오가면 정리가 **따라오지 않는다**(같은 사람인데 화면이 다르다).
//   · 핀의 키가 박스 id(`sess:<id>`)라, 복원 한 번에 id 가 바뀌면 가리킬 행이 사라져 **핀이 풀린 것으로
//     보였다**(원준 2026-08-28 "핀 해 둔 것도 다시 사라졌다. 반복된다" → #2402 가 프론트에서 우회).
//   · 브라우저 데이터를 지우면 통째로 사라진다.
//
// 대시보드 개인화(member_dash_pref, #1129)·구 셸 사이드바(member_side_pref, #1227)와 **같은 성격·같은 방식**이다:
//  서버가 정본, localStorage 는 첫 페인트용 캐시, 변경은 디바운스 write-through, `saved` 로 1회 이관.
//  감사 대상 아님 · scope=null(인증만).
//
// ⚠ 무엇을 여기 두고 무엇을 안 두나 — **«이 사람의 결정인가, 이 창의 사실인가»** 로 가른다.
//  결정(핀·치움·묶는 축·접힘·레일 순서·최근 앱)은 계정에 묶여야 어디서 들어와도 같다.
//  창의 사실(열린 탭·곁칸 배치·이름 캐시)은 그 기기의 것이라 여기 오면 안 된다 — 노트북에서 연 탭이
//  사무실 데스크톱에서 되살아나면 그게 더 이상하다. 목록은 SHELL_PREF_STORES 하나가 정하고,
//  프론트(web/v2/shell-prefs.ts)와 짝이 맞는지는 shell-prefs-seam.test.ts 가 잠근다.
//
// ── #3887 — 상한에 닿으면 **새 결정이 버려지던** 것 ─────────────────────────────
//  종전 상한은 «들어온 순서대로 앞 500개» 였다. 화면은 새 결정을 **뒤에** 붙이므로, 가득 찬 저장소에서는
//   방금 누른 × 가 서버에서 버려지고 다음 부팅의 동기가 캐시를 서버판으로 덮어 그 결정이 사라졌다 —
//   오류도 알림도 없이(실측 2026-09-10: 치움 맵이 정확히 500). 그래서 셋을 바꿨다.
//   ① 넘치면 **새것 쪽**을 남긴다(KEEP_FRONT 가 아니면 뒤가 새것) · ② 버렸으면 응답에 개수를 싣는다 ·
//   ③ 행 키 저장소는 형식이 깨진 키를 받지 않는다(실측 `sess:box-…](https:` · `route:raw:activate?code=…`).
//  그리고 기기끼리 문서를 통째로 덮던 것을 **저장소 단위 병합**(patchShellPrefs)으로 좁혔다.
import { itemsPool, q } from "../db/client.js";

/** 저장소의 모양 — list=순서 있는 문자열 목록 · map=문자열→문자열 · str=문자열 하나. */
export type ShellPrefKind = "list" | "map" | "str";

/**
 * 서버가 받아 주는 저장소와 그 모양. **여기 없는 키는 조용히 버린다** — 클라이언트가 무엇을 보내든
 *  이 표가 저장 스키마의 정본이다(구버전 셸·손으로 만든 요청이 임의 키를 쌓지 못하게).
 */
export const SHELL_PREF_STORES: Readonly<Record<string, ShellPrefKind>> = {
  lively_v2_app_pin: "list",          // 앱·세션 고정(사람이 맨 위로 올린 것)
  lively_v2_side_pin: "list",         // 프로젝트 고정
  lively_v2_side_dismissed: "map",    // × 로 치운 행 → 치울 때의 상태(그 상태가 바뀌면 다시 올라온다)
  lively_v2_side_group: "str",        // 묶는 축('proj' = 프로젝트로 묶기)
  lively_v2_side_grpclosed: "list",   // 접어 둔 프로젝트 그룹
  lively_v2_side_grpopened: "list",   // 펴 둔 프로젝트 그룹
  lively_v2_opened: "list",           // 펼쳐 둔 프로젝트
  lively_v2_side_selclosed: "list",   // 선택된 프로젝트인데도 일부러 접어 둔 것
  lively_v2_proj_fold_closed: "list", // 접어 둔 폴더
  lively_v2_rail_main: "list",        // 레일 메인 줄 순서(사람이 끌어 정한 자리)
  lively_v2_recent_apps: "list",      // 최근에 연 앱
};

/**
 * 넘칠 때 **앞을 남기는** 저장소. 나머지는 화면이 새 결정을 뒤에 붙이므로 뒤를 남긴다(#3887).
 *  · 최근 앱 — 화면이 연 앱을 **맨 앞에** 끼운다(web/v2/apps.ts noteAppUse).
 *  · 레일 순서 — 사람이 끌어 정한 자리라 앞이 윗자리다(새것·옛것이 없다).
 */
const KEEP_FRONT: ReadonlySet<string> = new Set(["lively_v2_recent_apps", "lively_v2_rail_main"]);

/**
 * 좌측 목록의 **행 키**(web/v2/main.ts sideRowKey — `sess:`·`inst:`·`route:`)를 담는 저장소.
 *  행 키는 임의의 주소에서 만들어져 쓰레기가 섞인다 — 형식이 깨진 키는 저장하지 않는다(isShellRowKey).
 *  행 키가 아닌 저장소(프로젝트 키·폴더 id·앱 키)엔 이 자를 대지 않는다 — 쓰레기가 생길 입구가 없고,
 *  자를 잘못 대면 멀쩡한 결정이 조회 때마다 지워진다(조회도 같은 정규화를 거친다).
 */
const ROW_KEY_STORES: ReadonlySet<string> = new Set(["lively_v2_app_pin", "lively_v2_side_dismissed"]);

/** 저장소 하나의 값. */
export type ShellPrefValue = string[] | Record<string, string> | string;
/** 정규화가 버린 개수 — overflow=상한을 넘친 것 · invalid=형식이 깨졌거나 너무 긴 것. 값은 싣지 않는다(일회용 코드가 든 키가 있었다). */
export interface ShellPrefDrop { overflow?: number; invalid?: number }
export interface ShellPrefs {
  prefs: Record<string, ShellPrefValue>;
  /** 이 멤버가 서버에 저장한 이력이 있는가 — 프론트의 1회 이관(로컬 캐시→서버) 판단용. */
  saved?: boolean;
  /** 이번 저장에서 버린 것(저장소 → 개수). 버린 게 없으면 칸이 없다 — 조용히 버리지 않는다(#3887). */
  dropped?: Record<string, ShellPrefDrop>;
  /** 저장소 단위 병합으로 저장했다(patchShellPrefs). 화면은 이 표식이 있을 때만 응답의 정규화 결과를 캐시에 얹는다 —
   *  옛 서버는 patch 를 모르고 통째 교체하므로 표식이 없다(#3887). */
  merged?: boolean;
}

// 방어 상한 — 값은 화면 상태지 자료가 아니다. 깨진/악성 입력이 무한정 쌓이지 않게 자른다.
const MAX_ITEMS = 500;   // list 원소 수 · map 항목 수
const MAX_ID = 200;      // 한 원소(=행 키·앱 키·폴더 id)의 길이 — 넘으면 버린다(자른 키는 아무것도 가리키지 않는다)
const MAX_VAL = 64;      // map 의 값(상태 key) · str 의 길이

const clip = (v: unknown, max: number): string => String(v ?? "").slice(0, max);

/** 서버가 세션·인스턴스 주체로 받는 자 — capabilities/app-instances.ts SUBJECT_RE 와 같다. 이 자를 못 넘는 id 는 아무것도 가리키지 않는다. */
const SUBJECT_RE = /^[A-Za-z0-9._:-]{1,160}$/;
/**
 * 화면 키에 들어올 수 없는 것 — 공백·제어문자, 따옴표·꺾쇠·백틱(브라우저가 해시에서도 늘 이스케이프한다), 그리고 마크다운 링크
 *  찌꺼기 `](`(실측 `sess:box-…](https:`). ⚠ 좁게 둔다: `[ ] { } | \ ^` 는 해시에서 브라우저가 안 바꾸는 글자라
 *  사람이 친 주소에 멀쩡히 있을 수 있고, 조회도 이 정규화를 거치므로 **오탐 하나가 곧 사람의 결정의 영구 삭제**다.
 *  `(`·`)`·`'` 는 encodeURIComponent 도 안 바꾼다(파일 경로 `report (final).pdf`).
 */
const ROUTE_BAD = /[\s\p{Cc}<>"`]|\]\(/u;
/** 쿼리에 자격이 든 화면 — 행 키로 두면 일회용 코드가 계정 행에 남는다(실측 `route:raw:activate?code=…`, device-auth 승인 주소). */
const ROUTE_SECRET = /[?&](?:code|token|access_token|refresh_token|id_token|secret|client_secret|password|passwd|api_key|apikey)=/i;

/** 좌측 목록의 행 키로 성립하나 — `sess:<주체>` · `inst:<주체>` · `route:<화면 키>`(web/v2/main.ts sideRowKey). */
export function isShellRowKey(key: string): boolean {
  if (key.startsWith("sess:") || key.startsWith("inst:")) return SUBJECT_RE.test(key.slice(5));
  if (!key.startsWith("route:")) return false;
  const r = key.slice(6);
  return r.length > 0 && !ROUTE_BAD.test(r) && !ROUTE_SECRET.test(r);
}

const bump = (drop: ShellPrefDrop, k: keyof ShellPrefDrop, n = 1): void => { drop[k] = (drop[k] ?? 0) + n; };

/** 원소·키 하나를 받아 줄까 — 문자열이 아니거나 비면 조용히(쓰레기), 길거나 행 키 형식이 깨졌으면 invalid 로 센다. */
function acceptId(x: unknown, rowKeys: boolean, drop: ShellPrefDrop): string | null {
  if (typeof x !== "string") return null;
  const s = x.trim();
  if (!s) return null;
  if (s.length > MAX_ID || (rowKeys && !isShellRowKey(s))) { bump(drop, "invalid"); return null; }
  return s;
}

/**
 * 임의 입력을 «순서 있는 문자열 목록»으로 — 중복·빈 값·객체를 걸러낸다(순서는 사람이 고른 자리라 보존).
 *  넘치면 keepFront 가 아니면 **뒤(새것)** 를 남긴다(#3887). 중복은 넘침이 아니다 — 접은 뒤에 센다.
 */
function toList(v: unknown, keepFront: boolean, rowKeys: boolean, drop: ShellPrefDrop): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const x of v) { const s = acceptId(x, rowKeys, drop); if (s) seen.add(s); }
  const all = [...seen];
  if (all.length <= MAX_ITEMS) return all;
  bump(drop, "overflow", all.length - MAX_ITEMS);
  return keepFront ? all.slice(0, MAX_ITEMS) : all.slice(all.length - MAX_ITEMS);
}

/**
 * 임의 입력을 «문자열→문자열» 로. 값이 문자열이 아닌 항목은 버린다(빈 문자열은 뜻이 있어 남긴다).
 *  넘치면 **뒤(새것)** 를 남긴다 — 화면은 치운 행을 맨 뒤에 붙인다(main.ts closeSideRow).
 */
function toMap(v: unknown, rowKeys: boolean, drop: ShellPrefDrop): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const at = new Map<string, number>();
  const entries: [string, string][] = [];
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x !== "string") continue;
    const key = acceptId(k, rowKeys, drop);
    if (!key) continue;
    const i = at.get(key);
    if (i === undefined) { at.set(key, entries.length); entries.push([key, clip(x, MAX_VAL)]); }
    else entries[i][1] = clip(x, MAX_VAL);   // 다듬은 뒤 같은 키 — 자리는 처음 것, 값은 나중 것(종전과 같다)
  }
  let kept = entries;
  if (entries.length > MAX_ITEMS) { bump(drop, "overflow", entries.length - MAX_ITEMS); kept = entries.slice(entries.length - MAX_ITEMS); }
  const out: Record<string, string> = {};
  for (const [k, x] of kept) out[k] = x;
  return out;
}

/** 저장소 하나를 정규화한다 — 비었으면 null(「고정 0개」와 「고정한 적 없음」은 이 층에서 같은 뜻이다). */
function normalizeStore(store: string, kind: ShellPrefKind, v: unknown, drop: ShellPrefDrop): ShellPrefValue | null {
  const rowKeys = ROW_KEY_STORES.has(store);
  if (kind === "list") { const out = toList(v, KEEP_FRONT.has(store), rowKeys, drop); return out.length ? out : null; }
  if (kind === "map") { const out = toMap(v, rowKeys, drop); return Object.keys(out).length ? out : null; }
  const s = typeof v === "string" ? clip(v, MAX_VAL) : "";
  return s || null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const hasDrop = (d: ShellPrefDrop): boolean => !!(d.overflow || d.invalid);

/**
 * 저장·조회 양쪽에서 도는 정규화 — 무엇을 버렸는지까지 돌려준다(#3887).
 *  ⚠ **빈 값은 아예 담지 않는다** — 「고정 0개」와 「고정한 적 없음」은 이 층에서 같은 뜻이고(둘 다 화면이
 *   비어 보인다), 담아 두면 사람이 쓰지도 않은 키가 계정마다 열두 개씩 쌓인다.
 */
export function normalizeShellPrefsReport(input: unknown): { prefs: Record<string, ShellPrefValue>; dropped: Record<string, ShellPrefDrop> } {
  const src = isObj(input) ? input : {};
  const prefs: Record<string, ShellPrefValue> = {};
  const dropped: Record<string, ShellPrefDrop> = {};
  for (const [key, kind] of Object.entries(SHELL_PREF_STORES)) {
    if (!(key in src)) continue;
    const drop: ShellPrefDrop = {};
    const v = normalizeStore(key, kind, src[key], drop);
    if (v !== null) prefs[key] = v;
    if (hasDrop(drop)) dropped[key] = drop;
  }
  return { prefs, dropped };
}

/** 저장·조회 양쪽에서 도는 정규화(버린 것은 안 묻는 자리용). */
export function normalizeShellPrefs(input: unknown): Record<string, ShellPrefValue> {
  return normalizeShellPrefsReport(input).prefs;
}

// ── 저장 형태 — 맵의 항목 순서를 칸 하나에 따로 둔다 ─────────────────────────────
//  ⚠ jsonb 는 **객체 키 순서를 지키지 않는다**(길이·바이트순으로 다시 늘어놓는다). 그러면 한 번 저장했다 읽은
//   치움 맵은 «짧은 키가 앞» 이 되어, «넘치면 앞(오래된 것)을 버린다» 가 «짧은 키부터 버린다» 로 바뀐다 —
//   하필 뜻이 살아 있는 짧은 키(`route:raw:inbox`·`route:sources`)가 먼저 나간다. 배열은 순서를 지키므로
//   맵마다 키 순서를 배열 칸(`~order:<저장소>`)에 함께 적고, 읽을 때 그 순서로 다시 세운다.
//  이 칸은 허용목록 밖이라 옛 서버는 읽을 때 무시하고 통째 저장 때 떨군다 — 순서만 잃고 맵은 멀쩡하다(되돌림 안전).
const ORDER_PREFIX = "~order:";
const orderKey = (store: string): string => ORDER_PREFIX + store;

/** 정규화된 문서 → DB 에 넣을 모양(맵 저장소마다 순서 칸을 붙인다). */
function toStored(prefs: Record<string, ShellPrefValue>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prefs };
  for (const [store, kind] of Object.entries(SHELL_PREF_STORES)) {
    if (kind === "map" && isObj(prefs[store])) out[orderKey(store)] = Object.keys(prefs[store]);
  }
  return out;
}

/**
 * DB 에서 읽은 모양 → 순서를 되살린 문서(정규화 전). 순서 칸에 없는 키(순서 칸을 모르는 서버가 쓴 것)는
 *  **앞**(더 오래된 쪽)에 둔다 — 넘칠 때 먼저 나가는 자리다.
 */
export function fromStoredShellPrefs(raw: unknown): Record<string, unknown> {
  if (!isObj(raw)) return {};
  const out: Record<string, unknown> = { ...raw };
  for (const [store, kind] of Object.entries(SHELL_PREF_STORES)) {
    const map = raw[store];
    const order = raw[orderKey(store)];
    if (kind !== "map" || !isObj(map) || !Array.isArray(order)) continue;
    const listed = new Set(order.filter((k): k is string => typeof k === "string" && Object.prototype.hasOwnProperty.call(map, k)));
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(map)) if (!listed.has(k)) next[k] = v;
    for (const k of listed) next[k] = map[k];
    out[store] = next;
  }
  return out;
}

const withDrops = (prefs: Record<string, ShellPrefValue>, dropped: Record<string, ShellPrefDrop>, memberId: string): ShellPrefs => {
  if (!Object.keys(dropped).length) return { prefs, saved: true };
  //  값은 남기지 않는다(행 키에 일회용 코드가 든 실측) — 누가 어느 저장소에서 몇 개를 잃었는지만.
  console.warn(`[shell-prefs] ${memberId}: 상한·형식으로 버림 ${JSON.stringify(dropped)}`);
  return { prefs, saved: true, dropped };
};

/** 이 멤버의 새 셸 개인화 — 없으면 빈 집합(saved:false). 행 존재 여부를 saved 로 알린다. */
export async function getShellPrefs(memberId: string): Promise<ShellPrefs> {
  if (!memberId) return { prefs: {}, saved: false };
  const rows = await q(itemsPool, `SELECT prefs FROM member_shell_pref WHERE member_id = $1`, [memberId]);
  if (!rows.length) return { prefs: {}, saved: false };
  return { prefs: normalizeShellPrefs(fromStoredShellPrefs(rows[0].prefs ?? {})), saved: true };
}

/**
 * patch 로 한 번이라도 쓴 행의 표식(저장 전용 칸). 이 행에는 **통째 교체를 받지 않는다**(setShellPrefs → null).
 *  왜: 통째 교체는 구버전 화면(배포 전에 연 탭 — 새로 고칠 때까지 옛 번들이 돈다)의 길이다. 그 탭의 캐시는 낡아서,
 *   한 번의 통째 교체가 그 사이 다른 기기에서 한 정리를 모두 덮는다. 종전엔 다음 통째 저장이 되덮어 복구했지만,
 *   새 화면은 바뀐 저장소만 보내므로 덮인 저장소를 다시 보내지 않는다 — 막지 않으면 낡은 문서가 그대로 굳는다.
 *  대가: 옛 탭에서 그 뒤에 한 결정은 서버에 안 남는다(그 탭을 새로 고치면 사라진다). 옛 서버는 이 칸을 모르고
 *   통째 교체 때 떨군다 — 되돌림(롤백) 동안은 종전 동작이다.
 */
const PATCHED_KEY = "~patched";

/**
 * 새 셸 개인화 저장(전체 덮어쓰기, upsert) — 구버전 화면의 길. 정규화 후 저장·반환(프론트 즉시 반영용).
 * @returns null = 이 행은 patch 로 관리된다 — 통째 교체를 거절했다(PATCHED_KEY). 호출부가 409 로 알린다.
 */
export async function setShellPrefs(memberId: string, prefs: unknown): Promise<ShellPrefs | null> {
  if (!memberId) throw new Error("no member");
  const { prefs: clean, dropped } = normalizeShellPrefsReport(prefs);
  const rows = await q(itemsPool,
    `INSERT INTO member_shell_pref(member_id, prefs, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (tenant_id, member_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()
       WHERE NOT (jsonb_typeof(member_shell_pref.prefs) = 'object' AND member_shell_pref.prefs ? '${PATCHED_KEY}')
     RETURNING 1 AS ok`,
    [memberId, JSON.stringify(toStored(clean))]);
  if (!rows.length) return null;
  return withDrops(clean, dropped, memberId);
}

/**
 * 저장소 단위 병합(#3887) — `patch` 에 **든 저장소만** 바꾼다. 값이 null 이거나 정규화 뒤 비면 그 저장소를 지운다.
 *  ⚠ 왜 통째 덮어쓰기로 부족한가: 화면은 저장할 때마다 문서 전체를 보낸다. 노트북이 켜 둔 채 낡은 캐시로
 *   접힘 하나를 저장하면(그룹이 활성이 되면 화면이 스스로 적는다 — side.ts grpOpened) 그 사이 데스크톱에서 한
 *   고정·치움까지 통째로 덮였다. 병합이면 그 저장은 접힘 칸만 건드린다(같은 칸끼리의 경합은 남는다).
 *  한 문장으로 병합한다 — 동시에 온 두 patch 가 서로의 다른 저장소를 지우지 않는다.
 * @returns 저장 뒤 **서버 문서 전체**(정규화) — 화면이 다른 기기의 변경을 함께 받아 간다.
 */
export async function patchShellPrefs(memberId: string, patch: unknown): Promise<ShellPrefs> {
  if (!memberId) throw new Error("no member");
  const src = isObj(patch) ? patch : {};
  const sets: Record<string, unknown> = {};
  const clears: string[] = [];
  const dropped: Record<string, ShellPrefDrop> = {};
  for (const [store, kind] of Object.entries(SHELL_PREF_STORES)) {
    if (!(store in src)) continue;
    const drop: ShellPrefDrop = {};
    const v = normalizeStore(store, kind, src[store], drop);
    if (hasDrop(drop)) dropped[store] = drop;
    if (v === null) { clears.push(store); if (kind === "map") clears.push(orderKey(store)); continue; }
    sets[store] = v;
    if (kind === "map") sets[orderKey(store)] = Object.keys(v as Record<string, string>);
  }
  if (!Object.keys(sets).length && !clears.length) return { ...(await getShellPrefs(memberId)), merged: true };
  sets[PATCHED_KEY] = true;   // 이 행은 이제 patch 로 관리된다 — 옛 번들의 통째 교체를 받지 않는다(PATCHED_KEY 머리말)
  //  저장된 값이 객체가 아니면(과거 손상·손으로 고친 행) {} 로 보고 병합한다 — `배열 || 객체` 는 배열로 굳어 영영 안 풀린다.
  const rows = await q(itemsPool,
    `INSERT INTO member_shell_pref(member_id, prefs, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (tenant_id, member_id) DO UPDATE
       SET prefs = ((CASE WHEN jsonb_typeof(member_shell_pref.prefs) = 'object' THEN member_shell_pref.prefs ELSE '{}'::jsonb END)
                    - $3::text[]) || EXCLUDED.prefs,
           updated_at = now()
     RETURNING prefs`,
    [memberId, JSON.stringify(sets), clears]);
  return { ...withDrops(normalizeShellPrefs(fromStoredShellPrefs(rows[0]?.prefs ?? {})), dropped, memberId), merged: true };
}
