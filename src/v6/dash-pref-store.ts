// 대시보드 개인화(#1129) — 멤버별 '내 프로젝트' 위젯 개요 카드 정리(리스트 순서·숨김·직접추가 핀).
//  즐겨찾기(member_favorite)와 같은 성격의 개인 UI 상태 — 감사 대상 아님, scope=null(인증만).
//  기존엔 localStorage(dash_list_order_v1 / dash_ov_hidden_v1 / dash_ov_pinned_v1, 기기별)라
//  다른 기기·브라우저·시크릿창으로 들어오면 정리가 사라져 전체 리스트가 다시 떴다 — 계정에 묶어 어디서든 유지.
import { itemsPool } from "../db/client.js";
import { q } from "../db/client.js";

export interface DashPrefs {
  list_order: number[]; // 개요 리스트 순서(드래그 재정렬)
  ov_hidden: number[];  // 숨긴 리스트 id (블랙리스트) — 미분류(0) 포함
  ov_pinned: number[];  // 직접 추가한 리스트 id (화이트리스트) — 0 이상 양수만
  saved?: boolean;      // 이 멤버가 서버에 저장한 이력이 있는가 — 프론트의 1회 이관(localStorage→서버) 판단용
}

const EMPTY: DashPrefs = { list_order: [], ov_hidden: [], ov_pinned: [] };

// 임의 입력을 정수 배열로 정규화 — 저장·조회 양쪽에서 방어적으로(악성/깨진 값 걸러냄).
function toIntArr(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) { const n = Number(x); if (Number.isFinite(n)) out.push(Math.trunc(n)); }
  return out;
}

function normalize(p: Partial<DashPrefs> | Record<string, unknown>): DashPrefs {
  const src = p as Record<string, unknown>;
  return {
    list_order: toIntArr(src.list_order),
    ov_hidden: toIntArr(src.ov_hidden),
    ov_pinned: toIntArr(src.ov_pinned).filter((n) => n > 0), // 핀은 실제 리스트(양수)만 — 미분류(0)는 핀 대상 아님
  };
}

// 이 멤버의 대시보드 개인화 — 없으면 빈 집합(saved:false). 행 존재 여부를 saved 로 알린다.
export async function getDashPrefs(memberId: string): Promise<DashPrefs> {
  if (!memberId) return { ...EMPTY, saved: false };
  const rows = await q(itemsPool, `SELECT prefs FROM member_dash_pref WHERE member_id = $1`, [memberId]);
  if (!rows.length) return { ...EMPTY, saved: false };
  return { ...normalize((rows[0].prefs ?? {}) as Record<string, unknown>), saved: true };
}

// 대시보드 개인화 저장(전체 덮어쓰기, upsert). 정규화 후 저장·반환(프론트 즉시 반영용).
export async function setDashPrefs(memberId: string, prefs: Partial<DashPrefs>): Promise<DashPrefs> {
  if (!memberId) throw new Error("no member");
  const clean = normalize(prefs);
  await q(itemsPool,
    `INSERT INTO member_dash_pref(member_id, prefs, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (tenant_id, member_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`,
    [memberId, JSON.stringify(clean)]);
  return { ...clean, saved: true };
}
