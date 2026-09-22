// connect-axes.ts — [외부 앱 연결] **목록**이 앱마다 «두 축»을 판정하는 잣대 (#3778, 원준 2026-09-20).
//
//  왜 목록에 두 축이 필요한가: 이 화면은 스스로 «앱마다 연결이 두 가지예요» 라고 말해 놓고, 카드는 한 축
//  (내 계정 자격)만 보고 «아직 연결 안 함» 이라고 썼다. 그래서 자료를 이미 가져오고 있는 앱이 목록에선
//  «연결 안 함» 으로 서 있었다 — #2202 B1 이 상세에서 한 번 푼 모순(«연결 안 됨» + «2곳에서 모으는 중»)이
//  목록에 그대로 남아 있었던 것이다. 상세(#2243 3차)는 이미 «연결 두 가지» 두 줄로 말하므로, 목록도 같은
//  두 줄을 쓰면 두 화면이 한 사실을 같은 말로 말한다.
//
//  ⚠ 이 파일은 DOM 을 모른다 — 판정만 한다(그래서 scripts/connect-axes.test.mjs 가 표를 돈다).

/**
 * 한 축의 상태.
 *  · on   — 켜져 있다
 *  · off  — 아직 안 켰고 **정하지도 않았다**(이 상태가 있으면 그 앱은 «연결 중»이다)
 *  · skip — 이 사람이 «안 쓴다»고 **정했다**. 꺼진 것과 다른 말이다 — 정한 것은 미완이 아니다.
 *  · soon — 라이블리가 아직 못 연다
 *  · none — 이 앱엔 그 축이 아예 없다(끌 수 있는 것이 아니다)
 */
export type AxisState = 'on' | 'off' | 'skip' | 'soon' | 'none';

/** 목록에서 이 앱이 어느 묶음에 서나. «half» = 한쪽만 켜고 나머지는 아직 안 정했다. */
export type CardState = 'on' | 'half' | 'off' | 'soon';

/** «안 쓴다»고 정한 축의 키 — `<앱키>:use` · `<앱키>:get`. */
export function skipKey(app: string, axis: 'use' | 'get'): string { return `${app}:${axis}`; }

/**
 * 수집기 preset → 외부 앱 키. **관문이 아니라 별명표다** — 여기 있는 것만 통과시키는 게 아니라, 이름이
 *  다른 것만 고쳐 적는다.
 *  preset_key 는 서버의 CONNECTOR_SPECS system 이름이라 앱 키와 대체로 같고, 구글만 드라이브·Gmail·캘린더
 *  세 프리셋이 한 앱(#1881 G2 — 구글 타일은 한 줄)으로 접힌다.
 *  ⚠ 표에 없는 preset 을 버리면, 서버에 앱이 하나 늘 때마다 그 카드가 **영영 «꺼짐»** 이라고 말한다(거짓).
 *   그래서 모르는 preset 은 제 이름 그대로 센다 — 카드가 그 이름으로 찾을 때만 쓰이므로 엉뚱한 칸이
 *   켜지지 않는다(화면에 카드가 없는 domain-wiki·discord 는 아무도 안 찾는다).
 */
export const COLLECT_PRESET_APP: Record<string, string> = {
  slack: 'slack', notion: 'notion', github: 'github', gitlab: 'gitlab', linear: 'linear',
  figma: 'figma', clickup: 'clickup',
  gdrive: 'google', google_drive: 'google', gmail: 'google', gcal: 'google', google_calendar: 'google',
};

/**
 * «자료 가져오기» 얼굴이 있는 앱 — 상세(renderConnectApp)가 어댑터를 붙이는 명단 그대로다.
 *  여기 없는 앱(Prometheus·Claude 헤드리스·관리자가 새로 등록한 커넥터)은 상세에서 «아직 없어요» 라고
 *  말하므로, 목록도 같은 말을 해야 한다. 칸을 지우지 않는 이유는 상세와 같다 — 틀이 흔들리면 앱마다 다른
 *  화면이 된다.
 */
export const COLLECT_APPS: readonly string[] = ['slack', 'notion', 'google', 'linear', 'gitlab', 'figma', 'clickup', 'github'];

export interface CollectorLike { preset_key?: string | null; enabled?: boolean | null }
/** 앱 하나에 걸린 수집기 셈 — 켜진 것 · 만들어는 뒀지만 꺼진 것. */
export interface CollectTally { on: number; off: number }

/**
 * `/api/ui/org/collectors` 한 번으로 앱별 수집기 셈을 만든다.
 *  ⚠ 앱마다 `/api/ui/org/<app>/collect` 를 부르면 목록 한 장에 여덟 번 왕복이다 — 목록은 한 번만 묻는다.
 *   (그 창구들은 상세가 쓴다: 상세는 한 앱만 그리고 토글·범위까지 다뤄야 해서 그 앱의 전체 상태가 필요하다.)
 */
export function collectTally(rows: readonly CollectorLike[] | null | undefined): Map<string, CollectTally> {
  const out = new Map<string, CollectTally>();
  for (const r of rows ?? []) {
    const raw = String(r?.preset_key ?? '').trim();
    if (!raw) continue;
    const app = COLLECT_PRESET_APP[raw] ?? raw;
    const cur = out.get(app) ?? { on: 0, off: 0 };
    if (r?.enabled) cur.on += 1; else cur.off += 1;
    out.set(app, cur);
  }
  return out;
}

