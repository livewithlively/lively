// lib/pad-hidden.ts — 앱 찾기(런처)에서 **뺀 앱**의 순수 판정(#4600, 원준 2026-10-07 «앱 버튼 누르면 쫙 앱 뜨는 거에서
//  원하면 삭제하거나, 삭제했던 거 나중에 추가하는 방식»). DOM 을 모르는 잎 — 시험이 컴파일 결과를 그대로 돌린다.
//
//  뺀다 = 지운다가 아니다. 앱은 그대로 설치돼 있고 주소로도 열린다. 격자에서 **내 눈앞에서만** 치우는 것이고, 격자 아래
//  접힌 「뺀 앱」 묶음에서 언제든 다시 넣는다. 그래서 저장은 계정의 것(shell-prefs)이다 — 노트북에서 뺀 앱이 사무실 데스크톱에서도 빠져 있어야 「내가 정리한 목록」이 된다.

/** 격자 칸의 열쇠 — 화면 앱(APPS 표)은 key 그대로, 설치된 앱(org_app)은 `i:<id>`. 두 표의 이름이 겹쳐도 다른 칸이다. */
export function padTileId(kind: 'screen' | 'installed', keyOrId: string): string {
  return kind === 'screen' ? keyOrId : 'i:' + keyOrId;
}

/** 뺀 목록에 넣거나(없으면) 뺀다(있으면). 순서는 뺀 차례. */
export function padHiddenToggle(list: readonly string[], tileId: string): string[] {
  return list.includes(tileId) ? list.filter((x) => x !== tileId) : [...list, tileId];
}

/**
 * 칸 하나가 어디에 서나.
 *  · 안 뺀 칸 → 제 묶음(group)
 *  · 뺀 칸 + 검색 중이 아님 → 「뺀 앱」 묶음(hidden)
 *  · 뺀 칸 + 검색 중 → 제 묶음에 「뺀 앱」 표시로(찾아서 쳤는데 안 보이면 «없어졌다» 로 읽힌다)
 */
export function padPlacement(tileId: string, hidden: ReadonlySet<string>, searching: boolean): 'group' | 'hidden' | 'group-marked' {
  if (!hidden.has(tileId)) return 'group';
  return searching ? 'group-marked' : 'hidden';
}
