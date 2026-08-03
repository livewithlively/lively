// filepage.ts — 공유 링크의 착지 화면(#1436): `#/f?root=<shared|personal>&path=<rel>`.
//
// ## 무엇인가
//  공유 워크스페이스·개인 폴더의 파일·폴더 **하나만** 보여주는 전체 페이지다. 상단 탭·사이드바 같은 앱 내비게이션이
//  없다(main.ts 가 data-route="f" 를 세우고 32-file-share.css 가 셸을 감춘다) — 링크를 받은 사람이 "무엇을 봐야
//  하는지" 찾지 않아도 되게. 대신 그 파일에 필요한 것만 상단 바에 둔다: 이름·경로 · 링크 복사 · 다운로드 ·
//  (md/html) 렌더↔원문 토글 · Lively 앱으로 나가는 문.
//
// ## 표시 규칙 (요구 원문 그대로)
//  md·html = 렌더 · pdf = 브라우저 내장 PDF 뷰어 · 이미지/표(csv·tsv)/음성/영상/텍스트·코드 = 제자리 미리보기 ·
//  그 외 = 다운로드 버튼. 타입 판정표(확장자·MIME·상한)는 대시보드 폴더 브라우저와 **같은 한 벌**을 쓴다
//  (dash/widget-folders-preview.ts) — 같은 파일이 화면에 따라 다르게 열리면 그게 곧 버그로 신고된다.
//
// ## html 은 왜 iframe(sandbox)인가
//  아래 renderHtml 주석 참조. 요약: 같은 오리진에서 남이 올린 html 을 그냥 심으면 저장형 XSS(세션 쿠키·토큰 탈취)다.
//
// ## 권한
//  이 화면은 특권이 없다 — 파일을 읽는 API 가 기존 게이트(공유폴더 ACL + 프로젝트 가시성)를 그대로 집행한다.
//  안 보이는 경로는 목록에서 빠지므로 여기선 '찾을 수 없음'으로 보인다(존재 은닉 정책과 같은 결).
import { TOKEN_KEY, api, apiUrl, el, errorNote, renderMarkdown, toast } from './core.js';
import { copyFileLink, fileLinkHash, joinRel, shareLinkIcon, shareRootLabel } from './lib/sharelink.js';
import {
  DASH_AUDIO_MIME, DASH_IMG_MIME, DASH_MEDIA_MAX, DASH_PREVIEW_CODE, DASH_PREVIEW_IMG,
  DASH_PREVIEW_TABLE, DASH_PREVIEW_TEXT, DASH_VIDEO_MIME, dashFileExt, dashTablePreview,
} from './dash/widget-folders-preview.js';
import { dashFileThumb, dashFolderThumb } from './dash/icons.js';
import { fmtFileDateFull, fmtSize } from './projects/files-format.js';

// 확장자 없는 흔한 텍스트 파일 — 목록에서 클릭했을 때 '미지원'으로 떨어지지 않게(터미널 미리보기와 같은 목록).
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'license', 'readme', 'changelog', 'agents.md', '.gitignore', '.env']);
const HTML_EXTS = new Set(['html', 'htm']);
const MD_EXTS = new Set(['md', 'markdown']);

// 인증 fetch — **apiUrl 경유**가 중요하다: 프리뷰 서브패스(/preview/<id>/ui/)에서 뜬 화면이 fetch('/api/…')를
//  그대로 쓰면 오리진 루트(=라이브 게이트웨이)로 새어 '새 프론트 + 구 백엔드'를 본다(lib/net.ts 헤더 주석).
//  ⚠ dash/widget-folders-preview.ts 의 dashAuthFetch 는 그 버그가 남아 있어(그 파일 주석에 명시) 여기서 쓰지 않는다.
function fileFetch(url: string): Promise<Response> {
  const t = localStorage.getItem(TOKEN_KEY);
  return fetch(apiUrl(url), { headers: t ? { Authorization: 'Bearer ' + t } : {} });
}

const browseQs = (root: string, rel: string): string =>
  'root=' + encodeURIComponent(root) + '&path=' + encodeURIComponent(rel || '');

