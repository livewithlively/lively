// 세션 행의 «보임 축» — 홈 목록에 **설지**를 정하는 규칙 한 자리 (#3855 · #3857) — 순수 함수.
//  규칙이 틀리면 «어젯밤 세션이 아침에 사라진다» 거나 «치운 세션이 저절로 되살아난다». 그래서 값으로 검증한다
//  (scripts/sess-visibility.test.mjs).
//
// ── 무엇이 문제였나 (상민님 신고 2026-09-10) ────────────────────────────────
//  종전 규칙은 «살아 있거나 오늘 쓴 것» 이었고, «내가 닫았나» 는 판정에 **아예 없었다**:
//   · 사람이 안 닫은 사실은 서버(org_app_instance active)에 멀쩡히 있었는데 목록이 세션 인스턴스를 한 줄로 건너뛰었다.
//     그래서 회수(idle 2시간)로 멈추고 자정이 넘으면 그대로 사라졌다 — 실측: 멈춘 내 세션 165건이 전량 컷.
//   · × 는 «치울 때의 상태» 를 브라우저 맵에 적고 **그 상태 그대로인 동안만** 숨겼다. 상태가 바뀌면 돌아왔다 —
//     치운 세션이 작업 완료로 바뀌는 순간 목록에 되살아난 것이 그 뜻 그대로의 동작이었다(게다가 맵은 상한 500 에 포화).
//
// ── 규칙 — 축을 둘로 가른다 (상민님 승인안) ─────────────────────────────────
//  [실행 축]  도는 중 → 중단됨 → 완전 삭제      ← 시스템(회수 정책·/exit)만. 목록에 서느냐와 무관하다.
//  [보임 축]  목록에 둠 → 치움 → 휴지통 → 완전 삭제 ← 사람만. 회수·시간·상태와 무관하게 유지된다.
//  판정 순서(먼저 걸리는 것이 이긴다):
//   ① 목록에 둠(내 active 세션 인스턴스가 **어느 id 로든** 있다)            → 선다(회수돼도·어제 것이어도)
//   ② 치움(내가 치운 기록이 **어느 id 로든** 있다)                          → 안 선다(상태가 바뀌어도)
//   ③ 둘 다 없음(화면에서 한 번도 안 연 세션 — CLI 로 뜬 것)                → 종전 규칙: 도는 중이거나 오늘 것
//  ①이 ②보다 먼저인 이유: 되살리기는 **새 박스 id** 로 인스턴스를 세우고 옛 id 를 닫는다. 옛 id 에 치움 기록이
//   남아 있어도, 사람이 그 세션을 다시 열었다(=되살렸다)는 사실이 더 나중의 결정이다.
//  «어느 id 로든» 인 이유: 한 세션이 박스 id · 대화 uuid · 되살리기 전 옛 박스 id 로 불린다(views.ts mergeSessions).

export type SessRowVerdict = 'kept' | 'dismissed' | 'live' | 'today' | 'cut';

export interface SessRowFacts {
  /** 그 세션의 모든 이름 — 박스 id · 대화 uuid(logId) · 접힌 옛 박스 id(altIds). 빈 값은 무시한다. */
  ids: string[];
  /** 지금 도는 중인가(views.ts isLiveSess). */
  live: boolean;
  /** 마지막 활동(ms). */
  lastSeen: number;
  /** '오늘 일감' 의 시작(ms, lib/sess-fold workDayStart). 이 시각과 **같으면** 오늘 것이다. */
  dayStart: number;
  /** 내 active 세션 인스턴스가 가리키는 세션 id(«목록에 둠»). */
  kept: ReadonlySet<string>;
  /** 내가 치운 세션 id(«치움»). */
  dismissed: ReadonlySet<string>;
}

export function sessRowVerdict(f: SessRowFacts): SessRowVerdict {
  const ids = (f.ids || []).filter(Boolean);
  if (ids.some((id) => f.kept.has(id))) return 'kept';
  if (ids.some((id) => f.dismissed.has(id))) return 'dismissed';
  if (f.live) return 'live';
  if ((Number(f.lastSeen) || 0) >= f.dayStart) return 'today';
  return 'cut';
}

