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

/** 저장소 하나의 값. */
export type ShellPrefValue = string[] | Record<string, string> | string;
export interface ShellPrefs {
  prefs: Record<string, ShellPrefValue>;
  /** 이 멤버가 서버에 저장한 이력이 있는가 — 프론트의 1회 이관(로컬 캐시→서버) 판단용. */
  saved?: boolean;
}

// 방어 상한 — 값은 화면 상태지 자료가 아니다. 깨진/악성 입력이 무한정 쌓이지 않게 자른다.
const MAX_ITEMS = 500;   // list 원소 수 · map 항목 수
const MAX_ID = 200;      // 한 원소(=행 키·앱 키·폴더 id)의 길이
const MAX_VAL = 64;      // map 의 값(상태 key) · str 의 길이

const clip = (v: unknown, max: number): string => String(v ?? "").slice(0, max);

/** 임의 입력을 «순서 있는 문자열 목록»으로 — 중복·빈 값·객체를 걸러낸다(순서는 사람이 고른 자리라 보존). */
function toList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const x of v) {
    if (typeof x !== "string") continue;
    const s = clip(x, MAX_ID).trim();
    if (!s) continue;
    seen.add(s);
    if (seen.size >= MAX_ITEMS) break;
  }
  return [...seen];
}

/** 임의 입력을 «문자열→문자열» 로. 값이 문자열이 아닌 항목은 버린다(빈 문자열은 뜻이 있어 남긴다). */
function toMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x !== "string") continue;
    const key = clip(k, MAX_ID).trim();
    if (!key) continue;
    out[key] = clip(x, MAX_VAL);
    if (++n >= MAX_ITEMS) break;
  }
  return out;
}

/**
 * 저장·조회 양쪽에서 도는 정규화.
 *  ⚠ **빈 값은 아예 담지 않는다** — 「고정 0개」와 「고정한 적 없음」은 이 층에서 같은 뜻이고(둘 다 화면이
 *   비어 보인다), 담아 두면 사람이 쓰지도 않은 키가 계정마다 열두 개씩 쌓인다.
 */
export function normalizeShellPrefs(input: unknown): Record<string, ShellPrefValue> {
  const src = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const out: Record<string, ShellPrefValue> = {};
  for (const [key, kind] of Object.entries(SHELL_PREF_STORES)) {
    if (!(key in src)) continue;
    if (kind === "list") { const v = toList(src[key]); if (v.length) out[key] = v; continue; }
    if (kind === "map") { const v = toMap(src[key]); if (Object.keys(v).length) out[key] = v; continue; }
    const s = typeof src[key] === "string" ? clip(src[key], MAX_VAL) : "";
    if (s) out[key] = s;
  }
  return out;
}

/** 이 멤버의 새 셸 개인화 — 없으면 빈 집합(saved:false). 행 존재 여부를 saved 로 알린다. */
export async function getShellPrefs(memberId: string): Promise<ShellPrefs> {
  if (!memberId) return { prefs: {}, saved: false };
  const rows = await q(itemsPool, `SELECT prefs FROM member_shell_pref WHERE member_id = $1`, [memberId]);
  if (!rows.length) return { prefs: {}, saved: false };
  return { prefs: normalizeShellPrefs(rows[0].prefs ?? {}), saved: true };
}

/** 새 셸 개인화 저장(전체 덮어쓰기, upsert). 정규화 후 저장·반환(프론트 즉시 반영용). */
export async function setShellPrefs(memberId: string, prefs: unknown): Promise<ShellPrefs> {
  if (!memberId) throw new Error("no member");
  const clean = normalizeShellPrefs(prefs);
  await q(itemsPool,
    `INSERT INTO member_shell_pref(member_id, prefs, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (tenant_id, member_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`,
    [memberId, JSON.stringify(clean)]);
  return { prefs: clean, saved: true };
}