/** 라우터 진입점 — #/f?root=&path= 를 그린다. */
async function renderFilePage(view, params): Promise<void> {
  const root = String(params.get('root') || 'shared');
  const rel = String(params.get('path') || '').replace(/^\/+|\/+$/g, '');
  const name = rel ? rel.split('/').pop()! : shareRootLabel(root);

  const stage = el('div', { class: 'fpg-stage' }, el('div', { class: 'fpg-msg', text: '불러오는 중…' }));
  const acts = el('div', { class: 'fpg-acts' });
  const head = el('header', { class: 'fpg-head' },
    el('div', { class: 'fpg-idbox' },
      el('div', { class: 'fpg-name', title: name, text: name }),
      crumb(root, rel)),
    acts);
  view.replaceChildren(el('div', { class: 'fpg' }, head, stage));

  // 루트 자신은 언제나 폴더 — 부모가 없어 아래 '부모 목록에서 나를 찾기'가 성립하지 않는다.
  if (!rel) { await showDir(root, '', stage, acts); return; }

  // 타입(파일/폴더)·크기는 **부모 목록**에서 얻는다. 파일에 stat 라우트가 따로 없고, 목록 응답은 공개범위
  //  게이트를 이미 통과한 것만 담으므로 "권한 없음"과 "없음"이 같은 답(안 보임)으로 수렴한다 — 존재 은닉 유지.
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  let entry: any = null;
  try {
    const d = await api('/api/ui/terminal/browse?' + browseQs(root, parent));
    entry = ((d && d.items) || []).find((i) => i.name === name) || null;
  } catch (e: any) {
    stage.replaceChildren(errorNote(e, '이 링크를 열지 못했습니다'));
    acts.replaceChildren(...tailActions(root, rel, 'file'));
    return;
  }
  if (!entry) {
    stage.replaceChildren(el('div', { class: 'fpg-msg fpg-msg-empty' },
      el('b', { text: '이 링크의 대상을 찾을 수 없어요' }),
      el('span', { text: '파일이 옮겨졌거나 이름이 바뀌었을 수 있어요. 볼 권한이 없을 때도 같게 보입니다 — 공유한 사람에게 확인해 주세요.' }),
      el('div', { class: 'fpg-msg-path', text: shareRootLabel(root) + ' / ' + rel })));
    acts.replaceChildren(...tailActions(root, rel, 'file'));
    return;
  }
  if (entry.type === 'dir') { await showDir(root, rel, stage, acts); return; }
  await showFile(root, rel, name, entry, stage, acts);
}

// 경로 브레드크럼 — 각 조각이 그 폴더의 공유 링크다(같은 페이지 안에서 위로 걸어 올라갈 수 있게).
function crumb(root: string, rel: string): any {
  const box = el('nav', { class: 'fpg-crumb', 'aria-label': '경로' },
    el('a', { class: 'fpg-crumb-seg', href: fileLinkHash(root, ''), text: shareRootLabel(root) }));
  let acc = '';
  for (const seg of (rel ? rel.split('/') : [])) {
    acc = acc ? acc + '/' + seg : seg;
    box.append(el('span', { class: 'fpg-crumb-sep', text: '/' }),
      el('a', { class: 'fpg-crumb-seg', href: fileLinkHash(root, acc), text: seg }));
  }
  return box;
}

// 어느 화면에서나 붙는 꼬리 액션 — 링크 복사 + (파일이면) 다운로드 + 앱으로 나가는 문.
//  '앱에서 보기'를 두는 이유: 이 페이지는 의도적으로 막다른 길(내비 없음)이라, 받은 사람이 Lively 를 처음
//  본 경우 여기서 조직 화면으로 들어갈 문이 하나는 있어야 한다.
function tailActions(root: string, rel: string, kind: 'file' | 'dir', dlUrl?: string): any[] {
  const out: any[] = [];
  out.push(el('button', { class: 'fpg-btn fpg-btn-primary', type: 'button', title: '이 ' + (kind === 'dir' ? '폴더' : '파일') + '의 링크 복사',
    onclick: () => copyFileLink(root, rel, kind) }, shareLinkIcon(15), el('span', { text: '링크 복사' })));
  if (kind === 'file' && dlUrl) {
    out.push(el('button', { class: 'fpg-btn', type: 'button', text: '⬇ 다운로드', onclick: () => download(dlUrl, rel.split('/').pop() || 'file') }));
  }
  out.push(el('a', { class: 'fpg-btn fpg-btn-ghost', href: '#/dashboard', title: 'Lively 홈으로', text: 'Lively ↗' }));
  return out;
}

