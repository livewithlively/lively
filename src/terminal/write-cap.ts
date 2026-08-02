// 중앙 박스 — 세션 기록 범위(write cap, #1291 v2) + 세션 가시성 술어. terminal-sessions.ts 분할(#1313 R15).
import { dirToProjectFolder } from "../project/project-fs.js";
import { hiddenProjects, type HiddenProjects } from "../v6/visibility.js";
import { axisOn } from "../v6/visibility-axes.js";
import { PUBLIC_VIEWER } from "../v6/visibility.js";
import { getSessionState } from "../sessions/session-state.js";
import { tmux, sessionDir } from "./tmux-exec.js";

// ── 세션 기록 범위(write cap, #1291 v2) ───────────────────────────────────────
//  "이 세션이 **사용자 승인 없이** 만들 수 있는 맥락의 최대 가시성". 열람 축과 직교한다:
//  열람은 하드 경계(누가 보나), 이건 거버넌스 가드레일(AI 가 실수로 넓게 기록하는 걸 막는다).
//
//  ⚠ 조회 계약(설계 §3.5) — 여기가 이 기능의 정확성 전부다:
//   ① 권위 서열: 살아있는 tmux → DB 미러(죽은/복원 대기) → 실행 폴더 파생.
//   ② **오류 ≠ 미설정**: getOpt 는 tmux 타임아웃도 빈 문자열로 삼킨다(부하 시 실측된 함정 — #687).
//      그 값을 '미설정'으로 읽으면 좁혀둔 캡이 조용히 넓어진다. 그래서 여기선 tmux 를 직접 부르고
//      **실패와 미설정을 구분**한다.
//   ③ 실패의 방향: 판정 불가면 가장 좁은 값(private). 넓히는 쪽으로 실패하면 그게 곧 사고다.
export type WriteCap = "open" | "audience" | "private";
const CAP_TTL_MS = 30_000;
const capCache = new Map<string, { v: WriteCap; at: number }>();

/** 캡이 바뀌었으면 캐시를 버린다(세션 편집 경로에서 호출). */
export function invalidateWriteCap(sessionId?: string): void {
  if (sessionId) capCache.delete(sessionId); else capCache.clear();
}

/** 자유 입력 → 캡. 모르는 값은 null(=미지정, 폴더에서 파생). 세션 생성 라우트도 이걸로 걸러
 *  임의 문자열이 tmux 옵션에 그대로 박히는 걸 막는다(#1291 v2). */
export function normalizeCap(v: string | null | undefined): WriteCap | null {
  const x = String(v ?? "").trim().toLowerCase();
  return x === "open" || x === "audience" || x === "private" ? x : null;
}

/**
 * 이 세션의 기록 범위. 세션 id 가 없으면(로컬·헤더 없는 호출) 'open' — 종전 동작이다.
 *  ⚠ 세션이 있는데 판정을 못 하면 'private'(닫는 쪽)이다.
 */
