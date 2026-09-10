// 관측 못 한 판을 **직전 관측으로 잇는다**(#2544 후속) — 순수 함수. 규칙이 틀리면 세션 목록이 한 틱에
//  통째로 «작업 완료» 로 뒤집힌다. 그래서 값으로 검증한다(scripts/obs-carry.test.mjs).
//
// ── 무엇이 문제였나 (상민님 신고 2026-09-10) ────────────────────────────────
//  매니지드에서 세션 목록은 중계(게이트웨이 → 허브 → 브로커 → 테넌트 tmux)를 지난다. 그 중계가 잠깐
//  끊긴 틱에는 tmux 를 **못 본다**. 그때 «세션 0개» 라고 하면 살아 있는 세션이 전부 죽은 것처럼 보이므로,
//  서버는 DB desired 행으로 목록을 채우고 `observed:false` 를 달아 보낸다(src/terminal/session-unobserved.ts).
//
//  그런데 그 행은 **관측값을 지어낸다**: `agentState:"offline"` · `lastActive`(DB 미러) 는 실려 오고
//  열람 시각(`lastAttached`·`lastViewed`)·`restorable` 은 **아예 없다**(tmux 만 아는 값이라 DB 에 없다).
//  화면은 그 표식을 **한 곳도 읽지 않아** 진짜 관측처럼 계산했고, 그래서 한 틱에 세 가지가 함께 났다:
//   ① 열람 시각 0 → «마지막 작업 > 마지막 열람» 이 전부 참 → **최근 24시간 안에 작업한 세션이 전량 초록 '작업 완료'**
//   ② `restorable` 없음 → 「살아 있는 세션」으로 그려져 사이드바의 날짜 컷(오늘 것만)을 **우회** → 지난 세션 수백 줄이 되살아남
//   ③ ①이 만든 상태 변화가 「치움」 판정(치울 때 상태 그대로면 숨김)을 깨서 **치워 둔 행까지 전부 부활**
//  실측: 사용자가 `/exit` 로 직접 죽인 세션이 «작업 완료» 로 목록에 떴다 사라졌다.
//
// ── 고치는 방향 — 「모른다」를 화면에 드러내지 않는다 ─────────────────────────
//  사용자에게 «관측 안 됨» 이라고 말할 이유가 없다. 옳은 그림은 **아무 일도 안 일어난 것**이다:
//  그 행이 지어낸 관측값만 **직전 관측**으로 되돌리면, 중계가 돌아올 때까지 화면이 한 픽셀도 안 움직인다.
//   · 좌표(이름·소속·초대·휴지통 표식…)는 **새 응답이 정본**이다 — 그건 DB 가 아는 사실이고 폴백에도 정확히 실린다.
//   · 그래서 «지어낸 것만 되돌린다»(OBSERVED_FIELDS)로 좁힌다. 빠뜨렸을 때의 실패 방향이 옳은 쪽이다:
//     관측 필드를 하나 빠뜨리면 그 값만 낡고, 좌표를 하나 빠뜨리면 **이름이 틀린 행**이 남는다.
//
// ── 오래 못 보면 점은 조용히 끈다 ───────────────────────────────────────────
//  이어 주는 것은 **잠깐의 끊김**을 덮으려는 것이다. 장애가 길어지면 «작업 중» 파란 점이 사실과 멀어지므로,
//  CARRY_MS 를 넘기면 잇기를 그만두고 폴백 행 그대로 둔다 — 그 행은 `observed:false` 라
//  isUnreadDone(초록점)·sessIsDead(살아있음) 판정에서 둘 다 빠져 **점 없는 조용한 행**이 된다.
//  라벨로 «관측 안 됨» 을 띄우지는 않는다(위 방향).

/** 이 모듈이 다루는 최소 모양 — 행의 나머지 필드는 그대로 통과시킨다. */
export interface ObsRowLike {
  id?: unknown;
  /** 서버 표식(src/terminal/catalog.ts SessionInfo.observed). 관측된 행에는 없다. */
  observed?: boolean;
  [k: string]: unknown;
}

/**
 * **폴백 행이 지어내는 관측 필드** — 이 값들만 직전 관측에서 되돌린다.
 *  `observed` 도 여기 든다: 되돌린 행은 «직전에 관측한 그 행» 이므로 표식이 남으면 안 된다
 *  (남으면 isUnreadDone·sessIsDead 가 그 행을 계속 «모름» 으로 다뤄, 이어 준 뜻이 사라진다).
 */
export const OBSERVED_FIELDS = ['agentState', 'working', 'awaiting', 'attached', 'title', 'lastActive', 'observed'] as const;

/** 이만큼 못 보면 잇기를 그만둔다 — 그 뒤로는 점 없는 조용한 행(위 머리말). */
export const OBS_CARRY_MS = 120_000;

/** 마지막으로 **관측된** 그 행. */
export interface ObsMemory { at: number; row: ObsRowLike }

const idOf = (r: ObsRowLike | null | undefined): string => String((r && r.id) ?? '');

/**
 * 이번 판의 세션 행들을 «관측된 값» 으로 되돌린다. `mem` 은 호출부가 들고 있는 기억(세션 id → 직전 관측)이며
 *  이 함수가 갱신·정리한다.
 *
 *  · 관측된 행 → 그대로 두고 기억에 새로 적는다.
 *  · 관측 못 한 행 + 기억이 신선함 → 기억 위에 **이번 응답의 좌표**를 얹어 돌려준다(화면이 안 움직인다).
 *  · 관측 못 한 행 + 기억이 없거나 낡음 → **그대로** 돌려준다(`observed:false` 가 초록점·살아있음 판정을 막는다).
 */
export function keepObserved<T extends ObsRowLike>(rows: T[], mem: Map<string, ObsMemory>, now: number = Date.now()): T[] {
  const src = Array.isArray(rows) ? rows : [];
  //  낡은 기억은 먼저 버린다 — 이 한 줄이 «오래 못 보면 점을 끈다» 이고, 동시에 기억이 무한히 자라지 않게 한다.
  for (const [k, v] of [...mem]) if (now - v.at > OBS_CARRY_MS) mem.delete(k);
  return src.map((r) => {
    const id = idOf(r);
    if (!id) return r;
    if (r.observed !== false) { mem.set(id, { at: now, row: r }); return r; }
    const had = mem.get(id);
    if (!had) return r;
    //  지어낸 것만 되돌린다 — 기억을 바닥에 깔고 **이번 응답의 나머지**(좌표)를 위에 얹는다.
    //  ⚠ 관측 필드는 얹지 않으므로 `out` 의 그 자리는 기억의 것뿐이다 — 기억에 없던 관측 필드
    //   (열람 시각·restorable 처럼 폴백 행에 애초에 없는 것)는 그대로 «없음» 으로 남는다.
    const out: ObsRowLike = { ...had.row };
    for (const k of Object.keys(r)) if (!(OBSERVED_FIELDS as readonly string[]).includes(k)) out[k] = r[k];
    return out as T;
  });
}
