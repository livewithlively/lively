// frame-bridge.ts — 격리 프레임(sandbox=allow-scripts, allow-same-origin 없음) 안의 문서 ↔ 셸 «검토 다리» (#4075)
//
//  왜: 시안(HTML)은 공용 렌더러 htmlFrame 으로 격리 프레임에 뜬다. 문서의 오리진이 불투명하므로 문서 안
//   스크립트는 localStorage 에 손을 못 대고(접근 자체가 예외) 클립보드 쓰기·내려받기도 막힌다. 줄마다 코멘트를
//   달아 저장하고 [코멘트 전체 복사]로 채팅에 붙이는 «검토판» 문서(원준 2026-09-19)는 그래서 곁칸 [뷰어]에서
//   죽어 있었다 — 새 탭에서만 됐다. 격리는 그대로 두고(문서에 쿠키·부모 DOM 을 주지 않는다), 문서가 부탁하는
//   세 가지(저장·복사·내려받기)만 셸이 **대신** 한다. v2/app-ui.ts 의 앱 UI 브리지와 같은 수법이다.
//
//  규약(문서 쪽 검토 레이어와 합의, 2026-09-20 — 문서는 window.parent.postMessage(msg, '*') 로 보낸다):
//   문서 → 셸  {lv:'rv', op:'hello'} · {op:'get', key} · {op:'set', key, value} · {op:'del', key}
//              · {op:'copy', text, html} · {op:'download', name, text, mime}
//   셸 → 문서  {lv:'rv', op:'ready'} · {op:'got', key, value|null} · {op:'copied', ok}
//
//  안전 규칙(전부 순수 함수 handleBridgeMessage 가 지킨다 — 창 없이 시험한다):
//   · 이 프레임(contentWindow)에서 온 메시지만 받는다(attachFrameBridge 가 거른다).
//   · 값은 문자열로만 다루고 절대 실행하지 않는다. 키 200자·값 1MB 를 넘으면 버린다.
//   · 저장 키에는 파일마다 이름 공간(rvb:<ns>:)을 붙인다 — 문서가 남의 저장값을 읽거나 덮지 못한다.
//   · 내려받기 이름은 경로 문자를 지우고, MIME 은 꼴이 맞을 때만 받는다.
//   · 응답 target 은 '*' — 불투명 오리진은 이름으로 못 가리키고, 그 프레임 창만 받는다.

//  ── 보던 자리 (#4523, 2026-10-01) ─────────────────────────────────────────────────────────────
//   «html 미리보기가 새로고침되거나 다른 탭 갔다 오면 스크롤이 처음으로 돌아간다». 프레임이 **새로 서면**(새로고침 ·
//   세션을 갈아탔다 돌아옴 · 살아 있는 미리보기의 다시 펴기 · 곁칸 재구성) 문서가 새로 읽혀 맨 위에서 시작한다.
//   격리 프레임이라 셸은 안쪽 자리를 읽지도 쓰지도 못한다 — 그래서 **문서 쪽에 작은 스크립트(withScrollKeeper)**를
//   붙여, 문서가 제 자리를 셸에 알리고(pos-set) 새로 설 때 물어 되돌린다(pos-get → pos). 격리는 그대로다.
//   문서 → 셸  {lv:'rv', op:'pos-get'} · {op:'pos-set', pos:{x, y, p?}}      셸 → 문서  {lv:'rv', op:'pos', pos|null}
//   · p = 문서 안 스크롤 칸의 자리(자식 순번을 '.' 로 이은 것) — 창이 아니라 칸이 구르는 문서(덱·앱 꼴 보고서)도 지킨다.
//   · 실측(크롬 headless=new, CDP): 숨김(display:none)은 크롬이 되살리고, 떼었다 붙이면 문서가 새로 읽혀 0 이 된다.
//     숨긴 동안 scrollY 는 0 으로 **읽힌다** — 그래서 자리는 scroll 이벤트 그 순간에 적고, 늦은 타이머에서 읽지 않는다.
export const RV_POS_MAX = 10_000_000;      // 1천만 px — 이보다 먼 자리는 문서가 거짓말하는 것이다
export const RV_POS_PATH_MAX = 64;         // 칸 자리의 깊이 상한

export const RV_KEY_MAX = 200;
export const RV_VALUE_MAX = 1_000_000;    // 코멘트 수백 건도 수십 KB 다 — 1MB 면 넉넉하고 저장소도 안 넘친다
export const RV_NS_PREFIX = 'rvb:';

/** 문서가 알려 온 보던 자리. p 가 없으면 창(문서 전체)의 자리다. */
export interface ScrollPos { x: number; y: number; p?: string }

