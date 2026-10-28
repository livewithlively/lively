// v2/connect-own-ai.ts — 외부 앱 연결을 **시작하는 문** 한 벌(#4970). 처음 설정의 [연결할게요]와 [외부 앱 연결] 화면의 [연결 도와줘]가 같이 쓴다.
//
//  · 리브 세션이 있거나 서버에 로그인된 AI 가 있으면 — 리브에게 맡긴다(me_liv_open job:connect — 리브 = 세션 하나, 상민님 결정 2026-10-22).
//    리브 세션이 없으면 그 말(연결 스킬 liv-connect 를 부르는 말)로 열고, 있으면 그 세션에 넣고 그 세션으로 간다.
//  · 없으면 — «쓰는 AI 에서 하기» 세 걸음을 그 자리에 그린다: 데스크톱 앱 받기 → 앱에서 이 워크스페이스에 로그인 → 쓰는 AI 에 한 마디.
//   커서·Claude Code 처럼 사람이 이미 쓰는 AI 가 연결 스킬을 받아 같은 일을 한다(스킬은 데스크톱 앱 설치가 그 AI 에 내려 준다).
//  두 자리가 따로 그리면 말이 갈린다 — 문구·내려받기 판정은 여기 한 곳에만 둔다.
import { toast } from '../core.js';
import { managedWorkspaces } from './switcher.js';   // 매니지드면 데스크톱 앱의 로그인 문이 다르다(클라우드 로그인 vs 주소 입력)
import { openLiv } from './liv-open.js';

/** 쓰는 AI 에 그대로 말할 한 마디 — 스킬 이름을 넣어 자동 호출이 빗나가도 사람과 AI 가 알아본다. */
export const SAY_IN_AI = '라이블리 liv-connect 스킬로 외부 앱 연결 도와줘';

/* ── 데스크톱 앱 내려받기 (#1813 · #4970) ──────────────────────────────────────
 *  릴리스는 공개라 **브라우저가 직접** GitHub API 에 묻는다(CORS 가 열려 있다) — 서버를 거치지 않는다.
 *  · 윈도우 — 고정 주소의 설치 도우미(Lively-Setup.exe, 사전 릴리스 `win-installer`). 버전마다 바뀌는 설치 파일은 SmartScreen 평판이
 *    쌓이지 않아서 따로 둔 자리다(.github/workflows/desktop-installer-helper.yml).
 *  · 맥 — 최신 릴리스의 `.dmg`. ★ 맥 자산은 universal `.dmg` 하나여야 한다 — 브라우저는 맥의 CPU 를 알 수 없다(애플이 `navigator.platform`
 *    을 `MacIntel` 로 남겨 뒀다). 그래서 desktop/package.json 의 mac 타깃이 universal 이다. arch 별로 나누려면 사람에게 고르게 하는 화면이 먼저다.
 *  · 그 밖(리눅스·판정 불가) — 받는 곳(릴리스 페이지)을 연다. 없는 파일을 가리키지 않는다.
 *  ⚠ 실패하면 릴리스 페이지로 보낸다 — 절대 던지지 않는다. */
const DL_API = 'https://api.github.com/repos/livewithlively/lively/releases/latest';
const DL_PAGE = 'https://github.com/livewithlively/lively/releases/latest';
const WIN_INSTALLER = 'https://github.com/livewithlively/lively/releases/download/win-installer/Lively-Setup.exe';

