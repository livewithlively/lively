// lib/tab-key.ts — 곁칸 탭의 **정체** (#762, 원준 2026-09-05).
//
//  원준: "뷰어는 여러 탭이 뜨게 하고 싶은데 이거만 예외 두긴 좀 그런데 어케할까?
//        자료에 있는 파일 중에서 한 번에 하나만 열 수 있는게 이상해서."
//
//  맞는 걱정이다. 종전엔 **탭의 정체가 곧 부품의 종류**였다(배치가 `['files','knowledge','apps']` 처럼
//  종류 이름의 목록이었다). 그래서 한 종류는 칸마다 하나뿐이고, 뷰어에 두 파일을 띄우려면 뷰어에만
//  «두 개까지» 같은 예외를 박아야 했다 — 그 예외는 웹 칸에서도, 자료 칸에서도 곧바로 다시 필요해진다.
//
//  그래서 예외 대신 **정체를 한 칸 내린다**: 탭은 종류가 아니라 그 종류의 **인스턴스** 하나다.
//  셸의 앱이 이미 그렇게 되어 있다(#1780 v2.2 — 창 = 앱의 인스턴스). 곁칸도 같은 문법을 쓴다.
//  «여러 개를 띄울 수 있나»는 부품이 스스로 선언한다(PART_DEFS 의 multi) — 셸엔 부품 이름이 안 박힌다.
//
//  ⚠ 열쇠 모양은 **첫 번째가 종류 이름 그대로**여야 한다('editor', 'editor#2', 'editor#3'…).
//   그래야 이미 저장된 배치·부품별 기억(펴 둔 파일·주소·배율)이 **그대로 첫 탭의 것**으로 살아난다.
//   번호를 붙이는 판으로 갈면 사람들이 쓰던 화면이 한 번 리셋된다.

/** 탭 하나의 열쇠. `'editor'`(첫 번째) · `'editor#2'`(두 번째)… */
export type TabKey = string;

/** 이 탭이 **무슨 부품**인가. `'editor#2'` → `'editor'` */
export const tabBase = (k: TabKey): string => String(k).split('#')[0];

/** 몇 번째 인스턴스인가(첫 번째 = 1). 번호가 없거나 이상하면 1. */
export function tabNum(k: TabKey): number {
  const n = Number(String(k).split('#')[1]);
  return Number.isInteger(n) && n >= 2 ? n : 1;
}

/** 종류 + 번호 → 열쇠. 1번은 **종류 이름 그대로**(위 머리말의 호환 규칙). */
export const tabKey = (type: string, n: number): TabKey => (n >= 2 ? `${type}#${n}` : type);

/** 열쇠 모양이 성한가 — 저장된 배치를 읽을 때 쓴다(`'editor#0'`·`'editor#x'`·`'a#1#2'` 는 아니다). */
export function isTabKey(k: unknown): boolean {
  if (typeof k !== 'string' || !k) return false;
  const parts = k.split('#');
  if (parts.length === 1) return true;
  if (parts.length !== 2) return false;
  //  ⚠ **`[2-9][0-9]*` 로 쓰면 안 된다** — 그러면 `#10`~`#19`·`#100`~ 이 통째로 빠진다(사양만 보고 쓴
  //   블라인드 시험이 잡았다). 같은 모듈의 tabKey/nextTabKey 는 `editor#10` 을 멀쩡히 만들어 내므로,
  //   그 판정이면 **제가 만든 열쇠를 제가 부정한다** → 저장된 배치를 읽을 때 열 번째 탭부터 조용히 사라진다.
  //   막으려는 것은 앞자리 0(`#02`)뿐이다.
  return /^([2-9]|[1-9][0-9]+)$/.test(parts[1]);
}

/**
 * 그 부품의 **다음 빈 번호**로 열쇠를 만든다.
 *  ⚠ 번호는 **배치 전체**(세 칸 모두)에서 유일해야 한다 — 탭을 다른 칸으로 옮겨도 부딪히지 않게,
 *   그리고 부품마다 기억하는 값(펴 둔 파일·주소)이 열쇠에 매달리기 때문이다.
 *  빈 번호를 **되쓴다**(2를 닫고 다시 열면 다시 2) — 3,4,5… 로만 자라면 탭 이름이 이유 없이 커진다.
 */
export function nextTabKey(type: string, used: Iterable<TabKey>): TabKey {
  const taken = new Set<number>();
  for (const k of used) if (tabBase(k) === type) taken.add(tabNum(k));
  let n = 1;
  while (taken.has(n)) n += 1;
  return tabKey(type, n);
}