export interface BridgeDeps {
  get(key: string): string | null;
  set(key: string, value: string): void;
  del(key: string): void;
  copy(text: string, html: string): Promise<boolean>;
  download(name: string, text: string, mime: string): void;
  /** 보던 자리 — 없으면 자리를 지키지 않는다(다리의 다른 일은 그대로). */
  getPos?(ns: string): ScrollPos | null;
  setPos?(ns: string, pos: ScrollPos): void;
}

export interface BridgeReply { lv: 'rv'; op: 'ready' | 'got' | 'copied' | 'pos'; key?: string; value?: string | null; ok?: boolean; pos?: ScrollPos | null }

const POS_PATH_RE = new RegExp('^\\d{1,5}(\\.\\d{1,5}){0,' + (RV_POS_PATH_MAX - 1) + '}$');
const posNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= RV_POS_MAX ? Math.round(v) : null);

/** 문서가 보낸 자리를 믿을 수 있는 꼴로 — 아니면 null. 저장소에서 읽은 값도 같은 문을 지난다. */
export function cleanPos(v: unknown): ScrollPos | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const x = posNum(o.x), y = posNum(o.y);
  if (x === null || y === null) return null;
  if (o.p === undefined || o.p === null || o.p === '') return { x, y };
  return typeof o.p === 'string' && POS_PATH_RE.test(o.p) ? { x, y, p: o.p } : null;
}

/** 저장 키 — 파일마다 이름 공간을 붙인다. */
export function nsKey(ns: string, key: string): string { return RV_NS_PREFIX + ns + ':' + key; }

/** 내려받기 파일 이름 — 경로·제어 문자를 지우고 120자로 자른다. 비면 기본 이름. */
export function safeDownloadName(name: string): string {
  const s = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120);
  return s || 'download.txt';
}

const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;

/**
 * 메시지 하나를 처리해 답(있으면)을 돌려준다. 순수 — DOM·창 없이 시험한다.
 *  규약 밖 메시지·모양이 다른 값은 조용히 버린다(null). 문서가 보내는 것은 신뢰하지 않는다.
 */
export async function handleBridgeMessage(data: unknown, ns: string, deps: BridgeDeps): Promise<BridgeReply | null> {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (m.lv !== 'rv' || typeof m.op !== 'string') return null;
  const key = typeof m.key === 'string' && m.key.length > 0 && m.key.length <= RV_KEY_MAX ? m.key : null;
  switch (m.op) {
    case 'hello':
      return { lv: 'rv', op: 'ready' };
    case 'get': {
      if (!key) return null;
      let value: string | null = null;
      try { value = deps.get(nsKey(ns, key)); } catch { value = null; }
      return { lv: 'rv', op: 'got', key, value: typeof value === 'string' ? value : null };
    }
    case 'set': {
      if (!key || typeof m.value !== 'string' || m.value.length > RV_VALUE_MAX) return null;
      try { deps.set(nsKey(ns, key), m.value); } catch { /* 용량·차단 — 문서 쪽이 다음 get 에서 없음을 본다 */ }
      return null;
    }
    case 'del': {
      if (!key) return null;
      try { deps.del(nsKey(ns, key)); } catch { /* 위와 같음 */ }
      return null;
    }
    case 'copy': {
      const text = typeof m.text === 'string' ? m.text : '';
      const html = typeof m.html === 'string' ? m.html : '';
      if (!text && !html) return { lv: 'rv', op: 'copied', ok: false };
      let ok = false;
      try { ok = await deps.copy(text, html); } catch { ok = false; }
      return { lv: 'rv', op: 'copied', ok: !!ok };
    }
    case 'download': {
      const text = typeof m.text === 'string' ? m.text : null;
      if (text === null || text.length > RV_VALUE_MAX * 4) return null;
      const name = safeDownloadName(typeof m.name === 'string' ? m.name : '');
      const mime = typeof m.mime === 'string' && MIME_RE.test(m.mime) ? m.mime : 'text/plain';
      try { deps.download(name, text, mime); } catch { /* 내려받기 막힘 — 문서 쪽 시트 대안이 있다 */ }
      return null;
    }
    case 'pos-get': {
      if (!deps.getPos) return null;
      let pos: ScrollPos | null = null;
      try { pos = cleanPos(deps.getPos(ns)); } catch { pos = null; }
      return { lv: 'rv', op: 'pos', pos };
    }
    case 'pos-set': {
      const pos = cleanPos(m.pos);
      if (!pos || !deps.setPos) return null;
      try { deps.setPos(ns, pos); } catch { /* 차단·용량 — 다음에 맨 위에서 시작할 뿐이다 */ }
      return null;
    }
    default:
      return null;
  }
}