export interface AppAxes {
  /** 내 계정으로 직접 사용(= MCP·자격). */
  use: AxisState;
  /** 자료 가져오기(= 수집기). */
  get: AxisState;
  /** 켜져 있는 수집기 개수 — 노션처럼 워크스페이스가 여럿이면 2 이상이 된다(«2곳»). */
  getOn: number;
}

/** 아직 «켤까 말까»가 남은 축 — 이게 있으면 카드가 «연결 중»이다(덜 끝난 느낌은 여기서 나온다). */
export function pendingAxes(a: AppAxes): Array<'use' | 'get'> {
  const out: Array<'use' | 'get'> = [];
  if (a.use === 'off') out.push('use');
  if (a.get === 'off') out.push('get');
  return out;
}

/**
 * 앱 하나의 두 축.
 *  @param key   앱 키(LOGIN_SERVICES.key)
 *  @param use   자격 원본으로 판정한 «직접 사용» 상태 — 목록 배치가 아니라 자격이 근거다(#2243 stateOf 와 같은 규칙)
 *  @param tally collectTally 결과
 *
 *  ★ 열거는 «가진 것» 쪽으로 한다 — COLLECT_APPS 에 있는 앱만 그 축을 가진다(기본값 «없음»). 반대로
 *   «없는 앱만 빼기» 로 적으면 앱이 늘 때마다 조용히 «꺼짐» 으로 새서, 켤 수도 없는 축을 «꺼져 있다» 고
 *   말하게 된다(이 프로젝트가 세 번 밟은 그 모양 — 3778 본문 «열거의 방향»).
 */
export function appAxes(key: string, use: AxisState, tally: Map<string, CollectTally>,
  skip?: ReadonlySet<string> | null): AppAxes {
  const t = tally.get(key);
  const has = COLLECT_APPS.includes(key);
  const getOn = t?.on ?? 0;
  const declined = (axis: 'use' | 'get') => !!skip?.has(skipKey(key, axis));
  //  ⚠ «안 쓴다»는 **켜져 있지 않을 때만** 뜻이 있다 — 실제로 도는 것을 «안 쓴다»고 칠하면 화면이 거짓말한다.
  //   준비 중도 «안 쓴다»가 이길 수 없다(못 켜는 것을 사람이 정한 것으로 바꾸지 않는다).
  const useSt: AxisState = use === 'on' || use === 'soon' ? use : declined('use') ? 'skip' : use;
  //  수집기가 실제로 돌고 있으면 «켜짐» 이 이긴다 — 명단에 없더라도 사실이 먼저다(표가 낡아도 거짓말하지 않는다).
  const get: AxisState = getOn > 0 ? 'on' : !has ? 'none' : declined('get') ? 'skip' : 'off';
  return { use: useSt, get, getOn };
}

/**
 * 목록에서 이 앱이 어느 묶음에 서나 — 네 갈래.
 *  ★ 하나도 안 켰으면 «연결할 수 있는 앱», **하나만 켰고 나머지를 아직 안 정했으면 «연결 중»**,
 *   켠 것이 있고 남은 게 없으면 «연결 완료».
 *  «연결 중»을 따로 세우는 이유(원준 2026-09-20): 수집기는 흔히 저절로 생기므로 «둘 중 하나만 켜진» 상태가
 *   기본값처럼 흔한데, 종전엔 그게 «연결됨»과 한 칸에 섞여 **덜 끝난 것이 끝난 것처럼** 보였다. 끝내는 길은
 *   둘이다 — 나머지를 켜거나, «안 쓴다»고 정하거나. 둘 다 «연결 완료»로 간다(정한 것은 미완이 아니다).
 *  ⚠ 준비 중이 연결 여부보다 앞선다 — 목록의 뜻이 «라이블리가 이걸 내밀고 있나» 이기 때문이다(#2243).
 *   그래도 카드는 제 두 축을 사실대로 말한다(뺏지 않는다).
 */
export function listBucket(axes: AppAxes, soon: boolean): CardState {
  if (soon) return 'soon';
  if (axes.use !== 'on' && axes.get !== 'on') return 'off';
  return pendingAxes(axes).length ? 'half' : 'on';
}

/**
 * 카탈로그의 «준비 중» 이 **지금도** 유효한가 (#4211).
 *  · soon 이 없으면 준비 중이 아니다.
 *  · soonUntilReady 인 앱은 서버가 그 커넥터 줄에 `ready: true` 를 실어 보낼 때만 준비 중을 걷는다.
 *    ready 를 **모르면**(옛 게이트웨이·필드 없음) 표 그대로 둔다 — 모르는 것을 «열렸다» 로 읽으면 눌러도 안 되는 카드를 내민다.
 *  종전엔 구글의 준비 중이 화면에 박혀 있어, 매니지드에 릴레이·클라이언트가 갖춰져도 **코드를 다시 배포해야** 열렸다.
 */
export function catalogSoon(svc: { soon?: string; soonUntilReady?: boolean }, connector: { ready?: unknown } | null | undefined): boolean {
  if (!svc.soon) return false;
  if (!svc.soonUntilReady) return true;
  return !(connector && connector.ready === true);
}
