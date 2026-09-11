// v2/shell-prefs-sync.ts — 셸 개인화 동기의 **판정만** 떼어 둔 순수 모듈(#3887). DOM·네트워크·저장소를 모른다.
//
// ── 무엇이 문제였나 ─────────────────────────────────────────────────────────────
//  화면은 저장할 때마다 **문서 전체**를 보냈고 서버는 통째로 바꿨다. 켜 둔 채 낡은 캐시를 든 창(노트북)이 접힘 하나를
//   저장하면 — 그룹이 활성이 되는 순간 화면이 스스로 적는다(side.ts grpOpened) — 그 사이 다른 기기(데스크톱)에서
//   한 고정·치움이 그 판에 통째로 덮였다. 사람은 아무것도 안 눌렀는데 결정이 사라진다.
//
// ── 어떻게 ────────────────────────────────────────────────────────────────────
//  · **기준판(base)** — «이 창이 서버와 같다고 아는 저장소별 값». 부팅 때 **늘** 선다:
//    조회 성공 → 서버판을 얹은 뒤의 캐시 · 서버에 이력 없음 → 빈 판 · 조회 실패 → **부팅 스냅숏**(서버판을 얹기 전 캐시).
//    그래서 조회가 실패해도 통째 교체를 보내지 않는다 — «이 창에서 로드 뒤 바뀐 것» 만 보낸다.
//  · 저장은 **기준판과 다른 저장소만** patch 로 보낸다(서버가 그 저장소만 병합한다).
//  · 응답에서 얹는 것은 **보낸 저장소의 서버 정규화 결과**(상한·형식으로 버린 뒤)뿐이다 — 보낸 뒤로 캐시가 그대로일 때만.
//    ⚠ **안 보낸 저장소는 얹지 않는다**(적대검토 r2). 다른 기기의 값이 «더 새 결정» 인지 «낡은 캐시의 통째 교체» 인지
//     여기서는 가를 수 없다 — 얹으면 조회 실패 창·옛 번들 탭의 통째 교체 한 번이 이 창에 영구히 채택된다.
//  · 응답에 병합 표식(merged)이 없으면 옛 서버다 — prefs 로 통째 교체됐으니 기준판은 보낼 때 캐시 전부, 얹는 것 없음.
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
 * 조회 응답이 서버 정본으로 믿을 모양인가 — `{ prefs: 객체, saved: 불리언 }`.
 *  api() 는 2xx 인데 JSON 이 아니면 null 을 돌려준다(lib/net.ts) — 그걸 «서버에 이력 없음» 으로 읽으면 안 된다.
 */
export function isPrefsResponse(v: unknown): v is { prefs: Record<string, unknown>; saved: boolean } {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return !!r.prefs && typeof r.prefs === 'object' && !Array.isArray(r.prefs) && typeof r.saved === 'boolean';
}

/** 이번 저장에 patch 로 실을 저장소 — 기준판과 비교값이 다른 것(비었으면 보낼 것이 없다). */
export function planPush(now: Record<string, string>, base: Record<string, string>): string[] {
  return Object.keys(now).filter((name) => now[name] !== (base[name] ?? ''));
}

export interface AdoptInput {
  /** 보내기 직전의 기준판. */
  base: Record<string, string>;
  /** 실어 보낸 저장소 → 보낼 때의 캐시 비교값. */
  sent: Record<string, string>;
  /** 보낼 때의 캐시 비교값 전부 — 옛 서버는 이것(prefs)으로 통째 교체했다. */
  all: Record<string, string>;
  /** 응답을 받은 지금의 캐시 비교값. */
  cacheNow: Record<string, string>;
  /** 병합 응답(merged)의 저장소별 비교값. null = 병합 표식 없음(옛 서버의 통째 교체). */
  server: Record<string, string> | null;
}

/**
 * 저장 응답을 받았다 — 새 기준판과 «캐시에 서버 값을 얹을 저장소» 를 정한다.
 *  · 옛 서버(server=null): 보낸 prefs 로 통째 교체됐다 → 기준판 = 보낼 때 캐시 전부 · 얹는 것 없음.
 *  · 보낸 저장소: 기준판 ← 서버 값. 보낼 때 값 그대로인데 서버 값이 다르면(버림) 얹는다.
 *    그새 바뀐 저장소는 얹지 않는다 — 방금 사람이 한 일을 되돌리지 않는다(다음 저장이 새 값을 보낸다).
 *  · 안 보낸 저장소: 기준판·캐시 모두 그대로(모듈 머리말 — 남의 값은 채택하지 않는다).
 */
export function adoptResponse(i: AdoptInput): { base: Record<string, string>; adopt: string[] } {
  if (!i.server) return { base: { ...i.all }, adopt: [] };
  const next: Record<string, string> = { ...i.base };
  const adopt: string[] = [];
  for (const name of Object.keys(i.sent)) {
    const server = i.server[name] ?? '';
    next[name] = server;
    if ((i.cacheNow[name] ?? '') === i.sent[name] && server !== i.sent[name]) adopt.push(name);
  }
  return { base: next, adopt };
}

/** 저장 실패 뒤 다시 보낼 때까지 기다릴 시간(ms) — n 번째 재시도. 다 쓰면 null(다음 조작이 다시 보낸다). */
export function retryDelay(n: number): number | null {
  return [5_000, 20_000, 60_000][n] ?? null;
}