/** 셸의 클립보드 — 서식(text/html)과 글자를 함께 쓰고, 안 되면 글자만. 사용자 손짓(프레임 안 클릭)은 조상 창에도 전해져 여기서 쓸 수 있다. */
async function copyToClipboard(text: string, html: string): Promise<boolean> {
  const cb = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!cb) return false;
  try {
    if (html && typeof ClipboardItem !== 'undefined' && typeof cb.write === 'function') {
      await cb.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text || html.replace(/<[^>]+>/g, '')], { type: 'text/plain' }) })]);
      return true;
    }
  } catch { /* 서식 쓰기 거절 — 글자만 */ }
  try { await cb.writeText(text || html); return true; } catch { return false; }
}

/** 셸에서 파일로 내려받게 한다(문서가 만든 백업 JSON 등). */
function downloadText(name: string, text: string, mime: string): void {
  const u = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = u; a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(u), 10_000);
}

//  보던 자리는 파일마다 키를 따로 만들지 않고 **한 키의 표**에 둔다 — 문서를 열 때마다 저장소 키가 하나씩 늘면
//   안 된다. 최근 것 POS_KEEP 개만 남긴다(오래 안 연 문서는 맨 위에서 시작해도 된다).
export const POS_STORE_KEY = 'lv.fpPos.v1';
export const POS_KEEP = 100;
type PosTable = Record<string, ScrollPos & { t: number }>;
function readPosTable(): PosTable {
  try { const v = JSON.parse(localStorage.getItem(POS_STORE_KEY) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
function writePos(ns: string, pos: ScrollPos): void {
  const tb = readPosTable();
  tb[ns] = { ...pos, t: Date.now() };
  const keys = Object.keys(tb);
  if (keys.length > POS_KEEP) keys.sort((a, b) => (tb[b].t || 0) - (tb[a].t || 0)).slice(POS_KEEP).forEach((k) => { delete tb[k]; });
  try { localStorage.setItem(POS_STORE_KEY, JSON.stringify(tb)); } catch { /* 차단·용량 */ }
}

/** 브라우저 localStorage 를 쓰는 기본 의존 — 막혀 있으면(사파리 비공개 등) 없는 것처럼 군다. */
export function browserDeps(): BridgeDeps {
  return {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 차단·용량 */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* 차단 */ } },
    copy: copyToClipboard,
    download: downloadText,
    getPos: (ns) => cleanPos(readPosTable()[ns]),
    setPos: writePos,
  };
}

/**
 * 문서 쪽 «보던 자리» 스크립트 — withScrollKeeper 가 문서 끝에 붙인다. 문서의 전역을 더럽히지 않게 즉시 실행 함수 하나.
 *  · 적기: 스크롤 이벤트 **그 순간**의 자리를 잡아 두고 250ms 뒤에 보낸다(숨긴 프레임은 scrollY 를 0 으로 읽는다 — 늦게 읽으면 0 을 적는다).
 *    칸 스크롤은 창 높이의 절반 이상인 칸만 — 옆으로 넘기는 작은 띠(캐러셀)가 본문 자리를 덮지 않게.
 *  · 되돌리기: 새로 서면 셸에 묻고, 받은 자리로 간다. 스크립트가 그리는 문서는 처음엔 짧다 — 닿을 때까지(최대 4초) 다시 해 보고,
 *    사람이 먼저 굴리거나 누르면 곧바로 손을 뗀다(사람의 손이 이긴다). 되돌리는 동안의 스크롤은 적지 않는다.
 *  · 크롬 아닌 브라우저가 숨김에서 자리를 잃으면 — 다시 보여 창 크기가 돌아올 때(resize) 마지막 자리로 한 번 더 간다.
 *  · ★ 리눅스 크롬은 숨겼다(display:none) 보이면 **맨 위(0)로 가며 scroll 이벤트를 쏜다**(맥 크롬은 제자리 · resize·IntersectionObserver
 *    는 둘 다 안 온다 — 2026-10-01 도커 Chromium 실측, CI 에서 처음 드러남). 그 0 을 적으면 보던 자리가 지워진다. 그래서
 *    **사람 입력(휠·키·누르기·터치) 없이** 0 이 아닌 자리에서 (0,0) 으로 뛴 것은 브라우저의 배치 초기화로 보고 되돌린다.
 *    사람이 맨 위로 올리면 늘 입력이 먼저 온다(RESET_QUIET_MS 안) — 그건 그대로 적는다.
 */
const RESET_QUIET_MS = 1500;   // 마지막 사람 입력 뒤 이만큼 조용하면 (0,0) 도약은 사람 것이 아니다(트랙패드 관성 스크롤도 휠 이벤트를 계속 낸다)
const SCROLL_KEEPER_JS = `(function(){try{
if(window.__lvPosKeeper||window.parent===window)return;window.__lvPosKeeper=1;
var P=window.parent,D=document,rec=null,tmr=0,restoring=false,handsOn=false,lastIn=0;
function root(){return D.scrollingElement||D.documentElement;}
function pathOf(e){var a=[];while(e&&e!==D.documentElement){var p=e.parentElement;if(!p||a.length>=${RV_POS_PATH_MAX})return null;a.unshift(Array.prototype.indexOf.call(p.children,e));e=p;}return e?a.join('.'):null;}
function byPath(s){var e=D.documentElement,a=s.split('.');for(var i=0;i<a.length&&e;i++)e=e.children[+a[i]];return e||null;}
function tgt(p){return p?byPath(p):root();}
function at(p){var e=tgt(p);return e?{x:e.scrollLeft,y:e.scrollTop}:null;}
function go(q){var e=tgt(q.p);if(!e)return false;if(!q.p)window.scrollTo(q.x,q.y);else{e.scrollLeft=q.x;e.scrollTop=q.y;}var c=at(q.p);return !!c&&Math.abs(c.y-q.y)<2&&Math.abs(c.x-q.x)<2;}
function send(){tmr=0;if(rec)try{P.postMessage({lv:'rv',op:'pos-set',pos:rec},'*');}catch(_){}}
D.addEventListener('scroll',function(ev){if(restoring)return;var t=ev.target,r;
 if(t===D||t===D.documentElement||t===D.body&&t===root()){var c=root();r={x:c.scrollLeft,y:c.scrollTop};}
 else if(t&&t.nodeType===1&&t.clientHeight>=innerHeight*0.5){var p=pathOf(t);if(!p)return;r={x:t.scrollLeft,y:t.scrollTop,p:p};}
 else return;
 if(rec&&!r.x&&!r.y&&(rec.x||rec.y)&&(rec.p||'')===(r.p||'')&&Date.now()-lastIn>${RESET_QUIET_MS}){var q=rec;restoring=true;go(q);setTimeout(function(){restoring=false;},50);return;}
 rec=r;if(!tmr)tmr=setTimeout(send,250);},true);
function hands(){handsOn=true;restoring=false;lastIn=Date.now();}
['wheel','touchstart','pointerdown','keydown'].forEach(function(n){addEventListener(n,hands,{capture:true,passive:true});});
addEventListener('pagehide',function(){if(tmr){clearTimeout(tmr);send();}});
addEventListener('resize',function(){if(!rec||restoring)return;var q=rec;setTimeout(function(){var c=at(q.p);if(c&&c.y===0&&c.x===0&&(q.y>0||q.x>0)){restoring=true;go(q);setTimeout(function(){restoring=false;},50);}},0);});
addEventListener('message',function(ev){var d=ev.data;if(ev.source!==P||!d||d.lv!=='rv'||d.op!=='pos'||!d.pos||handsOn)return;
 var q=d.pos,t0=Date.now();if(!(q.y>0||q.x>0))return;rec=q;restoring=true;
 (function step(){if(handsOn){restoring=false;return;}var ok=go(q);if((ok&&D.readyState==='complete')||Date.now()-t0>4000){setTimeout(function(){restoring=false;},50);return;}setTimeout(step,100);})();});
P.postMessage({lv:'rv',op:'pos-get'},'*');
}catch(_){}})();`;

/**
 * html 문서에 «보던 자리» 스크립트를 붙인다 — **끝에** 붙인다: 앞에 두면 <!doctype> 보다 먼저 나와 문서가 쿼크 모드가 된다.
 *  </html> 뒤의 <script> 는 파서가 body 끝에 넣어 그대로 돈다. 문서가 CSP 로 인라인 스크립트를 막았으면 조용히 안 돌 뿐이다.
 *  다리(attachFrameBridge)가 걸린 프레임에서만 뜻이 있다 — 셸이 답하지 않으면 문서는 맨 위에서 시작한다(종전과 같다).
 */
export function withScrollKeeper(html: string): string {
  return html + '\n<script>' + SCROLL_KEEPER_JS + '</script>';
}

/**
 * 프레임에 다리를 건다. 돌려주는 함수가 뗀다 — 부른 쪽이 다른 파일을 펼 때 부른다.
 *  프레임이 문서에서 빠진 뒤 오는 메시지는 없지만(창이 사라진다), 안전하게 그때도 스스로 뗀다.
 */
export function attachFrameBridge(frame: HTMLIFrameElement, ns: string, deps: BridgeDeps = browserDeps()): () => void {
  const onMsg = (ev: MessageEvent): void => {
    if (!frame.isConnected) { window.removeEventListener('message', onMsg); return; }
    if (!ev.source || ev.source !== frame.contentWindow) return;
    void handleBridgeMessage(ev.data, ns, deps).then((reply) => { if (reply) frame.contentWindow?.postMessage(reply, '*'); });
  };
  window.addEventListener('message', onMsg);
  return () => window.removeEventListener('message', onMsg);
}
