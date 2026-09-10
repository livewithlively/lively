// 좌측 목록에 **설 자격**을 정하는 규칙 하나 (#3778, 원준 2026-09-10 3차 신고).
//
// ★ 왜 모듈로 뺐나 — 이 판정은 `main.ts` 안의 조건문으로 살면서 **같은 자리를 세 번 새게** 했다:
//   1차 앱 첫 화면 다섯 줄 · 2차 프로젝트마다 생기던 「새 세션」 줄 · 3차 앱 인스턴스(웹 브라우저 ×3).
//   묻혀 있으면 아무도 전체 규칙을 못 보고, 새 종류가 생겼을 때 «여기도 걸리나»를 물을 자리가 없다.
//   여기 순수 함수로 두면 표(아래 엣지)와 1:1로 테스트할 수 있고, 규칙 전체가 한 화면에 보인다.
//
// ★ 판정 방향을 뒤집었다 — 종전은 «서지 **않을** 것»을 열거했고(isBlankScreen), 그래서 **열거에서 빠진
//  종류가 전부 샜다**. 이제 «**설** 것»을 열거한다. 기본값이 «안 섬»이라 새 종류는 저절로 안 샌다.
//  대가: 여기 없는데 서야 하는 것이 생기면 **안 보이는 쪽으로 틀린다**. 그 대가를 고른 이유는,
//  목록에 없다고 못 가는 자리가 없기 때문이다(레일·런치패드·주소가 그대로 있다). 반대로 잡동사니는
//  목록 자체를 못 믿게 만든다 — 그게 세 번 신고된 증상이다.
//
// 기준은 하나 — **«두고 온 것이 있나»**. 돌아갈 상태가 없으면 «돌아간다»가 성립하지 않는다.

/** 판정에 필요한 앱 인스턴스의 사실만 — 레코드 전체가 아니라 이 셋이면 된다. */
export interface InstFacts {
  renderer?: string | null;
  /** 그 앱의 첫 주소(manifest system.home) — 브라우저가 «아직 안 움직였나»의 기준선. */
  home?: string | null;
  state?: Record<string, unknown> | null;
}

export interface StandsDeps {
  /** 그 창에 쓰다 만 지시가 있나(빈 홈·빈 프로젝트 슬롯을 가르는 유일한 축). */
  hasDraft: boolean;
  /** 클래식 딥링크의 첫 세그먼트인가(main.ts CLASSIC_PAGES). */
  isClassicPage(p: string): boolean;
  /** 인스턴스 사실 — 아직 못 읽었으면 null. */
  inst(id: string): InstFacts | null;
}

/** `#/a/b?x=1` → ['a','b'] (main.ts parseRoute 와 같은 자). */
export function routeSegs(route: string): string[] {
  const h = String(route || '').replace(/^#\/?/, '');
  const q = h.indexOf('?');
  return (q >= 0 ? h.slice(0, q) : h).split('/').filter(Boolean);
}

/**
 * 이 앱 인스턴스가 **두고 온 것을 들고 있나**.
 *
 * ⚠ «인스턴스가 있다»와 «두고 온 것이 있다»는 다르다. 정본 주소가 없는 앱(웹 브라우저 등)은
 *  multiplicity=multiple 이라 **열 때마다 새 인스턴스**가 서고(app-instance.ts openInstalledApp),
 *  스스로 닫히지 않는다(instance-janitor 는 `subject_kind='session'` 만 쓴다). 그래서 열어만 보고
 *  둔 것이 영영 줄로 남았다 — 실측 2026-09-10: 「웹 브라우저」 세 줄이 서로 구별도 안 됐다.
 *
 * · 브라우저 — `state.url` 이 첫 주소와 **다를 때만** 두고 온 것이다. 주소는 실제로 갱신된다
 *   (main.ts 의 300ms 디바운스 updateAppInstance) — 그래서 이 판정이 성립한다.
 * · 그 밖 — `state` 에 무언가 적혀 있으면 그것이 두고 온 것이다.
 */
export function instHasState(inst: InstFacts | null | undefined): boolean {
  if (!inst) return false;                       // 아직 못 읽었다 → 안 세운다(위 «안 보이는 쪽으로 틀린다»)
  const st = inst.state || {};
  if (inst.renderer === 'browser') {
    const url = String(st.url || '').trim();
    const home = String(inst.home || '').trim();
    return !!url && url !== home;
  }
  return Object.keys(st).length > 0;
}

/** 브라우저 인스턴스가 서 있는 호스트(`news.ycombinator.com`). 브라우저가 아니거나 주소가 없으면 ''.
 *  ⚠ `www.` 는 뗀다 — 목적이 «줄끼리 구분»이라, 모든 줄에 붙는 접두는 구분에 기여하지 않고 폭만 먹는다. */
export function instBrowserHost(inst: InstFacts | null | undefined): string {
  if (!inst || inst.renderer !== 'browser') return '';
  const url = String((inst.state || {}).url || '').trim();
  if (!url) return '';
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; }
}

/** 이 주소가 좌측 목록에 설 자격이 있나. **기본값은 «안 섬»** — 아래 열거에 걸릴 때만 선다. */
export function rowStands(route: string, deps: StandsDeps): boolean {
  const segs = routeSegs(route);
  const p = segs[0] || '';
  //  세션 — 대화·스크롤·돌던 작업을 들고 있고, **여기 말고 돌아갈 길이 없다.** 언제나 선다.
  //   (#2460 «보고 있는 화면이 목록에 없으면 고장이다»가 지키려던 것이 이 한 줄이다.)
  if (p === 's') return true;
  //  홈(새 작업)·프로젝트 주소(= 세션 되기 전 빈 슬롯) — 쓰다 만 지시가 있을 때만.
  if (!p || p === 'dashboard' || p === 'p') return deps.hasDraft;
  //  앱 인스턴스 — 그 인스턴스가 실제로 뭘 들고 있을 때만.
  if (p === 'i') return instHasState(deps.inst(decodeSeg(segs[1])));
  //  앱의 **깊은 자리**(문서·항목 하나를 열어 둠) = «어디까지 봤나». 뿌리(첫 화면)는 레일·런치패드가 문이다.
  if (p === 'app') return segs.length > 2;
  if (p === 'inbox' || p === 'sources' || deps.isClassicPage(p)) return segs.length > 1;
  //  그 밖(보관·휴지통·연결·리브·처음설정 …)은 안 선다 — 전부 한 번 눌러 가는 자리다.
  return false;
}

function decodeSeg(s: string | undefined): string {
  try { return decodeURIComponent(s || ''); } catch { return s || ''; }
}
