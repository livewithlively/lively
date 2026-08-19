// 세션 desired-state 를 읽는 **단일 창구** — DB 우선, tmux 폴백. (#1059 E 의 미러를 SoT 로 승격하는 첫 조각)
//
// ── 왜 방향을 뒤집나 ────────────────────────────────────────────────────────
// 지금 세션 메타의 SoT 는 tmux user-option(`@box_*`)이다. 그건 **그 tmux 서버 안에서만 읽을 수 있다** —
//  게이트웨이가 tmux 와 같은 프로세스 문맥에 있어야 세션이 누구 것인지 알 수 있다는 뜻이고,
//  그래서 "게이트웨이 하나가 여러 워크스페이스를 서비스한다"가 원천적으로 불가능했다.
//  메타가 DB 에 있으면 게이트웨이는 tmux 를 **실행 표면**으로만 쓰면 된다.
//
// 재부팅에 통째로 증발한다는 문제도 같은 뿌리다(#1059). 그래서 이미 DB 미러가 있다 —
//  이 모듈은 그 미러를 **읽기의 기본값**으로 승격한다. 스키마는 그대로 쓴다(새 테이블 없음).
//
// ── 두 축 ──────────────────────────────────────────────────────────────────
//  desired(DB) : 누가 만들었나·무슨 하네스·어디서·누구에게 열었나 — **사람이 정한 것**. 재부팅해도 안 변한다.
//  observed(tmux): 붙어 있나·지금 뭘 돌리나·화면에 뭐가 떴나 — **지금 그런 것**. 프로세스가 죽으면 사라지는 게 맞다.
//  회수·복원이 성립하는 이유가 이 분리다: observed 를 잃어도 desired 가 남으면 다시 만들 수 있다.
//
// ── OSS 무해 ───────────────────────────────────────────────────────────────
// ⚠ 폴백을 **지우지 않는다.** 자가호스팅 박스는 이 버전으로 올려도 기존 세션에 DB 행이 없다
//  (백필은 부팅 후 40초에 돈다). 그 사이 tmux 값으로 읽히지 않으면 **살아 있는 세션이 남의 것처럼 보이거나
//  통째로 사라진다.** DB 행이 생기면 자연히 DB 가 이긴다 — 이행에 사람 손이 필요 없다.

import { itemsPool } from "../db/client.js";
import { rowToState, type SessionState } from "./session-state.js";

// #1791 — 노드 에이전트 프로세스에는 DB 가 없다(설계). 거기서 desired 조회는 **묻지 않고** tmux 폴백이다 — 종전엔 3초마다
//  (상태 push 마다) 실패 로그를 찍어 노드 로그를 채웠다(하루 9천 줄, 실 오류를 가림). 판별자는 session-state.ts 와 같다.
const ON_NODE = !!process.env.LIVELY_NODE_TOKEN;

/** tmux `list-sessions` 한 줄에서 뽑은 desired 후보. 필드는 DB 컬럼과 1:1. */
export interface TmuxDesired {
  owner: string;
  label: string | null;
  harness: string;
  dir: string | null;
  autoApprove: boolean;
  flags: Record<string, string>;
  invites: string[];
  projectId: number | null;
}

/** 조회 결과 — 어느 축에서 왔는지까지 알려준다(진단·정리기 판단용). */
export interface ResolvedDesired extends TmuxDesired {
  /** "db" = DB 행이 있었다 · "tmux" = 없어서 tmux 값을 썼다(백필 대상) */
  source: "db" | "tmux";
}

/**
 * desired 해소(순수) — DB 행이 있으면 그쪽이 이긴다. 단, **null/빈 값은 tmux 로 메운다.**
 *
 * 왜 통째로 안 덮나: 구버전에 만들어진 행은 나중에 추가된 컬럼이 null 이다(예: project_src, flags).
 *  그걸 그대로 쓰면 화면에서 프로젝트 배지나 플래그가 조용히 사라진다 — "DB 로 옮겼더니 정보가 줄었다"는
 *  이행 사고의 전형이다. 값이 **있는 쪽**을 쓰되 우선순위만 DB 로 둔다.
 *
 * ⚠ 예외 하나: `owner` 는 절대 메우지 않는다. 소유자는 접근 제어의 근거이고, DB 에 owner 가 있는데
 *  tmux 값으로 덮이면 **권한이 뒤집힌다.** DB 행이 있으면 그 owner 만 쓴다.
 */
