// 좌측 목록의 **자리 규칙** — 「지금 볼 것」에 선 행과 프로젝트 카드가 언제 내려가나 (#3856). 순수 함수.
//  규칙이 틀리면 목록이 사람 손 없이 저 혼자 튀거나, 반대로 아무것도 안 내려가 「지금 볼 것」이 쌓인다.
//  그래서 값으로 검증한다(scripts/hold-rules.test.mjs).
//
// ── 무엇이 두 번 틀렸나 ─────────────────────────────────────────────────────
//  ① 원안(상민님): «세션에 들어가서 볼 일이 가라앉은 뒤, 그 세션에서 나올 때 내려간다.» 첫 구현(activeHold)은
//    자물쇠가 **보고 있는 행 하나**뿐이라 «나올 때»만 보고 «가라앉았나» 를 안 봤다 — 아직 작업 중인 세션을 잠깐
//    열었다 나와도 자리를 놓았다. 그리고 프로젝트 축(#2033)에서는 그 행이 **카드의 자리를 정하는 첫 행**이라
//    딸린 세션 전부를 데리고 카드가 이사했다(원준 2026-09-02 «질문이 끝나서 그런지 중간중간 튄다»).
//  ② `301d8234`(#2534 2차)는 그걸 «자물쇠를 행마다 두고, **목록에서 빠질 때만** 놓는다» 로 고쳤다. 튐은 멎었지만
//    원안의 해제가 통째로 사라져 **확인하고 나와도 아무것도 안 내려갔다**. 진짜 원인이던 «카드에 자물쇠가 없다» 는
//    행 쪽에서 우회됐을 뿐 그대로 남았다.
//
// ── 그래서 이번 판 ──────────────────────────────────────────────────────────
//  · 행: 원안의 해제를 **조건을 보강해** 되살린다 — 가라앉았고(a) · 올라간 뒤 열어 봤고(b) · 지금 안 보고 있을 때(c).
//    원준 신고는 (a)·(c)가 막고(보는 동안엔, 그리고 아직 볼 일이 남아 있는 동안엔 안 움직인다),
//    상민 원안은 그대로 돌아온다. 상태를 모르는 판에는 놓지 않는다(«모름» 은 자리를 바꿀 사유가 아니다 — #869 와 같은 뜻).
//  · 카드: 행과 **같은 한 방향** 자물쇠를 카드 키에 준다 — 위로는 즉시, 「지금 볼 것」에서 내려가는 것은 그 카드 안을
//    보고 있지 않을 때만. 카드끼리 순서 시각은 **카드가 그 묶음에 들어온 순간**으로 얼린다(행의 orderPin 과 같은 뜻).
//    카드 문제를 카드에서 푸니, 행 자물쇠를 영구화할 이유가 없어졌다.
//
// ⚠ 점(상태)은 여기서 다루지 않는다 — 초록점은 보는 즉시 꺼진다(main.ts put). 자리와 점은 다른 축이다.

/** 사람이 고른 것 — 상태·날짜와 무관하게 맨 위(#1954). */
export const PINNED_GROUP = '고정';
/** 지금 사람이 볼 일이 있는 묶음(#1954). */
export const PRIORITY_GROUP = '지금 볼 것';
/** 묶음의 층 — 낮을수록 위. 이 숫자가 **한 방향**(작아지는 쪽으로만)을 정의한다. 날짜 묶음은 전부 2. */
export const groupTier = (g: string): number => (g === PINNED_GROUP ? 0 : g === PRIORITY_GROUP ? 1 : 2);
/** 볼 일이 아닌 행의 순위 — 우선상태(0·1·2) 뒤. */
export const QUIET_RANK = 9;

// ══ 행 ════════════════════════════════════════════════════════════════════════

/** 한 번 「지금 볼 것」에 선 행의 자리. */
export interface RowHold {
  group: string;
  rank: number;
  /** 올라간 뒤 사용자가 **이 행을 연 적이 있나** — 해제 조건 (b). */
  seen: boolean;
}

/** 이번 판에 그 행에 대해 아는 사실. */
export interface RowFacts {
  /** 지금 사실로 잰 묶음(고정 · 지금 볼 것 · 날짜). 보고 있어 점을 끈 '작업 완료' 는 여기선 날짜 묶음이다. */
  group: string;
  /** 지금 사실로 잰 순위 — 우선상태가 아니면 QUIET_RANK. */
  rank: number;
  /** **원본** 상태가 확인 필요·작업 완료·작업 중인가 — 보고 있어 점을 끈 '작업 완료' 도 참이다(아직 가라앉지 않았다). */
  hot: boolean;
  /** 지금 이 행을 보고 있나(활성 행). */
  viewing: boolean;
  /** 상태를 관측으로 아나 — 중계가 못 본 판(observed:false)이면 거짓. */
  known: boolean;
  /** 사람이 고정했나. */
  pinned: boolean;
}

/**
 * 행 하나의 자리를 한 판 진행한다.
 * @returns 이번 판의 자물쇠(없으면 undefined — 호출부가 지운다)와, 그 자물쇠를 반영한 묶음·순위.
 */
