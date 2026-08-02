// 프로젝트 사이드바 개인화(#1227) — 멤버별 폴더·스페이스 접힘/펼침 상태.
//  대시보드 개인화(member_dash_pref, #1129)와 같은 성격의 개인 UI 상태 — 감사 대상 아님, scope=null(인증만).
//  기존엔 인메모리 Map(pjvFolderOpen, 탭 세션 한정)이라 **새로고침만 해도 접어둔 폴더가 전부 다시 펼쳐졌다**.
//  계정에 묶어 어느 기기·브라우저로 들어와도 접어둔 대로 유지한다.
//
//  왜 '닫힘'과 '열림' 두 배열인가 — 기본값이 항목마다 다르기 때문(일반 폴더=펼침, 아카이브=접힘).
//  '명시적으로 접은 것'과 '명시적으로 편 것'을 따로 담아야 프론트의 3상태 Map(미설정/false/true)이 그대로 복원된다.
import { itemsPool } from "../db/client.js";
import { q } from "../db/client.js";

export interface SidePrefs {
  folder_closed: number[]; // 사용자가 접은 폴더 id (기본 펼침인 일반 폴더·스페이스)
  folder_open: number[];   // 사용자가 편 폴더 id (기본 접힘인 아카이브 등)
  saved?: boolean;         // 이 멤버가 서버에 저장한 이력이 있는가 — 프론트의 1회 이관(로컬 캐시→서버) 판단용
}

const EMPTY: SidePrefs = { folder_closed: [], folder_open: [] };
const MAX_IDS = 2000; // 방어 상한 — 폴더 수는 수십~수백 규모. 깨진/악성 입력이 무한정 쌓이지 않게.

// 임의 입력을 폴더 id 배열로 정규화 — 저장·조회 양쪽에서 방어적으로(깨진 값·중복 걸러냄).
function toIdArr(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<number>();
  for (const x of v) {
    const n = Number(x);
    if (!Number.isFinite(n)) continue;
    const id = Math.trunc(n);
    if (id <= 0) continue; // 폴더 id 는 양수
    seen.add(id);
    if (seen.size >= MAX_IDS) break;
  }
  return [...seen];
}

function normalize(p: Partial<SidePrefs> | Record<string, unknown>): SidePrefs {
  const src = p as Record<string, unknown>;
  const closed = toIdArr(src.folder_closed);
  const closedSet = new Set(closed);
  return {
    folder_closed: closed,
    // 같은 폴더가 양쪽에 들어오면 '닫힘'을 우선(모순 입력 방어) — 한 폴더가 두 상태를 가질 수 없다.
    folder_open: toIdArr(src.folder_open).filter((id) => !closedSet.has(id)),
  };
}

// 이 멤버의 사이드바 개인화 — 없으면 빈 집합(saved:false). 행 존재 여부를 saved 로 알린다.
export async function getSidePrefs(memberId: string): Promise<SidePrefs> {
  if (!memberId) return { ...EMPTY, saved: false };
  const rows = await q(itemsPool, `SELECT prefs FROM member_side_pref WHERE member_id = $1`, [memberId]);
  if (!rows.length) return { ...EMPTY, saved: false };
  return { ...normalize((rows[0].prefs ?? {}) as Record<string, unknown>), saved: true };
}

// 사이드바 개인화 저장(전체 덮어쓰기, upsert). 정규화 후 저장·반환(프론트 즉시 반영용).
export async function setSidePrefs(memberId: string, prefs: Partial<SidePrefs>): Promise<SidePrefs> {
  if (!memberId) throw new Error("no member");
  const clean = normalize(prefs);
  await q(itemsPool,
    `INSERT INTO member_side_pref(member_id, prefs, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (member_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`,
    [memberId, JSON.stringify(clean)]);
  return { ...clean, saved: true };
}