// 인증 다운로드 — <a download> 는 헤더를 실을 수 없어 blob 을 거친다(projects/files-upload.authDownload 와 같은 수).
async function download(url: string, name: string): Promise<void> {
  try {
    const res = await fileFetch(url);
    if (!res.ok) throw new Error('' + res.status);
    const href = URL.createObjectURL(await res.blob());
    const a = el('a', { href, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1500);
  } catch (e: any) { toast('다운로드 실패 — ' + (e.message || e), true); }
}

// ── 폴더 ────────────────────────────────────────────────────────────────────
//  폴더 링크는 '이 폴더를 열어 보라'는 뜻이므로 목록을 준다(파일마다 링크를 다시 뿌리지 않아도 되게 행마다 🔗).
//  여기선 업로드·삭제 같은 편집을 일부러 넣지 않는다 — 공유받은 사람의 화면이고, 편집 표면은 앱 안에 이미 있다.
async function showDir(root: string, rel: string, stage, acts): Promise<void> {
  acts.replaceChildren(...tailActions(root, rel, 'dir'));
  let data: any;
  try { data = await api('/api/ui/terminal/browse?' + browseQs(root, rel)); }
  catch (e: any) { stage.replaceChildren(errorNote(e, '폴더를 불러오지 못했습니다')); return; }
  const items = (data && data.items) || [];
  if (!items.length) { stage.replaceChildren(el('div', { class: 'fpg-msg', text: '빈 폴더입니다.' })); return; }
  const list = el('div', { class: 'fpg-list' },
    el('div', { class: 'fpg-row fpg-row-head' },
      el('span', { class: 'fpg-row-ic' }), el('span', { class: 'fpg-row-nm', text: '이름' }),
      el('span', { class: 'fpg-row-sz', text: '크기' }), el('span', { class: 'fpg-row-dt', text: '수정 일시' }),
      el('span', { class: 'fpg-row-act' })));
  for (const it of items) {
    const childRel = joinRel(rel, it.name);
    const isDir = it.type === 'dir';
    list.append(el('a', { class: 'fpg-row' + (isDir ? ' is-dir' : ''), href: fileLinkHash(root, childRel), title: it.name },
      el('span', { class: 'fpg-row-ic' }, isDir ? dashFolderThumb() : dashFileThumb(it.name)),
      el('span', { class: 'fpg-row-nm', text: it.name }),
      el('span', { class: 'fpg-row-sz', text: isDir ? '' : fmtSize(it.size) }),
      el('span', { class: 'fpg-row-dt', text: fmtFileDateFull(it.mtime) }),
      el('span', { class: 'fpg-row-act' },
        el('button', { class: 'fpg-rowbtn', type: 'button', title: '링크 복사', 'aria-label': '링크 복사',
          onclick: (ev: any) => { ev.preventDefault(); ev.stopPropagation(); copyFileLink(root, childRel, isDir ? 'dir' : 'file'); } },
        shareLinkIcon(13)))));
  }
  stage.replaceChildren(list);
}

// ── 파일 ────────────────────────────────────────────────────────────────────
async function showFile(root: string, rel: string, name: string, entry: any, stage, acts): Promise<void> {
  const ext = dashFileExt(name);
  const viewUrl = '/api/ui/terminal/browse/file?' + browseQs(root, rel);
  const dlUrl = '/api/ui/terminal/browse/file?download=1&' + browseQs(root, rel);
  const size = Number(entry && entry.size) || 0;
  // md·html 은 렌더가 기본, 원문은 토글로. 다른 형식엔 이 버튼을 아예 안 만든다(빈 버튼 자리를 남기지 않는다).
  const toggle = el('button', { class: 'fpg-btn', type: 'button', text: '</> 원문' });
  const withToggle = (nodes: any[]): any[] => [toggle, ...nodes];
  const tail = tailActions(root, rel, 'file', dlUrl);
  acts.replaceChildren(...tail);

  const fail = (msg: any): void => { stage.replaceChildren(el('div', { class: 'fpg-msg', text: msg })); };
  const tooBig = (res: Response): boolean => res.status === 413;
  const readable = async (url: string, what: string): Promise<Response | null> => {
    const res = await fileFetch(url);
    if (res.ok) return res;
    fail(tooBig(res)
      ? what + '이(가) 커서 미리보기할 수 없어요 — [⬇ 다운로드] 로 확인하세요.'
      : '미리보기를 불러오지 못했어요 (' + res.status + ')');
    return null;
  };

  try {
    if (DASH_PREVIEW_IMG.includes(ext)) {
      const res = await readable(viewUrl, '이미지'); if (!res) return;
      const img = el('img', { class: 'fpg-img', alt: name });
      img.src = URL.createObjectURL(new Blob([await res.blob()], { type: DASH_IMG_MIME[ext] || 'application/octet-stream' }));
      stage.replaceChildren(img);
    } else if (ext === 'pdf') {
      // 브라우저 내장 PDF 뷰어(요구: "바로 해당 브라우저의 pdf미리보기로"). blob 에 MIME 을 명시해야 iframe 이
      //  뷰어를 띄운다(안 하면 %PDF 원시바이트가 텍스트로 노출된다 — files-cards.ts 가 같은 함정을 이미 적어뒀다).
      //  전체 페이지라 썸네일 사이드바(navpanes)를 켜 둔다 — 모달과 달리 폭이 넉넉해 목차가 쓸모 있다.
      const res = await readable(viewUrl, 'PDF'); if (!res) return;
      const frame = el('iframe', { class: 'fpg-pdf', title: name });
      frame.src = URL.createObjectURL(new Blob([await res.blob()], { type: 'application/pdf' })) + '#toolbar=1&view=FitH';
      stage.replaceChildren(frame);
    } else if (MD_EXTS.has(ext)) {
      const res = await readable(viewUrl, '파일'); if (!res) return;
      const text = await res.text();
      let raw = false;
      const paint = (): void => {
        stage.replaceChildren(raw
          ? codeBlock(text, ext)
          : el('article', { class: 'md-rendered fpg-md' }, renderMarkdown(text)));
        toggle.textContent = raw ? '👁 렌더 보기' : '</> 원문';
      };
      toggle.onclick = () => { raw = !raw; paint(); };
      acts.replaceChildren(...withToggle(tail));
      paint();
    } else if (HTML_EXTS.has(ext)) {
      const res = await readable(viewUrl, '파일'); if (!res) return;
      const text = await res.text();
      let raw = false;
      const paint = (): void => {
        stage.replaceChildren(raw ? codeBlock(text, ext) : renderHtml(text, name));
        toggle.textContent = raw ? '👁 렌더 보기' : '</> 원문';
      };
      toggle.onclick = () => { raw = !raw; paint(); };
      acts.replaceChildren(...withToggle(tail));
      paint();
    } else if (DASH_PREVIEW_TABLE.has(ext)) {
      const res = await readable(viewUrl, '파일'); if (!res) return;
      stage.replaceChildren(el('div', { class: 'fpg-table' }, dashTablePreview(await res.text(), ext === 'tsv' ? '\t' : ',')));
    } else if (DASH_AUDIO_MIME[ext] || DASH_VIDEO_MIME[ext]) {
      // 미디어는 인라인 상한(서버 MAX_PREVIEW)을 넘기 쉬워 download=1 로 받고, 메모리 보호는 클라 상한으로.
      if (size && size > DASH_MEDIA_MAX) { fail('파일이 커서(' + fmtSize(size) + ') 미리보기 대신 [⬇ 다운로드] 로 확인하세요.'); return; }
      const res = await readable(dlUrl, '파일'); if (!res) return;
      const isVid = !!DASH_VIDEO_MIME[ext];
      const src = URL.createObjectURL(new Blob([await res.blob()], { type: isVid ? DASH_VIDEO_MIME[ext] : DASH_AUDIO_MIME[ext] }));
      stage.replaceChildren(el(isVid ? 'video' : 'audio',
        { class: isVid ? 'fpg-video' : 'fpg-audio', src, controls: 'true', preload: 'metadata', playsinline: 'true' }));
    } else if (DASH_PREVIEW_TEXT.includes(ext) || !ext || TEXT_NAMES.has(name.toLowerCase())) {
      const res = await readable(viewUrl, '파일'); if (!res) return;
      let text = await res.text();
      if (ext === 'json') { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* 원문 유지 */ } }
      stage.replaceChildren(codeBlock(text, ext));
    } else {
      // 미리보기 미지원 — 요구대로 '다운로드 버튼'을 화면 가운데에 크게(상단 바에도 있지만 여기가 이 화면의 결론이다).
      stage.replaceChildren(el('div', { class: 'fpg-msg fpg-msg-empty' },
        el('b', { text: '이 형식은 미리보기를 지원하지 않아요' }),
        el('span', { text: (ext ? '.' + ext + ' 파일은' : '이 파일은') + ' 브라우저에서 그려 줄 수 없어요 — 내려받아 확인하세요.' }),
        el('div', { class: 'fpg-msg-path', text: name + ' · ' + fmtSize(size) }),
        el('button', { class: 'fpg-btn fpg-btn-primary fpg-btn-lg', type: 'button', text: '⬇ 다운로드', onclick: () => download(dlUrl, name) })));
    }
  } catch (e: any) { fail('미리보기 실패 — ' + ((e && e.message) || e)); }
}