export function resolveDesired(db: SessionState | undefined, tmux: TmuxDesired): ResolvedDesired {
  if (!db) return { ...tmux, source: "tmux" };
  const pick = <T>(a: T | null | undefined, b: T): T => (a === null || a === undefined ? b : a);
  return {
    source: "db",
    owner: db.owner || tmux.owner,          // DB owner 가 빈 문자열인 건 데이터 파손 — 그때만 tmux
    label: pick(db.label, tmux.label),
    harness: db.harness || tmux.harness,
    dir: pick(db.dir, tmux.dir),
    autoApprove: db.auto_approve,
    flags: Object.keys(db.flags || {}).length ? db.flags : tmux.flags,
    invites: db.invites.length ? db.invites : tmux.invites,
    projectId: pick(db.project_id, tmux.projectId),
  };
}

/**
 * 세션 하나의 desired(DB). 없거나 DB 가 죽었으면 undefined — 호출부가 tmux 폴백으로 흐른다.
 *
 * ⚠ 접근 제어(누가 붙을 수 있나)가 이걸 쓴다. **오류 시 undefined 를 주는 게 fail-safe 다**:
 *  호출부가 tmux(종전 진실)로 떨어지므로 판정이 느슨해지지 않는다. 여기서 예외를 던지면
 *  DB 가 잠깐 흔들릴 때 **살아 있는 세션에 아무도 못 붙는다.**
 */
export async function loadDesiredOne(id: string): Promise<SessionState | undefined> {
  if (ON_NODE) return undefined;   // 노드: tmux 가 유일한 진실(아래 resolveSessionDir 주석)
  try {
    const r = await itemsPool.query("SELECT * FROM org_session_state WHERE id=$1", [id]);
    return r.rows[0] ? rowToState(r.rows[0]) : undefined;
  } catch (e) {
    console.warn(`[session-desired] ${id} 조회 실패 — tmux 폴백: ${(e as Error)?.message}`);
    return undefined;
  }
}

/**
 * 세션 작업 디렉터리 — desired(DB) 우선, tmux 폴백.
 *
 * 폴백을 **주입받는** 이유는 계층 때문이다: tmux-exec 은 최하층이라 위쪽(DB)을 import 하면 안 된다
 *  (그 파일 머리말의 규약). 그래서 규칙은 여기 한 곳에 적고, tmux 접근은 호출부가 넘긴다.
 *
 * ⚠ **노드 에이전트에서는 쓰지 마라.** 노드에는 DB 가 없다(설계) — 거기서는 tmux 가 유일한 진실이다.
 *  이 함수는 게이트웨이 경로 전용이다.
 */
export async function resolveSessionDir(id: string, tmuxFallback: () => Promise<string>): Promise<string> {
  const db = await loadDesiredOne(id);
  return db?.dir || (await tmuxFallback());
}

/**
 * 여러 세션의 desired 를 **한 쿼리**로. 목록 조회가 세션 수만큼 쿼리를 치면 안 된다
 *  (collectSessions 는 폴링 경로다 — 세션 20개면 초당 20쿼리가 된다).
 *
 * DB 가 죽어도 **던지지 않는다** — 빈 맵을 주면 호출부가 tmux 폴백으로 흘러 목록이 계속 보인다.
 *  세션 목록은 장애 중에도 보여야 하는 화면이다(그게 복구 작업을 하는 자리이므로).
 */
export async function loadDesiredMap(ids: string[]): Promise<Map<string, SessionState>> {
  const out = new Map<string, SessionState>();
  if (!ids.length || ON_NODE) return out;   // 노드: 전부 tmux 폴백(조용히)
  try {
    const r = await itemsPool.query("SELECT * FROM org_session_state WHERE id = ANY($1::text[])", [ids]);
    for (const row of r.rows) {
      const s = rowToState(row);
      out.set(s.id, s);
    }
  } catch (e) {
    console.warn(`[session-desired] DB 조회 실패 — tmux 값으로 진행: ${(e as Error)?.message}`);
  }
  return out;
}
