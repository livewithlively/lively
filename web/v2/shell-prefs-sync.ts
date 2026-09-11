// v2/shell-prefs-sync.ts — 셸 개인화 동기의 **판정만** 떼어 둔 순수 모듈(#3887). DOM·네트워크·저장소를 모른다.
//
// ── 무엇이 문제였나 ─────────────────────────────────────────────────────────────
//  화면은 저장할 때마다 **문서 전체**를 보냈고 서버는 통째로 바꿨다. 켜 둔 채 낡은 캐시를 든 창(노트북)이 접힘 하나를
//   저장하면 — 그룹이 활성이 되는 순간 화면이 스스로 적는다(side.ts grpOpened) — 그 사이 다른 기기(데스크톱)에서
//   한 고정·치움이 그 판에 통째로 덮였다. 사람은 아무것도 안 눌렀는데 결정이 사라진다.
//
// ── 어떻게 ────────────────────────────────────────────────────────────────────
//  · **기준판(base)** — «이 창이 마지막으로 서버와 같다고 확인한 저장소별 값». 부팅 동기와 저장 성공 뒤에만 선다.
//  · 저장은 **기준판과 다른 저장소만** patch 로 보낸다(서버가 그 저장소만 병합한다). 기준판이 없으면(부팅 조회 실패)
//    무엇이 바뀌었는지 모르므로 종전대로 통째 교체다.
//  · 응답은 저장 뒤 서버 문서 전체다. 저장소마다 **보낸 뒤로 이 창 캐시가 그대로면** 서버 값을 캐시에 얹는다 —
//    서버가 상한·형식으로 버린 것과 다른 기기가 바꾼 저장소가 그 자리에서 화면에 온다. 그새 캐시가 바뀌었으면
//    캐시를 두고 기준판만 서버 값으로 옮긴다(다음 저장이 새 값을 보낸다).
//  비교는 저장소 값의 JSON(순서 포함 — 레일·치움 순서는 뜻이 있다). 빈 저장소는 '' 로 «없음» 과 같게 친다.

/** 저장소 모양 — shell-prefs.ts 와 같다. */
export type SyncKind = 'list' | 'map' | 'str';

/** 저장소 값 하나를 비교용 문자열로 — 비었거나 모양이 틀리면 ''(«없음» 과 같다 · shellPrefsBody 가 싣지 않는 값). */
export function canonOf(kind: SyncKind, v: unknown): string {
  if (kind === 'str') return typeof v === 'string' && v ? JSON.stringify(v) : '';
  if (kind === 'list') return Array.isArray(v) && v.length ? JSON.stringify(v) : '';
  return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length ? JSON.stringify(v) : '';
}

/**
 * 이번 저장에 무엇을 싣나.
 * @param now  지금 캐시의 저장소별 비교값(동기 저장소 전부)
 * @param base 기준판 — null 이면 서버가 무엇을 가졌는지 모른다
 * @returns patch = patch 에 실을 저장소 이름(비었으면 보낼 것 없음) · null 이면 통째 교체만
 */
export function planPush(now: Record<string, string>, base: Record<string, string> | null): { patch: string[] | null } {
  if (!base) return { patch: null };
  return { patch: Object.keys(now).filter((name) => now[name] !== (base[name] ?? '')) };
}

export interface AdoptInput {
  /** 동기 저장소 이름 전부. */
  names: string[];
  /** 보내기 직전의 기준판(없었으면 null). */
  base: Record<string, string> | null;
  /** 실어 보낸 저장소 → 보낼 때의 캐시 비교값. 통째 교체였으면 저장소 전부. */
  sent: Record<string, string>;
  /** 응답을 받은 지금의 캐시 비교값. */
  cacheNow: Record<string, string>;
  /** 응답(저장 뒤 서버 문서)의 비교값. */
  server: Record<string, string>;
}

/**
 * 저장 응답을 받았다 — 새 기준판과 «캐시에 서버 값을 얹을 저장소» 를 정한다.
 *  얹는 조건은 하나다: 이 창의 캐시가 **서버가 받은 그 값(또는 이 창이 서버와 같다고 알던 값)에서 안 바뀌었다**.
 *   · 보낸 저장소: 보낼 때 값 그대로면 서버 값(상한·형식으로 버린 뒤)을 얹는다.
 *   · 안 보낸 저장소: 기준판 그대로면 서버 값(다른 기기의 변경)을 얹는다.
 *   · 그새 바뀐 저장소는 얹지 않는다 — 방금 사람이 한 일을 서버의 옛 값으로 되돌리면 그게 바로 이 모듈이 막으려는 사고다.
 *  새 기준판은 저장소마다 서버 값이다(서버가 지금 가진 것 — 다음 저장의 비교 기준).
 */
export function adoptResponse(i: AdoptInput): { base: Record<string, string>; adopt: string[] } {
  const next: Record<string, string> = {};
  const adopt: string[] = [];
  for (const name of i.names) {
    const server = i.server[name] ?? '';
    next[name] = server;
    const known = Object.prototype.hasOwnProperty.call(i.sent, name) ? i.sent[name] : i.base ? (i.base[name] ?? '') : null;
    if (known === null) continue;   // 기준판도 없고 보내지도 않았다 — 캐시가 서버와 같았는지 모르니 건드리지 않는다
    const cache = i.cacheNow[name] ?? '';
    if (cache === known && cache !== server) adopt.push(name);
  }
  return { base: next, adopt };
}