/** 이 브라우저가 도는 OS. 못 가리면 null. */
export function desktopOs(): 'mac' | 'win' | 'linux' | null {
  const s = `${navigator.userAgent} ${navigator.platform || ''}`.toLowerCase();
  if (s.includes('mac')) return 'mac';
  if (s.includes('win')) return 'win';
  if (s.includes('linux') || s.includes('x11')) return 'linux';
  return null;
}
/** 맥 최신 릴리스의 `.dmg` — 확장자로 끝나는 것만 본다(.blockmap·.yml 은 저절로 걸러진다). */
export function pickDmg(assets: Array<{ name?: unknown; browser_download_url?: unknown }>): string | null {
  for (const a of assets) {
    const name = typeof (a && a.name) === 'string' ? String(a.name).toLowerCase() : '';
    const url = typeof (a && a.browser_download_url) === 'string' ? String(a.browser_download_url) : '';
    if (name && url && name.endsWith('.dmg')) return url;
  }
  return null;
}
let dlCache: string | null | undefined;
/** 내 OS 설치본 주소. 한 번만 묻고 재사용한다. 못 가리거나 실패하면 null(그때는 받는 곳을 연다). */
export async function desktopLink(): Promise<string | null> {
  if (dlCache !== undefined) return dlCache;
  const os = desktopOs();
  if (os === 'win') { dlCache = WIN_INSTALLER; return dlCache; }
  if (os !== 'mac') { dlCache = null; return null; }
  try {
    const res = await fetch(DL_API, { headers: { accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    dlCache = pickDmg(Array.isArray(body && body.assets) ? body.assets : []);
  } catch (_) { dlCache = null; }
  return dlCache;
}

const esc = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const kbd = (t: string) => `<kbd class="ob-kbd">${esc(t)}</kbd>`;
/** 복사 단추가 붙은 한 줄. **사람이 손으로 타이핑하게 두지 않는다** — 오타 한 글자가 곧 막힘이다. */
const cmdBox = (cmd: string) => `<div class="ob-cmd"><code>${esc(cmd)}</code><button type="button" class="ob-cmd-copy" data-copy="${esc(cmd)}">복사</button></div>`;

export type ConnectOpen = { ai: true; href: string } | { ai: false };

/** 외부 앱 연결을 리브에게 맡긴다(서버 me_liv_open job:connect). 첫 지시 그리기·못 넣은 말 돌려 두기는 openLiv 가 남긴다.
 *  실패는 던진다 — 부르는 쪽이 사람에게 이유를 말한다. */
export async function openConnectSession(o: { fromWelcome?: boolean } = {}): Promise<ConnectOpen> {
  const r = await openLiv({ job: 'connect', fromWelcome: !!o.fromWelcome });
  return r.ai ? { ai: true, href: r.href } : { ai: false };
}

/** «쓰는 AI 에서 하기» 세 걸음 — 서버에 로그인된 AI 가 없을 때. 사람이 손대는 것은 받기·로그인·붙여넣기 셋뿐이다.
 *  say — 셋째 걸음에서 쓰는 AI 에 붙여 넣을 말(기본: 외부 앱 연결). 리브 화면은 점검하는 말을 준다. */
/** 앱 받기 · 앱에서 로그인 — 두 걸음(#5060). «쓰는 AI 에서 하기» 의 앞 두 걸음이자, 처음 설정 «앱으로 이어 하기» 장면의 안내다.
 *  [앱 받기]는 data-get — 배선은 wireOwnAiSteps 가 한다(받기 주소를 미리 물어 둔다). */
export function appInstallStepsHtml(): string {
  const os = desktopOs();
  const getBtn = '<button type="button" class="ob-btn ob-btn-sub ob-btn-inline ob-btn-mini" data-get>앱 받기</button>';
  const step1 = os === 'win'
    ? `${getBtn} 를 누르면 <b>Lively-Setup.exe</b> 가 내려받아져요. 내려받은 파일을 두 번 눌러 설치하세요.`
    : os === 'mac'
      ? `${getBtn} 를 누르면 <b>Lively.dmg</b> 가 내려받아져요. 내려받은 파일을 두 번 누르고, 나온 라이블리 아이콘을 ${kbd('응용 프로그램')} 폴더로 끌어다 놓으세요.`
      : `${getBtn} 를 누르면 받는 곳이 새 창으로 열려요. 거기서 내 컴퓨터에 맞는 파일을 골라 받으시면 됩니다.`;
  //  데스크톱 앱 첫 화면은 두 문이다(desktop/renderer/index.html): [라이블리 클라우드로 로그인] · «회사에 직접 설치했어요 — 주소 입력».
  const managed = managedWorkspaces();
  const step2 = managed
    ? `앱을 열고 ${kbd('라이블리 클라우드로 로그인')}을 누르세요. 브라우저에 승인 화면이 뜨면 ${kbd('승인')}을 누르세요.`
    : `앱을 열고 <b>회사에 직접 설치했어요 — 주소 입력</b>을 눌러 아래 주소를 넣고 ${kbd('연결')}을 누르세요. 브라우저에 승인 화면이 뜨면 ${kbd('승인')}을 누르세요.`;
  const host = String(location.host || '');
  return `<div class="ob-ins" data-n="1">
        <b class="ob-ins-t">라이블리 앱을 받아 설치합니다</b>
        <p class="ob-ins-p">${step1}</p>
      </div>
      <div class="ob-ins" data-n="2">
        <b class="ob-ins-t">앱에서 이 워크스페이스에 로그인합니다</b>
        <p class="ob-ins-p">${step2}</p>
        ${managed || !host ? '' : cmdBox(host)}
      </div>`;
}

export function ownAiStepsHtml(say: string = SAY_IN_AI): string {
  return `<p class="ob-q-help">이 워크스페이스에는 아직 로그인된 AI가 없어요. 커서·Claude Code처럼 평소 쓰시는 AI에서 연결을 이어 가시면 됩니다.</p>
    <div class="ob-ins-list">
      ${appInstallStepsHtml()}
      <div class="ob-ins" data-n="3">
        <b class="ob-ins-t">쓰시는 AI에 이렇게 말합니다</b>
        <p class="ob-ins-p">설치가 끝나면 쓰시던 AI를 한 번 껐다 켜고, 새 대화에 아래 말을 그대로 붙여 넣으세요.</p>
        ${cmdBox(say)}
        <p class="ob-ins-n">${say === SAY_IN_AI ? '그 AI가 앱마다 무엇이 준비됐는지 보고, 연결을 한 걸음씩 안내합니다.' : '그 AI가 이 워크스페이스에서 손볼 것을 보고, 한 걸음씩 안내합니다.'} 서버에서 쓰는 AI는 왼쪽 아래 내 이름을 누르면 나오는 [AI 계정 연결]에서 언제든 로그인하실 수 있어요.</p>
      </div>
    </div>`;
}

/** 세 걸음의 배선 — 복사 단추·[앱 받기]. 받기 주소는 **미리** 물어 둔다(누른 순간 await 하면 사용자 제스처가 풀려 새 창이 막힌다). */
export function wireOwnAiSteps(root: ParentNode): void {
  root.querySelectorAll<HTMLButtonElement>('.ob-cmd-copy').forEach((b) => b.onclick = async () => {
    const txt = b.dataset.copy || '';
    try {
      await navigator.clipboard.writeText(txt);
      const was = b.textContent; b.textContent = '복사됨'; b.classList.add('ob-on');
      setTimeout(() => { b.textContent = was; b.classList.remove('ob-on'); }, 1600);
    } catch (_) {
      //  클립보드가 막힌 자리(비 HTTPS·권한 거부) — 글자를 선택해 준다(조용히 실패하지 않는다).
      const code = b.parentElement && b.parentElement.querySelector('code');
      if (code) { const r = document.createRange(); r.selectNodeContents(code); const sel = getSelection(); if (sel) { sel.removeAllRanges(); sel.addRange(r); } }
      toast('복사가 막혀 있어요. 파랗게 선택해 뒀으니 ⌘/Ctrl + C 로 복사해 주세요.');
    }
  });
  const doGet = desktopDownloader();
  root.querySelectorAll<HTMLElement>('[data-get]').forEach((b) => b.onclick = (e) => { e.preventDefault(); doGet(); });
}

/** 내려받기 함수 — 받기 주소를 **지금** 물어 두고, 돌려준 함수는 누른 그 자리에서 곧바로 받는다(누른 순간 await 하면 사용자 제스처가 풀려 막힌다).
 *  주소를 아직 모르거나 못 가렸으면 받는 곳(릴리스 페이지)을 연다. 처음 설정 «앱으로 이어 하기» 는 장면을 그릴 때 이걸 받아 둔다(#5060). */
export function desktopDownloader(): () => void {
  let url: string | null = null;
  void desktopLink().then((u) => { url = u; });
  return () => {
    if (url) {
      const a = document.createElement('a'); a.href = url; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      toast('내려받기를 시작했어요.');
    } else {
      window.open(DL_PAGE, '_blank', 'noopener');
      toast('받는 곳을 새 창으로 열었어요.');
    }
  };
}