export async function sessionWriteCap(sessionId: string | null | undefined): Promise<WriteCap> {
  const id = String(sessionId ?? "").trim();
  if (!id) return "open";
  // 축 꺼짐(#1291) — 캡을 안 건다. 'open' 이 곧 "승인 없이 무엇이든 기록 가능"(종전 동작)이다.
  if (!(await axisOn("session_cap"))) return "open";
  const hit = capCache.get(id);
  if (hit && Date.now() - hit.at < CAP_TTL_MS) return hit.v;

  const remember = (v: WriteCap): WriteCap => { capCache.set(id, { v, at: Date.now() }); return v; };
  let tmuxAlive = false;
  try {
    // 살아있는 tmux 가 권위. 옵션이 비어 있으면 '미설정'(아래 파생)이다.
    const raw = (await tmux(["show-options", "-t", id, "-v", "@box_write_vis"])).trim();
    tmuxAlive = true;
    const cap = normalizeCap(raw);
    if (cap) return remember(cap);
  } catch {
    // tmux 가 답을 못 줬다(종료됐거나, 타임아웃·과부하). **어느 쪽이든 미러로 간다.**
    //  여기서 곧장 private 로 닫으면, 아무것도 안 잠근 조직에서 tmux 가 한 번 느려지는 것만으로
    //  전체 공개 프로젝트의 activity_log 가 400 이 된다 — "잠그기 전까지 동작 변화 0" 이라는
    //  이 기능의 전제를 일시적 장애가 깨는 셈이다(#687 은 실제로 있는 조건이다).
    //  미러는 추측이 아니라 **desired-state** 다: 캡을 명시한 세션은 생성 시 tmux 와 미러에 함께 쓰이므로
    //  (createSession), 명시된 값은 언제나 미러에 있다. 닫는 쪽으로 가는 건 미러 조회마저 실패할 때다.
  }

  try {
    const st = await getSessionState(id);
    const cap = normalizeCap(st?.write_vis);
    if (cap) return remember(cap);
    // 미러에 값이 없다 = 한 번도 지정 안 함 → 실행 폴더에서 파생(신규 세션과 같은 규칙).
    //  일괄 private 로 떨어뜨리지 않는다 — 배포 후 첫 재부팅에 전 세션 캡이 급변하면 그게 회귀다.
    const dir = st?.dir || (tmuxAlive ? await sessionDir(id).catch(() => "") : "");
    return remember(await deriveWriteCap(dir));
  } catch {
    return remember("private");
  }
}

/** 실행 폴더에서 파생 — 프로젝트 폴더면 그 프로젝트 대상(잠겼으면 audience), 그 밖은 open. */
export async function deriveWriteCap(dir: string | null | undefined): Promise<WriteCap> {
  const folder = dirToProjectFolder(String(dir ?? ""));
  if (!folder) return "open";
  try {
    const hidden = await hiddenProjects(PUBLIC_VIEWER);   // 아무 grant 없는 사람에게 가려지나 = 잠긴 프로젝트인가
    return hidden.folders.has(folder) ? "audience" : "open";
  } catch { return "private"; }
}

// 이 세션을 이 사람이 **볼 수 있나** — 라이브(collectSessions)와 restorable 목록이 공유하는 단일 술어.
//  프로젝트 폴더 세션은 로그인한 전원(#452 공동 세션), 개인 세션은 소유자·초대자만.
//  ⚠ 두 목록이 이 규칙을 따로 구현하면 "라이브일 땐 보이는데 회수되면 사라지는" 비대칭이 생긴다(실측 사고:
//   F 를 켜자 남의 프로젝트 세션이 팀원 화면에서 사라져 삭제된 줄 알았다 — 2026-07-28).
//  #1291: '전원 공개'는 **공개된 프로젝트**에 한한다. 공개범위가 걸린 리스트의 프로젝트라면 그 대상만 본다 —
//   세션 화면에는 그 프로젝트의 파일·대화가 그대로 흐르므로, 메타만 잠그고 세션을 열어두면 잠금이 무의미하다.
//   hidden 은 호출부가 한 번 조회해 넘긴다(세션마다 DB 를 때리지 않게 — 이 목록은 5초마다 폴링된다).
export function canSeeSession(
  s: { dir?: string | null; owner?: string | null; invites?: string[] | null; projectId?: number | null },
  me: string,
  hidden?: HiddenProjects,
): boolean {
  if (!me) return false;
  const folder = dirToProjectFolder(s.dir || "");
  if (folder) {                                              // 프로젝트 공동 세션
    if (!hidden) return true;                                // 판정 재료 없음 = 종전 동작(전원 공개)
    if (s.projectId && hidden.ids.has(Number(s.projectId))) return false;
    if (hidden.folders.has(folder)) return false;
    return true;
  }
  return s.owner === me || (s.invites || []).includes(me);   // 개인 세션 = 소유자·초대자
}
