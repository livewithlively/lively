// v2/onboarding.ts — 처음 설정(#/welcome). 프로토타입 public/onboarding-proto/v2.html 의 가운데 화면을 v2 셸 안으로 옮긴 것(#1813).
//  노션 온보딩 실측(원준님 PDF 2026-08-24)의 3막 구조: 막1 이름만(사이드바 숨김) → 막2 질문 기둥 → 막3 리브와의 채팅.
//  사이드바는 실제 것(side.ts)이 그린다 — 여기선 막1에서 숨겨 달라고(ctx.onBare), 막2·3에서는 **유령**으로
//  세워 달라고(ctx.onGhost — 보이되 만질 수 없다, 노션 p2~4 · 원준님 지시 #2232)만 부탁한다.
//  문구는 원준님 교정 31건 반영본. 새로 쓴 연결부는 [새문구] 주석. 상태는 sessionStorage(진행)·localStorage(끝남 표식).
//  ⚠ 프로토타입에서 그대로 옮긴 코드라 타입을 붙이지 않았다(// @ts-nocheck) — 기능 배선(답 저장·실제 분류)을 붙일 때 정리한다.
// @ts-nocheck
import { authUploadProgress, upDropZone, upFromInput } from '../projects/files-upload.js';
import { sessionTermUrl } from '../lib/session-open.js';   // #2232 — AI 로그인 창(터미널 한 장) 주소는 한 곳에서만 만든다   // #1881 L4 — 자료 넘기기 실배선(새 업로드 코드 금지)
import { api, apiUrl, state } from '../core.js';
import { drawRail } from './rail.js';   // 이름을 바꾸면 레일 발치의 [나]도 그 자리에서 다시 그린다(#1813)
//  #1879 — 외부 앱을 **실제로** 잇는다. 잇는 길은 새로 만들지 않고 이미 깎아 둔 한 곳을 그대로 쓴다:
//   서비스 표·연결 판정은 me-logins.ts(=[외부 앱 연결] 화면 v2/connect.ts 와 같은 정본), 토큰 발급처·생김새는
//   admin-credentials.ts 의 CRED_KINDS. **표가 두 벌이 되면 조용히 어긋난다** — 여기서 다시 만들지 않는다.
import { LOGIN_SERVICES, partition } from '../me-logins.js';
import { CRED_KINDS } from '../admin-credentials.js';
export const OB_DONE_KEY = 'lively_ob_done';
/** 빠른 로컬 캐시 — 첫 그림에서 화면이 깜빡이지 않게 쓴다. **정본은 서버**(아래 fetchOnboardingDone). */
export function onboardingDone(): boolean { try { return localStorage.getItem(OB_DONE_KEY) === '1'; } catch (_) { return false; } }
/**
 * 처음 설정으로 **자동으로 보냈다**를 서버에 남긴다(#2171). «끝냈다»(onboarded)와 다른 사실이다.
 *
 *  왜 필요한가: 종전엔 끝냄 표식이 온보딩 맨 끝 [준비 끝, 정리해 주세요] 한 자리에서만 찍혔다. 그래서
 *   중간에 나간 사람은 서버 눈에 영영 '처음 오는 사람'이라 **앱을 열 때마다 다시 끌려갔다**(원준님 신고
 *   2026-08-27). 자동 진입은 평생 한 번이어야 하고, 그 근거는 «보여줬다»는 사실이지 «끝냈다»가 아니다.
 *
 *  ⚠ 실패해도 삼킨다 — 표식을 못 남겼다고 화면이 안 뜨면 안 된다. 다음 부팅에 한 번 더 뜨는 것이
 *   최악이고, 그건 종전과 같지 더 나쁘지 않다(구 서버도 400 을 낼 뿐 화면은 그대로 뜬다).
 */
export function markWelcomeSeen(): void {
  void api('/api/ui/me/liv-profile', { method: 'POST', body: JSON.stringify({ welcome_seen: true }) })
    .catch(() => { /* 비치명 — 위 ⚠ */ });
}

/**
 * [나중에 할게요] — 사람이 **스스로 미뤘다**는 표식(#2232). 하다 만 자리가 있으면 다음 부팅에 그 장면으로 자동
 *  복귀하는 것이 기본인데(«어디까지 했는지 기억해서 거기부터»), 스스로 미룬 사람까지 끌고 가면 #2171 의
 *  «시도때도없이»가 된다. 그래서 이 버튼만 표식을 남기고, 홈의 «이어서 하기»가 길을 지킨다. 실패해도 삼킨다.
 */
export function markWelcomeDeferred(): void { setWelcomeDeferred(true); }

/**
 * 미룸 해제 — **사람이 처음 설정을 다시 연 순간**(#2232). 자동 진입은 미룬 사람에게 오지 않으므로, 이 화면이
 *  떴다는 것은 곧 «홈의 이어서 하기를 눌렀거나 스스로 주소로 왔다» 는 뜻이다. 여기서 풀어야 그 뒤 탭을 그냥
 *  닫아도 다음 입장에 하던 자리로 돌아간다. ⚠ 진행 저장에서 풀면 나가기 flush 와 경합한다(server members.ts 주석).
 */
export function clearWelcomeDeferred(): void { setWelcomeDeferred(false); }

function setWelcomeDeferred(on: boolean): void {
  void api('/api/ui/me/liv-profile', { method: 'POST', body: JSON.stringify({ welcome_deferred: on }) })
    .catch(() => { /* 비치명 */ });
}

/**
 * 처음 설정을 끝냈는지 **서버에 묻는다**(#1813). 종전엔 localStorage 표식뿐이라 기기·브라우저를 바꾸면
 *  이미 끝낸 사람에게 온보딩이 다시 떴다. 서버가 답을 주면 로컬 캐시도 그 값으로 맞춘다.
 *  못 물으면(오프라인·구 서버) 로컬 캐시로 떨어진다 — 온보딩 때문에 앱이 안 열리는 일은 없어야 한다.
 */
export async function fetchOnboardingDone(): Promise<boolean> {
  try {
    const r: any = await api('/api/ui/me/welcome');
    const done = !!(r && r.done);
    try { done ? localStorage.setItem(OB_DONE_KEY, '1') : localStorage.removeItem(OB_DONE_KEY); } catch (_) { /* 사파리 프라이빗 */ }
    return done;
  } catch (_) { return onboardingDone(); }
}

/* ── 데스크톱 앱 내려받기 (#1813) ──────────────────────────────────────────────
 *  종전엔 «앱 받기» 가 "설정 ▸ 데스크톱 앱에서 받으실 수 있어요" 토스트만 띄웠다. 그런데 **코어 어디에도
 *   내려받기 주소가 없다**(실측 2026-08-26: releases/download 문자열 0건) — 안내가 가리키는 자리가 비어
 *   있어서 사람은 앱을 끝내 못 받는다. 퍼널이 거기서 끊긴다.
 *  릴리스는 공개라 **브라우저가 직접** 물어볼 수 있다(GitHub API 가 CORS 를 연다). 서버를 거치지 않으니
 *   테넌트 컨테이너의 바깥 망에 기대지 않고, 게이트웨이에 새 문을 내지도 않는다.
 *  ⚠ 실패하면 **릴리스 페이지로 보낸다** — 종전과 같은 자리이지 더 나쁘지 않다. 절대 던지지 않는다.
 */
const DL_API = 'https://api.github.com/repos/livewithlively/lively/releases/latest';
const DL_PAGE = 'https://github.com/livewithlively/lively/releases/latest';

/** 이 브라우저가 도는 OS. 못 가리면 null — 그때는 릴리스 페이지로 보낸다(추측해서 엉뚱한 파일을 주지 않는다). */
function desktopOs() {
  const s = `${navigator.userAgent} ${navigator.platform || ''}`.toLowerCase();
  if (s.includes('mac')) return 'mac';
  if (s.includes('win')) return 'win';
  if (s.includes('linux') || s.includes('x11')) return 'linux';
  return null;
}

/** 자산 이름 → 내 OS 것인가. blockmap·업데이트 매니페스트(.yml)·코어 tgz 는 사람이 받을 것이 아니다 —
 *  확장자로 끝나는지만 보면 `.exe.blockmap` 류는 저절로 걸러진다.
 *
 *  ★★ 불변식: **맥 자산은 `.dmg` 가 정확히 하나여야 한다.** 이 함수는 첫 번째로 맞는 것을 집는데,
 *   arch 별로 둘(`-arm64.dmg`·`-x64.dmg`)이면 **인텔 사용자가 arm64 를 받을 확률이 반반**이 된다.
 *   그리고 브라우저는 맥의 CPU 아키텍처를 **알 수 없다** — 애플이 호환성 때문에 애플 실리콘에서도
 *   `navigator.platform` 을 `MacIntel` 로 남겨 뒀고, UA 힌트도 macOS 에선 arch 를 안 준다.
 *   즉 여기서 갈라 주는 것은 원리적으로 불가능하다.
 *  → 그래서 `desktop/package.json` 의 mac 타깃을 **universal** 로 둔다(dmg·zip 둘 다).
 *   그 앱은 네이티브 의존성이 없어(electron-updater 하나, 순수 JS) universal 의 주된 위험도 없다.
 *  ⚠ 그 설정을 `arch:["x64","arm64"]` 로 되돌리려는 사람에게: 그러면 **이 함수부터 고쳐야 하는데
 *   고칠 방법이 없다.** 정 나눠야 한다면 사람에게 고르게 하는 화면이 먼저다. */
function pickAsset(assets, os) {
  const ext = os === 'mac' ? '.dmg' : os === 'win' ? '.exe' : '.appimage';
  for (const a of assets) {
    const name = typeof (a && a.name) === 'string' ? a.name.toLowerCase() : '';
    const url = typeof (a && a.browser_download_url) === 'string' ? a.browser_download_url : '';
    if (name && url && name.endsWith(ext)) return url;
  }
  return null;
}

