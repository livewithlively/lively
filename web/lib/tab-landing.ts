// lib/tab-landing.ts — 보고 있던 화면을 닫은 뒤 **어디로 가나** (#3890, 상민님 2026-09-11) — 순수 함수.
//
//  상민님: "홈화면 좌측 사이드바에서 세션 닫기 이후에 보일 세션 자동으로 선정하는 로직이 좀 이상한데?
//          box-…-0bfd8541 을 닫으니까 뜬금없이 엄청 옛날에 만들어 뒀던 box-…-034ec402 가 올라옴.
//          vscode 같은 거 참고해서 자연스럽게 선정하는 게 필요할 듯."
//
// ── 무엇이 문제였나 ──────────────────────────────────────────────────────────
//  셸은 열린 화면(탭)을 **숨긴 채** 들고 있다(main.ts TABS_OFF — 탭 줄을 안 그리고 사이드바가 그 역할을 한다).
//  그런데 닫은 뒤 갈 곳은 종전 크롬식 탭 줄의 규칙 그대로 **배열에서 닫힌 자리의 옆 칸**이었다(tabs.ts close).
//  사람은 그 배열을 볼 수 없으니 옆 칸은 무작위와 같다. 게다가 복원은 저장본의 **앞에서 12개**(= 가장 오래
//  연 것)를 남기고 새로 연 것을 버려서, 오래된 탭이 배열 앞쪽에 영영 눌러앉았다. 034ec402 는 서버의 세션
//  목록·기록·인스턴스·치운 목록 어디에도 없는 세션이었다(2026-09-11 실측) — 사이드바에도 안 서는 **유령 탭**이
//  옆 칸이라는 이유로 화면에 올라온 것이다.
//
// ── 규칙 — VS Code 기본값 ────────────────────────────────────────────────────
//  `workbench.editor.focusRecentEditorAfterClose`(기본 true): "Controls whether editors are closed in most
//  recently used order or from left to right." 닫힌 것이 보던 화면이면 **가장 최근에 보던 화면**으로 간다
//  (editorGroupModel: `newActive = this.mru[1]`). 그 순서는 창을 다시 열어도 이어진다(mru 를 직렬화한다).
//   · 한 번도 본 적 없는 화면(복원만 되고 이 기기에서 본 기록이 없다)은 «돌아갈 곳» 이 아니다.
//   · 셸이 «갈 수 없다» 고 한 화면(서버가 모르는 세션을 가리키는 낡은 탭)은 가장 최근이어도 건너뛴다.
//   · 갈 곳이 없으면 null — 셸이 홈으로 간다(VS Code 의 «빈 편집기 영역» 자리).

/** 이 기기에서 이 화면으로 **마지막으로 들어온 시각**(ms). 보는 구간은 한 번에 하나라 이 순서가 곧 최근에 본 순서다.
 *  0·음수·NaN·Infinity·숫자 아님 = 본 적 없다. */
export function seenValue(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 보던 화면을 닫은 뒤 갈 곳 — 남은 화면 중 **가장 최근에 본 것**.
 * @param tabs 닫힌 화면을 **뺀** 나머지. 배열의 자리는 판정에 끼지 않는다.
 * @param canLand 셸이 아는 «그 화면이 아직 있나». 안 주면 전부 갈 수 있다.
 * @returns 갈 곳. 없으면 null(셸이 홈으로 간다). 같은 시각끼리는 앞선 것.
 */
export function pickLanding<T extends { seenAt?: unknown }>(tabs: readonly T[], canLand?: (t: T) => boolean): T | null {
  let best: T | null = null;
  let bestAt = 0;
  for (const t of tabs) {
    const at = seenValue(t.seenAt);
    if (at <= bestAt) continue;                   // 본 적 없는 화면(0)은 여기서 걸러진다 — 동률도 앞선 것이 남는다
    if (canLand && !canLand(t)) continue;
    best = t;
    bestAt = at;
  }
  return best;
}

/** 다음 도장 — 늘 직전 도장보다 크다. 같은 ms 에 두 번 옮겨도, 시계가 뒤로 가도(복원값이 앞서 있어도) 순서가 선다. */
export function nextStamp(prev: unknown, now: number): number {
  return Math.max(now, seenValue(prev) + 1);
}

/**
 * 저장본을 되살릴 때 **어느 화면을 남기나** — 상한을 넘으면 저장 당시 보던 화면 + 최근에 본 순서.
 *  본 기록이 없는 것끼리는 **나중에 저장된 것**(= 더 새로 연 것 — 탭은 배열 끝에 붙는다)을 남긴다.
 *  종전은 앞에서 max 개였다 — 가장 오래 연 것이 남고 방금 연 것이 버려졌다(머리말).
 * @param seen 저장본 순서대로의 «본 시각»(seenValue 로 읽는다).
 * @param active 저장 당시 보던 화면의 번호. 범위 밖이면 강제로 남기는 것이 없다.
 * @returns 남길 번호 — **오름차순**(저장본의 순서를 그대로 지킨다).
 */
export function keepRecent(seen: readonly unknown[], active: number, max: number): number[] {
  const order = seen.map((v, i) => ({ i, at: seenValue(v) }));
  order.sort((a, b) => Number(b.i === active) - Number(a.i === active) || b.at - a.at || b.i - a.i);
  return order.slice(0, Math.max(0, max)).map((x) => x.i).sort((a, b) => a - b);
}

/**
 * 저장본에서 **되살릴 줄의 번호**를 고른다 — 모양이 깨진 줄·지나가는 화면을 빼고, 같은 화면은 하나로, 상한까지.
 *  같은 화면이 두 줄이면(옛 버그가 만든 짝 — find() 가 첫 탭만 잡아 둘째가 영영 남는다) **보던 것 → 더 최근에 본 것 →
 *  앞선 것** 하나를 남긴다. 그다음 상한은 keepRecent 로 자른다.
 * @param saved 저장본의 tabs 배열 그대로(모양은 여기서 본다 — `{ route: string, seen?: number }`).
 * @param active 저장 당시 보던 줄의 번호(저장본 기준).
 * @param keyOf 같은 화면인지 가르는 열쇠(tabs.ts routeKey). @param sticky 되살릴 화면인가(tabs.ts routeSticky).
 * @returns 저장본 번호 — 오름차순.
 */
export function planRestore(saved: readonly unknown[], active: number, max: number,
  keyOf: (route: string) => string, sticky: (route: string) => boolean): number[] {
  const byKey = new Map<string, { i: number; at: number }>();
  saved.forEach((row, i) => {
    const route = row && typeof row === 'object' ? (row as { route?: unknown }).route : undefined;
    if (typeof route !== 'string' || !sticky(route)) return;
    const cand = { i, at: seenValue((row as { seen?: unknown }).seen) };
    const k = keyOf(route);
    const had = byKey.get(k);
    const wins = !had || (Number(cand.i === active) - Number(had.i === active) || cand.at - had.at) > 0;
    if (wins) byKey.set(k, cand);
  });
  const rows = [...byKey.values()].sort((a, b) => a.i - b.i);
  return keepRecent(rows.map((r) => r.at), rows.findIndex((r) => r.i === active), max).map((n) => rows[n].i);
}