export function stepRowHold(prev: RowHold | undefined, f: RowFacts): { hold: RowHold | undefined; group: string; rank: number } {
  //  고정은 제 층(0)이 있다 — 풀렸을 때 낡은 자물쇠가 남지 않게 여기서 버린다.
  if (f.pinned) return { hold: undefined, group: f.group, rank: f.rank };
  let hold: RowHold | undefined = prev ? { ...prev, seen: prev.seen || f.viewing } : undefined;
  //  ★ 해제 — 넷 다 참일 때만: 가라앉았고(a) · 열어 봤고(b) · 지금 안 보고 있고(c) · 그 사실을 관측으로 안다.
  if (hold && !f.hot && hold.seen && !f.viewing && f.known) hold = undefined;
  let group = f.group, rank = f.rank;
  if (hold) {
    //  한 방향 — 위로는 즉시(자물쇠보다 위면 사실을 따른다), 아래로는 자물쇠가 붙든다.
    if (groupTier(hold.group) < groupTier(group)) { group = hold.group; rank = hold.rank; }
    //  같은 묶음 안에서도 안 가라앉는다 — 「지금 볼 것」 안에서 뒤로 밀리는 것도 이사다.
    else if (hold.group === group && hold.rank < rank) rank = hold.rank;
  }
  //  「지금 볼 것」에 선 사실을 붙든다. 새로 잡는 자물쇠의 «봤다» 는 **지금 보고 있나** 로 시작한다 —
  //   보는 중에 볼 일이 생긴 행은 그 순간 이미 본 것이다.
  if (groupTier(group) === 1) return { hold: { group, rank, seen: hold ? hold.seen : f.viewing }, group, rank };
  return { hold: undefined, group, rank };
}

// ══ 카드(프로젝트 묶음) ═══════════════════════════════════════════════════════

/** 카드의 자리 — 묶음 · 그 묶음 안의 순위 · 그 묶음에 들어온 순간의 시각. */
export interface CardHold { bucket: string; rank: number; at: number }

/** 이번 판에 그 카드에 대해 아는 사실(정렬된 행 목록에서 그 카드의 첫 행이 준 값). */
export interface CardFacts {
  /** 첫 행의 묶음 — 행 자물쇠가 이미 반영된 값이다. */
  bucket: string;
  /** 첫 행의 순위. */
  rank: number;
  /** 첫 행의 (얼린) 시각. */
  at: number;
  /** 카드 안의 행을 지금 보고 있나. */
  viewing: boolean;
  /** 카드째 고정됐나. */
  pinned: boolean;
}

/**
 * 카드 하나의 자리를 한 판 진행한다.
 *  · 위로(층이 작아짐) — 즉시. 그 묶음에 들어온 순간으로 시각을 다시 얼린다.
 *  · 같은 묶음 — 시각은 얼린 값, 순위는 좋아지기만 한다.
 *  · 「지금 볼 것」에서 아래로 — 카드 안을 보고 있으면 안 내려간다. 안 보고 있으면 내려가고 다시 얼린다.
 *  · 날짜 묶음끼리(오늘 → 어제 등) — 사실을 따르고 다시 얼린다(행의 orderPin 과 같다).
 */
export function stepCardHold(prev: CardHold | undefined, f: CardFacts): { hold: CardHold | undefined; bucket: string; rank: number; at: number } {
  const fresh = { bucket: f.bucket, rank: f.rank, at: f.at };
  if (f.pinned) return { hold: undefined, ...fresh };
  if (!prev) return { hold: fresh, ...fresh };
  const pt = groupTier(prev.bucket), nt = groupTier(f.bucket);
  if (nt < pt) return { hold: fresh, ...fresh };
  if (prev.bucket === f.bucket) {
    const kept = { bucket: prev.bucket, rank: Math.min(prev.rank, f.rank), at: prev.at };
    return { hold: kept, ...kept };
  }
  if (pt === 1 && nt > pt && f.viewing) return { hold: { ...prev }, ...prev };
  return { hold: fresh, ...fresh };
}

/** 카드 줄 세우기의 최소 모양. */
export interface CardOrderLike { bucket: string; rank: number; at: number }

/**
 * 카드를 줄 세운다 — 층(고정 · 지금 볼 것 · 날짜) → 날짜 묶음끼리는 `bucketSeq`(세션 축에 처음 나온 순서) →
 *  순위 → 얼린 시각(최신 먼저). 같으면 들어온 순서를 지킨다(안정 정렬).
 *  ★ 자물쇠가 아무것도 붙들지 않는 판에서는 이 순서가 **세션 축에서 각 프로젝트의 첫 행이 나오는 순서와 같다**
 *   (세션 축 정렬이 층 → 순위 → 시각이고, 카드의 값이 곧 그 첫 행의 값이므로) — 두 뷰가 갈라지지 않는다.
 */
export function orderCards<T extends CardOrderLike>(cards: T[], bucketSeq: string[]): T[] {
  const idx = new Map<string, number>();
  bucketSeq.forEach((b, i) => { if (!idx.has(b)) idx.set(b, i); });
  const at = (b: string): number => (idx.has(b) ? idx.get(b)! : Number.MAX_SAFE_INTEGER);
  return [...cards].sort((a, b) => groupTier(a.bucket) - groupTier(b.bucket) || at(a.bucket) - at(b.bucket) || a.rank - b.rank || b.at - a.at);
}

/** 이번 판에 없는 것의 자물쇠를 버린다 — 목록에서 빠지면 놓고, 다시 오면 새로 잡는다(누수 없음). */
export function pruneHolds(holds: Map<string, unknown>, present: { has(k: string): boolean }): void {
  for (const k of [...holds.keys()]) if (!present.has(k)) holds.delete(k);
}