function codeBlock(text: string, ext: string): any {
  const pre = el('pre', { class: 'fpg-code' + (DASH_PREVIEW_CODE.has(ext) ? ' is-code' : '') });
  pre.textContent = text;
  return pre;
}

/**
 * html 렌더 — **sandbox iframe + srcdoc**.
 *  이 파일들은 남이 올린 임의의 html 이다. innerHTML 로 같은 문서에 심으면 그 안의 <script> 가 우리 오리진에서
 *  돌아 세션 쿠키·localStorage 토큰을 그대로 가져갈 수 있다(저장형 XSS). 그래서:
 *   · srcdoc + sandbox → 문서가 **불투명 오리진**을 갖는다(allow-same-origin 을 주지 않는 것이 핵심).
 *     부모 DOM·쿠키·localStorage 에 손이 닿지 않는다.
 *   · allow-scripts 는 준다 — 스크립트로 그리는 보고서(차트 등)가 아예 백지로 뜨면 '렌더해서 보여주자'가
 *     성립하지 않는다. 불투명 오리진이라 스크립트가 있어도 우리 자격증명엔 닿지 못한다.
 *     (⚠ allow-scripts 와 allow-same-origin 을 **함께** 주면 샌드박스가 스스로 풀린다 — 절대 같이 주지 말 것.)
 *   · allow-top-navigation 은 주지 않는다 → 이 페이지를 피싱 사이트로 갈아치울 수 없다.
 *   · 링크는 새 탭으로만 열리게 allow-popups(+escape-sandbox) — 그것마저 막으면 문서 안 링크가 죽은 것처럼 보인다.
 *  한계(정직하게): srcdoc 문서엔 base URL 이 없어 상대경로 <img src="a.png">·외부 css 는 안 붙는다.
 *   자기완결 html(단일 파일 보고서)이 이 기능의 대상이고, 아니라면 다운로드해서 보는 게 맞다.
 */
function renderHtml(text: string, name: string): any {
  const frame = el('iframe', {
    class: 'fpg-html', title: name,
    sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals',
    referrerpolicy: 'no-referrer',
  });
  frame.srcdoc = text;
  return frame;
}

export { renderFilePage };