/** 내 OS 설치본 주소. 한 번만 묻고 그 답을 재사용한다. 실패·못 가림이면 null. */
let dlCache;
async function desktopLink() {
  if (dlCache !== undefined) return dlCache;
  const os = desktopOs();
  if (!os) { dlCache = null; return null; }
  try {
    const res = await fetch(DL_API, { headers: { accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    dlCache = pickAsset(Array.isArray(body && body.assets) ? body.assets : [], os);
  } catch (_) { dlCache = null; }
  return dlCache;
}

export function renderOnboarding(host: HTMLElement, ctx: { onBare?: (bare: boolean) => void; onGhost?: (on: boolean) => void; onDone?: () => void } = {}): { destroy(): void } {
  host.className = 'ob-root';
  // ⚠ 나가는 문(#2171). 종전엔 처음 설정에서 **스스로 나갈 길이 없었다** — 장면마다 「나중에 정할게요」가
  //  있었지만 그건 다음 질문으로 넘기는 버튼이지 나가는 버튼이 아니었고, 끝까지 완주해야만 벗어날 수 있었다.
  //  홈으로 보내면서 «이어서 하기» 를 남긴다(포기가 아니라 미룸 — views.ts 의 홈 줄이 받는다).
  host.innerHTML = `<div class="ob-crumb" id="crumb"><span class="ob-lm">L</span><span style="font-weight:600">리브</span><span class="ob-sep">/</span><span>처음 설정</span><button class="ob-q-back" id="obBack" data-back hidden>← 이전</button><button class="ob-q-back ob-q-exit" id="obExit" title="홈으로 갑니다. 남은 설정은 홈에서 이어서 하실 수 있어요.">나중에 할게요</button></div>
    <div class="ob-qwrap"><div class="ob-qcol" id="qcol"></div></div>
    <div class="ob-chat"><div class="ob-thread" id="thread"></div></div>
    <div class="ob-composer"><div class="ob-composer-in">
      <input id="composeIn" type="text" placeholder="직접 적으셔도 됩니다" aria-label="리브에게 쓰기">
      <div class="ob-composer-row"><span>＋</span><span>Auto</span><button class="ob-send" id="composeGo">↑</button></div>
    </div></div>
<div class="ob-toast" id="toast"></div>`;
  const DONE_KEY = OB_DONE_KEY;
  // 나가는 문 배선(#2171) — 화면에 들어온 것 자체가 «보여줬다» 이므로 표식을 찍고 홈으로 보낸다.
  //  ★ 여기서 markWelcomeSeen 을 한 번 더 부르는 이유: 자동 진입이 아니라 **사람이 스스로** 이 화면을
  //   열었을 수도 있다(홈의 «이어서 하기» · 주소 직접 입력). 그때도 자동 진입 표식은 있어야 옳다 —
  //   서버는 이미 찍혔으면 처음 시각을 지키므로(appendLivProfile) 두 번 불러도 값이 밀리지 않는다.
  markWelcomeSeen();
  //  #2232 — 이 화면이 떴다 = 사람이 다시 열었다(미룬 사람에겐 자동 진입이 오지 않는다) → 미룸을 푼다.
  clearWelcomeDeferred();
  //  #2232 — 떴다(보여줬다) = 끝낼 때까지 «하다 만 것» 이다. 홈의 «이어서 하기» 줄은 me.welcome_pending 을 보는데
  //   me 는 부팅 때 한 번 읽는다 — 그래서 [나중에 할게요] 가 아닌 길(사이드바·뒤로·주소창)로 나가면 새로고침 전엔
  //   줄이 안 떴다(원준님 실측 2026-08-28 "어떻게 해야 하던 데까지 다시 돌아가?"). 서버 판정(seen && !done)과 같은 값을
  //   여기서 미리 맞춰 둔다. 끝내면 아래 마무리에서 끈다.
  try { if (state.me && !onboardingDone()) (state.me as { welcome_pending?: boolean }).welcome_pending = true; } catch (_) { /* 비치명 */ }
  //  ⚠ `$` 는 아래에서 선언된다(const, TDZ) — 여기선 host 에서 직접 집는다.
  const exitBtn = host.querySelector('#obExit') as HTMLButtonElement | null;
  if (exitBtn) exitBtn.onclick = () => {
    markWelcomeDeferred();
    //  #2232 — 홈의 «이어서 하기» 줄은 me.welcome_pending 을 본다. me 는 부팅 때 한 번 읽으므로, 표식만
    //   서버에 보내고 나가면 **그 자리에서는 줄이 안 뜬다**(새로고침해야 보였다 — 실측). 나가는 사람에게
    //   돌아올 길이 보이지 않으면 그 버튼은 '포기'가 된다. 우리가 방금 만든 사실이니 여기서 함께 반영한다.
    try { if (state.me) (state.me as { welcome_pending?: boolean }).welcome_pending = true; } catch (_) { /* 비치명 */ }
    location.hash = '#/';
  };
  /* 서버 실측 — 내가 올린 자료·종류별 집계·지금 갈래. 연출 숫자를 여기 값으로 갈아끼운다(#1813). */
  let WS: any = null;
  async function loadWelcome() {
    try { WS = await api('/api/ui/me/welcome'); } catch (_) { WS = null; }
    return WS;
  }
  /** 지금 아는 **진짜** 갈래 집계. 서버를 아직 못 읽었으면 빈 배열(연출 숫자를 만들지 않는다). */
  const realKinds = () => (WS && WS.uploads && Array.isArray(WS.uploads.kinds)) ? WS.uploads.kinds : [];
  /** 올린 자료 총수 — 업로드 카운터와 서버 총계 중 큰 쪽(막 올린 건 서버가 아직 모를 수 있다). */
  const realTotal = () => Math.max(S.upN || 0, (WS && WS.uploads && WS.uploads.total) || 0);
  /* ── #2232 올린 파일 목록 ─────────────────────────────────────────────────────
   *  S.upFiles = [{ n: 이름, r: 상대경로, s: 바이트, st: 'up'|'ok'|'err' }] — 진행 저장에 함께 실려 새로고침·재입장에도 남는다.
   *  그림 미리보기는 이 탭의 메모리(objectURL)에만 있다 — 다시 들어오면 종류 배지로 돌아간다(서버에 다시 묻지 않는다).
   *  ⚠ 상한(UP_KEEP)을 둔다 — 폴더째 수천 장을 올리면 진행 저장(welcome_progress)이 그만큼 커진다. 넘친 만큼은 숫자로만. */
  const THUMB = new Map();
  const UP_KEEP = 200;
  const noteFile = (it) => {
    if (!Array.isArray(S.upFiles)) S.upFiles = [];
    const f = it.file, rel = String(it.rel || f.name).replace(/^\/+/, '');
    const row = { n: f.name, r: rel, s: f.size || 0, st: 'up' };
    if (S.upFiles.length < UP_KEEP) S.upFiles.push(row);
    try { if (/^image\//.test(f.type || '') && f.size < 8 * 1024 * 1024 && !THUMB.has(rel)) THUMB.set(rel, URL.createObjectURL(f)); } catch (_) { /* noop */ }
    return row;
  };
  const KIND_OF = [
    ['doc', /\.(pdf|docx?|hwpx?|txt|md|rtf|odt|pages)$/i], ['sheet', /\.(xlsx?|csv|tsv|numbers|ods)$/i], ['slide', /\.(pptx?|key|odp)$/i],
    ['img', /\.(png|jpe?g|gif|webp|svg|heic|bmp|tiff?)$/i],
    ['code', /\.(js|ts|tsx|jsx|py|java|go|rs|rb|php|c|cpp|h|cs|swift|kt|json|ya?ml|xml|html?|css|sql|sh)$/i],
    ['zip', /\.(zip|tar|gz|tgz|7z|rar)$/i],
  ];
  const kindOf = (name) => { for (const [k, re] of KIND_OF) if (re.test(name)) return k; return 'file'; };
  const extOf = (name) => { const m = /\.([a-z0-9]{1,5})$/i.exec(name); return m ? m[1].toUpperCase().slice(0, 4) : '파일'; };
  const fmtSize = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
  const KIND_LABEL = { dir: '폴더', img: '사진', doc: '문서', sheet: '표', slide: '발표', code: '코드', zip: '압축', file: '기타' };
  /** 받은 파일 목록 HTML — **요약 칩 한 줄 + 스크롤 되는 촘촘한 줄 목록**(#2232 원준님: 타일 카드는 8개만 돼도 화면을 다 먹는다).
   *  폴더째 올린 것은 폴더 한 줄(안에 몇 개), 낱개 파일은 한 줄씩, 방금 올린 것이 맨 위. 목록은 여섯 줄 높이에서 멈추고
   *  안에서만 스크롤한다 — 몇 백 개를 올려도 화면 길이는 같다. 비어 있으면 ''. */
  function fileListHtml() {
    const rows = Array.isArray(S.upFiles) ? S.upFiles : [];
    if (!rows.length && !(S.upN || 0)) return '';
    const dirs = new Map(), loose = [];
    for (const r of rows) {
      const i = String(r.r || '').indexOf('/');
      if (i > 0) { const top = r.r.slice(0, i); const d = dirs.get(top) || { n: top, c: 0, s: 0, up: 0 }; d.c++; d.s += r.s || 0; if (r.st === 'up') d.up++; dirs.set(top, d); }
      else loose.push(r);
    }
    // 요약 — 종류별 개수(폴더는 안의 파일 수가 아니라 폴더 수)
    const cnt = {};
    for (const r of loose) { const k = kindOf(r.n); cnt[k] = (cnt[k] || 0) + 1; }
    if (dirs.size) cnt.dir = dirs.size;
    const missing = Math.max(0, (S.upN || 0) - rows.length);   // 저장 상한(UP_KEEP)을 넘긴 몫 — 이름 없이 숫자로만
    const order = ['dir', 'img', 'doc', 'sheet', 'slide', 'code', 'zip', 'file'];
    const chips = order.filter((k) => cnt[k]).map((k) => `<span class="ob-fchip ob-fi-${k}"><i></i>${KIND_LABEL[k]} <b>${cnt[k]}</b></span>`).join('')
      + (missing ? `<span class="ob-fchip"><i></i>그 밖 <b>${missing}</b></span>` : '');
    const busy = rows.filter((r) => r.st === 'up').length;
    const sum = `<div class="ob-files-sum"><span class="ob-files-n">${(S.upN || 0) + busy}개</span>${chips}</div>`;
    const line = [];
    for (const d of [...dirs.values()].reverse()) {
      line.push(`<div class="ob-file${d.up ? ' ob-up' : ''}"><span class="ob-fi ob-fi-dir">${GLYPH.folder}</span><span class="ob-file-n" title="${esc(d.n)}">${esc(d.n)}</span><span class="ob-file-m">${d.up ? '올리는 중' : `${d.c}개 · ${fmtSize(d.s)}`}</span></div>`);
    }
    for (const r of loose.slice().reverse()) {
      const k = kindOf(r.n), th = THUMB.get(r.r);
      const ic = th ? `<span class="ob-fi ob-fi-img"><img src="${esc(th)}" alt=""></span>` : `<span class="ob-fi ob-fi-${k}"><i>${esc(extOf(r.n))}</i></span>`;
      const m = r.st === 'up' ? '올리는 중…' : r.st === 'err' ? '올리지 못했어요' : fmtSize(r.s);
      line.push(`<div class="ob-file${r.st === 'up' ? ' ob-up' : ''}${r.st === 'err' ? ' ob-err' : ''}">${ic}<span class="ob-file-n" title="${esc(r.n)}">${esc(r.n)}</span><span class="ob-file-m">${m}</span></div>`);
    }
    const more = line.length > 6 ? `<div class="ob-files-more">전체 ${line.length}줄 — 목록 안에서 스크롤하세요</div>` : '';
    return sum + `<div class="ob-files-list">${line.join('')}</div>` + more;
  }
  /* 막1(이름)은 민낯(셸 숨김), 막2·3(질문·채팅)은 유령 셸(#2232) — 사이드바를 누르면 처음 설정에서 **빠져나가 버렸다**
   *  (원준님 실측 2026-08-28). 나가는 문은 [나중에 할게요] 하나다. */
  const setStage = (s) => { host.className = 'ob-root ob-' + s; ctx.onBare && ctx.onBare(s === 'stage-name'); ctx.onGhost && ctx.onGhost(s !== 'stage-name'); };
  /* ══════════════ 데이터 — 기존 프로토(app.js)에서 그대로 추출한 확정본 ══════════════ */
  const DATA = {
   "STAGES": {
    "company": {
     "label": "회사·조직",
     "axis": "어느 부서에 가까우세요?",
     "opts": [
      [
       "제품·기획",
       "기획·PO"
      ],
      [
       "마케팅·브랜드",
       "마케팅"
      ],
      [
       "영업·고객",
       "마케팅"
      ],
      [
       "개발·데이터",
       "개발"
      ],
      [
       "디자인",
       "기획·PO"
      ],
      [
       "경영·전략",
       "기획·PO"
      ],
      [
       "재무·회계·법무",
       "운영·재무"
      ],
      [
       "인사·총무·운영",
       "운영·재무"
      ]
     ]
    },
    "solo": {
     "label": "1인·프리랜서",
     "axis": "어떤 일을 하고 계세요?",
     "opts": [
      [
       "컨설팅·자문",
       "1인 사업"
      ],
      [
       "개발·외주",
       "개발"
      ],
      [
       "디자인·크리에이티브",
       "1인 사업"
      ],
      [
       "콘텐츠·미디어",
       "마케팅"
      ],
      [
       "커머스",
       "1인 사업"
      ],
      [
       "교육·강의",
       "1인 사업"
      ],
      [
       "전문직",
       "법무·계약"
      ]
     ]
    },
    "academy": {
     "label": "학교·연구",
     "axis": "어느 단계이신가요?",
     "opts": [
      [
       "학부연구생",
       "연구·대학원"
      ],
      [
       "석사",
       "연구·대학원"
      ],
      [
       "박사",
       "연구·대학원"
      ],
      [
       "포닥·연구원",
       "연구·대학원"
      ],
      [
       "교원",
       "연구·대학원"
      ]
     ]
    },
    "student": {
     "label": "학생",
     "axis": "어떤 일에 주로 사용하실 예정인가요?",
     "opts": [
      [
       "수업·과제",
       "학생"
      ],
      [
       "외부 시험(자격 시험 등)",
       "학생"
      ],
      [
       "학회·동아리",
       "학생"
      ],
      [
       "창업·사이드 프로젝트",
       "학생"
      ],
      [
       "취업",
       "학생"
      ]
     ]
    }
   },
   "KINDS7": [
    [
     "기획·설계",
     "무엇을 만들지 정한 것"
    ],
    [
     "보고·분석",
     "결과를 정리해 알린 것"
    ],
    [
     "기록",
     "오간 말을 남긴 것"
    ],
    [
     "규정·계약",
     "지켜야 할 것을 못박은 것"
    ],
    [
     "산출물",
     "내보낸 결과물 자체"
    ],
    [
     "조사·자료",
     "남이 만든 것을 모아 둔 것"
    ],
    [
     "거래·정산",
     "돈이 오간 것"
    ]
   ],
   "NOW_KINDS": [
    "지난 자료를 찾아 확인하는 일",
    "문서를 처음부터 쓰는 일",
    "같은 양식을 매번 다시 채우는 일",
    "사람들과 맞추고 공유하는 일",
    "숫자를 모아 맞춰 보는 일",
    "길게 읽고 요약하는 일"
   ],
   "TALLY7": {
    "기획·PO": [
     [
      "기획·설계",
      18
     ],
     [
      "기록",
      13
     ],
     [
      "보고·분석",
      10
     ]
    ],
    "마케팅": [
     [
      "산출물",
      17
     ],
     [
      "보고·분석",
      12
     ],
     [
      "기록",
      12
     ]
    ],
    "연구·대학원": [
     [
      "조사·자료",
      23
     ],
     [
      "기록",
      12
     ],
     [
      "기획·설계",
      6
     ]
    ],
    "법무·계약": [
     [
      "규정·계약",
      21
     ],
     [
      "기록",
      11
     ],
     [
      "보고·분석",
      7
     ]
    ],
    "개발": [
     [
      "산출물",
      19
     ],
     [
      "기획·설계",
      12
     ],
     [
      "기록",
      10
     ]
    ],
    "운영·재무": [
     [
      "보고·분석",
      16
     ],
     [
      "거래·정산",
      13
     ],
     [
      "규정·계약",
      9
     ]
    ],
    "1인 사업": [
     [
      "기획·설계",
      14
     ],
     [
      "거래·정산",
      12
     ],
     [
      "기록",
      9
     ]
    ],
    "학생": [
     [
      "조사·자료",
      20
     ],
     [
      "기록",
      10
     ],
     [
      "산출물",
      8
     ]
    ],
    "default": [
     [
      "기획·설계",
      15
     ],
     [
      "기록",
      12
     ],
     [
      "보고·분석",
      9
     ]
    ]
   },
   "SOURCE_ROWS": [
    {
     "k": "문서·위키",
     "items": [
      { "id": "notion", "label": "Notion", "logo": "notion", "live": true },
      { "id": "figma", "label": "Figma", "logo": "figma", "live": true },
      { "id": "gdrive", "label": "Google Drive", "logo": "googledrive", "live": true }
     ]
    },
    {
     "k": "메신저·메일·일정",
     "items": [
      { "id": "slack", "label": "Slack", "logo": "slack", "live": true },
      { "id": "gmail", "label": "Gmail", "logo": "gmail", "soon": true },
      { "id": "gcal", "label": "Google 캘린더", "logo": "googlecalendar", "soon": true }
     ]
    },
    {
     "k": "태스크 관리",
     "items": [
      { "id": "linear", "label": "Linear", "logo": "linear", "live": true },
      { "id": "clickup", "label": "ClickUp", "logo": "clickup", "live": true }
     ]
    },
    {
     "k": "코드",
     "items": [
      { "id": "github", "label": "GitHub", "logo": "github", "live": true },
      { "id": "gitlab", "label": "GitLab", "logo": "gitlab", "live": true }
     ]
    },
    {
     "k": "내 컴퓨터",
     "items": [
      { "id": "folder", "label": "내 컴퓨터 폴더", "ic": "folder" },
      { "id": "git", "label": "로컬 깃 저장소", "ic": "term" }
     ]
    },
    {
     "k": "그 밖",
     "items": [
      { "id": "none", "label": "딱히 없어요, 대화로 시작", "ic": "doc", "none": true }
     ]
    }
   ],
   "AIS": [
    "Claude",
    "ChatGPT",
    "Gemini",
    "Grok",
    "아직 없어요"
   ],
   "CAN": {
    "제품·기획": [
     [
      "지난 분기 VOC를 전부 훑어서 세 번 넘게 나온 요구만 고르고, 이번 로드맵에 있는지 대조한 다음, 빠진 것마다 왜 빠졌는지 회의록에서 근거를 찾아 표로 만들어 줘",
      "VOC 열어 세고 → 로드맵 대조하고 → 회의록 뒤지고 → 표로 정리. 네 번 왔다 갔다."
     ],
     [
      "마케팅",
      "그 요구 중에 우리가 이미 만들었는데 안 알린 게 있는지 지난 공지와 릴리스 노트에서 찾아 줘"
     ]
    ],
    "마케팅·브랜드": [
     [
      "작년 같은 달 캠페인과 올해 것을 비교해서 나빠진 지표를 고르고, 각각 그때 쓴 소재를 붙이고, 회의에서 이유로 언급된 게 있으면 같이 정리해 줘",
      "작년 리포트 찾고 → 올해와 비교하고 → 소재 뒤지고 → 회의록 검색. 네 번."
     ],
     [
      "영업",
      "그 캠페인으로 들어온 문의가 실제 계약까지 간 비율을 영업 자료에서 찾아 붙여 줘"
     ]
    ],
    "영업·고객": [
     [
      "이번 분기에 떠난 고객들의 문의 기록과 계약서를 다 읽고 공통된 신호를 찾아서, 아직 남아 있는 고객 중 같은 신호가 보이는 곳을 알려 줘",
      "이탈 목록 뽑고 → 고객별 문의 열고 → 계약 확인하고 → 남은 고객과 대조. 고객 수만큼 반복."
     ],
     [
      "제품",
      "그 신호가 제품의 어느 기능과 맞닿아 있는지 스펙에서 짚어 줘"
     ]
    ],
    "개발·데이터": [
     [
      "이번 릴리스에서 바뀐 부분과 문서를 대조해서 설명이 안 맞는 것만 찾고, 그걸 쓰고 있는 쪽까지 짚어 줘",
      "변경 목록 뽑고 → 문서 찾아 비교하고 → 사용처 검색. 항목마다 반복."
     ],
     [
      "기획",
      "그 변경 중에 스펙에 없던 것이 있으면 표시해 줘"
     ]
    ],
    "디자인": [
     [
      "최근 시안 세 개에서 반복해서 지적받은 것을 뽑고, 그게 우리 디자인 규칙 중 어디와 어긋나는지 짚어 줘",
      "시안별 코멘트 열고 → 겹치는 것 세고 → 규칙 문서 대조. 세 번 이상."
     ],
     [
      "제품",
      "그 지적이 실제로 스펙 변경까지 이어졌는지 확인해 줘"
     ]
    ],
    "경영·전략": [
     [
      "지난 6개월 회의록에서 우리가 미룬 결정만 모아서, 각각 지금은 어떻게 됐는지 최근 자료로 확인해 줘",
      "회의록 스무 건 훑고 → 미룬 것 표시하고 → 각각 후속 자료 찾기. 결정 수만큼 반복."
     ],
     [
      "재무",
      "그중 돈이 걸린 것만 골라 금액 규모를 붙여 줘"
     ]
    ],
    "재무·회계·법무": [
     [
      "이번 달 계약서에서 표준과 다른 조항만 뽑고, 과거에 같은 조항으로 문제가 생긴 적이 있는지 지난 기록에서 찾아 줘",
      "계약서 한 건씩 열고 → 표준본과 비교하고 → 과거 사례 검색. 계약 수만큼 반복."
     ],
     [
      "영업",
      "그 조항이 어느 고객과의 계약에 몰려 있는지 정리해 줘"
     ]
    ],
    "인사·총무·운영": [
     [
      "지난 1년 채용 공고와 실제 입사자 이력을 비교해서, 공고와 다르게 뽑힌 패턴을 정리해 줘",
      "공고 모으고 → 입사자 이력 대조하고 → 패턴 세기. 직무 수만큼 반복."
     ],
     [
      "경영",
      "그 패턴이 올해 조직 목표와 어긋나는 지점이 있으면 짚어 줘"
     ]
    ],
    "solo": [
     [
      "지난 프로젝트 산출물 중에 이번 제안에 재활용할 수 있는 것을 찾아서, 이 고객 업종에 맞게 고친 제안서 초안을 만들어 줘",
      "옛 프로젝트 폴더 뒤지고 → 쓸 것 고르고 → 업종에 맞게 고쳐 쓰기. 반나절."
     ],
     [
      "정산",
      "그 제안에 들어갈 견적을 지난 비슷한 건들 기준으로 잡아 줘"
     ]
    ],
    "academy": [
     [
      "내가 읽은 논문 중에 이 가설을 반박하는 것을 찾고, 내 실험 결과와 어긋나는 지점을 짚고, 관련 연구 절 초안까지 써 줘",
      "논문 스무 편 다시 훑고 → 반박 찾고 → 내 데이터와 대조하고 → 초안 쓰기. 며칠."
     ],
     [
      "지도 미팅",
      "다음 미팅 전에 교수님이 지난번에 지적하신 것 중 아직 반영 안 된 게 뭔지 알려 줘"
     ]
    ],
    "student": [
     [
      "이번 학기 강의자료 전부에서 시험에 나올 만한 개념을 뽑고, 내 필기에서 빠진 것만 알려 줘",
      "강의자료 열두 개 열고 → 정리하고 → 필기와 대조. 시험 전날 밤샘."
     ],
     [
      "취업",
      "내가 한 프로젝트들에서 이 공고의 요구사항과 맞는 경험만 뽑아 자기소개서 초안을 써 줘"
     ]
    ]
   },
   "FILES": {
    "기획·PO": [
     "스펙_결제개편_v3.docx",
     "VOC 정리 8월.xlsx"
    ],
    "마케팅": [
     "8/12 팀 회의.m4a",
     "7월 월간 보고서.pptx"
    ],
    "연구·대학원": [
     "Kim et al. 2025.pdf",
     "학위논문 2장 초안.docx"
    ],
    "법무·계약": [
     "표준 계약서 v4.docx",
     "검토 요청 계약서(18쪽).pdf"
    ],
    "개발": [
     "README.md",
     "API v2 마이그레이션 스펙.md"
    ],
    "운영·재무": [
     "8월 정산.xlsx",
     "7월 결산 보고.xlsx"
    ],
    "1인 사업": [
     "견적서_A사_v2.docx",
     "계약서_B사.pdf"
    ],
    "학생": [
     "강의노트_경영전략.pdf",
     "과제_3주차.docx"
    ]
   }
  };

  /* 서비스 로고·무대 아이콘 — v1 app.js 의 BRAND(인라인 SVG)를 그대로. 사람은 '내가 쓰는 그 서비스'를 로고로 알아본다. */
  const BRAND = {"slack":"<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#4A154B\"><path d=\"M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z\"/></svg>","notion":"<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#000000\"><path d=\"M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z\"/></svg>","linear":"<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#5E6AD2\"><path d=\"M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z\"/></svg>","googledrive":"<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#4285F4\"><path d=\"M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z\"/></svg>","github":"<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#181717\"><path d=\"M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12\"/></svg>","gitlab":"<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#FC6D26\"><path d=\"m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z\"/></svg>","clickup":"<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#7B68EE\"><path d=\"M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z\"/></svg>","figma":"<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#F24E1E\"><path d=\"M15.852 8.981h-4.588V0h4.588c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.491-4.49 4.491zM12.735 7.51h3.117c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-3.117V7.51zm0 1.471H8.148c-2.476 0-4.49-2.014-4.49-4.49S5.672 0 8.148 0h4.588v8.981zm-4.587-7.51c-1.665 0-3.019 1.355-3.019 3.019s1.354 3.02 3.019 3.02h3.117V1.471H8.148zm4.587 15.019H8.148c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h4.588v8.98zM8.148 8.981c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h3.117V8.981H8.148zM8.172 24c-2.489 0-4.515-2.014-4.515-4.49s2.014-4.49 4.49-4.49h4.588v4.441c0 2.503-2.047 4.539-4.563 4.539zm-.024-7.51a3.023 3.023 0 0 0-3.019 3.019c0 1.665 1.365 3.019 3.044 3.019 1.705 0 3.093-1.376 3.093-3.068v-2.97H8.148zm7.704 0h-.098c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h.098c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.49-4.49 4.49zm-.097-7.509c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h.098c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-.098z\"/></svg>","prometheus":"<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#E6522C\"><path d=\"M12 0C5.373 0 0 5.372 0 12c0 6.627 5.373 12 12 12s12-5.373 12-12c0-6.628-5.373-12-12-12zm0 22.46c-1.885 0-3.414-1.26-3.414-2.814h6.828c0 1.553-1.528 2.813-3.414 2.813zm5.64-3.745H6.36v-2.046h11.28v2.046zm-.04-3.098H6.391c-.037-.043-.075-.086-.111-.13-1.155-1.401-1.427-2.133-1.69-2.879-.005-.025 1.4.287 2.395.511 0 0 .513.119 1.262.255-.72-.843-1.147-1.915-1.147-3.01 0-2.406 1.845-4.508 1.18-6.207.648.053 1.34 1.367 1.387 3.422.689-.951.977-2.69.977-3.755 0-1.103.727-2.385 1.454-2.429-.648 1.069.168 1.984.894 4.256.272.854.237 2.29.447 3.201.07-1.892.395-4.652 1.595-5.605-.529 1.2.079 2.702.494 3.424.671 1.164 1.078 2.047 1.078 3.716a4.642 4.642 0 01-1.11 2.996c.792-.149 1.34-.283 1.34-.283l2.573-.502s-.374 1.538-1.81 3.019z\"/></svg>","gmail":"<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#EA4335\"><path d=\"M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z\"/></svg>","googlecalendar":"<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#4285F4\"><path d=\"M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z\"/></svg>"};
  /* 우리 것(브랜드 아님) — 선 아이콘. 로고는 색이 있고 이건 글자색을 따라가서, 남의 서비스와 내 것이 눈으로 갈린다. */
  const GLYPH = {
    folder: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    git: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><circle cx="17.5" cy="8" r="2.6"/><path d="M6 8.6v6.8M17.5 10.6c0 3.2-2.9 4.4-5.4 4.9"/></svg>',
    none: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 11.6a7.9 7.9 0 0 1-8.5 7.9 8.6 8.6 0 0 1-3.6-.8L3.5 20.3l1.6-4.3a7.9 7.9 0 0 1-1.6-4.8 8 8 0 0 1 8.5-7.7 7.9 7.9 0 0 1 8.5 7.7z"/><path d="M8.6 11.5h.01M12 11.5h.01M15.4 11.5h.01"/></svg>',
  };

  /* 무대·직무·AI 아이콘 (#1813) — 글자만 늘어선 카드는 훑기 어렵다.
   *  선 아이콘은 셸 아이콘(web/v2/icons.ts)과 같은 붓: 24 뷰박스 · 획 1.7 · 둥근 끝 · 채움 없음.
   *  AI 넷은 각 회사의 실제 마크를 그대로 쓴다(브랜드는 사람이 로고로 알아본다). */
  const ICONS = {
    company: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18M5 21V6a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v15M14 10h4a1 1 0 0 1 1 1v10"/><path d="M8 9h3M8 13h3M8 17h3"/></svg>',
    solo: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg>',
    academy: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 2 9l10 5 10-5-10-5z"/><path d="M6 11.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-4.5"/></svg>',
    student: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H18a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5.5A1.5 1.5 0 0 1 4 17.5z"/><path d="M4 17.5A1.5 1.5 0 0 1 5.5 16H19"/><path d="M8 8h7"/></svg>',
    제품·기획: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h7v7H4zM13 4h7v4h-7zM13 12h7v8h-7zM4 15h7v5H4z"/></svg>',
    마케팅·브랜드: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h3l6 4V5L7 9H4z"/><path d="M17 9.5a4 4 0 0 1 0 5"/></svg>',
    영업·고객: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/><path d="M19 4l1.5 1.5L23 3"/></svg>',
    개발·데이터: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/></svg>',
    디자인: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.6-1.4-.3-.4-.4-.8-.4-1.1 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-3.9-4-6-9-6z"/><circle cx="7.5" cy="11" r="1"/><circle cx="11" cy="7.5" r="1"/><circle cx="15.5" cy="8.5" r="1"/></svg>',
    경영·전략: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/></svg>',
    재무·회계·법무: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18M7 7h7a3 3 0 0 1 0 6H8a3 3 0 0 0 0 6h8"/></svg>',
    인사·총무·운영: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/><path d="M2 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1"/><path d="M17 5.5a3 3 0 0 1 0 6M18.5 14a4.5 4.5 0 0 1 3.5 4.4V20"/></svg>',
    /* #2232 — 회사 말고 다른 무대(1인·학교·학생)의 직무 카드가 전부 같은 서류가방이었다(원준님 실측 2026-08-28). 하나씩 그린다. */
    컨설팅·자문: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h9a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H8l-4 3z"/><path d="M17 9h2a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-1v3l-3-3h-3"/></svg>',
    개발·외주: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/></svg>',
    디자인·크리에이티브: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>',
    콘텐츠·미디어: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z"/></svg>',
    커머스: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8h12l-1 12H7z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
    교육·강의: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h18"/><rect x="5" y="4" width="14" height="11" rx="1"/><path d="M12 15v5M9 20h6"/><path d="M9 8h6M9 11h4"/></svg>',
    전문직: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18M4 21h16M12 6l-6 3M12 6l6 3"/><path d="M3 13a3 3 0 0 0 6 0L6 9zM15 13a3 3 0 0 0 6 0l-3-4z"/></svg>',
    학부연구생: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6M10 3v6l-5.5 9.5A1.5 1.5 0 0 0 5.8 21h12.4a1.5 1.5 0 0 0 1.3-2.5L14 9V3"/><path d="M7.5 15h9"/></svg>',
    석사: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6c-1.5-1.5-4-2-8-2v15c4 0 6.5.5 8 2 1.5-1.5 4-2 8-2V4c-4 0-6.5.5-8 2z"/><path d="M12 6v15"/></svg>',
    박사: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 2 9l10 5 10-5-10-5z"/><path d="M6 11.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-4.5"/><path d="M22 9v6"/></svg>',
    포닥·연구원: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)"/></svg>',
    교원: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M7 20h10M12 16v4"/><path d="M7 8h6M7 11h4"/></svg>',
    수업·과제: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3h11l3 3v15H5z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>',
    '외부 시험(자격 시험 등)': '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="9" r="5"/><path d="M9.5 9l1.8 1.8L14.8 7.5"/><path d="M8.5 13.2L7 21l5-2.5 5 2.5-1.5-7.8"/></svg>',
    학회·동아리: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M2.5 20v-1a5.5 5.5 0 0 1 5.5-5.5h2a5.5 5.5 0 0 1 5.5 5.5v1"/><path d="M16 5.2a3.2 3.2 0 0 1 0 6.1"/><path d="M18.5 13.6A5.5 5.5 0 0 1 21.5 19v1"/></svg>',
    '창업·사이드 프로젝트': '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3c3.5 0 7 3.5 7 9l-2 4H7l-2-4c0-5.5 3.5-9 7-9z"/><path d="M9 16l-1.5 4M15 16l1.5 4M12 16v5"/><circle cx="12" cy="10" r="1.6"/></svg>',
    취업: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6 16c.5-1.5 1.7-2 3-2s2.5.5 3 2M15 10h3M15 13h3"/></svg>',
    _job: '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M9 6V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V6"/></svg>',
  };
  const AI_LOGO = {
    'Claude': '<svg class="ob-blogo" viewBox="0 0 24 24" aria-hidden="true" fill="#D97757"><path d="M4.709 15.955l4.72-2.647.079-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.004 1.81 2.508 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>',
    'ChatGPT': '<svg class="ob-blogo" viewBox="0 0 24 24" aria-hidden="true" fill="#000000"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z"/></svg>',
    'Gemini': '<svg class="ob-blogo" viewBox="0 0 24 24" aria-hidden="true" fill="#4285F4"><path d="M12 24A14.304 14.304 0 0 0 0 12 14.304 14.304 0 0 0 12 0a14.305 14.305 0 0 0 12 12 14.305 14.305 0 0 0-12 12"/></svg>',
    'Grok': '<svg class="ob-blogo" viewBox="0 0 24 24" aria-hidden="true" fill="#000000"><path d="M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l-2.233 3.164L2 16.68l2.232-3.163 2.233 3.159zM22 6.919l-9.489 13.44-2.232-3.163 7.257-10.28H22zM22 1l-9.879 14-2.233-3.163L17.536 1H22z"/></svg>',
    '여러 개': '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z"/><path d="M12 8v8M8 12h8"/></svg>',
    '아직 없어요': '<svg class="ob-blogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z"/><path d="M9.2 9.3a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.4-2.8 4"/><path d="M12 17.2h.01"/></svg>',
  };
  /** 직무 아이콘 — 목록에 없는 답(직접 적기)도 기본 아이콘을 준다. */
  const jobIcon = (label) => ICONS[label] || ICONS._job;

  const $ = (s, el) => (el || host).querySelector(s);
  const $$ = (s, el) => Array.from((el || host).querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let toastT = null;
  function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('ob-on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('ob-on'), 2600); }

  /* ── 상태 ── */
  const KEY = 'lively-ob-v2';
  /** 검토용 장면 점프(?scene=)로 들어왔나 — 그때만 없는 답을 지어내 화면을 채운다(#2207). */
  let demoJump = false;
  /** 이 화면이 이미 걷혔나 — 서버를 기다리는 사이에 떠날 수 있다. */
  let destroyed = false;
  /** 이 화면이 히스토리에 쌓은 걸음 순번 — «뒤로» 와 «나가기» 를 가르는 근거(onPop 참조). */
  let obSeq = 0;
  /** 서버에 «어디까지 하셨나» 를 묻고 기다리는 한도. 넘으면 처음부터 연다 — 못 물었다고 화면이 안 열리면 안 된다. */
  const RESUME_WAIT_MS = 2500;
  const fresh = () => ({
    scene: 'name', name: '', nameSet: false, stage: null, job: null,
    sources: [], connected: [], ai: null, aiConnected: false, aiName: null, terminal: null, app: null,
    local: null,            // #1879 내 컴퓨터 설치 — 'done'|'getting'|'later'
    trail: [],              // 지나온 장면 — 뒤로가기가 조건부 경로를 그대로 되짚게 한다
    read: { total: 0, done: 0, finished: false }, drawersOn: false,
    drawers: [],            // 승인한 자료함 갈래 — 마무리에서 **진짜 카테고리**로 만들어진다(#1813)
    upN: 0, upBusy: 0,      // #1881 실업로드 — 자료로 등록된 파일 수 / 올리는 중 수(연출 아님)
    upFiles: [],            // #2232 받은 파일 목록 [{n,r,s,st}] — 화면에 보이는 근거(상한 UP_KEEP)
    aiDone: [],             // #2232 이 온보딩에서 로그인을 확인한 AI 하네스 키들 — «다른 AI 도?» 화면의 체크 근거
    b2: null, b3: null, nowline: null, firstOrder: null, decisions: [], notes: [],
    chatDone: [],           // 막3에서 끝난 단계들
  });
  let S = fresh();
  /** 이 탭에 남아 있던 진행이 있었나 — 있으면 그게 가장 새 것이다(아래 «어느 쪽이 정본인가» 참조).
   *  ⚠ **아무것도 답하지 않은 상태는 «있음» 으로 치지 않는다.** 서버를 못 물었을 때(장애·느림) 첫 화면이
   *   그대로 이 탭에 저장되는데, 그걸 «있음» 으로 읽으면 그 탭은 **다시는 서버에 묻지 않는다** — 한 번의
   *   일시적 실패가 그 사람의 저장된 진행을 영영 가린다(실측 2026-08-27: 프리뷰 백엔드가 잠깐 죽은 사이 재현). */
  let hadLocal = false;
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY));
    if (v && v.scene) { S = Object.assign(fresh(), v); hadLocal = v.scene !== 'name' || !!v.nameSet; }
  } catch (e) {}

  /* ── 하다 만 자리를 **서버에** 남긴다 (#2207) ─────────────────────────────────
   *  종전엔 진행이 sessionStorage 하나였다. sessionStorage 는 **탭을 닫으면 사라진다** — 온보딩을 하다
   *   창을 닫고 app.lvly.io 로 다시 들어오면 이름부터 다시 물었고, 거기까지 답한 것(무대·직무·고른 AI·
   *   자료함 갈래)은 아무 데도 안 남았다. 이름·업무를 그 자리에서 남기기로 한 것(#1813)과 같은 이유로,
   *   **자리표까지** 서버가 든다.
   *  ⚠ 어느 쪽이 정본인가: **이 탭에 있으면 이 탭이 정본**이다. 로컬은 매 저장마다 서버로 밀리므로
   *   서버보다 앞서거나 같다(뒤질 수 없다). 서버는 «탭이 사라진 뒤» 를 위한 자리다.
   *  ⚠ 자주 불린다(장면 하나에 여러 번) — 그래서 debounce 하고, 한 번에 하나만 날린다.
   */
  const PUSH_MS = 800;
  let pushT = null, pushing = false, pushAgain = false, pushOff = false;
  const saveLocal = () => { try { sessionStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} };
  /** 남길 만한 진행인가 — **아무것도 답하지 않은 첫 화면은 «하다 만 것» 이 아니다.**
   *  ⚠ 이 문턱이 없으면 처음 설정을 **열어보기만 한** 사람도 다음 로그인마다 처음 설정으로 끌려간다
   *   (서버 판정이 자리표를 흔적보다 세게 보기 때문이다 — first-run.ts ★). 답이 하나라도 있을 때부터 남긴다. */
  const worthSaving = () => S.scene !== 'name' || S.nameSet;
  function schedulePush() {
    if (pushOff || !worthSaving()) return;   // 끝난 사람의 진행은 남기지 않는다(서버도 거절한다)
    clearTimeout(pushT);
    pushT = setTimeout(() => { void flushProgress(); }, PUSH_MS);
  }
  /** 지금 상태를 서버에 밀어 넣는다. **실패해도 진행을 막지 않는다** — 이 탭에는 그대로 남아 있다.
   *  `keepalive` 는 창을 닫는 중에도 요청이 끝까지 가게 한다(pagehide). */
  async function flushProgress(keepalive) {
    if (pushOff || !worthSaving()) return;
    clearTimeout(pushT); pushT = null;
    if (pushing) { pushAgain = true; return; }
    pushing = true;
    try {
      await api('/api/ui/me/welcome/progress', Object.assign(
        { method: 'POST', body: JSON.stringify({ scene: S.scene || 'name', state: S }) },
        keepalive ? { keepalive: true } : {}));
    } catch (_) { /* 비치명 — 이 탭에는 남아 있다 */ }
    pushing = false;
    if (pushAgain) { pushAgain = false; void flushProgress(); }
  }
  const save = () => { saveLocal(); schedulePush(); };
  /** 창을 닫거나 탭을 숨길 때 — 마지막 한 걸음이 유실되는 자리가 정확히 여기다(debounce 대기 중). */
  const onLeave = () => { if (document.visibilityState === 'hidden') void flushProgress(true); };
  const onPageHide = () => { void flushProgress(true); };
  addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onLeave);

  const stageOf = () => DATA.STAGES[S.stage] || DATA.STAGES.company;
  const jobOf = () => S.job || stageOf().opts[0][0];
  const personaOf = () => { const hit = stageOf().opts.find(([l]) => l === S.job); return hit ? hit[1] : stageOf().opts[0][1]; };
  const canOf = () => DATA.CAN[jobOf()] || DATA.CAN[S.stage] || DATA.CAN['제품·기획'];
  const nick = () => S.nameSet && S.name ? S.name : '';

  /* ── #1879 «내 컴퓨터에 잇기» 장면의 부품 ─────────────────────────────────────
   *  게이트웨이 주소는 **지금 이 화면이 떠 있는 그 주소**다. 서버에 물어볼 필요가 없다(비관리자에겐
   *   org_profile.gateway_url 이 가려지기도 한다 — 클래식 설치 가이드도 같은 값으로 접는다:
   *   web/learn.ts drawInstallGuide 의 `profile.gateway_url || window.location.origin`).
   *  `/cli` 는 게이트웨이가 **자기 주소를 구워** 내보내므로(kit/cli/bootstrap.sh 의 __LIVELY_GATEWAY__),
   *   한 줄 안에 주소가 한 번만 들어가면 나머지는 스크립트가 안다.
   */
  const GW = String(location.origin || '').replace(/\/+$/, '');
  /* ⚠ OS 토글을 두지 않는다. 사람이 고르게 하면 **고른 값과 실제로 받아지는 파일이 어긋날 수 있다** —
   *  내려받기는 desktopLink()→pickAsset() 이 `desktopOs()` 로 고르지, 사람이 고른 값을 보지 않기 때문이다.
   *  그래서 문구도 같은 판정을 쓴다. 셋으로 가른다(둘로 접으면 리눅스 사람에게 .dmg 라고 말하게 된다):
   *   mac / win — 받아질 파일 이름을 그대로 말한다.
   *   other(리눅스·판정불가) — desktopLink() 가 null 이라 [앱 받기]가 **릴리스 페이지**를 연다. 그러니
   *    "파일이 내려받아진다"고 말하면 안 된다. 없는 자리를 가리키지 않는다. */
  const kbd = (t) => `<kbd class="ob-kbd">${esc(t)}</kbd>`;
  /** 복사 단추가 붙은 명령 한 줄. **사람이 손으로 타이핑하게 두지 않는다** — 오타 한 글자가 곧 막힘이다. */
  function cmdBox(cmd) {
    return `<div class="ob-cmd"><code>${esc(cmd)}</code><button type="button" class="ob-cmd-copy" data-copy="${esc(cmd)}">복사</button></div>`;
  }
  /** 복사 배선 — 클립보드가 막힌 자리(비 HTTPS·권한 거부)에서는 **글자를 선택해 준다**.
   *  조용히 실패하면 사람은 붙여넣기가 안 되는 이유를 영영 모른다. */
  function wireCopy(root) {
    $$('.ob-cmd-copy', root).forEach((b) => b.onclick = async () => {
      const txt = b.dataset.copy || '';
      try {
        await navigator.clipboard.writeText(txt);
        const was = b.textContent; b.textContent = '복사됨'; b.classList.add('ob-on');
        setTimeout(() => { b.textContent = was; b.classList.remove('ob-on'); }, 1600);
      } catch (_) {
        const code = b.parentElement && b.parentElement.querySelector('code');
        if (code) { const r = document.createRange(); r.selectNodeContents(code); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
        toast('복사가 막혀 있어요 — 파랗게 선택해 뒀으니 ⌘/Ctrl + C 로 복사해 주세요.');
      }
    });
  }
  let localTimer = null;      // 설치 확인 폴링
  let localBase = null;       // 장면에 들어올 때의 기준값(이미 참이면 전이를 볼 수 없다)
  /** 이 사람 신원으로 라이블리 MCP 툴이 **실제로 성공 호출된 적 있나**(서버 자동판정).
   *  true/false, 못 물었으면 null — 못 물은 것을 '아직 안 됐다'로 뭉개지 않는다. */
  async function connectSignal() {
    try {
      const r: any = await api('/api/ui/me/onboarding');
      const items = (r && r.status && r.status.items) || [];
      const it = items.find((x) => x && x.key === 'connect');
      return !!(it && it.state === 'done' && it.by === 'auto');
    } catch (_) { return null; }
  }

  /* ══ #1879 «가져올 곳 잇기» — 실배선 부품 ═══════════════════════════════════════
   *  종전 이 장면은 카드를 누르면 `await sleep(1100)` 뒤 무조건 «연결이 완료됐어요» 라고 썼다.
   *   **아무것도 이어지지 않았다.** 그러고는 다음 화면들이 «쌓인 자료를 가져오는 중» 이라고 말했고
   *   (읽는 개수 41 도 그 자리에서 지어낸 숫자였다), 온보딩을 마친 사람이 [외부 앱 연결] 에 가 보면
   *   전부 «연결 안 됨» 이었다. 첫 3분이 통째로 거짓말을 하는 자리였다.
   *  이제 실제로 잇는다 — 길은 [외부 앱 연결](v2/connect.ts)이 이미 깎아 둔 그것 하나다:
   *   · 계정 로그인 = POST /api/ui/me/oauth/connect → 새 탭 동의 → **창 포커스 복귀**에 재조회(폴링 없음)
   *   · 토큰       = POST /api/ui/me/credential
   *   · 판정       = me-logins.ts partition() — 연결됨 / 내가 켤 수 있음 / 관리자가 열어야 함
   *
   *  기준선은 이 온보딩 전체의 그것과 같다 — **컴맹인 중학생도 따라올 수 있어야 한다**:
   *   한 번에 한 걸음 · 어디를 누르는지 그대로 · 전문용어 금지 · 왜 하는지 먼저 · 값이 어떻게 생겼는지 ·
   *   되돌릴 수 있다고 말해 주기. 그래서 토큰형은 오버레이(svcTokenForm)를 띄우지 않고 **그 카드 아래에서
   *   펼쳐지는 세 걸음**으로 바꿨다: 관리자용 폼은 '발급 스펙'을 보여 주지만, 이 사람에게 필요한 것은
   *   '어느 버튼을 누르는가'다. 발급처 주소와 값의 생김새는 지어내지 않고 CRED_KINDS 에서 읽는다.
   */
  // 온보딩이 부르는 이름 → 서비스 표(LOGIN_SERVICES)의 키. 이 줄 하나가 두 자리를 잇는 전부다.
  //  없는 것(git·folder·none)은 여기 없다 — 잇는 길이 다르거나(내 컴퓨터 설치) 연결이랄 게 없다.
  //  ⚠ #2232 — 구글 셋(gdrive·gmail·gcal)이 'google-drive' 같은 **없는 키**를 가리키고 있었다. 서버가 내려주는
  //   커넥터도, LOGIN_SERVICES 의 행도 이름이 'google' 하나다(#1881 G2 에서 세 줄을 한 줄로 합쳤다). 그 결과
  //   Google Drive 카드는 상태를 못 읽고(회사가 안 열어 뒀다는 안내조차 못 하고), 눌러도 아무 일이 없었다.
  const SVC_OF = {
    notion: 'notion', gdrive: 'google', gmail: 'google', gcal: 'google',
    slack: 'slack', linear: 'linear', clickup: 'clickup',
    github: 'github', gitlab: 'gitlab', figma: 'figma', prometheus: 'prometheus',
  };
  /** 서버 실측(partition 결과). null = **아직 못 물었다** — '연결 안 됨'과 뭉개지 않는다. */
  let CONN = null;
  /** 한 번이라도 물어봤나. ⚠ 이게 없으면 서버가 답을 못 줄 때 '못 읽음 → 다시 그림 → 또 물음'이 영원히 돈다. */
  let connTried = false;
  const isAdmin = () => { try { return (state.me && Array.isArray(state.me.scopes) && state.me.scopes.includes('admin')) === true; } catch (_) { return false; } };
  /* ★ #2243 (원준 2026-08-28: "온보딩 <연결하기> 로 슬랙·노션은 MCP 말고 수집기가 돌아가게") ──────────────────
   *  이 화면이 약속하는 것은 «그동안 쌓인 자료를 가져온다» 다. 개인 연결(금고에 자격 한 줄 = AI 도구·MCP)은 그 약속과
   *  무관하고, 노션은 그 토큰(DCR)으로 수집도 못 한다(#1881). 그래서 슬랙·노션은 **수집기 축(org_collector)** 으로 잇고
   *  판정·해제도 그 축으로 본다. 수집기는 관리자만 켤 수 있다(셀프서브에선 만든 사람 본인) — 관리자가 아니면 종전 길.
   *   · 노션 — 라이블리 공개 통합 동의(노션 화면의 페이지 고르기)가 곧 연결이자 범위. 개인 MCP 로그인은 시키지 않는다.
   *   · 슬랙 — 내 계정 로그인(라이블리 슬랙 앱, 유저+봇 토큰)이 곧 수집기의 자격이다. 로그인 뒤 수집기를 켠다. */
  //  #2247 — 피그마·ClickUp 도 같은 축: 토큰(금고)이 자격, 켜면 수집기가 그 토큰을 가리킨다. 피그마는 범위(파일 링크)가 있어야 켜진다.
  const COLLECT_FIRST = { slack: 'slack', notion: 'notion', figma: 'figma', clickup: 'clickup' };
  const COLLECT_ON_DESC = {
    notion: '노션에서 고른 페이지를 팀 자료함에 모으고 있어요.', slack: '공개 채널 대화를 팀 자료함에 모으고 있어요.',
    figma: '고른 피그마 파일의 코멘트를 팀 자료함에 모으고 있어요.', clickup: 'ClickUp 작업·댓글을 프로젝트 탭으로 가져오고 있어요.',
  };
  /** 토큰형 앱의 자격이 이미 금고에 있나(개인 축 실측). */
  const tokenSaved = (id) => !!(CONN && SVC_OF[id] && CONN.connected.some((s) => s.key === SVC_OF[id]));
  /** 피그마 범위 입력 → 서버 scope(숫자만인 토막 = 팀 id, 나머지 = 파일 링크). */
  const figmaScope = (text) => {
    const toks = String(text || '').split(/\s+/).map((x) => x.trim()).filter(Boolean);
    const teams = toks.filter((x) => /^\d{5,}$/.test(x)), files = toks.filter((x) => !/^\d{5,}$/.test(x));
    const out: any = {}; if (files.length) out.file_keys = files.join(' '); if (teams.length) out.team_ids = teams.join(' '); return out;
  };
  /** 토큰형 앱 수집기 켜기 — 서버 답(ok / needs_connect / needs_scope)을 그대로 돌려준다. 던지지 않는다. */
  async function startMemberCollect(id, scopeText) {
    const body: any = { enabled: true };
    if (id === 'figma' && scopeText && scopeText.trim()) body.scope = figmaScope(scopeText);
    try { return await api(`/api/ui/org/${COLLECT_FIRST[id]}/collect`, { method: 'POST', body: JSON.stringify(body) }); }
    catch (e) { return { ok: false, message: (e && e.message) || '모으기를 켜지 못했어요.' }; }
  }
  let COLL: any = {};
  const collectMode = (id) => !!COLLECT_FIRST[id] && isAdmin();
  async function loadColl() {
    const out: any = {};
    await Promise.all(Object.entries(COLLECT_FIRST).map(async ([id, svc]) => {
      try { out[id] = await api(`/api/ui/org/${svc}/collect`); } catch (_) { out[id] = null; }
    }));
    COLL = out;
  }
  async function loadConn() {
    connTried = true;
    try {
      const creds = await api('/api/ui/me/credentials');
      const oauth = await api('/api/ui/me/oauth/connectors').catch(() => ({ connectors: [] }));
      CONN = partition(oauth, creds);
      if (isAdmin()) await loadColl();
    } catch (_) { CONN = null; }
    return CONN;
  }
  //  표에 없는 앱(관리자가 조직에 등록한 MCP 커넥터)은 서버가 내려준 목록에서 키로 찾는다 — #/connect 와 같은 규약
  //   (me-logins.ts svcFromConnector). 이게 없으면 «회사가 열어 둔 앱»이 온보딩에만 안 보인다.
  const svcOf = (id) => LOGIN_SERVICES.find((s) => s.key === SVC_OF[id])
    || (CONN && CONN.all.find((s) => s.key === id)) || null;
  /** 화면에 쓸 이름 — 표에 있으면 표의 이름, 없으면 서버가 준 이름. */
  const srcLabel = (id) => {
    const it = DATA.SOURCE_ROWS.flatMap((r) => r.items).find((x) => x.id === id);
    if (it) return it.label;
    const svc = svcOf(id); return (svc && svc.label) || id;
  };
  /** 표에 없이 서버만 아는 앱들(관리자 등록) — 온보딩 목록 맨 아래 한 묶음으로 세운다. */
  const dynSvcs = () => (CONN ? CONN.all.filter((s) => s.dynamic) : []);
  /** 이 앱이 지금 어떤 자리에 있나 — 'on'(이어짐) · 'off'(내가 켤 수 있다) · 'blocked'(관리자가 열어야) · null(모른다). */
  function connState(id) {
    const svc = svcOf(id); if (!svc || !CONN) return null;
    if (collectMode(id)) {
      const c = COLL[id];
      if (c) {
        if (id === 'notion') return c.enabled ? 'on' : (!c.ready && !(c.workspaces || []).length ? 'blocked' : 'off');
        if (id === 'slack') return (c.search && c.search.enabled) ? 'on' : 'off';
        if (id === 'figma' || id === 'clickup') return c.enabled ? 'on' : 'off';
      }
      // 수집 상태를 못 읽었으면(구 이미지·권한) 개인 축 판정으로 떨어진다 — 화면을 비우지 않는다.
    }
    if (CONN.connected.some((s) => s.key === svc.key)) return 'on';
    if (CONN.blockedOAuth.some((s) => s.key === svc.key)) return 'blocked';
    return 'off';
  }
  /** 어떻게 잇나 — 계정 로그인이 가능하면 **무조건 그쪽**이다(누르고 [허용] 한 번 = 이 사람에게 가장 쉬운 길).
   *  조직에 그 커넥터가 없을 때만 토큰으로 떨어진다. 둘 다 없으면 null(카드를 내밀지 않는다). */
  function connHow(id) {
    const svc = svcOf(id); if (!svc) return null;
    if (svc.oauth && CONN && CONN.oauthMap.has(svc.oauth)) return 'oauth';
    //  #1881 G5 — 전용 창구를 가진 앱(GitHub)도 '계정 로그인' 길이다. 이게 없으면 토큰 발급 3단계로 보내는데,
    //   그건 우리가 없애려던 바로 그 벽이고 저장소도 못 고른다(계정 연결은 그 화면에서 범위를 함께 정한다).
    if ((svc as any).appConnect) return 'oauth';
    return svc.token ? 'token' : (svc.oauth ? 'oauth' : null);
  }
  /** 이어진 것으로 세어도 되는 id 만 — 화면이 «2곳 이었어요» 라고 말할 근거. */
  const pickedIds = () => S.sources.filter((id) => id !== 'none' && (SVC_OF[id] || (CONN && CONN.all.some((s) => s.key === id))));

  /* 토큰형의 «어느 버튼을 누르는가». 주소·값의 생김새는 CRED_KINDS 에서 읽고(지어내면 그 자리에서 막힌다),
   *  경로도 그 표의 help 에 적힌 그것을 따른다 — 여기서 한 일은 **말투를 바꾼 것**뿐이다.
   *  ⚠ 화면 이름은 그 회사가 언제든 바꾼다. 그래서 마지막에 늘 '조금 달라 보이면' 한 줄을 붙인다. */
  const TOKEN_HOWTO = {
    github: {
      why: 'GitHub 에서 <b>글자 한 줄</b>을 받아 오면 돼요. 이걸 주면 제가 이슈·코드 기록을 읽을 수 있습니다.',
      go: 'GitHub 에서 글자 받기',
      steps: [
        '새 탭이 열리면 오른쪽 위 <b>Generate new token</b> ▸ <b>Generate new token (classic)</b> 을 누르세요.',
        '<b>Note</b> 칸에 아무 이름이나 적고(예: lively), 아래 목록에서 <b>repo</b> 앞 네모를 체크하세요.',
        '맨 아래 <b>Generate token</b> 을 누르면 <b>ghp_</b> 로 시작하는 긴 글자가 나옵니다. 그걸 복사해 아래에 붙여넣으세요.',
      ],
      last: '그 글자는 <b>그 화면에서 한 번만</b> 보여요. 놓쳤으면 같은 자리에서 새로 만들면 됩니다. 나중에 GitHub 에서 지우면 연결도 그때 끊깁니다.',
    },
    figma: {
      why: 'Figma 에서 <b>개인 액세스 토큰</b>(글자 한 줄)을 하나 만들어 주시면 돼요. 이걸 주면 제가 디자인 파일과 거기 달린 댓글을 읽을 수 있습니다.',
      go: 'Figma 설정 열기',
      //  #2232 — 실제 한국어 화면의 이름·자리로 다시 썼다(원준님 실측 2026-08-28): 프로필 ▸ 설정 ▸ 보안 탭 ▸ 개인 액세스 토큰 ▸
      //   새로운 토큰 생성. 범위는 «Read only 한 번에» 가 없다(하나씩 체크) — 그래서 무엇을 켤지 사람이 정하게 두고, 쓰기는
      //   안 켜도 된다고만 말한다. ★ current_user:read 는 우리가 «정말 되는 값인지» 확인할 때(GET /v1/me) 쓰므로 필수다.
      steps: [
        '새 탭에 Figma 설정 창이 열려요(안 열리면 왼쪽 위 <b>내 프로필(이름·아바타)</b> ▸ <span class="ob-kbd">설정</span>). 창 위쪽 탭에서 <span class="ob-kbd">보안</span>(Security)을 누르고 아래로 내리면 <b>개인 액세스 토큰</b>(Personal access tokens)이 있어요.',
        '<span class="ob-kbd">새로운 토큰 생성</span>(Generate new token)을 누르고, <b>토큰 이름</b>은 아무거나 적으세요(예: Lively). <b>만료</b>는 가장 긴 것(또는 «만료 없음»)을 고르면 다시 만들 일이 적어요. 짧게 고르면 그 날짜 뒤에 연결이 끊깁니다.',
        '<b>범위</b>(Scopes)는 어디까지 공유할지 직접 정하시면 돼요. 많이 열수록 제가 맥락을 더 잘 읽습니다. 다만 <b>:write</b> 가 붙은 것(고치기)은 안 켜셔도 됩니다. 읽기(<b>:read</b>)면 충분해요. ★ <b>current_user:read</b> 는 꼭 켜 주세요(연결이 됐는지 확인하는 데 씁니다). 그리고 <b>file_content:read</b> · <b>file_comments:read</b> · <b>file_metadata:read</b> · <b>projects:read</b> 를 권해요.',
        '맨 아래 <span class="ob-kbd">토큰 생성</span>을 누르면 노란 상자에 <b>figd_</b> 로 시작하는 글자가 나와요. 상자 안 글자를 통째로 복사해 아래 칸에 붙여넣으세요.',
      ],
      last: '그 글자는 <b>그 화면에서 한 번만</b> 보여요. 놓쳤으면 같은 자리에서 새로 만들면 됩니다. Figma 에서 토큰을 지우면 연결도 그때 끊깁니다.',
    },
    clickup: {
      why: 'ClickUp 에서 <b>글자 한 줄</b>을 받아 오면 돼요. 이걸 주면 제가 거기 쌓인 일감을 읽을 수 있습니다.',
      go: 'ClickUp 설정 열기',
      //  #2232 — 로그인이 안 된 브라우저에선 이 화면이 아예 안 열리거나 Generate/Copy 가 안 눌린다(원준님 실측 2026-08-28,
      //   구글 계정으로 쓰는 클릭업). 그래서 «먼저 로그인» 을 첫 걸음으로 적는다.
      steps: [
        '새 탭이 열리면 먼저 ClickUp 에 <b>로그인돼 있는지</b> 보세요. 로그인 화면이 나오면 평소 쓰는 방법(구글로 계속 등)으로 로그인한 뒤, 왼쪽 위 <b>내 아바타</b> ▸ <span class="ob-kbd">Settings</span> ▸ <span class="ob-kbd">Apps</span> 로 오세요.',
        '<b>API Token</b> 자리에서 <span class="ob-kbd">Generate</span> 를 누르세요(이미 만들어 둔 게 있으면 <span class="ob-kbd">Copy</span>). 버튼이 안 눌리거나 안 보이면 로그인이 덜 된 것이니 로그인한 뒤 새로고침하세요.',
        '<b>pk_</b> 로 시작하는 글자를 복사해 아래에 붙여넣으세요.',
      ],
      last: '언제든 같은 자리에서 새로 만들거나(Regenerate) 지울 수 있어요. 새로 만들면 예전 글자는 그 자리에서 무효가 됩니다.',
    },
    slack: {
      why: 'Slack 에서 <b>글자 한 줄</b>을 받아 와야 해요.',
      go: 'Slack 앱 화면 열기',
      steps: ['Slack 앱 화면에서 사용자 토큰(<b>xoxp-</b> 로 시작)을 발급받아 아래에 붙여넣으세요.'],
      last: '이 길은 손이 많이 갑니다. 보통은 <b>계정으로 연결</b>(새 탭에서 허용 한 번)이 되는데, 이 워크스페이스에선 그 길이 아직 안 열려 있어요. 어려우면 지금은 건너뛰고 나중에 하셔도 됩니다.',
    },
  };
  /** 그 밖의 토큰형(예: Prometheus) — 표에 안내가 없으면 지어내지 않고 '값 붙여넣기'만 연다. */
  const tokenHowto = (id) => TOKEN_HOWTO[id] || null;
  const credSpec = (svc) => (svc && svc.token ? CRED_KINDS.find((x) => x.kind === svc.token) : null);

  /** 계정 로그인 — 새 탭에서 [허용]. 돌아온 것을 아는 길이 셋이다(#2232):
   *   ① 돌아온 탭이 보내는 신호(BroadcastChannel 'lively-connect' — main.ts 릴레이 복귀·/oauth/callback 페이지가 쏜다)
   *   ② 이 탭에 포커스·가시성이 돌아옴  ③ 3초마다 서버에 다시 묻기(최대 4분).
   *  종전엔 ② **한 번**뿐이었다 — [허용] 전에 이 탭을 잠깐 봤다 가면 그 한 번이 소진돼, 실제로 연결된 뒤에도 화면은
   *  «연결 안 됨» 에 머물렀다(원준님 실측 2026-08-28, Slack: 세 번째 앱을 연결하고서야 두 번째가 «연결됨» 이 됐다). */
  async function svcOAuth(id, after) {
    const svc = svcOf(id); if (!svc || !(svc.oauth || (svc as any).appConnect)) return;
    try {
      //  전용 창구를 가진 앱(#1881 GitHub)은 공용 경로를 못 탄다 — MCP 서버 행이 없기 때문이다.
      const app = !!(svc as any).appConnect;
      const r: any = await api(app ? '/api/ui/org/github/connect' : '/api/ui/me/oauth/connect',
        { method: 'POST', body: JSON.stringify(app ? {} : { server: svc.oauth }) });
      if (r && r.authorized) { await loadConn(); after(); return; }
      const url = r && (r.authorization_url || r.url);
      if (!url) { after('연결할 주소를 받지 못했어요. 잠시 뒤 다시 눌러 주세요.'); return; }
      window.open(url, '_blank', 'noopener');
      watchConnect(id, after);
    } catch (e) { after((e && e.message) || '연결을 시작하지 못했어요.'); }
  }
  /** 앱별 감시자 — 같은 앱을 다시 누르면 앞 감시자를 갈아끼운다(둘이 같은 after 를 두 번 부르지 않게). */
  const WATCH = new Map();
  function watchConnect(id, after) {
    const prev = WATCH.get(id); if (prev) prev();
    let done = false, busy = false;
    let iv = null, to = null, bc = null;
    const stop = () => {
      if (done) return; done = true;
      clearInterval(iv); clearTimeout(to);
      window.removeEventListener('focus', poke); document.removeEventListener('visibilitychange', poke);
      try { if (bc) bc.close(); } catch (_) { /* noop */ }
      if (WATCH.get(id) === stop) WATCH.delete(id);
    };
    const check = async () => {
      if (done || busy) return; busy = true;
      try { await loadConn(); } finally { busy = false; }
      if (done) return;
      if (collectMode(id) && connState(id) !== 'on') {
        const ready = id === 'notion' ? !!(COLL[id] && (COLL[id].workspaces || []).length) : (id === 'slack' || id === 'clickup') && tokenSaved(id);
        if (ready) {
          busy = true;
          try { await api(`/api/ui/org/${COLLECT_FIRST[id]}/collect`, { method: 'POST', body: JSON.stringify({ enabled: true }) }); await loadConn(); }
          catch (_) { /* 다음 폴링에 다시 */ } finally { busy = false; }
          if (done) return;
        }
      }
      if (connState(id) === 'on') { stop(); after(); }
    };
    const poke = () => { void check(); };
    window.addEventListener('focus', poke); document.addEventListener('visibilitychange', poke);
    try { bc = new BroadcastChannel('lively-connect'); bc.onmessage = poke; } catch (_) { bc = null; }
    iv = setInterval(poke, 3000);
    to = setTimeout(() => { stop(); after(); }, 4 * 60 * 1000);   // 4분 — 그 뒤엔 화면만 되돌린다(after 가 상태를 다시 읽는다)
    WATCH.set(id, stop);
  }
  /** 토큰 저장 — 저장되면 곧바로 서버에 다시 물어 **정말 이어졌는지** 확인하고 넘어간다. */
  async function svcToken(id, value) {
    const svc = svcOf(id); const spec = credSpec(svc);
    if (!svc || !spec) throw new Error('이 앱은 글자로 연결하는 곳이 아니에요.');
    const payload: any = { kind: spec.kind, secret: value };
    if (spec.meta) payload.meta = spec.meta;
    await api('/api/ui/me/credential', { method: 'POST', body: JSON.stringify(payload) });
    //  #2232 — 저장은 **아무 글자나** 성공한다(금고는 값을 검사하지 않는다). 그래서 저장만 보고 초록불을 켜면
    //   오타를 넣어도 «이어졌어요» 가 된다. 관리 화면(admin-credentials.ts)이 이미 쓰는 확인 창구를 여기서도 부른다.
    //   확인이 없는 배포(구 이미지)면 supported:false 로 오거나 실패한다 — 그때는 종전대로 저장만 믿는다.
    let verdict = null;
    try {
      const r: any = await api('/api/ui/me/credential/verify',
        { method: 'POST', body: JSON.stringify({ kind: spec.kind, scope_key: '' }) });
      if (r && r.supported !== false) verdict = { ok: !!r.ok, message: String(r.message || '') };
    } catch (_) { /* 확인 경로 없음 — 저장은 이미 됐다 */ }
    await loadConn();
    return verdict;
  }

  /** 팀 자료로 모으기(수집)가 짝인 앱 — 연결 성사 뒤 켜고(관리자), 해제 때 끈다. */
  const COLLECT_OF = { slack: 'slack', notion: 'notion', gdrive: 'google', gmail: 'google', gcal: 'google' };
  /** 연결 해제 — [외부 앱 연결](v2/connect.ts)과 **같은 창구**다(계정 로그인 = oauth/disconnect · 토큰 = credential/delete).
   *  #2232 — 종전엔 «연결됐어요» 카드가 잠겨 되돌릴 길이 없었다(원준님 2026-08-28: "마음이 바뀌어서 해제할 수도 있게").
   *  관리자가 이 연결로 켠 팀 수집은 함께 끈다 — 연결이 없는데 «모으는 중» 으로 남으면 거짓 상태다. */
  async function svcDisconnect(id) {
    const svc = svcOf(id); if (!svc || !CONN) throw new Error('연결 상태를 아직 못 읽었어요. 잠시 뒤 다시 눌러 주세요.');
    const oc = svc.oauth ? CONN.oauthMap.get(svc.oauth) : null;
    const cred = svc.token ? CONN.credMap.get(svc.token) : null;
    let did = false;
    if (oc && oc.connected) { await api('/api/ui/me/oauth/disconnect', { method: 'POST', body: JSON.stringify({ server: svc.oauth }) }); did = true; }
    if (cred && cred.has_secret) { await api('/api/ui/me/credential/delete', { method: 'POST', body: JSON.stringify({ kind: svc.token, scope_key: cred.scope_key || '' }) }); did = true; }
    if (collectMode(id)) {
      try { await api(`/api/ui/org/${COLLECT_FIRST[id]}/collect`, { method: 'POST', body: JSON.stringify({ enabled: false }) }); did = true; } catch (_) { /* 아래에서 판정 */ }
    }
    if (!did) throw new Error('해제할 연결을 찾지 못했어요. [외부 앱 연결]에서 확인해 주세요.');
    const col = COLLECT_OF[id];
    if (col && isAdmin()) { try { await api(`/api/ui/org/${col}/collect`, { method: 'POST', body: JSON.stringify({ enabled: false }) }); } catch (_) { /* 비치명 */ } }
    const label = srcLabel(id);
    S.connected = S.connected.filter((x) => x !== id);
    S.decisions = S.decisions.filter((d) => d !== `${label} 연결`);
    save(); renderSB();
    await loadConn();
  }
  /** 지금 «연결 해제할까요?» 를 묻고 있는 앱(한 번에 하나). */
  let unlinkAsk = null;
  /** 연결된 앱 카드 — 잠긴 카드지만 **해제 문**은 열려 있다(인라인 확인 한 번). 두 장면(sources·connect)이 같이 쓴다. */
  function doneCardHtml(id, label, icon, desc) {
    const ask = unlinkAsk === id;
    return `<div class="ob-opt-card ob-on ob-locked ob-done" data-done="1" data-conn="${esc(id)}"><span class="ob-oc-ic">${icon}</span><span><span class="ob-oc-t">${esc(label)}</span><span class="ob-oc-d">${ask ? '정말 해제할까요?' : esc(desc)}</span></span>
      <span class="ob-oc-act">${ask
        ? `<button type="button" class="ob-oc-unlink ob-danger" data-unlink-go="${esc(id)}" title="저장된 로그인 정보가 지워져요">해제</button><button type="button" class="ob-oc-unlink" data-unlink-no="1">아니요</button>`
        : `<span class="v2-dot done" style="margin:0"></span><button type="button" class="ob-oc-unlink" data-unlink="${esc(id)}" title="이 앱 연결을 끊습니다">연결 해제</button>`}</span></div>`;
  }
  /** 해제 버튼 배선 — 장면이 자기 redraw 를 넘긴다. */
  function wireUnlink(el, redraw) {
    $$('[data-unlink]', el).forEach((b) => b.onclick = (e) => { e.stopPropagation(); unlinkAsk = b.dataset.unlink; redraw(); });
    $$('[data-unlink-no]', el).forEach((b) => b.onclick = (e) => { e.stopPropagation(); unlinkAsk = null; redraw(); });
    $$('[data-unlink-go]', el).forEach((b) => b.onclick = async (e) => {
      e.stopPropagation(); const id = b.dataset.unlinkGo; b.disabled = true; b.textContent = '해제 중…';
      try { await svcDisconnect(id); toast(`${srcLabel(id)} 연결을 해제했어요.`); }
      catch (err) { toast((err && err.message) || '해제하지 못했어요.'); }
      unlinkAsk = null; redraw();
    });
  }
  /** 지금 «글자 받아 오기»가 펼쳐진 앱. 한 번에 하나만 편다 — 한 번에 한 걸음이 이 화면의 규칙이다. */
  let tokOpen = null;
  /** 그 카드 아래에서 펼쳐지는 세 걸음. 발급처 주소·값의 생김새는 CRED_KINDS 에서 읽는다.
   *  안내가 없는 앱(표에 help 가 없는 것)은 지어내지 않고 붙여넣는 칸만 연다 — 틀린 길을 알려 주느니 없는 게 낫다. */
  function tokPanel(id) {
    const svc = svcOf(id), spec = credSpec(svc), h = tokenHowto(id);
    const it = (DATA.SOURCE_ROWS.flatMap((r) => r.items).find((x) => x.id === id)) || { label: id };
    const ph = (spec && spec.secretPh) || '받아 오신 글자를 붙여넣으세요';
    const doc = (spec && spec.docUrl) || '';
    return `<div class="ob-tok ob-tok-in">
      <p class="ob-note">${h ? h.why : `${esc(it.label)} 에서 받은 글자를 아래에 붙여넣으면 연결됩니다.`}</p>
      ${doc ? `<a class="ob-btn ob-btn-sub ob-btn-inline" href="${esc(doc)}" target="_blank" rel="noopener noreferrer">${esc(h ? h.go : it.label + ' 열기')} ↗</a>` : ''}
      ${h ? `<ol>${h.steps.map((t) => `<li>${t}</li>`).join('')}</ol>` : ''}
      ${tokenSaved(id) ? '<p class="ob-note">토큰은 이미 저장돼 있어요 — 바꿀 때만 다시 붙여넣으세요.</p>' : ''}
      <input id="tokIn" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(tokenSaved(id) ? '(저장된 토큰을 그대로 씁니다)' : ph)}">
      ${collectMode(id) && id === 'figma' ? `<p class="ob-note">모을 <b>피그마 파일 링크</b>를 넣어 주세요 — 주소창에서 복사, 여러 개면 공백으로. 팀 전체를 모으려면 팀 주소(figma.com/files/team/<id>/…)의 숫자 id 를 넣어도 돼요.</p>
      <input id="tokScope" type="text" autocomplete="off" spellcheck="false" placeholder="https://www.figma.com/design/…">` : ''}
      <p class="ob-err" id="tokErr"></p>
      ${h ? `<p class="ob-note ob-fine2">${h.last}</p>` : ''}
      <p class="ob-note ob-fine2">화면이 조금 달라 보이면 비슷한 이름을 찾아 주세요 — 그 회사가 화면을 바꾸기도 합니다. 어려우면 지금은 건너뛰고 나중에 하셔도 됩니다.</p>
      <button class="ob-btn ob-btn-pri ob-btn-inline" id="tokGo">이걸로 연결하기</button>
    </div>`;
  }


  let pendingChips = null;   // 지금 답을 기다리는 칩들 — 입력창 해석이 본다
  function renderSB() { /* 사이드바는 실제 것(web/v2/side.ts)이 그린다 */ }

  /* ══════════════ 장면 차례 ══════════════ */
  //  #2232 — 순서: 파일 → **AI 고르기·연결** → 외부 앱 → 내 컴퓨터(원준님 2026-08-28: "AI 골라서 연결하는 플로우가 먼저, 그 다음 외부 앱, 로컬은 그 다음").
  const ORDER = ['name', 'stage', 'role', 'files', 'ai', 'claude', 'sources', 'connect', 'terminal', 'local', 'app', 'read', 'b1', 'b2', 'b3', 'nowline', 'can'];
  const STEP_OF = Object.fromEntries(ORDER.map((k, i) => [k, i]));
  const CHAT_FROM = STEP_OF.read;          // 여기부터 막3(채팅)
  const QPROG = ['stage', 'role', 'files', 'ai', 'claude', 'sources', 'connect', 'terminal', 'local', 'app'];   // 막2 진행 눈금

  /* ── 막1·막2: 가운데 질문 기둥 ── */
  function qHead(prog, lead, title, help) {
    const at = QPROG.indexOf(prog);
    // 눈금은 지나온 자리로 돌아가는 문이기도 하다 — 앞 단계는 눌러서 고칠 수 있다(원준님 2026-08-25).
    return `<div class="ob-q-top"><div class="ob-q-ic">L</div></div>
      ${at >= 0 ? `<div class="ob-q-prog">${QPROG.map((k, i) => i < at
          ? `<button class="ob-on ob-go" data-jump="${k}" aria-label="${esc(SCENE_LABEL[k] || '')}(으)로 돌아가기"></button>`
          : `<i class="${i === at ? 'ob-on' : ''}"></i>`).join('')}</div>` : ''}
      ${lead ? `<p class="ob-q-lead">${lead}</p>` : ''}
      <h1 class="ob-q-title">${title}</h1>
      ${help ? `<p class="ob-q-help">${help}</p>` : ''}`;
  }
  function card(label, desc, ic, on) {
    return `<button class="ob-opt-card ${on ? 'ob-on' : ''}" data-opt="${esc(label)}">
      ${ic ? `<span class="ob-oc-ic">${ic}</span>` : ''}<span><span class="ob-oc-t">${esc(label)}</span>${desc ? `<span class="ob-oc-d">${esc(desc)}</span>` : ''}</span>
      <span class="ob-oc-chk">✓</span></button>`;
  }

  const SCENES = {
    /* 막1 — 민낯. 노션 p1: 이름 하나만, 가운데. */
    name: {
      html: () => qHead(null,
        '안녕하세요, 저는 리브예요. 이 워크스페이스를 계속 돌봐 드릴 담당자입니다.',
        '어떻게 불러 드릴까요?',
        '이름이든 별명이든 편한 대로 적어 주세요. 나중에 언제든 바꾸실 수 있어요.')
        + `<div class="ob-q-write"><input id="nameIn" type="text" placeholder="예: 원준" value="${esc(S.nameSet ? S.name : '')}"></div>
           <button class="ob-btn ob-btn-pri" id="nameGo">이렇게 불러 주세요</button>
           <button class="ob-q-skip" data-skip>그냥 넘어갈게요</button>`,
      bind: (el) => {
        const inp = $('#nameIn', el);
        // ⚠ 이름은 **그 자리에서** 서버에 남긴다. 종전엔 온보딩을 끝까지 마쳐야(POST /api/ui/me/welcome) 저장돼서,
        //  중간에 나가면 방금 적은 이름이 워크스페이스 어디에도 안 보였다(원준님 신고 2026-08-26).
        //  실패해도 진행은 막지 않는다 — 마무리에서 한 번 더 보낸다.
        //  ⚠ **display_name 과 nickname 을 함께** 넣는다. 종전엔 nickname 만 넣었는데, 화면이 사람 이름을 읽는
        //   자리는 전부 display_name 이다(rail.ts·side.ts·views.ts·me-modal.ts 모두 `display_name || email || userId`).
        //   nickname 은 활동 로그·알림 위젯에서만 쓰여서, 「어떻게 불러 드릴까요」에 답해도 사이드바엔 이메일
        //   앞부분(프로비저닝이 넣은 값)이 계속 떠 있었다(원준님 신고 2026-08-26).
        const saveName = (v) => {
          if (!v) return;
          //  ⚠ **display_name 만** 넣는다(닉네임은 건드리지 않는다). 「어떻게 불러 드릴까요」는 곧 표시이름이고,
          //   닉네임은 [내 설정 ▸ 프로필]에서 따로 정한 뒤 「이 닉네임을 내 이름으로 사용」을 켜야 이름을 대체한다.
          //   종전엔 여기서 nickname 까지 덮어써서, 프로필에 정해 둔 닉네임이 온보딩을 다시 지나면 날아갔다.
          void api('/api/ui/me/profile', { method: 'POST', body: JSON.stringify({ display_name: v }) })
            .then(() => {
              // 화면이 읽는 값을 그 자리에서 갈아끼우고 레일을 다시 그린다 — 안 그리면 새로고침 전엔
              //  사이드바 발치가 옛 이름(이메일 앞부분)을 그대로 들고 있다.
              try { if (state && (state as any).me) { (state as any).me.display_name = v; } } catch (_) { /* noop */ }
              try { drawRail(); } catch (_) { /* 레일이 없는 배포(클래식)면 그냥 넘어간다 */ }
            })
            .catch(() => { /* 비치명 — 마무리에서 한 번 더 보낸다 */ });
        };
        const go = () => { const v = inp.value.trim(); if (v) { S.name = v; S.nameSet = true; saveName(v); } goScene('stage'); };
        $('#nameGo', el).onclick = go;
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) go(); });
        $('[data-skip]', el).onclick = () => goScene('stage');
        inp.focus();
      },
    },
    /* 막2 — 사이드바가 유령으로 등장. 노션 p2: 큰 질문 + 카드 선택지. */
    stage: {
      html: () => qHead('stage',
        `안녕하세요, 저는 리브예요. <b>이 워크스페이스를 계속 돌봐 드릴 담당자입니다.</b> 몇 가지만 여쭙고, 나머지는 자료를 보고 제가 알아서 세팅할게요.`,
        '어디에서 일하고 계세요?',
        '자세한 건 안 여쭙습니다. 두 번만 고르시면 됩니다.')
        /* [새문구] 카드 설명 4줄 — 노션 카드형에 맞춰 새로 씀 */
        + `<div class="ob-opt-cards">
            ${card('회사·조직', '팀과 함께 회사 일을 합니다', ICONS.company, S.stage === 'company')}
            ${card('1인·프리랜서', '내 이름으로 여러 일을 합니다', ICONS.solo, S.stage === 'solo')}
            ${card('학교·연구', '연구실·학교에서 연구합니다', ICONS.academy, S.stage === 'academy')}
            ${card('학생', '수업·시험·진로를 준비합니다', ICONS.student, S.stage === 'student')}
          </div><button class="ob-q-skip" data-skip>나중에 정할게요</button>`,
      bind: (el) => {
        const ID = { '회사·조직': 'company', '1인·프리랜서': 'solo', '학교·연구': 'academy', '학생': 'student' };
        $$('.ob-opt-card', el).forEach((c) => c.onclick = async () => {
          $$('.ob-opt-card', el).forEach((x) => x.classList.remove('ob-on')); c.classList.add('ob-on');
          const id = ID[c.dataset.opt]; if (S.stage !== id) { S.job = null; }
          S.stage = id; save(); saveWork(); await sleep(200); goScene('role');
        });
        $('[data-skip]', el).onclick = () => { S.stage = S.stage || 'company'; goScene('role'); };
      },
    },
    role: {
      html: () => qHead('role',
        `${esc(stageOf().label)}이시군요.`,
        esc(stageOf().axis),
        '고르신 것에 맞춰 자료를 읽습니다. 목록에 없으면 직접 적어 주세요.')
        + `<div class="ob-opt-cards">${stageOf().opts.map(([l]) => card(l, '', jobIcon(l), S.job === l)).join('')}</div>
           <div class="ob-q-write" hidden><input id="roleIn" type="text" placeholder="무슨 일을 하시는지 적어 주세요"><button class="ob-btn ob-btn-pri ob-btn-inline" id="roleInGo" style="margin-top:0">확인</button></div>
           <button class="ob-q-skip" data-other>목록에 없어요. 직접 적을게요</button>
           <button class="ob-q-skip" data-skip>나중에 정할게요</button>`,
      bind: (el) => {
        $$('.ob-opt-card', el).forEach((c) => c.onclick = async () => {
          $$('.ob-opt-card', el).forEach((x) => x.classList.remove('ob-on')); c.classList.add('ob-on');
          S.job = c.dataset.opt; save(); saveWork(); await sleep(200); goScene('files');
        });
        const wr = $('.ob-q-write', el), win = $('#roleIn', el);
        $('[data-other]', el).onclick = (e) => { wr.hidden = false; e.target.hidden = true; win.focus(); };
        const commit = () => { const v = win.value.trim(); if (!v) return; S.job = v; save(); saveWork(); goScene('files'); };
        $('#roleInGo', el).onclick = commit;
        win.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) commit(); });
        $('[data-skip]', el).onclick = () => goScene('files');
      },
    },
    /* 로컬 파일 — 앱 연결과 섞여 있던 것을 앞으로 떼어냈다(원준님 2026-08-25).
       여기서 받은 파일은 곧바로 읽기 시작해, 뒤이어 앱을 연결하는 동안 배경에서 분류가 끝난다.
       업로드 자체는 #1881 L4 실배선 그대로 — 드롭·피커 → 개인 폴더 uploads/<상대경로> → 서버가 자료로 등록.
       #2232 — 받은 것을 **눈에 보이게** 남긴다(이름·크기·종류 배지, 그림은 미리보기, 폴더째면 폴더 하나로). 종전엔
        «3개를 받았어요» 숫자 하나뿐이라 무엇이 올라갔는지 알 길이 없었다(원준님 2026-08-28). 고르기 버튼은 첫 파일
        뒤에 [파일 추가]로 바뀐다. */
    files: {
      html: () => qHead('files',
        `${esc(S.name)}님, 먼저 파일부터 받겠습니다.`,
        '지금 가지고 계신 파일을 올려 주세요.',
        '파일이든 폴더든 끌어다 놓으시면 됩니다. 받는 즉시 읽기 시작해서, 다음 단계를 하시는 동안 정리해 둡니다.')
        //  #1813 f27094f2 — 고르기는 **한 번에 끝난다**(모달·팝오버·버튼 둘 전부 폐기, 원준님 2026-08-27). 폴더째는 끌어다 놓기가 받는다.
        + `<div class="ob-drop ${S.upN ? 'ob-has' : ''}" id="upZone">
            <span class="ob-drop-t" id="upZoneT">${S.upN ? `${S.upN}개를 받았어요` : '여기에 끌어다 놓으세요'}</span>
            <span class="ob-drop-d" id="upZoneD">${S.upBusy ? `올리는 중 ${S.upBusy}개` : (S.upN ? '더 올리셔도 됩니다. 폴더째는 끌어다 놓으세요.' : '폴더째는 여기에 끌어다 놓으세요(고르기 창은 파일만 골라요). 정리도, 이름 짓기도 필요 없습니다.')}</span>
            <span class="ob-drop-pick" id="upPick"></span>
          </div>
          <div class="ob-files" id="upList" hidden></div>
          <button class="ob-btn ob-btn-pri" id="fGo" ${S.upN ? '' : 'disabled'}>${S.upN ? `${S.upN}개 올리고 계속` : '계속'}</button>
          <button class="ob-q-skip" data-skip>지금은 건너뛰기. 나중에 올려도 됩니다</button>`,
      bind: (el) => {
        const zone = $('#upZone', el), list = $('#upList', el);
        let pickBtn = null;
        const paintList = () => { if (!list) return; const h = fileListHtml(); list.hidden = !h; list.innerHTML = h; };
        const paintZone = () => {
          const t = $('#upZoneT', el), d = $('#upZoneD', el), go = $('#fGo', el);
          if (!t || !d) return;
          t.textContent = S.upN ? `${S.upN}개를 받았어요` : '여기에 끌어다 놓으세요';
          d.textContent = S.upBusy ? `올리는 중 ${S.upBusy}개` : (S.upN ? '더 올리셔도 됩니다. 폴더째는 끌어다 놓으세요.' : '폴더째는 여기에 끌어다 놓으세요(고르기 창은 파일만 골라요). 정리도, 이름 짓기도 필요 없습니다.');
          zone.classList.toggle('ob-has', !!S.upN);
          if (go) { go.disabled = !S.upN; go.textContent = S.upN ? `${S.upN}개 올리고 계속` : '계속'; }
          if (pickBtn) pickBtn.textContent = (S.upN || S.upBusy) ? '파일 추가' : '파일 고르기';
          paintList();
        };
        const sendAll = async (items) => {
          if (!items.length) return;
          S.upBusy += items.length;
          const rows = items.map((it) => noteFile(it));
          paintZone();
          for (let i = 0; i < items.length; i++) {
            const it = items[i], row = rows[i];
            const rel = 'uploads/' + String(it.rel || it.file.name).replace(/^\/+/, '');
            try {
              await authUploadProgress(apiUrl('/api/ui/terminal/browse/file?root=personal&path=' + encodeURIComponent(rel)), it.file, () => {}, undefined);
              // ⚠ 종전엔 응답의 source_id 가 있을 때만 셌다. 그런데 그 필드는 **자료 등록까지 성공했을 때만** 실린다
              //  (terminal-files.ts: `...(ing?.ingested ? { source_id } : {})`) — 등록이 조용히 실패하면 파일은 올라갔는데
              //  화면은 0개로 남아 «계속» 이 영영 안 켜졌다(실측 2026-08-26 원준님 신고). 올라간 건 올라간 것으로 센다.
              S.upN++; if (row) row.st = 'ok';
            } catch (e) { if (row) row.st = 'err'; toast(`${it.file.name} 을 올리지 못했어요 — ${e && e.message ? e.message : e}`); }
            S.upBusy--; S.read.total = S.upN; save(); paintZone();
          }
          renderSB();
        };
        upDropZone(zone, zone, (items) => void sendAll(items));
        // 고르기는 **한 번에 끝난다** — 묻지 않는다(원준님 2026-08-27: "모달로 또 떠서 고르라는데").
        //  ⚠ 브라우저 제약은 그대로다: 고르기 창은 파일만(폴더는 webkitdirectory 입력이 따로라 **한 창에서 같이 못 고른다** —
        //   크롬·사파리·파폭 공통, File System Access API 도 둘로 갈린다). 그건 **우리 사정**이지 사람에게 물을 일이 아니다.
        //   그래서 [파일 고르기] 하나만 두고, 폴더째는 **끌어다 놓기**가 받는다(드롭은 파일·폴더를 함께 받는다) — 그 사실은
        //   상자 문구가 말한다. 프로젝트 화면의 팝오버 메뉴(upControl)는 파일 브라우저의 문법이라 이 자리에는 맞지 않는다.
        //   (#2232 에서 잠깐 그 메뉴를 다시 붙였다가 되돌렸다 — 같은 지적을 두 번 받을 일이다.)
        //  #2232 — 첫 파일 뒤엔 [파일 추가]로 이름이 바뀐다(paintZone).
        const fileIn = document.createElement('input');
        fileIn.type = 'file'; fileIn.multiple = true; fileIn.style.display = 'none';
        fileIn.addEventListener('change', () => { void sendAll(upFromInput(fileIn)); fileIn.value = ''; });
        pickBtn = document.createElement('button');
        pickBtn.type = 'button'; pickBtn.className = 'ob-btn ob-btn-sub ob-btn-inline'; pickBtn.textContent = S.upN ? '파일 추가' : '파일 고르기';
        pickBtn.onclick = (ev) => { ev.stopPropagation(); fileIn.click(); };
        $('#upPick', el).append(pickBtn, fileIn);
        paintList();
        // 올린 것을 서버가 어떻게 세었는지 곧바로 읽어 온다 — 뒤 채팅이 쓸 숫자가 여기서 정해진다.
        $('#fGo', el).onclick = () => { void loadWelcome(); startReading(); goScene('ai'); };
        $('[data-skip]', el).onclick = () => goScene('ai');
      },
    },
    /* 앱 고르기 — 로컬 파일은 앞에서 받았으므로 '내 컴퓨터 폴더' 항목은 뺀다. */
    sources: {
      html: () => {
        // 뺀 셋: '내 컴퓨터 폴더'는 앞 단계(파일 올리기)가 대신하고, '딱히 없어요'는 아래 건너뛰기가 이미 그 자리다
        //  (버튼으로 두면 글이 길어 두 줄로 잘린다).
        //  #1879 — '로컬 깃 저장소'도 뺀다. 이건 외부 서비스 연결이 아니라 **내 컴퓨터에 라이블리를 까는 일**이고,
        //   뒤 «내 컴퓨터 연결» 장면이 통째로 그걸 한다. 여기 두면 골라 놓고 연결할 길이 없는 카드가 된다.
        const DROP = new Set(['folder', 'none', 'git']);
        //  #2232 — 아직 못 여는 앱(구글 셋: 이 워크스페이스엔 연결 창구가 없다)은 **제자리에 잠가 둔다**. 종전엔
        //   «아직 열려 있지 않은 곳» 묶음으로 내려 «회사에서 열어 줘야 해요 · 부탁 문구 복사» 를 붙였는데, 이 제품은
        //   회사만 쓰는 게 아니다 — 혼자 쓰는 사람에게 '회사 담당자'는 없는 사람이고, 사실은 우리가 아직 준비 못 한
        //   것이다(원준님 2026-08-28). 그래서 표의 soon 과 같은 모양으로 «준비 중» 이라고만 말한다.
        //  아직 서버에 못 물었으면(CONN===null) 표 그대로 다 보여 준다 — 모르는 것을 '안 된다'로 뭉개지 않는다.
        const rows = [];
        for (const r of DATA.SOURCE_ROWS) {
          const items = r.items.filter((it) => !DROP.has(it.id));
          if (!items.length) continue;
          const k = r.k === '내 컴퓨터' ? '그 밖' : r.k;
          const hit = rows.find((x) => x.k === k);
          if (hit) hit.items.push(...items); else rows.push({ k, items: [...items] });
        }
        const notYet = (it) => it.soon || connState(it.id) === 'blocked';
        //  #2232 — «준비 중» 카드는 묶음 안에서 **맨 오른쪽**으로(원준님 2026-08-28). 문서·위키는 Notion · Figma · Google Drive 순이 된다.
        for (const r of rows) r.items = [...r.items.filter((it) => !notYet(it)), ...r.items.filter(notYet)];
        const flat = rows.flatMap((r) => r.items);
        const already = flat.filter((it) => connState(it.id) === 'on');
        const ic = (it) => BRAND[it.logo] || GLYPH[it.id] || '';
        const doneCard = (id, label, icon) => doneCardHtml(id, label, icon, '연결돼 있어요');
        //  아직 안 되는 곳 — **고를 수 없게 잠그고 그 사실을 적는다.** 고를 수 있게 두면 골랐는데 아무 일도 안 일어나고,
        //   그때 사람은 서비스가 고장 났다고 읽는다.
        const soonCard = (label, icon) => `<button class="ob-opt-card ob-locked ob-soon" aria-disabled="true" disabled title="아직 준비 중이에요"><span class="ob-oc-ic">${icon}</span><span><span class="ob-oc-t">${esc(label)}</span><span class="ob-oc-d">준비 중</span></span></button>`;
        return qHead('sources',
          S.upN ? `파일 <b>${S.upN}개</b>를 받아서 읽는 중입니다. 이어서 한 가지만 더요.` : '알겠습니다. 이어서 한 가지만 더요.',
          '그동안 쌓아 두신 자료를 가져올 외부 서비스를 연결할게요.',
          '고르신 곳에 쌓여 있던 지난 자료부터 읽어서 자료함에 정리합니다. 파일로 일일이 옮기실 필요가 없어요.')
          + (already.length ? `<p class="ob-q-fine" style="text-align:left;margin:0 0 14px">이미 연결된 곳이 있어요 — ${esc(already.map((it) => it.label).join(' · '))}. 다시 하실 필요 없습니다.</p>` : '')
          + rows.map((r) => `<p class="ob-opt-group">${esc(r.k)}</p><div class="ob-opt-grid">
              ${r.items.map((it) => connState(it.id) === 'on' ? doneCard(it.id, it.label, ic(it))
                : notYet(it) ? soonCard(it.label, ic(it))
                : card(it.label, '', ic(it), S.sources.includes(it.id))).join('')}</div>`).join('')
          //  #2232 — 표에 없지만 **이 워크스페이스에 등록된 앱**(관리자가 등록한 MCP 커넥터). 종전엔 코드를 고쳐 표에
          //   한 줄 넣어야만 온보딩에 떴다 — #/connect 는 이미 이것들을 세우고 있었으므로 두 화면이 서로 다른
          //   목록을 보여 주고 있었다. 로고만 없을 뿐 연결하는 길은 같다.
          + (dynSvcs().length ? `<p class="ob-opt-group">그 밖에 연결할 수 있는 앱</p><div class="ob-opt-grid">
              ${dynSvcs().map((sv) => connState(sv.key) === 'on'
                ? doneCard(sv.key, sv.label, esc((sv.label || '?').slice(0, 1)))
                : card(sv.label, '', esc((sv.label || '?').slice(0, 1)), S.sources.includes(sv.key))).join('')}</div>` : '')
          + (flat.some(notYet) ? `<p class="ob-q-fine" style="text-align:left;margin:2px 0 0">흐리게 보이는 앱은 아직 준비 중이에요. 열리면 [외부 앱 연결]에서 바로 연결하실 수 있어요.</p>` : '')
          + `<button class="ob-btn ob-btn-pri" id="srcGo" disabled>계속</button>
             <button class="ob-q-skip" data-skip>가져올 곳이 없어요</button>`;
      },
      bind: (el) => {
        //  서버에 **먼저** 묻는다 — 무엇이 이미 연결돼 있고 무엇이 아직 안 열렸는지는 서버만 안다.
        //   못 물으면 표 그대로 두고 그냥 진행한다(연결 못 읽었다고 온보딩이 막히면 안 된다).
        if (!CONN && !connTried) { void loadConn().then(() => renderScene('sources', false)); }
        const all = DATA.SOURCE_ROWS.flatMap((r) => r.items);
        //  #2232 — 관리자가 등록한 앱은 표에 없으므로 서버가 준 목록에서도 찾는다(키가 곧 id 다).
        const idOf = (label) => (all.find((s) => s.label === label) || {}).id
          || (dynSvcs().find((sv) => sv.label === label) || {}).key;
        const go = $('#srcGo', el);
        //  이미 연결된 것은 고르고 말고 할 게 없다 — 잠가 두고 [계속]의 숫자에서도 뺀다.
        //  ⚠ 다만 **문은 열어 둔다**: 이미 다 연결해 둔 사람은 새로 고를 것이 없어 [계속]이 잠기고,
        //   그러면 남는 길이 [가져올 곳이 없어요]뿐이라 연결해 둔 사실을 스스로 부정하고 나가야 한다.
        const already = $$('.ob-opt-card.ob-locked[data-done]', el).length;
        const sync = () => { const n = $$('.ob-opt-card.ob-on:not(.ob-locked)', el).length;
          go.disabled = !n && !already; go.textContent = n ? `${n}곳에서 가져오기` : '계속'; };
        sync();
        $$('.ob-opt-card:not(.ob-locked)', el).forEach((c) => c.onclick = () => {
          c.classList.toggle('ob-on');
          S.sources = $$('.ob-opt-card.ob-on:not(.ob-locked)', el).map((x) => idOf(x.dataset.opt)).filter(Boolean); save(); renderSB(); sync();
        });
        wireUnlink(el, () => renderScene('sources', false));
        go.onclick = () => goScene(pickedIds().length ? 'connect' : 'terminal');
        $('[data-skip]', el).onclick = () => { S.sources = ['none']; save(); goScene('terminal'); };
      },
    },
    /* ══ #1879 — 고른 곳을 **실제로** 잇는다. 이 동안 앞에서 받은 파일이 배경에서 읽힌다(대기 없음). ══
     *  종전 이 장면은 카드를 누르면 1.1초 기다렸다가 무조건 «연결이 완료됐어요» 라고 썼고, 읽을 자료가
     *   없으면 «41개» 라는 숫자까지 지어내 진행바를 굴렸다. 아무것도 이어지지 않았고 아무것도 읽지 않았다.
     *  이제 [외부 앱 연결](v2/connect.ts)과 **같은 경로로** 잇는다. 초록불의 근거는 화면의 기억(S.connected)이
     *   아니라 **서버 실측**이다 — 새로고침해도, 다른 탭에서 이어도, 도중에 그만둬도 화면이 사실과 같아진다.
     *
     *  잇는 길이 둘이라 화면도 둘이다. 어느 쪽인지는 사람이 고르지 않는다(connHow 가 정한다):
     *   · **계정 로그인** — 누르면 새 탭이 열리고 그 서비스에서 [허용] 한 번. 이 사람에게 가장 쉬운 길이라
     *     가능하면 무조건 이쪽이다(Notion·Slack·Google·GitLab…).
     *   · **글자 받아 오기** — 조직에 그 커넥터가 없거나 애초에 그 방법뿐인 앱(GitHub·Figma·ClickUp).
     *     여기서 관리자용 토큰 폼(svcTokenForm)을 띄우지 않는다: 그 폼은 '발급 스펙'을 보여 주지만
     *     이 사람에게 필요한 것은 **어느 버튼을 누르는가**다. 그래서 카드 아래에서 세 걸음으로 펼친다.
     *     주소·값의 생김새는 CRED_KINDS 에서 읽는다(지어내면 그 자리에서 사람이 막힌다).
     *
     *  ⚠ 어느 갈래에서도 사람을 가두지 않는다 — 하나도 못 이어도 [나중에 가져올게요]로 그냥 간다.
     *   연결은 여기서 안 끝나도 [외부 앱 연결] 화면에 그대로 남아 있다(그 사실을 화면에 적어 둔다).
     */
    connect: {
      html: () => {
        const all = DATA.SOURCE_ROWS.flatMap((r) => r.items);
        const picked = pickedIds();
        const done = picked.filter((id) => connState(id) === 'on');
        const left = picked.length - done.length;
        const reading = S.read.total && !S.read.finished;
        //  아직 서버에 못 물었으면 그렇다고 말한다 — '연결 안 됨'으로 뭉개면 이미 이은 사람이 또 잇는다.
        const unknown = !CONN;
        return qHead('connect',
          reading ? `읽는 중이에요. <b>${S.read.done} / ${S.read.total}</b>` : (S.upN ? `파일 ${S.upN}개는 다 읽었어요.` : '거의 다 왔어요.'),
          done.length ? `${done.length}곳을 연결했어요.` : '고르신 곳을 하나씩 연결해 주세요.',
          unknown ? '연결 상태를 불러오는 중이에요…' : '아래에서 하나씩 눌러 주세요. 한 번에 하나면 됩니다.')
          + `<div class="ob-opt-cards">${picked.map((id) => {
              const it = all.find((s) => s.id === id) || { label: id };
              const st = connState(id);
              const how = connHow(id);
              const open = tokOpen === id;
              const scopeOnly = collectMode(id) && id === 'figma' && tokenSaved(id);
              const desc = st === 'on' ? (collectMode(id) ? (COLLECT_ON_DESC[id] || '모으고 있어요.') : '연결됐어요.')
                : scopeOnly ? (open ? '모을 파일 링크를 넣어 주세요.' : '토큰은 받았어요 — 눌러서 모을 파일 링크를 넣어 주세요.')
                : st === 'blocked' ? '아직 준비 중이에요.'
                : unknown ? '연결 상태를 확인하고 있어요.'
                : how === 'token' ? (open ? '아래 세 걸음을 따라 주세요.' : '눌러 주세요 — 글자 한 줄을 받아 오면 됩니다.')
                : (collectMode(id) && id === 'notion' ? '눌러 주세요 — 노션 화면에서 모을 페이지를 고르고 [액세스 허용]을 누르면 됩니다.' : '눌러 주세요 — 새 탭에서 [허용]만 누르면 됩니다.');
              if (st === 'on') return doneCardHtml(id, it.label, BRAND[it.logo] || GLYPH[it.id] || '', desc);
              return `<button class="ob-opt-card${open ? ' ob-open' : ''}" data-conn="${esc(id)}"><span class="ob-oc-ic">${BRAND[it.logo] || GLYPH[it.id] || ''}</span>
                <span><span class="ob-oc-t">${esc(it.label)}</span><span class="ob-oc-d">${esc(desc)}</span></span>
                <span class="ob-oc-st"></span></button>`
                + (open ? tokPanel(id) : ''); }).join('')}</div>
          <button class="ob-btn ob-btn-pri" id="upGo" ${done.length ? '' : 'disabled'}>${left > 0 && done.length ? `${left}곳은 나중에, 계속` : '다 연결했어요, 계속'}</button>
          <button class="ob-q-skip" data-skip>나중에 가져올게요. 지금은 넘어갈게요</button>
          <p class="ob-q-fine">지금 연결하지 못하셔도 괜찮아요 — <a href="#/connect" class="ob-link">외부 앱 연결</a>에서 언제든 다시 하실 수 있습니다.</p>`;
      },
      bind: (el) => {
        //  들어올 때마다 서버에 묻는다 — 앞 장면에서 뒤로 왔을 수도, 다른 탭에서 이었을 수도 있다.
        if (!CONN && !connTried) { void loadConn().then(() => renderScene('connect', false)); }
        const redraw = () => renderScene('connect', false);
        /** 이어진 것을 화면·사이드바·결정 기록에 반영한다. **서버가 그렇다고 한 뒤에만** 부른다. */
        const markConnected = (id) => {
          const label = srcLabel(id);
          if (S.connected.includes(id)) return;                     // 뒤로 왔다 다시 들어와도 두 번 세지 않는다
          S.connected.push(id);
          S.decisions.push(`${label} 연결`);
          save(); renderSB();
          //  ★ #2232 — 이 화면은 «그동안 쌓인 자료를 가져옵니다» 라고 약속한다. 개인 연결(금고에 자격 한 줄)은
          //   **AI 가 그 앱을 쓸 수 있게** 할 뿐, 지난 자료를 끌어오지는 않는다 — 그건 수집기(org_collector)이고
          //   새 워크스페이스에는 꺼진 채로 깔린다. 그래서 켤 수 있는 사람(=관리자, 셀프서브에선 만든 사람 본인)
          //   에게는 여기서 **실제로 켠다**. 못 켜는 사람에게는 약속하지 않는다(문구가 갈린다).
          void startCollect(id).then((on) => {
            toast(on ? `${label} 연결됐어요. 그동안 쌓인 자료를 가져오기 시작합니다.`
                     : `${label} 연결됐어요. 이제 제가 ${label} 을 직접 쓸 수 있어요.`);
          });
        };
        /** 팀 자료로 모으기(수집) 켜기 — 관리자만. 실패·미지원은 조용히 false(온보딩을 막지 않는다). */
        async function startCollect(id) {
          //  피그마는 수집기가 아니라 **코멘트 증류기**가 짝이다(#1881 F8) — 있으면 꺼진 채로 준비만 해 둔다.
          if (id === 'figma' && isAdmin()) {
            try { await api('/api/ui/org/distillers/figma', { method: 'POST', body: JSON.stringify({}) }); } catch (_) { /* 비치명 */ }
          }
          const svc = COLLECT_OF[id]; if (!svc || !isAdmin()) return false;
          try {
            const r: any = await api(`/api/ui/org/${svc}/collect`, { method: 'POST', body: JSON.stringify({ enabled: true }) });
            return !(r && r.needs_connect === true);
          } catch (_) { return false; }
        }
        /** #2243 수집기 축 연결 — 노션은 공개 통합 동의(페이지 고르기), 슬랙은 계정 로그인 뒤 수집기 켜기. */
        async function collectConnect(id, c) {
          const d = c.querySelector('.ob-oc-d');
          const fin = (err) => {
            if (err) { toast(err); if (S.scene === 'connect') redraw(); return; }
            if (connState(id) === 'on') markConnected(id);
            if (S.scene === 'connect') redraw();
          };
          if (id === 'notion') {
            try {
              //  켜기를 먼저 시도한다 — 이미 연결된 워크스페이스가 있으면 그 자리에서 켜지고, 없으면 노션 동의 주소가 온다.
              const r: any = await api('/api/ui/org/notion/collect', { method: 'POST', body: JSON.stringify({ enabled: true }) });
              if (r && r.ok) { await loadConn(); fin(); return; }
              const url = r && r.authorization_url;
              if (!url) { fin('노션 화면을 열지 못했어요. 잠시 뒤 다시 눌러 주세요.'); return; }
              if (d) d.textContent = '노션 화면에서 모을 페이지를 고르고 [액세스 허용]을 누르면 여기가 저절로 바뀌어요…';
              window.open(url, '_blank', 'noopener');
              watchConnect(id, fin);
            } catch (e) { fin((e && e.message) || '노션 연결을 시작하지 못했어요.'); }
            return;
          }
          //  #2247 피그마·ClickUp — 토큰이 없으면 토큰 폼(피그마는 범위 칸 포함), 있으면 바로 켠다. 범위가 없다면(피그마) 폼을 연다.
          if (id === 'figma' || id === 'clickup') {
            if (!tokenSaved(id)) { tokOpen = id; redraw(); return; }
            const r: any = await startMemberCollect(id, '');
            if (r && r.needs_scope) { tokOpen = id; redraw(); return; }
            await loadConn();
            fin(r && r.ok ? null : ((r && r.message) || '모으기를 켜지 못했어요 — [외부 앱 연결]에서 다시 시도해 주세요.'));
            return;
          }
          //  슬랙 — 내 토큰이 이미 있으면 로그인 없이 수집기만 켠다.
          if (CONN && CONN.connected.some((s) => s.key === 'slack')) {
            const on = await startCollect(id);
            await loadConn();
            fin(on ? null : '슬랙 자료 모으기를 켜지 못했어요 — [외부 앱 연결]에서 다시 시도해 주세요.');
            return;
          }
          if (d) d.textContent = '새 탭에서 허용을 누르면 여기가 저절로 바뀌어요…';
          await svcOAuth(id, fin);
        }
        wireUnlink(el, redraw);
        $$('[data-conn]', el).forEach((c) => c.onclick = async () => {
          const id = c.dataset.conn;
          if (connState(id) === 'on') return;                       // 이미 이어졌다 — 더 시킬 일이 없다
          if (connState(id) === 'blocked') { toast('이 앱은 아직 준비 중이에요. 열리면 [외부 앱 연결]에서 바로 연결하실 수 있어요.'); return; }
          //  ⚠ 아직 서버를 못 읽었으면 **어느 길로 이을지 고를 수 없다**: Slack·GitLab 은 계정 로그인과 글자 받아
          //   오기가 둘 다 있어서, 모르는 채로 정하면 회사가 이미 열어 둔 쉬운 길을 두고 어려운 길로 보내게 된다.
          if (!CONN) { toast('연결 상태를 아직 확인하는 중이에요 — 잠시 뒤 다시 눌러 주세요.'); if (!connTried) void loadConn().then(redraw); return; }
          if (collectMode(id)) { await collectConnect(id, c); return; }
          if (connHow(id) === 'token') { tokOpen = tokOpen === id ? null : id; redraw(); return; }
          const d = c.querySelector('.ob-oc-d'); if (d) d.textContent = '새 탭에서 허용을 누르면 여기가 저절로 바뀌어요…';
          await svcOAuth(id, (err) => {
            //  #2232 — 감시자(watchConnect)가 한참 뒤에 부를 수 있다. 그때 다른 장면에 가 있으면 화면은 건드리지 않는다(기록만).
            if (err) { toast(err); if (S.scene === 'connect') redraw(); return; }
            if (connState(id) === 'on') markConnected(id);
            if (S.scene === 'connect') redraw();
          });
        });
        // ── 펼쳐진 «글자 받아 오기» 폼 배선 ──
        const tokIn = $('#tokIn', el), tokGo = $('#tokGo', el), tokErr = $('#tokErr', el);
        if (tokIn && tokGo) {
          const submit = async () => {
            const id = tokOpen, v = (tokIn.value || '').trim();
            if (!id) return;
            if (!v && !tokenSaved(id)) { if (tokErr) tokErr.textContent = '받아 오신 글자를 붙여넣어 주세요.'; tokIn.focus(); return; }
            tokGo.disabled = true; tokGo.textContent = '연결하는 중…'; if (tokErr) tokErr.textContent = '';
            let verdict = null;
            try {
              if (v) verdict = await svcToken(id, v);
            } catch (e) {
              tokGo.disabled = false; tokGo.textContent = '이걸로 연결하기';
              if (tokErr) tokErr.textContent = (e && e.message) || '연결하지 못했어요. 글자를 다시 확인해 주세요.';
              return;
            }
            //  저장은 됐다. 그래도 **서버가 이어졌다고 할 때만** 초록불을 켠다(값이 틀려도 저장은 되기 때문).
            //  #2232 — 서버가 «그 값으로 실제 붙어 봤다» 고 답했으면 그 답이 먼저다(저장 성공 ≠ 되는 값).
            if (verdict && verdict.ok === false) {
              tokGo.disabled = false; tokGo.textContent = '이걸로 연결하기';
              if (tokErr) tokErr.textContent = verdict.message || '그 글자로는 아직 연결되지 않았어요. 값을 다시 확인해 주세요.';
              return;
            }
            //  #2247 수집기 축 — 토큰이 저장됐으면 그 토큰으로 수집기를 켠다(피그마는 범위 칸의 링크와 함께).
            if (collectMode(id)) {
              const sc = $('#tokScope', el);
              const r: any = await startMemberCollect(id, sc ? sc.value : '');
              if (!r || !r.ok) {
                tokGo.disabled = false; tokGo.textContent = '이걸로 연결하기';
                if (tokErr) tokErr.textContent = (r && r.message) || '모으기를 켜지 못했어요. 잠시 뒤 다시 눌러 주세요.';
                if (r && r.needs_scope && sc) sc.focus();
                await loadConn(); return;
              }
              await loadConn();
            }
            if (connState(id) === 'on') { markConnected(id); tokOpen = null; redraw(); return; }
            tokGo.disabled = false; tokGo.textContent = '이걸로 연결하기';
            if (tokErr) tokErr.textContent = '글자는 받았는데 아직 연결되지 않았어요. 복사할 때 앞뒤가 잘리지 않았는지 보고 다시 넣어 주세요.';
          };
          tokGo.onclick = submit;
          tokIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) submit(); });
          tokIn.focus();
        }
        //  남겨 두고 가는 사람에게는 **어디로 돌아오면 되는지**를 말한다 — 안 그러면 '나중에'가 갈 곳 없는 말이 된다.
        $('#upGo', el).onclick = () => { if (pickedIds().some((id) => connState(id) !== 'on')) toast('남은 곳은 왼쪽 [외부 앱 연결]에서 언제든 연결하실 수 있어요.'); goScene('terminal'); };
        $('[data-skip]', el).onclick = () => { toast('나중에 하셔도 돼요 — 왼쪽 [외부 앱 연결]에 그대로 있습니다.'); goScene('terminal'); };
      },
    },
    ai: {
      html: () => qHead('ai',
        S.read.total ? '자료를 읽는 동안 하나 더요.' : '이제 AI 차례예요.',
        '평소 어떤 AI를 쓰세요?', '')
        + `<div class="ob-opt-cards">${DATA.AIS.map((a) => card(a, '', AI_LOGO[a] || '', S.ai === a)).join('')}</div>
           <button class="ob-q-skip" data-skip>나중에 정할게요</button>`,
      bind: (el) => {
        $$('.ob-opt-card', el).forEach((c) => c.onclick = async () => {
          $$('.ob-opt-card', el).forEach((x) => x.classList.remove('ob-on')); c.classList.add('ob-on');
          S.ai = c.dataset.opt; AIC = null; save(); renderSB(); await sleep(200);
          goScene(S.ai === '아직 없어요' ? 'sources' : 'claude');
        });
        $('[data-skip]', el).onclick = () => goScene('sources');
      },
    },
    /* AI 잇기 — **실물**이다(#1813). 종전엔 900ms 기다렸다 무조건 «연결됐어요» 라고만 했다.
     *  이 제품의 LLM 은 그 사람 본인 AI 구독으로 돈다(박스에 API 키가 없는 게 설계다).
     *  ⚠ 잇는 방법은 **터미널에서 그 CLI 로 한 번 로그인**하는 것이다. 그러면 자격이 그 사람 프로필
     *   (~/.claude/.credentials.json 등)에 남고, 헤드리스 분석도 그 프로필로 돈다.
     *   setup-token 을 붙여넣게 하지 않는다 — 그건 자기 프로필이 없는 자리(남의 노드 위탁)용 보조 수단이라
     *   여기서 요구하면 사람에게 더 어려운 길을 시키는 것이 된다. 관문은 '로그인' 하나다(#1437 §6).
     *
     *  #1879 — **넷을 다 잇는다.** 종전 판정(ai_ready)은 «아무 하네스나 하나라도» 였고 고른 AI 와 무관했다.
     *   그래서 두 가지가 동시에 틀렸다: ① 그록을 고른 사람에게 claude 로그인을 근거로 «이어졌어요» 라고 했고
     *   ② 제미나이(agy)는 자격을 파일로 남기지 않아 서버가 영영 못 봐서, 로그인을 마쳐도 «아직 로그인이
     *   안 보여요» 만 반복되는 **막다른 길**이었다(고르게는 해 놓고 이을 수는 없는 자리).
     *   이제 고른 AI **하나**를 서버에 묻고(POST /api/ui/me/ai-accounts/check) 세 가지를 갈라 말한다:
     *     · CLI 가 이 자리에 없다      → 로그인을 시킬 게 아니라 그 사실을 말한다(사람이 할 일이 다르다)
     *     · 있는데 로그인 전이다        → 그 하네스의 **실측된** 절차를 그대로 보여 준다(catalog.loginSteps)
     *     · 됐다                        → 넘어간다
     *   그리고 어느 갈래에서도 **사람을 가두지 않는다**: 다른 AI 가 이미 이어져 있으면 그걸 정직하게 말하고
     *   그대로 계속할 문을 연다(분석은 resolveHeadlessHarness 가 고른 그 하네스로 실제로 돈다). */
    claude: {
      html: () => {
        const c = AIC || {};
        const picked = esc(S.ai || 'AI');
        const bin = esc(c.bin || AI_BIN_FALLBACK[aiHarness()] || '');
        const others = (c.others || []).map((k) => AI_LABEL[k] || k);
        const otherNote = others.length
          ? `<p class="ob-note">지금은 ${esc(others.join(' · '))}${josa(others[others.length - 1], 0)} 연결돼 있어요. ${picked}${josa(S.ai, 1)} 연결하지 않으셔도 제 분석은 그걸로 돌아갑니다.</p>`
          : '';
        const goOther = `<button class="ob-btn ob-btn-sub" data-other>다른 AI 고르기</button>`;
        //  #2232 — [이대로 계속]과 [나중에 할게요]는 결국 같은 곳으로 간다(원준님). 다른 AI 가 이미 연결돼 있으면 «이대로 계속» 하나만,
        //   아무것도 없으면 «나중에 할게요» 하나만 보인다.
        const keepBtn = (others.length || S.aiConnected) ? `<button class="ob-btn ob-btn-sub" id="cKeep">이대로 계속</button>` : '';
        const skip = keepBtn ? '' : `<button class="ob-btn ob-btn-sub" data-skip>나중에 할게요</button>`;
        //  #2232 — 이름을 아직 안 주신 분에게 «당신님» 이라고 부르던 자리(실측). 이름이 없으면 부르지 않는다.
        const lead = `연결해 두시면 제(리브)가 일할 때도 ${nick() ? `${esc(nick())}님의` : '쓰시던'} 구독을 씁니다. 라이블리가 따로 요금을 매기지 않습니다.`;

        // ── 아직 안 물어봤다 — 없는 답을 지어내지 않고 묻는 중이라고 말한다(bind 가 곧 채운다).
        if (!AIC) {
          return qHead('claude', lead, `${picked} 계정을 연결해 주세요.`, '')
            + `<div class="ob-tok"><p class="ob-note">${picked} 가 연결돼 있는지 확인하고 있어요…</p></div>` + skip;
        }
        // ── 물어봤는데 서버가 답을 못 줬다.
        if (c.error) {
          return qHead('claude', lead, `${picked} 계정을 연결해 주세요.`, '')
            + `<div class="ob-tok"><p class="ob-err">확인하지 못했어요 — ${esc(c.error)}</p>${otherNote}</div>`
            + `<button class="ob-btn ob-btn-pri" id="cGo">다시 확인</button>` + goOther + skip;
        }
        // ── 됐다 — **다른 AI 도 연결할지** 여기서 묻는다(#2232). 종전엔 고르는 화면에 «여러 개» 카드가 따로 있었는데,
        //    그걸 고르면 무엇을 어떻게 연결하라는 건지 알 수 없는 막다른 카드였다(원준님 2026-08-28). 이제 하나를 연결한
        //    뒤에 나머지를 보여 준다 — 연결된 것은 체크돼 있고, 안 된 것은 눌러서 이어서 연결한다.
        if (aiOn(c.harness)) {
          const onNow = new Set(aiOnKeys(c));
          return qHead('claude', lead, '연결됐어요.', '')
            + `<div class="ob-tok"><p class="ob-ok">${esc(AI_LABEL[c.harness] || picked)} 로그인이 확인됐어요.</p></div>
               <p class="ob-q-help" style="margin-top:4px">다른 AI 도 쓰고 계시면 함께 연결해 둘 수 있어요. 연결된 것은 체크돼 있습니다.</p>
               <div class="ob-opt-cards">${['Claude', 'ChatGPT', 'Gemini', 'Grok'].map((a) => { const k = AI_HARNESS[a];
                 return onNow.has(k)
                   ? `<button class="ob-opt-card ob-on ob-locked" data-done="1" aria-disabled="true"><span class="ob-oc-ic">${AI_LOGO[a] || ''}</span><span><span class="ob-oc-t">${esc(a)}</span><span class="ob-oc-d">연결됨</span></span><span class="ob-oc-chk">✓</span></button>`
                   : `<button class="ob-opt-card" data-more="${esc(a)}"><span class="ob-oc-ic">${AI_LOGO[a] || ''}</span><span><span class="ob-oc-t">${esc(a)}</span><span class="ob-oc-d">눌러서 연결하기</span></span><span class="ob-oc-chk">✓</span></button>`; }).join('')}</div>`
            + `<button class="ob-btn ob-btn-pri" id="cGo">이만하면 됐어요, 계속</button>`;
        }
        // ── CLI 가 이 자리에 없다. 로그인 절차를 보여 줘도 첫 줄에서 command not found 가 난다 —
        //    그러니 로그인을 시키지 않고 **없다는 사실**을 말한다(사람이 해야 할 일이 아예 다르다).
        if (c.installed === false) {
          return qHead('claude', lead, `이 자리엔 ${picked}${josa(S.ai, 0)} 아직 없어요.`,
            `${picked}${josa(S.ai, 1)} 쓰려면 그 CLI(<code>${bin}</code>)가 먼저 깔려 있어야 합니다.`)
            + `<div class="ob-tok">
                <p class="ob-note">라이블리 안 터미널에는 Claude 와 ChatGPT 가 준비돼 있어요. ${picked}${josa(S.ai, 2)} 그 CLI 가 깔린 내 컴퓨터를 연결해 두시면 그대로 쓸 수 있습니다(다음 화면).</p>
                ${otherNote}
              </div>`
            + (keepBtn ? keepBtn.replace('ob-btn-sub', 'ob-btn-pri') : '')
            + goOther + skip;
        }
        // ── 있는데 아직 로그인 전(또는 판정 불가).
        //  #2232 — «터미널을 열고 명령을 치세요» 는 컴맹에게 벽이었다(원준님 2026-08-28): 하네스·원격·device-auth 같은 말,
        //   무엇을 쳐야 하는지, 창이 안 열리면 뭘 하라는 건지. 이제 **로그인용 창을 이 버튼이 연다**(AI 세션 화면의
        //   [내 계정 로그인]과 같은 경로 — 그 사람 격리 홈으로 그 AI 를 띄운 터미널 한 장, 사이드바 없음) 그리고 그 창에서
        //   벌어지는 일을 순서대로 말한다. 쳐야 할 글자는 누르면 복사된다. 서버 절차(catalog.loginSteps)는 표에 없는
        //   하네스의 폴백으로만 남긴다.
        const h = c.harness || aiHarness();
        const g = AI_GUIDE[h];
        const steps = (g ? g.steps : (c.steps && c.steps.length ? c.steps : [`터미널에  ${c.bin || 'claude'}  를 입력해 안내대로 로그인합니다`]).map((t) => esc(t)))
          .map((t) => `<li>${t}</li>`).join('');
        return qHead('claude', lead, `${picked} 계정을 연결해 주세요.`,
          '아래 버튼으로 로그인 창을 열고 순서대로 하시면 됩니다. 쳐야 할 글자는 누르면 복사돼요.')
          + `<div class="ob-tok">
              <button class="ob-btn ob-btn-sub ob-btn-inline" id="cTerm">${LOGIN_INLINE[h] ? `${picked} 로그인 시작` : `${picked} 로그인 창 열기 ↗`}</button>
              <div class="ob-login-card" id="cCard" hidden></div>
              <ol>${steps}</ol>
              ${g && g.note ? `<p class="ob-note ob-fine2">${g.note}</p>` : ''}
              ${c.loggedIn === null ? `<p class="ob-note">이 자리에선 ${picked} 로그인 여부를 서버가 확인하지 못해요. 로그인하셨다면 그대로 계속하셔도 됩니다.</p>` : ''}
              <p class="ob-err" id="cErr"></p>
              ${otherNote}
            </div>`
          + `<button class="ob-btn ob-btn-pri" id="cGo">로그인했어요</button>`
          + keepBtn + goOther + skip;
      },
      bind: (el) => {
        const err = $('#cErr', el), go = $('#cGo', el);
        // 쳐야 할 글자 — 누르면 복사(#2232). 클립보드가 막힌 자리면 글자를 그대로 토스트로 보여 준다.
        $$('code[data-copy]', el).forEach((cd) => cd.onclick = async () => {
          const t = cd.dataset.copy || cd.textContent || '';
          try { await navigator.clipboard.writeText(t); toast('복사했어요. 터미널 창을 한 번 누른 뒤 붙여넣고 Enter 를 누르세요.'); }
          catch (_) { toast(t); }
        });
        // 로그인 창 열기 — 그 AI 를 내 격리 홈에서 띄운 터미널 한 장(사이드바 없는 페이지). me-ai.ts [내 계정 로그인]과 같은 규약.
        //  ⚠ 종전엔 #/terminal(AI 세션 목록, 셸 통째)을 열었다 — 온보딩도 안 끝난 사람에게 사이드바·세션 목록이 통째로
        //   보였고, 거기서 또 [내 계정 로그인]을 찾아 눌러야 했다(원준님 2026-08-28).
        const term = $('#cTerm', el);
        if (term) term.onclick = async () => {
          const h = (AIC && AIC.harness) || aiHarness();
          const label = AI_LABEL[h] || S.ai || h;
          // ★ 터미널 없이 여기서 끝내는 하네스(#2055 후속) — 새 탭·새 창을 열지 않는다.
          //  사람이 할 일은 «주소를 열고 코드를 넣는 것» 뿐인데 종전엔 그걸 하려고 검은 창을 통째로 봤다.
          //  대상이 아닌 하네스(agy·grok)는 아래 종전 경로 그대로다 — 그쪽은 비대화형 한 줄이 없다.
          if (LOGIN_INLINE[h]) { await startInlineLogin(el, h, label); return; }
          term.disabled = true; const was = term.textContent; term.textContent = '여는 중…';
          try {
            const out: any = await api('/api/ui/terminal/sessions', { method: 'POST', body: JSON.stringify({
              label: `내 계정 로그인 (${label})`, rootKey: 'personal', subpath: '', flags: {}, autoApprove: false, loginProfile: true,
              ...(LOGIN_SESSION[h] || { harness: h }) }) });
            const id = out && out.session && out.session.id;
            if (!id) throw new Error('세션을 받지 못했어요');
            window.open(sessionTermUrl(id, { label: (out.session && out.session.label) || label }), '_blank');
            toast('새 탭에 로그인 창을 열었어요. 거기서 로그인을 마치고 돌아오세요.');
          } catch (e) {
            toast(`로그인 창을 열지 못했어요 — ${(e && e.message) || e}`);
            try { window.open(location.pathname + '?solo=1#/terminal', '_blank', 'noopener'); } catch (_) { /* noop */ }
          } finally { term.disabled = false; term.textContent = was; }
        };
        // 장면에 들어오자마자 **한 번** 묻는다 — 사람이 버튼을 누르기 전에 '없는 CLI 를 치라는 안내'를 보지 않게.
        //  판정은 그때그때 다시 재므로 캐시를 믿지 않는다(AIC 는 그림용 최신값일 뿐이다).
        if (!AIC) { checkAi().then(() => renderScene('claude', false)); return; }
        /** 연결된 것으로 기록 — 이 온보딩에서 확인한 하네스(S.aiDone)는 «다른 AI 도?» 화면의 체크 근거다. */
        const mark = (name, key) => {
          S.aiConnected = true; S.aiName = name || null;
          if (!Array.isArray(S.aiDone)) S.aiDone = [];
          if (key && !S.aiDone.includes(key)) S.aiDone.push(key);
          if (!S.decisions.includes('AI 연결')) S.decisions.push('AI 연결');
          save(); renderSB();
        };
        const pass = (name, key) => { mark(name, key); toast('연결됐어요.'); renderScene('claude', false); };
        if (go) go.onclick = async () => {
          if (AIC && aiOn(AIC.harness)) return goScene('sources');
          go.disabled = true; go.textContent = '확인 중…'; if (err) err.textContent = '';
          const c = await checkAi();
          if (c && c.loggedIn === true) return pass(AI_LABEL[c.harness] || S.ai, c.harness);
          //  #2232 — 서버가 «모름»(null: 프로브를 못 돌림·자리에 CLI 없음)이면 사람을 가두지 않는다. 로그인했다는 말을 믿고 넘어간다 —
          //   분석은 서버가 실제 로그인된 하네스로 고르므로(resolveHeadlessHarness) 여기서 믿어도 거짓 실행은 안 난다.
          if (c && c.installed !== false && c.loggedIn === null) { toast('서버가 로그인을 직접 확인하진 못했지만, 말씀대로 진행할게요.'); return pass(AI_LABEL[c.harness] || S.ai, c.harness); }
          renderScene('claude', false);
          const e2 = $('#cErr', el);
          if (e2 && c && c.installed === true && c.loggedIn === false) {
            e2.textContent = '아직 로그인이 안 보여요. 로그인 창에서 끝까지 마치고 다시 눌러 주세요.';
          }
        };
        // 다른 AI 도 연결하기 — 고른 것을 바꿔 같은 장면을 다시 연다(판정은 새로 묻는다).
        $$('[data-more]', el).forEach((b) => b.onclick = () => { S.ai = b.dataset.more; AIC = null; save(); renderSB(); renderScene('claude', false); });
        // 다른 AI 가 이미 연결돼 있을 때의 문 — 고른 것을 못 연결했다고 사람을 가두지 않는다.
        //  (분석은 서버가 resolveHeadlessHarness 로 고른 **실제 로그인된** 하네스로 돈다.)
        const keep = $('#cKeep', el);
        if (keep) keep.onclick = () => { const o = (AIC && AIC.others || [])[0]; if (!S.aiConnected && o) mark(AI_LABEL[o] || o, o); goScene('sources'); };
        const other = $('[data-other]', el);
        if (other) other.onclick = () => { AIC = null; goScene('ai'); };
        // ⚠ 갈래마다 버튼 구성이 다르다 — «연결됐어요» 화면엔 [나중에]가 없다. 무조건 잡으면 bind 가 그 자리에서
        //  throw 하고, 그 뒤에 배선이 더 붙는 날 그것들이 통째로 조용히 안 걸린다(지금은 마지막 줄이라 안 드러났다).
        const skip = $('[data-skip]', el);
        if (skip) skip.onclick = () => goScene('sources');
      },
    },
    /* 노션 p4(데스크톱 앱 유도)와 같은 자리 — 우리는 터미널 질문 */
    terminal: {
      html: () => qHead('terminal',
        S.ai === '아직 없어요' ? `AI 구독이 아직 없으셔도 괜찮아요. 자료 쌓기·정리·검색은 지금부터 됩니다.` : (S.aiConnected ? '연결됐어요. 거의 끝났습니다.' : '거의 끝났습니다.'),
        '터미널에서 Claude Code나 Codex 등을 쓰시나요?',
        '쓰신다면 그 컴퓨터에 라이블리를 깔아 드릴게요. 앱을 받아서 여시면 앱이 알아서 합니다.')
        /* ⚠ 문구는 **설치만 하면 참인 것**으로 맞춘다. 종전 3줄 중 «웹에서 그 컴퓨터의 세션을 연다»·
         *  «오래 걸리는 일을 맡긴다» 는 설치가 아니라 노드 연결(`lively node --daemon`)이 있어야 참인데,
         *  설치만 안내하고 그 문장을 보여 주면 화면이 못 지킬 약속을 하는 것이 된다. 노드는 다음 장면에서
         *  «원하면 한 줄 더» 로 정직하게 연다. */
        + `<div class="ob-benefits">
            <p class="ob-benefit">내 컴퓨터에서 켜는 그 AI가 회사 자료·규칙을 그대로 압니다</p>
            <p class="ob-benefit">지금까지 쓰시던 작업 메모·직접 만든 기능을 그대로 가져올 수 있어요</p>
            <p class="ob-benefit">그 앱이 로컬 컴퓨터를 웹에서도 열 수 있도록 해 둡니다</p>
          </div>
          <button class="ob-btn ob-btn-pri" id="tYes">네, 씁니다. 깔아 둘게요</button>
          <button class="ob-btn ob-btn-sub" id="tNo">아니요</button>`,
      bind: (el) => {
        $('#tYes', el).onclick = () => { S.terminal = 'yes'; S.decisions.push('내 컴퓨터에 라이블리 설치, 터미널의 Claude Code에도 같은 자료'); save(); renderSB(); goScene('local'); };
        $('#tNo', el).onclick = () => { S.terminal = 'no'; save(); goScene('app'); };
      },
    },
    /* ══ #1879 — 내 컴퓨터에 잇기. «쓴다»고 답한 사람을 **실제로 설치까지** 데려간다. ══
     *  종전엔 [네, 씁니다] 를 눌러도 «홈에서 한 줄 설치를 안내할게요» 토스트 하나 띄우고 다음 장면이었다.
     *   그런데 **그 안내가 홈에 없다** — v2 셸에 로컬 설치 표면이 아예 없고(라우트는 #/ · #/inbox · #/welcome
     *   셋뿐), 설치 안내는 클래식 셸의 #/learn 설치 모달에만 있다. 약속만 하고 지키지 않는 자리였다.
     *
     *  ⚠ 이 사람들에게 특히 중요한 이유 — 앞 «AI 잇기»(claude 장면)가 재는 것은 **게이트웨이 서버**의
     *   자격이다(src/terminal/profiles.ts: 서버의 ~/.claude/.credentials.json · 맥 키체인). 평소 자기
     *   노트북에서 claude·codex 를 쓰던 사람은 **자기 자리에** 이미 로그인돼 있고, 그 사실을 이 서버는
     *   영영 못 본다. 그 사람에게 맞는 길은 «내 컴퓨터에 라이블리를 깔아, 이미 쓰던 그 AI 에 회사 맥락을
     *   넣는 것» 이다. 그래서 이 장면은 곁다리가 아니라 그 갈래의 본줄기다.
     *
     *  기준선은 리브 페르소나가 못박은 성립 조건이다 — "사람에게 시키는 것은 컴맹인 중학생도 따라올 수
     *   있어야 한다: 한 번에 한 걸음 · 어디를 누르는지 그대로 · 전문용어 금지 · 왜 하는지 먼저 ·
     *   값이 어떻게 생겼는지 · 되돌릴 수 있다고 말해 주기".
     *
     *  ★ **그래서 여기서 터미널 명령을 주된 길로 삼지 않는다 — 데스크톱 앱이 주된 길이다**(원준님 2026-08-27).
     *   이 자리를 다시 curl 안내로 되돌리려는 사람에게: 앱이 **이미 그 일을 전부** 한다.
     *     desktop/main/main.mjs:1089 `onboard()` — "주소 입력 한 번으로 **끝까지** 간다: (없으면) CLI
     *      부트스트랩 → `lively setup`"(= 로그인 + 키트 설치 + MCP 등록), 그리고 :1173 — 설치가 끝나면
     *      **노드까지 세운다**. 브라우저 승인·프롬프트는 GUI 가 받는다(ipc-contract.mjs IPC.RUN/ANSWER,
     *      cli-runner.mjs, e2e: desktop/main/onboard-e2e.test.mjs).
     *   즉 앞서 쓰던 3단계 curl 안내는 앱과 **같은 일을 사람 손으로 시키는 것**이었다. 터미널을 쓰는
     *   사람이라 해도 굳이 더 어려운 길로 보낼 이유가 없다 — 터미널 갈래는 아래 접힘에 남겨 둔다.
     *
     *  앱이 **하지 않는 것이 딱 하나** 있고, 그게 3단계다: 설치가 끝난 뒤 «온보딩 도와줘»(=`lively
     *   onboarding`, kit/cli/lively.mjs:2384 — claude 를 그 문구로 띄워 lively-onboarding 스킬 소환)를
     *   권하는 자리가 앱 완료 카드에 없다(실측: desktop/ 전체에 그 문자열 0건). 그래서 웹이 말한다.
     *
     *  화면에 적은 사실은 전부 코드·실측에서 확인한 것이다(지어내면 그 자리에서 사람이 막힌다):
     *   · 내려받기 자산 — GitHub 최신 릴리스 실측(v0.1.354, 2026-08-26): `Lively-<ver>-arm64.dmg` ·
     *     `Lively-Setup-<ver>.exe` · `.AppImage`. 고르는 코드는 이 파일 위쪽 desktopLink()/pickAsset().
     *   · 터미널 갈래 한 줄 — src/web.ts:339 `/cli`(sh) · `/cli.ps1`(ps1). 게이트웨이가 자기 주소를 굽는다.
     *   · sudo·비밀번호 없음 — kit/cli/bootstrap.sh 는 무sudo(~/.lively 안에서 끝난다).
     *   · 되돌리기 `lively uninstall` · 확인 `lively status` · 진단 `lively doctor` — lively.mjs HELP.
     */
    local: {
      html: () => {
        const os = desktopOs();                       // 'mac' | 'win' | 'linux' | null
        const win = os === 'win';
        const cmd = win ? `irm ${GW}/cli.ps1 | iex` : `curl -fsSL ${GW}/cli | sh`;   // 리눅스도 sh
        //  #2232 — [응용 프로그램]·[승인] 같은 대괄호 표기는 화면에서 못생겼다(원준님 2026-08-28) → 누를 것은 키캡(ob-kbd)으로,
        //   «앱 받기» 는 글 안에서도 **진짜 버튼**으로(눌러도 받아진다). 문장 사이 하이픈(—)도 걷었다.
        const getBtn = '<button type="button" class="ob-btn ob-btn-sub ob-btn-inline ob-btn-mini" data-get>앱 받기</button>';
        const step1 = win
          ? `아래 ${getBtn} 를 누르면 <b>Lively-Setup.exe</b> 가 내려받아져요. 내려받은 파일을 두 번 눌러 설치하세요.`
          : os === 'mac'
            ? `아래 ${getBtn} 를 누르면 <b>Lively.dmg</b> 가 내려받아져요. 내려받은 파일을 두 번 누르고, 나온 라이블리 아이콘을 ${kbd('응용 프로그램')} 폴더로 끌어다 놓으세요.`
            : `아래 ${getBtn} 를 누르면 받는 곳이 새 창으로 열려요. 거기서 내 컴퓨터에 맞는 파일을 골라 받으시면 됩니다.`;
        return qHead('local',
          '평소 쓰시던 그 터미널에 회사 맥락을 넣어 드릴게요.',
          '앱을 받으시면 앱이 알아서 깝니다.',
          '터미널에 뭘 치실 필요 없어요. 받아서 여시면 앱이 물어보는 대로 한 번만 눌러 주시면 됩니다.')
          + `<div class="ob-ins-list">
              <div class="ob-ins" data-n="1">
                <b class="ob-ins-t">앱을 받아서 엽니다</b>
                <p class="ob-ins-p">${step1}</p>
              </div>
              <div class="ob-ins" data-n="2">
                <b class="ob-ins-t">앱이 물어보는 대로 ${kbd('승인')} 한 번</b>
                <p class="ob-ins-p">앱을 열면 설치 도우미가 뜹니다. 브라우저에 <b>라이블리 승인</b> 창이 열리면 ${kbd('승인')}을 누르세요. 그게 전부예요.</p>
              </div>
              <div class="ob-ins" data-n="3">
                <b class="ob-ins-t">끝나면 이 한 마디만</b>
                <p class="ob-ins-p">평소처럼 클로드(코덱스)를 켜서 이렇게 말해 보세요.</p>
                ${cmdBox('온보딩 도와줘')}
                <p class="ob-ins-n">예전에 쓰시던 작업 메모·직접 만든 기능·연결해 둔 서비스를 찾아서 보여주고, 무엇을 회사와 나눌지 하나씩 같이 정합니다. <b>원본은 지우지도 고치지도 않아요.</b> 옮길 때도 복사만 합니다. <span class="ob-ins-n2">터미널에서 <code>lively onboarding</code> 이라고 쳐도 같은 게 열립니다.</span></p>
              </div>
            </div>
            <div class="ob-tok">
              <p class="ob-note" id="lcSt"></p>
            </div>
            <button class="ob-btn ob-btn-pri" id="lcGet">앱 받기</button>
            <button class="ob-btn ob-btn-sub" id="lcLater">나중에 할게요</button>
            <details class="ob-ins-alt">
              <summary>터미널이 더 편하신가요?</summary>
              <p class="ob-ins-n">앱 없이 터미널 한 줄로도 됩니다. 앱이 하는 일과 같은 것을 그대로 합니다(설치 · 로그인 · 회사 맥락 배선).</p>
              ${cmdBox(cmd)}
              <p class="ob-ins-n">확인 <code>lively status</code> · 진단 <code>lively doctor</code> · 되돌리기 <code>lively uninstall</code>. 이 컴퓨터를 웹에서도 열려면 <code>lively node --daemon</code>.${win ? ' 윈도우 터미널 설치는 아직 검증이 충분하지 않습니다. 막히면 앱 쪽을 쓰세요.' : ''}</p>
            </details>`;
      },
      bind: (el) => {
        wireCopy(el);
        const st = $('#lcSt', el);
        /* 설치를 **정말** 했는지는 서버 신호로 본다 — "lively status 쳐 보세요" 는 사람에게 판정을 떠넘기는
         *  것이고, 이 화면의 목표는 그 출력을 읽을 줄 몰라도 되게 하는 것이다.
         *  신호 = GET /api/ui/me/onboarding 의 connect 항목이 by:'auto' 로 done
         *   (src/org/delivery/onboarding.ts — `mcp_call_log WHERE actor=<나> AND ok`).
         *   그 행은 **설치·로그인·MCP 등록·AI 실행·라이블리 호출이 전부 성공해야** 남는다. 3단계
         *   «온보딩 도와줘» 가 딱 그 경로다.
         *  ⚠ 이미 웹 터미널을 쓴 사람은 이 신호가 **처음부터** 참이다. 그래서 장면에 들어올 때 기준값을
         *   먼저 재고 **거짓→참 전이**만 성공으로 읽는다. 기준값이 이미 참이면 자동확인을 끄고 그 사실을
         *   말한다 — 모르는 것을 안다고 하지 않는다(거짓 초록불을 켜면 사람은 안 깔고 넘어간다). */
        const say = (cls, text) => { if (!st.isConnected) return; st.className = 'ob-note' + (cls ? ' ' + cls : ''); st.textContent = text; };
        say('', '설치가 끝났는지 제가 지켜보고 있을게요. 3단계까지 마치시면 여기가 저절로 바뀝니다.');
        clearInterval(localTimer); localTimer = null;
        let ticks = 0;
        const poll = async () => {
          const now = await connectSignal();
          if (now === null) return;                          // 못 물었다 — 조용히 다음 차례에 다시
          if (localBase === null) { localBase = now; if (now) say('', '이 계정으로 AI가 라이블리를 쓴 기록이 이미 있어서, 설치가 끝났는지는 제가 자동으로 가려내지 못해요. 아래 [앱 받기]로 시작하시면 됩니다.'); return; }
          if (localBase === true) return;                    // 기준값이 참 — 전이를 볼 수 없다
          if (!now) return;
          clearInterval(localTimer); localTimer = null;
          S.local = 'done'; S.decisions.push('내 컴퓨터에 라이블리 설치'); save(); renderSB();
          say('ob-ok', '✓ 연결됐어요. 내 컴퓨터의 AI가 라이블리를 쓰는 걸 확인했어요.');
          toast('내 컴퓨터가 연결됐어요.');
        };
        void poll();
        localTimer = setInterval(() => {
          if (!st.isConnected || ++ticks > 240) { clearInterval(localTimer); localTimer = null; return; }  // 20분이면 멈춘다(무한 폴 금지)
          void poll();
        }, 5000);

        /* 내려받기 — 주소는 **미리** 물어 둔다(누른 순간 await 하면 사용자 제스처가 풀려 새 창이 막힌다).
         *  «앱 받기» 장면과 같은 코드를 쓴다: 같은 자산을 두 자리에서 다르게 고르면 한쪽이 조용히 틀린다. */
        let url = null;
        desktopLink().then((u) => { url = u; });
        const get = $('#lcGet', el);
        //  글 안의 «앱 받기» 도 같은 일을 한다(#2232). 받은 뒤 큰 버튼은 [계속]이 된다 — 곧장 넘기지 않는다.
        const doGet = () => {
          S.app = 'yes'; S.local = S.local || 'getting'; if (!S.decisions.includes('데스크톱 앱으로 내 컴퓨터에 설치')) S.decisions.push('데스크톱 앱으로 내 컴퓨터에 설치'); save(); renderSB();
          if (url) {
            const a = document.createElement('a'); a.href = url; a.rel = 'noopener';
            document.body.appendChild(a); a.click(); a.remove();
            toast('내려받기를 시작했어요. 설치는 지금 하셔도, 나중에 하셔도 됩니다.');
          } else {
            // 아직 답이 안 왔거나 못 가렸다 — 받는 곳을 그대로 연다. 없는 자리를 가리키지 않는다.
            window.open(DL_PAGE, '_blank', 'noopener');
            toast('받는 곳을 새 창으로 열었어요.');
          }
          get.textContent = '계속';
          get.onclick = () => goScene('read');   // 앱을 받았으면 «앱 받기» 장면은 건너뛴다 — 같은 걸 두 번 권하지 않는다
        };
        get.onclick = doGet;
        $$('[data-get]', el).forEach((b) => b.onclick = (e) => { e.preventDefault(); doGet(); });
        $('#lcLater', el).onclick = () => { S.local = 'later'; save(); toast('나중에 하셔도 돼요 — 여기 안내는 그대로 있습니다.'); goScene('app'); };
      },
    },
    /* 노션 p4 '앱 유도' 그대로의 자리 — 질문이 끝나고 채팅(컨설팅)에 들어가기 직전. [새문구] 전체 */
    app: {
      html: () => qHead('app',
        S.terminal === 'yes' ? '내 컴퓨터 설치는 언제든 다시 하실 수 있어요. 마지막으로 하나 권해 드릴게요.' : '마지막으로 하나 권해 드릴게요.',
        '라이블리 앱을 받아 두시면 더 편해요.',
        '웹으로도 전부 됩니다. 앱은 이런 게 더해져요.')
        + `<div class="ob-benefits">
            <p class="ob-benefit">더 빠르게 열리고, 로그인이 유지돼요</p>
            <p class="ob-benefit">리브가 확인이 필요할 때 알림으로 바로 알려 드려요</p>
            <p class="ob-benefit">내 컴퓨터 폴더와 로컬 깃 저장소를 앱이 직접 연결해 줘요</p>
          </div>
          <button class="ob-btn ob-btn-pri" id="appGet">앱 받기</button>
          <button class="ob-btn ob-btn-sub" id="appSkip">지금은 웹으로 할게요</button>`,
      bind: (el) => {
        // 주소는 **미리** 물어 둔다 — 누른 순간에 await 하면 사용자 제스처가 풀려 새 창이 막힌다.
        let url = null;
        desktopLink().then((u) => { url = u; });
        const get = $('#appGet', el), sk = $('#appSkip', el);
        get.onclick = () => { S.app = 'yes'; if (!S.decisions.includes('데스크톱 앱 받기')) S.decisions.push('데스크톱 앱 받기'); save(); renderSB();
          if (url) {
            // 같은 창에서 받는다(GitHub 가 attachment 로 내려 주므로 이 화면은 그대로 남는다).
            const a = document.createElement('a'); a.href = url; a.rel = 'noopener';
            document.body.appendChild(a); a.click(); a.remove();
            toast('내려받기를 시작했어요. 설치는 나중에 하셔도 됩니다.');
          } else {
            // 아직 답이 안 왔거나 못 가렸다 — 받는 곳을 그대로 열어 준다. 없는 자리를 가리키지 않는다.
            window.open(DL_PAGE, '_blank', 'noopener');
            toast('받는 곳을 새 창으로 열었어요.');
          }
          //  #2232 — 받기를 눌렀다고 곧장 다음으로 넘기지 않는다(원준님 2026-08-28). 받았으면 [계속]을 눌러 넘어간다.
          get.textContent = '계속'; get.onclick = () => goScene('read');
          if (sk) sk.hidden = true;
        };
        sk.onclick = () => { S.app = 'web'; save(); goScene('read'); };
      },
    },
  };

  /* ══════════════ 막3 — 컨설팅 채팅 (노션 p5·p6 구조) ══════════════ */
  let seqToken = 0;
  function msgLiv(html) { const el = document.createElement('div'); el.className = 'ob-msg'; el.innerHTML = `<span class="ob-ava">L</span><div class="ob-body">${html}</div>`; $('#thread').appendChild(el); keepChipsLast(); scrollChat(); return el; }
  function msgUser(text) { const el = document.createElement('div'); el.className = 'ob-msg ob-user'; el.innerHTML = `<div class="ob-body">${esc(text)}</div>`; $('#thread').appendChild(el); keepChipsLast(); scrollChat(); return el; }
  function chipsRow(items) {
    const el = document.createElement('div'); el.className = 'ob-chips';
    const list = items.map(({ label, cta, ghost, cb }) => {
      const b = document.createElement('button'); b.className = 'ob-chip' + (cta ? ' ob-cta' : '') + (ghost ? ' ob-ghost' : ''); b.textContent = label;
      b.onclick = () => { pendingChips = null; el.remove(); renderSB(); cb && cb(label); };
      el.appendChild(b); return { label, cta, ghost, fire: b.onclick };
    });
    pendingChips = { el, list };
    $('#composeIn').placeholder = '또는 여기에 적어 주세요';
    $('#thread').appendChild(el); renderSB(); scrollChat(); return el;
  }
  /* 새 말풍선이 붙으면 답 칩을 다시 맨 아래로 — 예시 카드를 누르고 나면 칩이 위로 밀려 '다음으로 가는 길'이 안 보였다(원준님 2026-08-25). */
  function keepChipsLast() { if (pendingChips && pendingChips.el.isConnected) { $('#thread').appendChild(pendingChips.el); } }
  /* 입력창에 친 글을 답으로 해석 — "응·네·어" 는 긍정 칩, "아니" 는 부정 칩, "다음·넘어가·계속·끝" 은 진행 칩, 그 밖엔 보기 낱말 맞춤 */
  function matchChip(v) {
    if (!pendingChips) return null;
    const L = pendingChips.list; const t = v.replace(/\s+/g, '').toLowerCase();
    const yes = /^(응|웅|네|넵|예|어|ㅇㅇ|ㅇㅋ|오케이|ok|yes|좋아요?|맞아요?|그래요?|이대로|해주세요|해줘)/.test(t);
    const no = /^(아니|아뇨|노|no|없어요?|안)/.test(t);
    const go = /(다음|넘어가|넘어갈|계속|끝|정리|준비|됐어|됐음|시작)/.test(t);
    if (no) return L.find((c) => /아니|없어/.test(c.label)) || null;
    if (yes) return L.find((c) => c.cta) || L.find((c) => /^네|맞아|이대로|응/.test(c.label)) || L[0];
    if (go) return L.find((c) => c.cta) || L.find((c) => !c.ghost) || null;
    const norm = (x) => x.replace(/[\s,.·]+/g, '').toLowerCase();
    // 라벨 낱말 맞춤 — 회색 칩(건너뛰기·직접 적기)도 글로 부를 수 있어야 한다
    const exact = L.find((c) => norm(c.label) === t || norm(c.label).includes(t));
    if (exact) return exact;
    const hit = L.filter((c) => !c.ghost).find((c) => t.includes(norm(c.label).slice(0, 4)));
    return hit || null;
  }
  function fineRow(text) { const el = document.createElement('div'); el.className = 'ob-fine'; el.textContent = text; $('#thread').appendChild(el); scrollChat(); return el; }
  function scrollChat() { const c = $('.ob-chat'); c.scrollTop = c.scrollHeight; }

  /* 아래 입력창 — 지금 받는 자유 입력이 있으면 그리로, 없으면 부드럽게 안내 */
  let freeHandler = null;
  function armCompose(placeholder, fn) { freeHandler = fn; $('#composeIn').placeholder = placeholder || '직접 적으셔도 됩니다'; $('#composeIn').focus(); }
  function composeSend() {
    const inp = $('#composeIn'); const v = inp.value.trim(); if (!v) return;
    inp.value = '';
    msgUser(v);
    if (freeHandler) { const fn = freeHandler; freeHandler = null; fn(v); return; }
    const hit = matchChip(v);
    if (hit) { hit.fire(); return; }
    S.notes.push(v); save();
    if (pendingChips) msgLiv(`적어 두었어요. 지금 질문은 위 보기에서 골라 주시면 돼요. 적어 주신 건 기억해 뒀다가 설정에 반영합니다.`); /* [새문구] */
    else msgLiv(`적어 두었어요.`);
  }

  // #1881 L4 — 표본 승인 = '내 컴퓨터 자료' 증류기 켜기. 올린 파일이 있을 때만(없으면 켤 것도 없다).
  //  서버는 멱등(이미 켜져 있으면 no-op)이고, 실패해도 온보딩을 막지 않는다 — 관리 화면에서 언제든 켤 수 있다.
  function enableLocalDistiller() {
    if (!S.upN) return;
    // 생 fetch 금지 — 데스크톱 앱·토큰 주입 환경은 쿠키가 아니라 localStorage 토큰으로 인증한다(api 가 헤더를 붙인다).
    Promise.resolve(api('/api/ui/org/distillers/local', { method: 'POST', body: JSON.stringify({ enable: true }) }))
      .catch(() => { /* 비치명 — 크론·관리 화면이 남은 길 */ });
  }

  /* 읽기 진행 — 사이드바 서랍 숫자가 실시간으로 올라간다 */
  let readTimer = null, readBarEl = null, readNEl = null;
  /**
   * 읽기 진행 — **서버에 물어서** 움직인다(#1813). 종전엔 240ms 타이머가 41까지 세는 연출이었다.
   *  지금은 올린 자료를 서버가 몇 건 받았는지 폴링하고, 다 받았으면 끝난 것으로 본다.
   *  올린 게 하나도 없으면 읽을 것도 없다 — 기다리게 하지 않고 곧바로 끝낸다.
   */
  function startReading() {
    if (S.read.finished) return;
    clearInterval(readTimer);
    const target = () => Math.max(S.upN || 0, S.read.total || 0);
    const paint = () => {
      const tot = Math.max(1, target());
      const p = Math.min(1, S.read.done / tot);
      if (readBarEl) readBarEl.style.width = Math.round(p * 100) + '%';
      if (readNEl) readNEl.textContent = `${S.read.done} / ${target()}`;
    };
    const finish = () => {
      S.read.finished = true; S.read.done = target(); save();
      clearInterval(readTimer); readTimer = null; paint(); renderSB();
      document.dispatchEvent(new Event('read-done'));
    };
    if (!target()) { finish(); return; }                 // 올린 자료 0건 — 기다릴 것이 없다
    readTimer = setInterval(async () => {
      const w = await loadWelcome();
      const got = (w && w.uploads && w.uploads.total) || 0;
      S.read.done = Math.min(target(), got);
      S.read.total = target();
      // 서버가 센 종류별 수를 사이드바에 그대로 싣는다(만들어 낸 목표치가 아니다).
      S._counts = {}; realKinds().forEach((k) => { S._counts[k.name] = k.n || ''; });
      const sub = $('#sb .v2-ss .sub'); if (sub && /^자료 읽는 중/.test(sub.textContent)) sub.textContent = `자료 읽는 중 ${S.read.done}/${S.read.total}`;
      paint(); save();
      if (S.read.done >= target()) finish();
    }, 1500);
  }

  /**
   * 올린 자료를 **실제로 AI 에게 보여** 갈래를 받아 온다(#1813).
   *  이 제품의 LLM 은 그 사람 본인 AI 구독으로 헤드리스 세션이 도는 것이 유일한 길이라,
   *  AI 를 아직 안 이었으면 여기서 실패한다 — **감추지 않고 이유를 돌려준다**(화면은 실제 집계로 내려앉는다).
   *  기다림에 상한을 둔다: 온보딩 한복판에서 사람을 무한정 세워 둘 수는 없다.
   */
  const ANALYZE_TIMEOUT_MS = 75000;
  async function analyzeUploads(token) {
    // AI 가 안 이어졌으면 **묻지도 않는다.** 서버도 402 로 막지만, 여기서 먼저 접으면 헛왕복이 없고
    //  사람이 기다리는 시간도 없다. 판정은 서버가 준 값이다(ai_ready — 실제로 리스가 붙는지로 잰 것).
    if (WS && WS.ai_ready === false) {
      return { drawers: null, why: 'AI 를 아직 연결하지 않으셔서, 파일 종류로 나눈 결과예요.' };
    }
    let started;
    try {
      started = await api('/api/ui/me/welcome/analyze', { method: 'POST', body: JSON.stringify({ job: S.job || null }) });
    } catch (e) {
      const m = e && e.message ? String(e.message) : '';
      return { drawers: null, why: /402|50[0-9]|잇지 않으|연결하지 않으|시작하지 못/.test(m) ? 'AI 를 아직 연결하지 않으셔서, 파일 종류로 나눈 결과예요.' : '' };
    }
    const id = started && started.turn_id;
    if (!id) return { drawers: null, why: '' };
    const until = Date.now() + ANALYZE_TIMEOUT_MS;
    let from = 0;
    while (Date.now() < until) {
      if (token !== seqToken) return { drawers: null, why: '' };
      await sleep(2000);
      let r;
      try { r = await api(`/api/ui/me/welcome/analyze/${encodeURIComponent(id)}?from=${from}`); } catch (_) { continue; }
      if (typeof r.next === 'number') from = r.next;
      if (!r.done) continue;
      if (r.drawers && r.drawers.length) return { drawers: r.drawers, why: '' };
      return { drawers: null, why: 'AI 판정을 읽지 못해서, 파일 종류로 나눈 결과예요.' };
    }
    return { drawers: null, why: 'AI 가 아직 답하지 않아서, 파일 종류로 나눈 결과를 먼저 보여 드려요.' };
  }

  /* 하는 일(무대·직무)을 **고른 즉시** 남긴다 (#1813).
   *  이 값은 매 세션 개인 층으로 주입된다(publish.ts renderLivOnboarding → 「### 온보딩에서 알려주신 것」).
   *  ⚠ 종전엔 마무리(POST /api/ui/me/welcome)에서만 저장돼서, 중간에 나간 사람은 답을 해 놓고도
   *   AI 가 그걸 모른 채 일했다 — 이름과 같은 구조의 결함이었다(원준님 실측 2026-08-26).
   *  실패해도 진행은 막지 않는다(마무리에서 한 번 더 보낸다). */
  const STAGE_TEXT = { company: '회사·조직에서 팀과 함께 일한다', solo: '1인·프리랜서로 여러 일을 한다',
    academy: '학교·연구실에서 연구한다', student: '학생으로 수업·시험·진로를 준비한다' };
  function saveWork() {
    const asis = [S.stage ? STAGE_TEXT[S.stage] : null, S.job].filter(Boolean).join(' · ');
    if (!asis) return;
    void api('/api/ui/me/liv-profile', { method: 'POST', body: JSON.stringify({ work: { asis, by: 'self' } }) })
      .catch(() => { /* 비치명 */ });
  }

  /* 고른 AI → **하네스 키**(서버 catalog/HEADLESS 표의 key). 헤드리스 규약을 아는 넷만 여기 있다 —
   *  ChatGPT 는 코덱스, 제미나이는 안티그래비티가 그 자리다. 표에 없으면(‘여러 개’ 등) claude 로 안내한다.
   *  ⚠ 여기 담는 건 **키뿐**이다(#1879). 실행 파일 이름(agy 등)·로그인 절차는 서버가 준다 —
   *   화면에 박아 두면 하네스 표가 바뀔 때 이 줄만 조용히 틀려지고, 그 틀린 한 줄을 사람이
   *   가입 직후 첫 화면에서 그대로 터미널에 친다. */
  const AI_HARNESS = { 'Claude': 'claude', 'ChatGPT': 'codex', 'Gemini': 'antigravity', 'Grok': 'grok' };
  const AI_LABEL = { claude: 'Claude', codex: 'ChatGPT', antigravity: 'Gemini', grok: 'Grok' };
  const AI_BIN_FALLBACK = { claude: 'claude', codex: 'codex', antigravity: 'agy', grok: 'grok' };
  /* 라틴 표기 이름의 **조사**. 끝소리로 갈린다 — Grok 만 받침이 있다(록). '이(가)' 같은 회피 표기는
   *  가입 직후 첫 화면에서 눈에 띄게 어색하다. [주격, 목적격, 주제격] 순. 표에 없으면 회피형으로 내려앉는다. */
  const AI_JOSA = { Claude: ['가', '를', '는'], ChatGPT: ['가', '를', '는'], Gemini: ['가', '를', '는'], Grok: ['이', '을', '은'] };
  const josa = (word, i) => (AI_JOSA[word] || ['이(가)', '을(를)', '은(는)'])[i];
  const aiHarness = () => AI_HARNESS[S.ai] || 'claude';
  /** 고른 AI 하나에 대한 마지막 판정(POST /api/ui/me/ai-accounts/check).
   *  null = 아직 안 물어봤다 — 화면은 «확인 중» 으로 살고, 없는 답을 지어내지 않는다. */
  let AIC = null;
  async function checkAi() {
    try {
      AIC = await api('/api/ui/me/ai-accounts/check', { method: 'POST', body: JSON.stringify({ harness: aiHarness() }) });
    } catch (e) {
      AIC = { error: (e && e.message) ? String(e.message) : '알 수 없는 오류' };
    }
    return AIC;
  }

  /** 지금 연결돼 있다고 아는 하네스 키들 — 서버 판정(고른 것 + others) ∪ 이 온보딩에서 확인한 것(S.aiDone). */
  const aiOnKeys = (c) => {
    const s = new Set(Array.isArray(S.aiDone) ? S.aiDone : []);
    if (c) { (c.others || []).forEach((k) => s.add(k)); if (c.loggedIn === true && c.harness) s.add(c.harness); }
    return [...s];
  };
  /** 이 하네스가 연결됐나 — 고른 것은 서버가 답했으면 그 답이 먼저(true/false), 모르면(null) 이 온보딩의 기록을 본다. */
  const aiOn = (k) => {
    if (!k) return false;
    if (AIC && AIC.harness === k && typeof AIC.loggedIn === 'boolean') return AIC.loggedIn;
    return aiOnKeys(AIC).includes(k);
  };
  /* 로그인 창에서 벌어지는 일 — 하네스별(#2232). 창은 LOGIN_SESSION 규약으로 연다(me-ai.ts [내 계정 로그인]과 같다):
   *  claude·antigravity 는 그 TUI 자체가 로그인을 안내하고, codex 는 서버가 `codex login`(device-auth)을 셸에서 돌려 주며
   *  (catalog.harnessLoginArgv), grok 은 셸을 열어 사람이 한 줄을 붙여넣는다. 붙여넣을 글자는 code[data-copy] 로 — 누르면 복사.
   *  ⚠ 여기 적은 화면 문구(«Login successful» 등)는 그 회사가 바꿀 수 있다 — 그래서 «같은 말» 로 느슨하게 적었다. */
  const DEVICE_NOTE = '왜 주소와 코드냐면: 그 창은 우리 서버에서 돌아서 로그인 페이지를 스스로 못 열어요. 그래서 주소는 사람이 열고, 코드를 넣어 «이 창이 내 것» 이라고 알려 주는 방식이에요.';
  //  #2232 원준님 실측 — 창은 검지 않을 수도 있고(밝은 테마), 사람은 CLI 조작법(↑↓·Enter)을 모를 수 있다. «터미널 창» 으로 부르고 조작법을 한 줄 준다.
  const CLI_NOTE = '터미널 창 조작: 글자만 있는 창이에요. 고르는 화면에선 <b>↑ ↓</b> 로 옮기고 <b>Enter</b> 로 확정, 붙여넣기는 <b>⌘V</b>(윈도우 Ctrl+V), 창 안 글자는 마우스로 끌어 복사할 수 있어요.';
  //  claude 는 codex 와 달리 **코드를 되받는다** — 왜 입력칸이 있는지 한 줄로 말해 준다.
  const PASTE_NOTE = '왜 코드를 다시 넣냐면: 로그인은 브라우저에서 끝나고, 그 결과를 우리 서버에서 도는 Claude 에게 전해 줘야 하기 때문이에요. 브라우저가 준 코드가 그 전달표입니다.';
  const cp = (t) => `<code class="ob-copy" data-copy="${esc(t)}" title="누르면 복사돼요">${esc(t)}</code>`;
  //  버튼은 이 글 **위**에 있다(qHead 다음 줄) — «아래» 라고 쓰면 사람이 아래를 뒤진다(원준님 실측 2026-08-28).
  const AI_GUIDE = {
    //  claude 도 이 자리에서 끝낸다(2026-08-28 상민님 지시). 종전 판(#2232 원준님)은 터미널 창에서 Claude Code 를
    //   켜 일곱 걸음을 밟는 안내였는데, 이제 서버가 `claude auth login` 을 대신 돌린다 — 창이 안 뜨므로 그 걸음들
    //   중 «창 조작» 부분은 사라진다. 다만 **브라우저 쪽 걸음은 그대로 남아** 그 실측(Authorize · «Paste this code
    //   back into Claude Code»)을 여기로 옮겨 적는다. 지우면 사람이 브라우저에서 무엇을 볼지 모른다.
    //  ⚠ 한 가지는 옮겨지지 않는다: claude 는 로그인과 별개로 **첫 실행 설정**(글자 스타일·보안 안내·폴더 신뢰)을
    //   그 TUI 에서 묻는다(바이너리에 hasCompletedOnboarding·hasTrustDialogAccepted·theme 문자열이 있다 — 실측
    //   2026-08-28, lvly-tenant:c83). 로그인만 이 자리로 빼면 그 물음은 **없어지는 게 아니라 첫 세션으로 미뤄진다.**
    //   숨기지 않고 마지막 줄에 적는다.
    claude: { steps: [
      `위의 ${kbd('Claude 로그인 시작')}을 누르면 이 자리에 <b>주소</b>가 나와요.`,
      `그 주소를 눌러 열고, <b>Claude(Anthropic) 계정</b>으로 로그인한 뒤 <b>Authorize</b>(허용)를 누르세요. 구독 계정(Pro·Max·Team)이면 그대로, 회사 API 콘솔 계정이면 그 계정으로 로그인하시면 됩니다.`,
      `브라우저에 <b>코드</b>가 나와요(«Paste this code back into Claude Code»). 그 코드를 복사해 <b>이 자리 입력칸</b>에 붙여넣고 ${kbd('넣기')}를 누르세요.`,
      `이 자리에 «로그인이 끝났어요» 가 뜨면 아래 ${kbd('로그인했어요')}를 누르세요.`,
      `<b>첫 세션에서 물음이 몇 개 더 나와요</b> — 글자 스타일, 보안 안내, 그리고 «이 폴더를 믿나요»(<b>Do you trust the files in this folder?</b>). Claude Code 가 로그인과 별개로 처음 한 번 묻는 것이라 여기서 미리 대신 답해 두지 않았습니다. 라이블리가 만든 작업 폴더이니 «Yes, proceed» 로 넘기시면 됩니다.`,
    ], note: PASTE_NOTE },
    codex: { steps: [
      `위의 ${kbd('ChatGPT 로그인 시작')}을 누르면 이 자리에 <b>주소</b>와 <b>짧은 코드</b>가 나와요.`,
      `주소를 눌러 열고, 그 코드를 입력하세요(코드는 눌러서 복사돼요).`,
      `ChatGPT 계정으로 로그인하고 허용을 누르세요.`,
      //  #2232 원준님 실측 — 계정에 «장치 코드 인증»이 꺼져 있으면 ChatGPT 화면이 빨간 글로 막는다. 켜고 다시 시작해야 한다.
      //  ⚠ 종전 안내는 «터미널 창에 codex login --device-auth 를 붙여넣어 다시» 였는데, 이제 창이 안 뜬다 —
      //   같은 뜻을 이 화면의 동작(다시 시도)으로 옮겨 적는다. 안 옮기면 없는 창을 찾게 된다.
      `ChatGPT 화면에 빨간 글로 «ChatGPT 보안 설정 내 <b>Codex용 장치 코드 인증</b>을 활성화한 뒤 다시 실행하세요» 가 나오면: 그 글의 <b>ChatGPT 보안 설정</b> 링크를 눌러(또는 chatgpt.com ▸ 프로필 ▸ ${kbd('설정')} ▸ ${kbd('보안')}) <b>Codex용 장치 코드 인증</b>을 켜세요. 그런 다음 이 자리에서 ${kbd('ChatGPT 로그인 시작')}을 다시 누르면 주소와 코드가 새로 나와요.`,
      `이 자리에 «로그인이 끝났어요» 가 뜨면 아래 ${kbd('로그인했어요')}를 누르세요.`,
    ], note: DEVICE_NOTE },
    antigravity: { steps: [
      `위의 ${kbd('Gemini 로그인 창 열기')}를 누르면 새 탭에 <b>Antigravity</b>(Gemini 를 쓰는 CLI)가 켜진 터미널 창이 열려요.`,
      `처음 켜면 <b>Select login method:</b> 라고 물어요. <b>1. Google OAuth</b> 앞에 «&gt;» 가 있는지 보고(기본으로 그 자리예요) <b>Enter</b> 를 누르세요. 다른 줄에 가 있으면 ↑ ↓ 로 1번에 맞춘 뒤 Enter.`,
      `그러면 <b>→ Click here to authenticate</b> 가 나와요. 그 글자를 누르면(누르면 열려요) 브라우저에 Google 로그인 화면이 뜹니다 — 거기서 Google 계정으로 로그인하고 허용을 누르세요. 안 눌리면 그 줄의 주소를 복사해 브라우저에 붙여 여세요.`,
      `로그인이 끝나고 창에 <b>코드</b>를 넣으라고 하면, 브라우저에 나온 코드를 복사해 터미널 창에 붙여넣고 Enter. (코드를 안 물으면 그냥 넘어가요.)`,
      `이어서 <b>Choose your color scheme:</b>(색 테마 고르기)가 나와요. ↑ ↓ 로 아무거나(예: terminal) 고르고 Enter, <b>[Next]</b> 가 있으면 Enter 로 넘기세요.`,
      //  #2232 원준님 실측 — 테마 뒤에 두 화면이 더 있다: 사용 정보 수집 동의, 폴더 신뢰. 여기까지 지나야 입력칸이 나온다.
      `다음은 <b>Yes, I agree to help improve Antigravity CLI…</b>(사용 정보를 Google 에 보내는 데 동의) 화면이에요. 동의는 선택이에요 — 끄고 싶으면 그 줄에서 Enter 를 눌러 체크를 빼세요. 그다음 ↓ 로 <b>[Done]</b> 에 옮기고 Enter.`,
      `마지막으로 <b>Do you trust the contents of this project?</b>(이 폴더의 내용을 믿나요) 가 나와요. <b>Yes, I trust this folder</b> 앞에 «&gt;» 가 있는 채로 Enter — 라이블리가 만든 작업 폴더라 괜찮습니다.`,
      `창에 글을 치는 입력칸(<b>&gt;</b> 표시, 오른쪽 아래에 <b>Gemini …</b> 모델 이름)이 뜨면 이 화면으로 돌아와 아래 ${kbd('로그인했어요')}를 누르세요.`,
    ], note: CLI_NOTE },
    grok: { steps: [
      `위의 ${kbd('Grok 로그인 창 열기')}를 누르면 새 탭에 터미널 창이 열려요.`,
      `그 창을 한 번 누른 뒤 ${cp('grok login --device-auth')} 를 붙여넣고 Enter 를 누르세요.`,
      `창에 <b>주소 하나</b>와 <b>짧은 코드</b>가 나와요. 주소를 열고 그 코드를 입력한 뒤 X(xAI) 계정으로 로그인하세요.`,
      `창에 로그인이 끝났다고 나오면 이 화면으로 돌아와 아래 ${kbd('로그인했어요')}를 누르세요.`,
    ], note: DEVICE_NOTE + ' ' + CLI_NOTE },
  };
  const LOGIN_SESSION = { claude: { harness: 'claude' }, codex: { harness: 'shell', loginFor: 'codex' }, antigravity: { harness: 'antigravity' }, grok: { harness: 'shell', loginFor: 'grok' } };
  /* 화면에서 바로 로그인이 되는 하네스(#2055 후속, 2026-08-28) — 서버가 로그인 명령을 대신 돌리고 주소·코드만 준다.
     · codex  `codex login --device-auth` → 주소 + 일회용 코드. 되돌려 줄 입력이 없다.
     · claude `claude auth login`        → 주소를 주고 **코드를 되받는다**(브라우저의 «Paste this code back…»).
     그 밖(agy·grok)은 비대화형 한 줄이 아예 없어(catalog.harnessLoginArgv 머리말) 종전 «로그인 창» 그대로다.
     ⚠ claude 는 로그인과 별개로 **첫 실행 설정**(글자 스타일·보안 안내·폴더 신뢰)을 TUI 에서 묻는다. 로그인만
     이 자리로 빼면 그 물음은 없어지는 게 아니라 **첫 세션으로 미뤄진다** — 그래서 안내 마지막 줄에 그대로 적는다.
     대신 답해 두지 않는 이유는 «이 폴더를 믿나요» 가 사람이 할 보안 판단이라서다(미리 눌러 주면 그 판단을 뺏는다).
     판정·파싱의 정본은 서버 ai-login-flow.ts 다 — 여기서 형식을 다시 짐작하지 않는다. */
  const LOGIN_INLINE = { codex: true, claude: true };

  /* 터미널 없이 로그인 — 서버가 명령을 멤버 자리에서 돌리고, 여기서는 주소·코드만 보여 준다(#2055 후속).
     ⚠ «막다른 카드» 를 만들지 않는다: 시작조차 못 하면 종전 «로그인 창» 경로로 정직하게 내려간다.
     ⚠ 완료 판정은 서버의 **자격 확인**이 한다(프로세스가 끝난 것과 로그인 성공은 다르다). */
  let inlineStop = false;
  async function startInlineLogin(el, h, label) {
    const card = $('#cCard', el); if (!card) return;
    inlineStop = false;
    card.hidden = false;
    const say = (...nodes) => { card.replaceChildren(...nodes); };
    const line = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; };
    const copyRow = (k, v, href) => {
      const row = document.createElement('div'); row.className = 'ob-login-row';
      const key = document.createElement('span'); key.className = 'ob-login-k'; key.textContent = k;
      const val = document.createElement('code'); val.className = 'ob-login-v'; val.textContent = v; val.title = '눌러서 복사';
      val.onclick = async () => { try { await navigator.clipboard.writeText(v); toast('복사했어요'); } catch (_) { toast(v); } };
      row.append(key, val);
      if (href) { const a = document.createElement('a'); a.className = 'ob-btn ob-btn-sub ob-btn-inline'; a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = '열기'; row.append(a); }
      return row;
    };
    //  ⚠ 창을 **자동으로** 열지 않는다. `await` 뒤의 window.open 은 사람이 누른 순간과 끊겨 있어 브라우저가
    //   조용히 막는다(팝업 차단 — 오류도 안 난다). 그러면 화면엔 작은 글 한 줄뿐이라 «눌러도 반응이 없다» 가 된다.
    //   그래서 탈출로는 **사람이 누르는 버튼**으로 준다 — 그 클릭이 곧 창을 열 자격이다.
    const escape = (why) => {
      const b = document.createElement('button');
      b.className = 'ob-btn ob-btn-sub ob-btn-inline'; b.textContent = `${label} 로그인 창 열기 ↗`;
      b.onclick = () => { void openLoginWindow(h, label); };
      say(line('ob-note', why), b);
    };
    say(line('ob-fine2', '로그인 절차를 시작하는 중이에요…'));
    try { await api('/api/ui/me/ai-login/start', { method: 'POST', body: JSON.stringify({ harness: h }) }); }
    catch (e) {
      // 여기서 못 하면 사람을 세우지 않는다 — 종전 경로로 내려간다(원준님이 지적한 «막다른 안내» 금지).
      escape(`여기서 바로 로그인할 수 없어요 — ${(e && e.message) || e}`);
      return;
    }
    let pasted = false;
    //  주소가 안 오는 채로 버티지 않는다 — codex 는 실측 1초 안에 찍는다. 상한을 넘기면 탈출로를 준다.
    const STALL_MS = 30000;
    const startedAt = Date.now();
    const tick = async () => {
      if (inlineStop || !document.body.contains(card)) return;
      let st = null;
      try { st = await api(`/api/ui/me/ai-login/state?harness=${encodeURIComponent(h)}`); } catch (_) { /* 다음 틱에 */ }
      if (!(st && st.url) && !(st && st.loggedIn === true) && !(st && st.step === 'failed') && Date.now() - startedAt > STALL_MS) {
        inlineStop = true;
        escape('로그인 주소가 오지 않았어요. 창으로 열어 주세요.');
        return;
      }
      if (st && st.loggedIn === true) {
        inlineStop = true;
        say(line('ob-ok', `${label} 로그인이 끝났어요 — 아래 [로그인했어요]를 누르시면 됩니다.`));
        try { await api('/api/ui/me/ai-login/cancel', { method: 'POST', body: JSON.stringify({ harness: h }) }); } catch (_) { /* noop */ }
        const go = $('#cGo', el); if (go) go.focus();
        return;
      }
      if (st && st.step === 'failed') {
        const again = document.createElement('button'); again.className = 'ob-btn ob-btn-sub ob-btn-inline'; again.textContent = '다시 시도';
        again.onclick = () => { void startInlineLogin(el, h, label); };
        say(line('ob-note', String((st && st.error) || '로그인이 실패했어요.')), again);
        return;
      }
      if (st && st.url) {
        const rows = [copyRow('주소', st.url, st.url)];
        if (st.code) rows.push(copyRow('일회용 코드', st.code));
        rows.push(line('ob-fine2', st.code
          ? '주소를 열고 위 코드를 넣어 주세요. 끝나면 이 자리에 «끝났어요» 가 뜹니다.'
          : '주소를 열고 로그인해 주세요. 끝나면 이 자리에 «끝났어요» 가 뜹니다.'));
        if (st.needsPaste && !pasted) {
          const row = document.createElement('div'); row.className = 'ob-login-row';
          const inp = document.createElement('input'); inp.className = 'ob-input'; inp.type = 'text'; inp.placeholder = '브라우저에서 받은 코드';
          const ok = document.createElement('button'); ok.className = 'ob-btn ob-btn-sub ob-btn-inline'; ok.textContent = '넣기';
          ok.onclick = async () => {
            const v = inp.value.trim(); if (!v) return; ok.disabled = true;
            try { await api('/api/ui/me/ai-login/paste', { method: 'POST', body: JSON.stringify({ harness: h, code: v }) }); pasted = true; toast('코드를 넣었어요'); }
            catch (e) { toast(`코드를 넣지 못했어요 — ${(e && e.message) || e}`); ok.disabled = false; }
          };
          row.append(inp, ok); rows.push(row);
        }
        say(...rows);
      }
      setTimeout(tick, 2000);
    };
    void tick();
  }
  /* 종전 «로그인 창»(새 탭) — 인라인 대상이 아닌 하네스와, 인라인이 시작조차 못 했을 때의 탈출로. */
  async function openLoginWindow(h, label) {
    const out: any = await api('/api/ui/terminal/sessions', { method: 'POST', body: JSON.stringify({
      label: `내 계정 로그인 (${label})`, rootKey: 'personal', subpath: '', flags: {}, autoApprove: false, loginProfile: true,
      ...(LOGIN_SESSION[h] || { harness: h }) }) });
    const id = out && out.session && out.session.id;
    if (!id) throw new Error('세션을 받지 못했어요');
    window.open(sessionTermUrl(id, { label: (out.session && out.session.label) || label }), '_blank');
    toast('새 탭에 로그인 창을 열었어요. 거기서 로그인을 마치고 돌아오세요.');
  }

  const CHAT_STEPS = ['b1', 'b2', 'b3', 'nowline', 'can'];
  async function chatStep(step, token) {
    if (token !== seqToken) return;
    const doneStep = (s) => { if (!S.chatDone.includes(s)) S.chatDone.push(s); save(); renderSB(); };
    if (step === 'b1') {
      await sleep(400);
      await loadWelcome();
      const total = realTotal();
      if (!total) {
        // 올린 자료가 없으면 셀 것도 없다. 없는 숫자를 지어내지 않는다.
        msgLiv(`올려 주신 자료가 아직 없어서 자료함은 나중에 나누겠습니다. 홈에서 파일을 올리시면 그때 제가 갈래를 잡아 드릴게요.`);
        await sleep(200); doneStep('b1'); chatStep('b2', token); return;
      }
      // ① 먼저 **실제로 센 것**을 보여 준다. AI 가 없어도 이 숫자는 진짜다.
      const bubble = msgLiv(`${esc(nick() || '')}${nick() ? '님이 ' : ''}올려 주신 자료 <b>${total}건</b>을 종류별로 세어 봤어요.
        <div class="ob-tags" data-tags>${realKinds().map((k) => `<span class="ob-tag">${esc(k.name)} <b>${k.n}</b></span>`).join('')}</div>
        <p style="margin-top:8px" data-note>AI 가 파일을 훑어보고 더 나은 갈래를 제안하는 중이에요.</p>`);
      // ② 그 위에 **진짜 LLM 판정**을 얹는다. 실패하면 ①이 그대로 답이 된다(감추지 않고 이유를 적는다).
      let drawers = realKinds().map((k) => ({ name: k.name, n: k.n }));
      const llm = await analyzeUploads(token);
      if (token !== seqToken) return;
      const note = $('[data-note]', bubble);
      if (llm.drawers && llm.drawers.length) {
        drawers = llm.drawers;
        $('[data-tags]', bubble).innerHTML = drawers.map((d) => `<span class="ob-tag">${esc(d.name)}</span>`).join('');
        note.innerHTML = `<b>자료함을 이렇게 나눠 둘까요?</b> 파일을 훑어보고 정한 갈래예요. 이대로 서랍을 만들어 두면 다음부터 새 자료가 알아서 제자리로 들어갑니다.`;
      } else {
        note.innerHTML = `<b>자료함을 이렇게 나눠 둘까요?</b> 옆의 숫자는 그 종류로 본 자료 수예요.`
          + (llm.why ? `<br><span style="color:var(--muted)">${esc(llm.why)}</span>` : '');
      }
      S.drawers = drawers;
      await sleep(200);
      const approve = (l) => { msgUser(l); S.drawersOn = true; S.decisions.push(`자료함 ${S.drawers.length}갈래로 나눔`); doneStep('b1'); renderSB(); enableLocalDistiller(); chatStep('b2', token); };
      chipsRow([
        { label: '네, 이대로 나눠 주세요', cta: true, cb: approve },
        { label: '빠진 종류가 있어요', cb: (l) => { msgUser(l);
            msgLiv('어떤 종류인가요? 아래 입력창에 적어 주세요. 서랍을 하나 더 만들어 둘게요.');
            armCompose('예: 고객 인터뷰', (v) => { S.drawers = [...(S.drawers || []), { name: v }]; S.drawersOn = true;
              S.decisions.push(`갈래 추가: ${v}`); doneStep('b1'); renderSB(); enableLocalDistiller();
              msgLiv(`<b>${esc(v)}</b> 서랍을 더해 뒀어요.`); chatStep('b2', token); }); } },
      ]);
    }
    if (step === 'b2') {
      await sleep(600);
      // 관찰은 **실제 파일 이름에서 본 것만** 말한다. 못 봤으면 관찰을 지어내지 않고 그냥 묻는다.
      const forms = (WS && WS.uploads && WS.uploads.forms) || [];   // 서버가 실제 파일 이름에서 본 것
      const seen = forms.length
        ? `같은 꼴 이름이 여러 개 보여요. ${forms.slice(0, 2).map((g) => `<b>${esc(g.names[0])}</b> 같은 것 ${g.names.length}개`).join(', ')}요.`
        : '';
      msgLiv(`${seen}<p style="margin-top:${seen ? '6px' : '0'}"><b>정해진 주기로 만드시거나 만들고 싶으신 문서가 있나요?</b> 주기가 있으면 다음 것을 미리 만들어 둘 수 있습니다.</p>`);
      await sleep(300);
      const pickB2 = (id, label) => { msgUser(label); S.b2 = id; if (id !== 'no') S.decisions.push(id === 'month' ? '매달 반복 작업으로 봄' : '매주 반복 작업으로 봄'); doneStep('b2'); chatStep('b3', token); };
      chipsRow([
        { label: '네, 매달', cb: () => pickB2('month', '네, 매달') },
        { label: '네, 매주', cb: () => pickB2('week', '네, 매주') },
        { label: '아니요', ghost: true, cb: () => pickB2('no', '아니요') },
      ]);
    }
    if (step === 'b3') {
      await sleep(600);
      // 종전엔 "문서에 같은 이름이 반복해서 나와요"라고 했는데, 우리는 문서 **안**을 아직 안 읽었다.
      //  근거 없는 관찰을 앞세우지 않고 묻기만 한다.
      msgLiv(`<b>이 자료를 같이 보는 팀이 있나요?</b><p style="margin-top:6px">있으면 팀이 볼 것과 나만 볼 것을 갈라 둡니다.</p>`);
      await sleep(300);
      const pickB3 = (id, label, dec) => { msgUser(label); S.b3 = id; S.decisions.push(dec); doneStep('b3'); renderSB(); chatStep('nowline', token); };
      chipsRow([
        { label: '나만 봐요', cb: () => pickB3('me', '나만 봐요', '나만 보는 자료로 봄') },
        { label: '우리 팀이 같이 봐요', cb: () => pickB3('team', '우리 팀이 같이 봐요', '팀과 함께 보는 자료로 봄') },
        { label: '회사의 여러 부서와 나눠요', cb: () => pickB3('dept', '회사의 여러 부서와 나눠요', '여러 부서와 나누는 자료로 봄') },
        { label: '고객·외부에 냅니다', cb: () => pickB3('ext', '고객·외부에 냅니다', '고객·외부로 나가는 자료로 봄') },
      ]);
    }
    if (step === 'nowline') {
      await sleep(600);
      msgLiv(`마지막 하나예요.<p style="margin-top:6px"><b>평소에 시간을 가장 많이 쓰시는 일은 무엇인가요?</b> 한 주를 놓고 볼 때 제일 자주, 제일 오래 붙잡고 계신 일이요. 여기부터 제가 손을 보탭니다.</p>`);
      await sleep(300);
      const pickNow = (label) => { msgUser(label); S.nowline = label; S.decisions.push(`시간을 가장 많이 쓰는 일: ${label}`); doneStep('nowline'); waitRead(token); };
      chipsRow(DATA.NOW_KINDS.map((t) => ({ label: t, cb: () => pickNow(t) }))
        .concat([{ label: '직접 적을게요', ghost: true, cb: () => {
          msgUser('직접 적을게요');
          msgLiv('아래 입력창에 한 줄로 적어 주세요.'); /* [새문구] */
          armCompose('예: 매주 실적 자료 만드는 일', (v) => { S.nowline = v; S.decisions.push(`시간을 가장 많이 쓰는 일: ${v}`); doneStep('nowline'); waitRead(token); });
        } }, { label: '지금은 건너뛰기', ghost: true, cb: () => { msgUser('지금은 건너뛰기'); doneStep('nowline'); waitRead(token); } }]));
    }
    if (step === 'can') {
      await sleep(500);
      const C = canOf();
      const readN = realTotal();
      msgLiv(`${readN ? `자료 <b>${readN}건</b>을 다 읽었어요.` : '준비됐어요.'}${S.nowline ? ` <b>${esc(S.nowline)}</b>에 시간을 제일 많이 쓰신다고 하셨죠.` : (nick() ? ` ${esc(nick())}님이 하시는 일이라면,` : '')}
        <p style="margin-top:6px"><b>이런 것까지 저한테 맡기실 수 있어요.</b> 보통은 몇 번씩 왔다 갔다 해야 하는 일이에요. 여기서는 한 문장이면 됩니다.</p>
        <div class="ob-excard" data-ex="0"><div class="ob-xt">“${esc(C[0][0])}”</div><div class="ob-xd"><b>보통은</b> ${esc(C[0][1])}</div></div>
        <div class="ob-excard" data-ex="1"><div class="ob-xt">“${esc(C[1][1])}”</div><div class="ob-xd"><b>${esc(C[1][0])} 쪽도</b> 이런 것까지 이어서 물으실 수 있어요.</div></div>`);
      $$('.ob-excard').forEach((c) => c.onclick = () => {
        if (c.dataset.taken) return; c.dataset.taken = '1';
        const t = $('.ob-xt', c).textContent.replace(/^“|”$/g, '');
        msgUser(t);
        S.firstOrder = t; S.decisions.push(`첫 지시: ${t.slice(0, 40)}…`); save(); renderSB();
        // ⚠ 종전엔 "세션을 하나 열어 뒀어요. 왼쪽에 보이죠?" 라고 했는데 **세션을 만들지 않았다**.
        //  적어 두는 것은 실제로 한다(마무리에서 프로필의 결정으로 남는다) — 그 사실만 말한다.
        msgLiv('적어 뒀어요. 정리가 끝나면 홈에서 이 문장으로 바로 시작하실 수 있어요. 다 됐으면 아래 <b>준비 끝, 정리해 주세요</b>를 눌러 주세요.');
      });
      await sleep(400);
      chipsRow([{ label: '준비 끝, 정리해 주세요', cta: true, cb: async (l) => {
        msgUser(l); doneStep('can'); S.scene = 'done'; save(); renderSB();
        // ★ 여기가 온보딩이 **실제로 워크스페이스를 바꾸는** 자리다. 종전엔 localStorage 표식 하나가 전부였다.
        const m = msgLiv('정리하고 있어요.');
        let applied = null;
        try {
          applied = await api('/api/ui/me/welcome', { method: 'POST', body: JSON.stringify({
            name: S.nameSet ? S.name : null,
            stage: S.stage || null,
            job: S.job || null,
            drawers: (S.drawers || []).map((d) => ({ name: d.name, why: d.why || null })),
            cadence: S.b2 || null,
            share: S.b3 || null,
            nowline: S.nowline || null,
            first_order: S.firstOrder || null,
          }) });
        } catch (e) {
          // 반영이 실패했으면 **끝났다고 말하지 않는다** — 다음에 다시 물을 수 있게 표식도 남기지 않는다.
          m.querySelector('.ob-body').innerHTML = `정리하다 막혔어요 — ${esc(e && e.message ? e.message : '알 수 없는 오류')}<p style="margin-top:6px">홈에서 이어서 하실 수 있습니다.</p>`;
          await sleep(1200); location.hash = '#/'; return;
        }
        try { localStorage.setItem(DONE_KEY, '1'); } catch (e) {}
        try { if (state.me) (state.me as { welcome_pending?: boolean }).welcome_pending = false; } catch (_) {}   // 홈의 «이어서 하기» 줄을 내린다(#2232)
        ctx.onGhost && ctx.onGhost(false);   // 끝났다 — 셸을 돌려준다(막3 → 워크스페이스)
        //  끝났으니 «하다 만 자리» 저장을 멈춘다(#2207). 서버 쪽 자리표는 반영이 지웠다 —
        //   여기서 늦게 도착한 push 하나가 그걸 되살리면 다음 로그인이 다시 온보딩으로 간다.
        pushOff = true; clearTimeout(pushT); pushT = null;
        ctx.onDone && ctx.onDone();
        const made = (applied && applied.created) || [];
        m.querySelector('.ob-body').innerHTML = made.length
          ? `정리했어요. 자료함에 <b>${made.map((x) => esc(x)).join(' · ')}</b> 서랍을 만들어 뒀습니다. 워크스페이스로 모시겠습니다.`
          : '정리했어요. 워크스페이스로 모시겠습니다.';
        scrollChat();
        await sleep(1100);
        location.hash = '#/';
      } }]);
      fineRow('지금 시키지 않으셔도 됩니다. 홈에서 언제든 그대로 말씀하시면 돼요.');
    }
  }

  function waitRead(token) {
    if (S.read.finished) { chatStep('can', token); return; }
    const m = msgLiv(`<div class="ob-readline"><span>자료를 읽고 있어요.</span><span class="ob-readbar"><i></i></span><span id="readN">${S.read.done} / ${S.read.total}</span></div>`); /* [새문구] 읽기+사이드바 연결 */
    readBarEl = $('.ob-readbar i', m); readNEl = $('#readN', m);
    readBarEl.style.width = Math.round(100 * S.read.done / Math.max(1, S.read.total)) + '%';
    document.addEventListener('read-done', () => { setTimeout(() => chatStep('can', token), 400); }, { once: true });
  }

  /* 채팅 시작(read 장면) — 노션 p5의 첫 인사에 대응 */
  async function enterChat(token) {
    setStage('stage-chat');
    $('#thread').innerHTML = '';
    await loadWelcome();
    S.read.total = Math.max(S.upN || 0, 0);
    startReading();
    await sleep(300);
    const n = S.read.total;
    msgLiv(`${nick() ? esc(nick()) + '님, ' : ''}연결까지 끝났어요.`
      + (n ? `<p style="margin-top:6px">지금 자료 <b>${n}건</b>을 읽고 있어요. 읽는 동안 몇 가지만 확인할게요.</p>`
           : `<p style="margin-top:6px">몇 가지만 확인하고 바로 시작할게요.</p>`));
    chatStep('b1', token);
  }

  /* ══════════════ 장면 전환 ══════════════ */
  function renderScene(key, animate) {
    const sc = SCENES[key];
    if (!sc) return;
    // 장면이 바뀌면 «내 컴퓨터» 폴링을 멈춘다 — 화면에 없는 타이머가 5초마다 도는 건 조용한 누수다.
    if (key !== 'local') { clearInterval(localTimer); localTimer = null; localBase = null; }
    setStage(key === 'name' ? 'stage-name' : 'stage-q');
    const col = $('#qcol');
    col.style.animation = 'none';
    if (animate !== false) { void col.offsetWidth; col.style.animation = ''; }
    col.classList.toggle('ob-wide', key === 'sources');
    col.innerHTML = sc.html();
    syncBack();
    $$('[data-jump]', col).forEach((b) => b.onclick = () => goJump(b.dataset.jump));
    sc.bind && sc.bind(col);
  }
  const SCENE_LABEL = { name: '이름', stage: '무대', role: '직무', files: '파일 올리기', sources: '앱 고르기',
    connect: '앱 연결', ai: 'AI 고르기', claude: 'AI 연결', terminal: '터미널', local: '내 컴퓨터 연결', app: '앱 받기' };
  /* 뒤로가기는 **지나온 자취**를 되짚는다 — 차례표를 거꾸로 세면 조건부로 건너뛴 장면(AI 없음 등)에 걸린다. */
  function goBack() { const prev = S.trail.pop(); if (!prev) return; save(); goScene(prev, { back: true }); }
  function goJump(key) {
    const i = S.trail.indexOf(key);
    if (i < 0) return goScene(key);
    S.trail = S.trail.slice(0, i); save(); goScene(key, { back: true });
  }
  /* 뒤로가기 버튼은 이동줄에 하나만 두고 켜고 끈다 — 질문 기둥의 L 뱃지가 밀리지 않게(원준님 2026-08-25) */
  function syncBack() {
    const b = $('#obBack'); if (!b) return;
    b.hidden = !S.trail.length;
    b.onclick = () => goBack();
  }
  /* 브라우저 뒤로가기 — 쌓아 둔 장면이 있으면 그 한 걸음을 먹고, 없으면 셸이 하던 대로 나간다.
   *
   * ⚠ **popstate 는 «뒤로» 전용이 아니다**(#2207 실측 2026-08-27). 같은 문서 안에서 해시가 바뀌는 이동이면
   *  브라우저가 전부 popstate 를 띄운다 — 사람이 사이드바를 눌러 홈·받은 편지함으로 **나가는** 순간에도 뜬다.
   *  그래서 종전 코드는 «떠날 때마다 장면을 하나 되감고» 그 자리를 저장했다. 진행이 이 탭 안에만 살던 때는
   *  잘 안 보였지만, 진행이 서버에 남게 된 지금은 **나갈 때마다 한 걸음씩 뒤로 밀린 자리가 저장된다**
   *  (재현: 「AI 고르기」에서 Claude 를 고르고 홈으로 나가면 저장된 자리가 다시 「AI 고르기」가 된다).
   *
   * 가르는 법: 우리가 쌓은 걸음에는 순번(obSeq)을 찍어 둔다. 되돌아온 자리의 순번이 **지금보다 뒤**일 때만
   *  «뒤로» 다(앞으로 나가는 이동은 우리 상태가 아예 없거나 순번이 뒤가 아니다).
   */
  function onPop(ev) {
    const st = ev && ev.state;
    if (!st || typeof st.obSeq !== 'number' || st.obSeq >= obSeq) return;   // 앞으로 나가는 이동 — 우리 일이 아니다
    obSeq = st.obSeq;
    if (!S.trail.length) return;                 // 더 물러날 곳이 없다 → 홈으로 나가는 게 맞다
    goBack();
    // 우리가 한 걸음 먹었으니 그만큼 다시 쌓아 둔다 — 다음 뒤로가기도 이 안에서 듣는다.
    try { history.pushState({ ob: S.scene, obSeq: ++obSeq }, '', location.href); } catch (_) { /* noop */ }
  }
  addEventListener('popstate', onPop);
  function goScene(key, opts) {
    if (!(opts && opts.back) && S.scene && S.scene !== key && STEP_OF[key] != null) {
      S.trail.push(S.scene);
      // 브라우저·셸의 «뒤로» 도 이 안에서 한 걸음 물러나게 한다(원준님 2026-08-26: "뒤로가기 누르니까 그냥 메인홈으로 가지네").
      //  ⚠ 주소(해시)는 **바꾸지 않는다** — 바꾸면 셸 라우터가 화면을 새로 그린다. 같은 주소로 state 만 쌓아
      //   popstate 때 우리가 먼저 받아 처리한다. 쌓인 장면이 없을 때의 뒤로가기는 종전대로 홈으로 나간다.
      //  ⚠ 순번(obSeq)을 함께 찍는다 — 이게 있어야 «뒤로» 와 «앞으로 나가는 이동» 이 갈린다(onPop 참조).
      try { history.pushState({ ob: key, obSeq: ++obSeq }, '', location.href); } catch (_) { /* 사파리 프라이빗 */ }
    }
    S.scene = key; save(); renderSB();
    seqToken++;
    if (STEP_OF[key] >= CHAT_FROM) {
      S.trail = []; save();
      replayChatTo(key, seqToken);
    } else {
      renderScene(key, true);
    }
    syncBack();
  }

  /* 채팅 단계로 점프·복원 — 앞 단계 문답을 압축해 깔아 놓고 그 단계부터 산다 */
  function replayChatTo(key, token) {
    setStage('stage-chat');
    $('#thread').innerHTML = '';
    // 막2 답이 비어 있으면 기본값으로 채움 (장면 점프용)
    //  ⚠ **검토용 점프(?scene=)에서만 지어낸다**(#2207). 실제로 이어 여는 사람에게 쓰면, 이름을 건너뛴
    //   사람이 갑자기 '원준' 으로 불리고 고른 적 없는 앱이 골라진 것으로 뜬다 — 그 사람의 답이 아니다.
    //   중립 폴백(`||`)은 둘 다 쓴다: 없는 것을 주장하지 않고 화면이 깨지지만 않게 하는 값이라서다.
    if (demoJump && !S.nameSet) { S.name = '원준'; S.nameSet = true; }
    S.stage = S.stage || 'company'; S.job = S.job || stageOf().opts[1][0];
    if (demoJump && !S.sources.length) S.sources = ['gdrive', 'notion'];
    if (!S.connected.length) S.connected = S.sources.filter((x) => x !== 'none');
    // ⚠ 여기서 **S.aiConnected 를 지어내지 않는다**(#1879). 종전엔 `S.ai !== '아직 없어요'` 로 무조건
    //  덮어썼는데, 그건 `||` 폴백이 아니라 **대입**이라 AI 잇기를 건너뛴 사람도 채팅 단계에 닿는 순간
    //  참이 됐다. 그 뒤 AI 화면으로 돌아가면 «이어졌어요 · 로그인이 확인됐어요» 라고 말한다 — 서버는
    //  그런 적이 없다. #1813 이 걷어낸 «900ms 뒤 무조건 연결됐어요» 와 같은 모양의 잔재였다.
    //  이음 여부는 서버가 답한다(ai-accounts/check) — 화면이 채워 넣을 값이 아니다.
    //  나머지 둘은 사람의 '답'이라 점프용 기본값이 성립한다(중립값으로 채운다 — 없는 연결을 주장하지 않는다).
    S.ai = S.ai || 'Claude';
    S.terminal = S.terminal || 'no'; S.app = S.app || 'web';
    //  읽고 있는 자료 수 — 이어 여는 사람에게는 **실측**을 쓴다(41 은 검토용 연출 숫자다).
    if (!S.read.total) S.read.total = demoJump ? 41 : realTotal();
    const past = [];
    const target = key === 'read' ? 'b1' : key;
    const upto = CHAT_STEPS.indexOf(target);
    if (key !== 'read' && upto > 0) {
      // 지나간 단계들을 요약 문답으로 재생
      if (upto > CHAT_STEPS.indexOf('b1')) { past.push([`자료함을 이렇게 나눠 둘까요?`, '네, 이대로 나눠 주세요']); S.drawersOn = true; }
      if (upto > CHAT_STEPS.indexOf('b2')) past.push([`정해진 주기로 만드시거나 만들고 싶으신 문서가 있나요?`, S.b2 === 'week' ? '네, 매주' : S.b2 === 'no' ? '아니요' : '네, 매달']);
      if (upto > CHAT_STEPS.indexOf('b3')) past.push([`같이 보는 팀이 있나요?`, S.b3 === 'me' ? '나만 봐요' : '우리 팀이 같이 봐요']), S.b3 = S.b3 || 'team';
      if (upto > CHAT_STEPS.indexOf('nowline')) { S.nowline = S.nowline || DATA.NOW_KINDS[2]; past.push([`평소에 시간을 가장 많이 쓰시는 일은 무엇인가요?`, S.nowline]); }
      Object.assign(S.read, { done: S.read.total, finished: true });
      // 장면 건너뛰기(?scene=)로 중간에 들어온 경우에도 사이드바 숫자는 **실측**을 쓴다 —
      //  여기만 상수 목표치를 쓰면 같은 화면이 두 가지 숫자를 말한다.
      S._counts = {}; realKinds().forEach((k) => { S._counts[k.name] = k.n || ''; });
    }
    save(); renderSB();
    if (key === 'read') { enterChat(token); return; }
    past.forEach(([q, a]) => { msgLiv(`<b>${esc(q)}</b>`); msgUser(a); });
    if (!S.read.finished) startReading();
    chatStep(target, token);
  }

  /* ── 이어서 열기 (#2207) ───────────────────────────────────────────────────
   *  탭에 남은 것이 없을 때만 서버에 묻는다(탭에 있으면 그게 더 새 것이다 — 위 «어느 쪽이 정본인가»).
   */
  /** 서버가 준 자리표 → 실제로 열 장면. 못 열 자리면 null(처음부터). */
  function resumeScene(p) {
    if (!p || !p.state || typeof p.state !== 'object') return null;
    if (STEP_OF[p.scene] != null) return p.scene;
    //  'done' 은 차례표에 없다 — 마무리(반영)를 누른 뒤 그게 실패했거나 끊긴 자리다. 답은 다 받아 놨으니
    //   맨 앞이 아니라 **마지막 채팅 단계**로 되돌려 «준비 끝, 정리해 주세요» 를 다시 누르게 한다.
    if (Array.isArray(p.state.chatDone) && p.state.chatDone.length) return 'can';
    return null;
  }
  /** 서버에 남은 자리로 화면을 연다. 못 물으면 처음부터 — 온보딩이 **안 열리는** 것보다 낫다. */
  async function resumeFromServer() {
    if (destroyed) return;
    setStage('stage-name');
    $('#qcol').innerHTML = `<div class="ob-q-top"><div class="ob-q-ic">L</div></div>
      <p class="ob-q-help">지난번에 어디까지 하셨는지 보고 있어요.</p>`;
    const got = await Promise.race([loadWelcome(), sleep(RESUME_WAIT_MS)]);
    if (destroyed) return;                 // 기다리는 사이에 화면을 떠났다 — 없는 화면에 그리지 않는다
    const scene = resumeScene(got && got.progress);
    if (scene) {
      S = Object.assign(fresh(), got.progress.state);
      S.scene = scene;
      saveLocal();          // 이 탭에도 얹어 둔다 — 이제부터는 이 탭이 정본이다(서버로 다시 밀지 않는다)
      renderSB(); goScene(scene);
      toast('지난번에 하시던 자리에서 이어 갑니다.');
      return;
    }
    renderSB(); goScene(S.scene || 'name');
  }

  /* ── 부팅 ── */
  //  지금 이 히스토리 자리에 **출발점 도장(obSeq 0)** 을 찍는다. 이게 있어야 첫 걸음에서의 «뒤로» 가
  //   «되돌아온 것» 으로 읽힌다 — 도장이 없으면 onPop 이 그 이동을 '우리 일이 아님' 으로 흘려보내고,
  //   사람은 처음 설정 안에서 뒤로가기가 먹지 않는 것을 본다(#2026 이 고쳤던 그 증상).
  //  ⚠ 셸이 찍어 둔 값(v2i 등)은 **보존한다** — 통째로 갈아끼우면 셸의 앞/뒤 화살표 판정이 무너진다.
  try { history.replaceState({ ...(history.state || {}), ob: S.scene, obSeq: 0 }, '', location.href); } catch (_) { /* 사파리 rate limit */ }
  $('#composeGo').onclick = composeSend;
  $('#composeIn').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) composeSend(); });
  // 장면 바로 열기 — 셸에선 질의가 해시 뒤에 붙는다(#/welcome?scene=b1). 검토용.
  const want = new URLSearchParams(location.search).get('scene') || new URLSearchParams((location.hash.split('?')[1] || '')).get('scene');
  if (want && STEP_OF[want] != null) { demoJump = true; goScene(want); }
  else if (hadLocal) { renderSB(); goScene(S.scene || 'name'); schedulePush(); }
  else { renderSB(); void resumeFromServer(); }
  return { destroy() {
    destroyed = true;
    clearInterval(readTimer); clearInterval(localTimer); clearTimeout(toastT);
    removeEventListener('popstate', onPop);
    removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onLeave);
    void flushProgress();          // 화면을 떠나는 것도 '중간에 나간 것'이다 — 마지막 한 걸음을 남긴다
    ctx.onBare && ctx.onBare(false);
    ctx.onGhost && ctx.onGhost(false);   // 유령 셸도 반드시 푼다 — 어떤 길로 나갔든(#2232)
  } };
}