export const verdictStands = (v: SessRowVerdict): boolean => v === 'kept' || v === 'live' || v === 'today';

/** 판정에 필요한 인스턴스의 사실만 — 레코드 전체가 아니라 이 넷이면 된다. */
export interface SessInstLike {
  status?: string | null;
  subject_kind?: string | null;
  subject_ref?: string | null;
  /** 서버가 싣는다 — 'gone' = desired-state 도 노드 스냅샷도 없다(되살릴 수 없다). */
  subject_state?: string | null;
}

/**
 * «목록에 둠» 인 세션 id. ⚠ 서버가 gone 이라 한 인스턴스는 **세지 않는다** — 되살릴 수도 열 수도 없는 세션을
 *  «사람이 목록에 둔 것» 이라 세우면 이름 없는 유령 행이 영영 남는다(instance-janitor 머리말의 그 행). 그런 세션은
 *  종전 규칙(③)으로 떨어지고, 목록에도 없으니 자연히 안 선다.
 */
export function keptSessionRefs(insts: readonly SessInstLike[] | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const i of insts || []) {
    if (!i || i.status !== 'active' || i.subject_kind !== 'session' || !i.subject_ref) continue;
    if (i.subject_state === 'gone') continue;
    out.add(String(i.subject_ref));
  }
  return out;
}

// ── 옛 치움 맵 옮기기 — 한 번, 멱등 ──────────────────────────────────────────
//  옛 맵(member_shell_pref · lively_v2_side_dismissed)의 `sess:<id>` 항목을 서버 정본으로 옮긴다.
//   · 지금 세션으로 풀리면(옛 id 도 지금 id 로) 그 id 를 옮긴다 — 치운 사실은 세션의 것이지 옛 이름의 것이 아니다.
//   · 안 풀리면(지금 없는 세션) 옮기지 않고 버린다 — 서지도 않을 세션에 행을 만들 이유가 없다.
//   · 형식이 깨진 키(실측: `sess:box-…](https:` — 마크다운 링크가 통째로 행 키가 됐다)도 버린다.
//   · 세션 아닌 행(route:/inst:)은 **그대로 둔다** — 이번 범위 밖이고, 그쪽은 종전 맵이 계속 정본이다.
//  옛 맵 값(치울 때의 상태 'done'·'' …)은 보지 않는다 — 새 규칙에서 치움은 상태와 무관하다.

/** 서버 SUBJECT_RE(src/capabilities/app-instances.ts)와 같은 자 — 서버가 받지 않을 id 를 보내지 않는다. */
const SESSION_REF_RE = /^[A-Za-z0-9._:-]{1,160}$/;

export interface DismissPlan {
  /** 서버에 «치움» 으로 옮길 세션 id(중복 없음, 들어온 순서). */
  sessionIds: string[];
  /** 옮긴 뒤 남길 맵 — 세션 키가 하나도 없다. */
  nextMap: Record<string, string>;
  /** 옮기지 않고 버린 세션 키(지금 없는 세션 · 깨진 키). */
  dropped: string[];
}

export function planDismissMigration(map: unknown, resolve: (id: string) => string | null | undefined): DismissPlan {
  const src = map && typeof map === 'object' && !Array.isArray(map) ? (map as Record<string, unknown>) : {};
  const nextMap: Record<string, string> = {};
  const sessionIds: string[] = [];
  const seen = new Set<string>();
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(src)) {
    if (!k.startsWith('sess:')) { if (typeof v === 'string') nextMap[k] = v; continue; }
    const raw = k.slice(5);
    const to = SESSION_REF_RE.test(raw) ? resolve(raw) : null;
    if (!to || !SESSION_REF_RE.test(String(to))) { dropped.push(k); continue; }
    if (!seen.has(String(to))) { seen.add(String(to)); sessionIds.push(String(to)); }
  }
  return { sessionIds, nextMap, dropped };
}

/** 세션 키를 뺀 맵 — 옮긴 뒤의 저장은 세션 키를 싣지 않는다(옛 페이지가 되올린 것도 여기서 걸러진다). */
export function withoutSessionKeys(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map || {})) if (!k.startsWith('sess:')) out[k] = v;
  return out;
}
