// lib/home-pins.ts — 홈 사이드바 「고정」 나누기 한 자리 — 순수 함수 (#4233, 원준 2026-09-25 «V1 의 1안으로»).
//
//  원칙: **고정한 단위가 그대로 움직인다.** 세션을 고정하면 그 세션 한 줄이, 프로젝트를 고정하면 그 카드가 통째로 올라간다.
//   · 고정한 세션은 「고정」 층의 세션 카드에 한 번만 선다. 소속 프로젝트 카드에서는 빠진다(카드는 나머지를 든다).
//   · 고정한 프로젝트 안의 세션을 또 고정하면, 그 세션은 **프로젝트 카드 안 맨 위**에 선다(세션 카드에 다시 세우지 않는다).
//     한 세션이 두 자리에 서지 않게 — 카드는 겹치지 않는다(카드 안에 카드는 없다).
//   · 두 축이 같은 「고정」 층을 쓴다. 세션별 축에서도 고정한 프로젝트는 카드로 선다(종전엔 세션별 축에서 프로젝트
//     압정이 아무 일도 안 했다 — #4233 홈 사이드바 2판 진단).
//  잎 모듈인 이유는 sess-fold · hold-rules 와 같다 — 이 잣대가 화면 코드 안에 있으면 시험할 데가 없다(scripts/home-pins.test.mjs).

/** 이 나누기가 한 줄에게 묻는 것 전부. */
export interface PinRowLike {
  pinned?: boolean;
  project?: { id: number } | null;
  /** 시간축이 준 묶음 이름(고정 · 지금 볼 것 · 오늘 · 어제 …). */
  group?: string;
}

/** 그 줄이 고정한 프로젝트 안에 있나. 프로젝트 없음(id 0 · null)은 고정할 수 없다. */
export function inPinnedProject(r: PinRowLike, isProjPinned: (id: number) => boolean): boolean {
  const id = Number(r.project && r.project.id) || 0;
  return id > 0 && isProjPinned(id);
}

/**
 * 프로젝트별 축: 「고정」 세션 카드에 설 줄(pinnedRows)과, 프로젝트 카드로 묶을 줄(rest)로 나눈다.
 *  rest 에는 «고정한 프로젝트 안에서 또 고정한 세션» 이 남는다 — 그 카드 안 맨 위에 서야 하므로. 순서는 들어온 그대로.
 */
export function splitHomePins<T extends PinRowLike>(rows: readonly T[] | null | undefined, isProjPinned: (id: number) => boolean): { pinnedRows: T[]; rest: T[] } {
  const pinnedRows: T[] = [];
  const rest: T[] = [];
  for (const r of rows || []) {
    if (r.pinned && !inPinnedProject(r, isProjPinned)) pinnedRows.push(r);
    else rest.push(r);
  }
  return { pinnedRows, rest };
}

/** 카드 안 줄 순서 — 고정한 줄이 맨 위, 나머지는 들어온 순서 그대로(안정 정렬). */
export function pinnedFirst<T extends PinRowLike>(rows: readonly T[]): T[] {
  return [...rows.filter((r) => r.pinned), ...rows.filter((r) => !r.pinned)];
}

/**
 * 세션별 축: 「고정」 세션 카드 · 고정한 프로젝트의 줄 · 날짜 카드 셋으로 나눈다.
 *  · pinnedRows — 고정한 세션(고정한 프로젝트 안의 것은 빼고).
 *  · pinnedProjRows — 고정한 프로젝트에 속한 줄 전부(고정 여부 무관, 프로젝트 카드가 통째로 든다). 순서는 들어온 그대로.
 *  · dated — 나머지를 시간축이 준 묶음 이름으로 **이어진 구간마다** 나눈 것(같은 이름이 떨어져 두 번 나오면 두 구간이다 —
 *    시간축의 순서를 지어내지 않는다).
 */
export function splitSessAxis<T extends PinRowLike>(rows: readonly T[] | null | undefined, isProjPinned: (id: number) => boolean): {
  pinnedRows: T[]; pinnedProjRows: T[]; dated: Array<{ group: string; rows: T[] }>;
} {
  const pinnedRows: T[] = [];
  const pinnedProjRows: T[] = [];
  const dated: Array<{ group: string; rows: T[] }> = [];
  for (const r of rows || []) {
    if (inPinnedProject(r, isProjPinned)) { pinnedProjRows.push(r); continue; }
    if (r.pinned) { pinnedRows.push(r); continue; }
    const g = r.group || '';
    const last = dated[dated.length - 1];
    if (last && last.group === g) last.rows.push(r);
    else dated.push({ group: g, rows: [r] });
  }
  return { pinnedRows, pinnedProjRows, dated };
}

/**
 * 세션별 축의 그림 설계 — 「고정」 층과 날짜 카드로 나눈다 (#4233 격리 리뷰: 이 맞춤이 화면 코드 안에 있어 시험이 비어 있었다).
 *  · pinRows — 「고정」 세션 카드에 설 줄: 고정한 세션(고정한 프로젝트 밖) + 고정한 프로젝트의 **자기 화면** 줄 중 사람이 꽂은 것.
 *  · cardRows — 고정한 프로젝트 카드에 들어갈 줄. 그 프로젝트 자기 화면 줄은 넣지 않는다(#3870 — 카드의 [→] 가 그 문이다).
 *  · dated — 나머지 전부(고정 안 한 자기 화면 줄 포함)를 시간축 순서 그대로 묶음 이름의 이어진 구간마다. 자기 화면 줄은
 *    **거르지 않는다** — 세션별 축에서 그 줄을 걷으면 그 화면으로 돌아갈 길이 없어진다(#3870 E9).
 *  selfRow 는 «이 줄이 그 프로젝트 자신의 화면인가»(부르는 쪽이 sess-fold 의 잣대로 준다).
 */
export function planSessAxis<T extends PinRowLike>(rows: readonly T[] | null | undefined, isProjPinned: (id: number) => boolean, selfRow: (r: T) => boolean): {
  pinRows: T[]; cardRows: T[]; dated: Array<{ group: string; rows: T[] }>;
} {
  const all = [...(rows || [])];
  const cut = splitSessAxis(all, isProjPinned);
  const cardRows = cut.pinnedProjRows.filter((r) => !selfRow(r));
  const selfRows = cut.pinnedProjRows.filter((r) => selfRow(r));
  const pinRows = [...cut.pinnedRows, ...selfRows.filter((r) => r.pinned)];
  if (!selfRows.length) return { pinRows, cardRows, dated: cut.dated };
  //  고정 안 한 자기 화면 줄은 시간축이 준 자리로 돌아간다 — 원래 순서를 지키려고 전체에서 다시 거른다.
  const upTop = new Set<T>([...pinRows, ...cardRows]);
  const back = all.filter((r) => !upTop.has(r));
  return { pinRows, cardRows, dated: splitSessAxis(back, () => false).dated };
}
