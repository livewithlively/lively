// filepage.ts — 파일 링크의 착지 화면 «자료 보기»(#1436 → #4672): `#/f?root=<shared|personal|apps>&path=<rel>`.
//
// ## 무엇인가
//  링크 하나가 가리키는 파일·폴더를 **워크스페이스 안에서 자료로** 보여 준다(#4672 — 상민님 2026-10-14 «구글 드라이브처럼: 링크는 바로
//  내려받기가 아니라 워크스페이스 화면에서 자료로 조회되고, 거기서 내려받기»). 미리보기 · 정보 칸(종류 · 크기 · 고친 때 · 위치 · 주소 ·
//  볼 수 있는 사람 · 올린 사람 · 여기서 나온 지식) · 속한 프로젝트 · 앱으로 가는 문 · 내려받기 · 링크 복사.
//  · 새 셸(v2 — 제품 기본)은 자료 앱의 한 화면으로 셸 안에 그린다(web/v2/main.ts 의 'f' 갈래 → renderFileView).
//  · 클래식 셸은 상단바를 둔 채 본문 자리에 그린다(renderFilePage). #1436 의 첫 판은 앱 내비를 감춘 전체 페이지였다.
//  · 새 셸이 실은 클래식 액자(?embed=1) 안에서 이 주소로 오면 셸 창의 주소를 옮긴다 — 셸이 자기 화면으로 연다.
//  두 셸이 같은 이 코드를 쓴다 — 셸마다 다른 것(자료 앱 문 · 앱 열기 · 앱 동의 창)은 새 셸이 FileViewEnv 로 꽂는다.
//
// ## 표시 규칙 (요구 원문 그대로)
//  md·html = 렌더 · pdf = 브라우저 내장 PDF 뷰어 · 이미지/표(csv·tsv)/음성/영상/텍스트·코드 = 제자리 미리보기 ·
//  그 외 = 다운로드 버튼. 판정·렌더는 공용 렌더러(lib/file-preview — 홈 모달·프로젝트 모달·자료 앱과 같은 한 벌)가 소유한다.
//
// ## html 은 왜 iframe(sandbox)인가
//  공용 렌더러 주석 참조. 요약: 같은 오리진에서 남이 올린 html 을 그냥 심으면 저장형 XSS(세션 쿠키·토큰 탈취)다.
//
// ## 권한
//  이 화면은 특권이 없다 — 정보(GET browse/info) · 미리보기 · 내려받기가 전부 기존 판정(공유 폴더 공개범위 + 프로젝트 공개범위 · 앱 폴더는
//  그 앱 동의)을 그대로 지난다. 안 보이는 자리는 «찾을 수 없음» 으로 보인다(존재 은닉 — 없는 것과 같은 답).
//  · 앱 폴더만 하나 다르다(#4671 ③ 결정 1): 그 앱이 보이는데 아직 동의하지 않은 사람에게는 동의 안내를 그린다(서버가 403 app_consent_required).
//  · 옮긴 파일의 옛 링크(#4688)도 같다 — 서버가 옛 경로와 닿은 자리를 둘 다 이 사람 기준으로 판정한 뒤에만 새 자리를 답한다.
//  · 셸 `mv` 로 옮긴 것은 서버가 모른다(기록 없음) — «옮겨졌거나 지워졌을 수 있어요» + 같은 이름 후보(browse/similar, 후보도 하나하나 판정을 지난다).
import { TOKEN_KEY, api, apiUrl, el, errorNote, personDisplayName, replaceKids, sv, toast } from './core.js';
import { iconPath } from './lib/icon-paths.js';
import { copyFileLink, fileLinkHash, joinRel, shareLinkIcon, shareRootLabel } from './lib/sharelink.js';
import { buildFilePreview } from './lib/file-preview.js';   // 미리보기 판정·렌더의 단일 소유(세 화면 공용)
import { dashFileThumb, dashFolderThumb } from './dash/icons.js';
import { fmtFileDateFull, fmtSize } from './projects/files-format.js';

/** 셸마다 다른 것 — 새 셸만 꽂는다(클래식엔 자료 앱 · 앱 화면이 없다). 없으면 그 문을 그리지 않는다. */
export interface FileViewEnv {
  /** 자료 앱에서 그 자료를 여는 주소(#/sources/<id>) */
  sourceHref?: (id: number) => string;
  /** 앱을 연다 — 앱 찾기에서 누를 때와 같은 규칙 */
  openApp?: (appId: string, title: string) => void;
  /** 앱 사용 동의 창 — 동의하면 true */
  consent?: (appId: string, title: string) => Promise<boolean>;
  /** 이 그림이 아직 이 자리의 것인가 — 기다리는 사이 다른 화면으로 갔으면 그리지 않는다. 없으면 «주소가 그대로인가»(클래식은 본창이 하나다).
   *  새 셸은 탭마다 본창이 따로라 «그 탭이 아직 이 링크를 보는가» 로 잰다 — 주소로 재면 다른 탭을 보는 동안 이 탭이 «불러오는 중» 에 굳는다. */
  isCurrent?: () => boolean;
  /** 옮긴 파일의 새 자리로 넘긴다 — 없으면 주소창을 바꾼다(location.replace). 새 셸은 **그 탭의** 주소를 바꾼다(다른 탭을 보고 있으면 끌고 오지 않는다). */
  replaceRoute?: (hash: string) => void;
}

/** GET /api/ui/terminal/browse/info 의 답(src/files/file-view.ts FileViewInfo 와 같은 모양) */
interface FileInfo {
  root: string; path: string; name: string; type: 'file' | 'dir'; size: number; mtime: number;
  address: string | null;
  place: { kind: 'project'; id: number; name: string; folder: string } | { kind: 'app'; id: string; name: string } | { kind: 'folder'; folder: string } | { kind: 'personal' };
  locked: boolean;
  source: null | { id: number; title: string | null; entry: string | null; uploaderId: string | null; uploaderName: string | null; createdAt: string | null; knowledge: Array<{ name: string; title: string | null }> };
}
interface Entry { type: 'file' | 'dir'; size?: number; mtime?: number }
interface SameName { path: string; type: 'file' | 'dir'; size: number; mtime: number }

// 인증 fetch — **apiUrl 경유**가 중요하다: 프리뷰 서브패스(/preview/<id>/ui/)에서 뜬 화면이 fetch('/api/…')를
//  그대로 쓰면 오리진 루트(=라이브 게이트웨이)로 새어 '새 프론트 + 구 백엔드'를 본다(lib/net.ts 헤더 주석).
//  ⚠ dash/widget-folders-preview.ts 의 dashAuthFetch 는 그 버그가 남아 있어(그 파일 주석에 명시) 여기서 쓰지 않는다.
function fileFetch(url: string): Promise<Response> {
  const t = localStorage.getItem(TOKEN_KEY);
  return fetch(apiUrl(url), { headers: t ? { Authorization: 'Bearer ' + t } : {} });
}

const browseQs = (root: string, rel: string): string =>
  'root=' + encodeURIComponent(root) + '&path=' + encodeURIComponent(rel || '');

// ── 옮긴 파일의 옛 링크(#4688) ──────────────────────────────────────────────
//  웹·API 로 이름을 바꾸거나 옮기면 서버가 «옛 경로 → 새 경로» 를 남긴다. 여기서 대상을 못 찾으면 그 기록을 물어(GET browse/moved)
//  지금 자리로 넘긴다 — 서버가 닿은 자리를 **이 사람 기준으로 다시 판정**한 뒤에만 답하므로 이 화면은 특권이 없다(위 «권한»).
//  주소창에는 새 주소만 남긴다(replace — 뒤로가기가 옛 주소로 돌아와 다시 넘기는 고리가 없다 · 링크 복사도 새 주소).
//  «옮겨진 파일이에요» 한 줄은 넘어온 직후 한 번만 — 넘어간 자리에서 또 못 찾으면 더 따라가지 않는다(서버가 단계 상한을 진다).
//  안내는 **그린 자리(host)마다** 따로 둔다 — 새 셸은 탭마다 본창이 따로라, 하나를 두면 다른 탭이 먼저 그릴 때 지워 버린다
//  (보고 있지 않은 탭을 옛 링크로 넘겼다가 돌아오면 안내가 없고, 두 번째 넘기기 막이도 빠진다).
const movedNotices = new WeakMap<object, { root: string; from: string; to: string }>();

/** 옛 경로의 지금 자리 — 기록이 없거나 · 지금 그 자리를 볼 수 없거나 · 옛 자리에 무엇이 있으면 null(종전 안내 그대로). */
async function movedTo(root: string, rel: string): Promise<string | null> {
  try {
    const d = await api('/api/ui/terminal/browse/moved?' + browseQs(root, rel));
    const to = d && d.moved && typeof d.path === 'string' ? d.path : '';
    return to && to !== rel ? to : null;
  } catch (_) { return null; }
}

/** 같은 이름 후보(#4672) — 셸 `mv` 처럼 기록 없이 옮긴 것. 넘기지 않고 후보로만 보인다(짐작이라서). 못 받으면 빈 목록. */
async function sameNameNear(root: string, rel: string): Promise<SameName[]> {
  try {
    const d = await api('/api/ui/terminal/browse/similar?' + browseQs(root, rel));
    return d && Array.isArray(d.items) ? d.items : [];
  } catch (_) { return []; }
}

/**
 * 옛 게이트웨이(browse/info 가 없는 판)에 붙은 화면 — 종전처럼 **부모 목록**에서 찾는다. 목록은 공개범위 판정을 지난 것만 담으므로
 *  «권한 없음» 과 «없음» 이 같은 답(안 보임)으로 수렴한다(존재 은닉 그대로). 새 게이트웨이에선 정보가 404 일 때만 여기 온다.
 */
async function listedEntry(root: string, rel: string): Promise<Entry | null> {
  if (!rel) return { type: 'dir' };
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const name = rel.split('/').pop();
  try {
    const d = await api('/api/ui/terminal/browse?' + browseQs(root, parent));
    return ((d && d.items) || []).find((i: any) => i.name === name) || null;
  } catch (_) { return null; }
}

/** 클래식 라우터 진입점 — #/f?root=&path= 를 그린다. */
async function renderFilePage(view, params): Promise<void> {
  //  새 셸이 실은 클래식 액자 안(다른 화면의 링크를 눌러 이리 왔다)이면 **셸 창의 주소**를 옮긴다 — 셸이 자기 화면(자료 앱의 자료 보기)으로 연다.
  //   액자 안에 그리면 셸의 사이드바 · 탭과 따로 노는 두 번째 화면이 된다(가이드 링크 learn 갈래와 같은 규율). 못 닿으면(다른 오리진) 여기 그린다.
  if (document.body.classList.contains('embed')) {
    try { const top = window.top || window; if (top !== window) { top.location.hash = location.hash; return; } } catch (_) { /* 아래로 */ }
  }
  await paintFileView(view, params, {});
}

/** 새 셸 진입점 — 셸의 본창(탭 중앙)에 그린다(web/v2/main.ts 의 'f' 갈래). */
function renderFileView(host: HTMLElement, params: URLSearchParams, env: FileViewEnv): void {
  void paintFileView(host, params, env);
}

async function paintFileView(host, params, env: FileViewEnv): Promise<void> {
  const root = String(params.get('root') || 'shared');
  const rel = String(params.get('path') || '').replace(/^\/+|\/+$/g, '');
  const name = rel ? rel.split('/').pop()! : shareRootLabel(root);
  const left = movedNotices.get(host);
  movedNotices.delete(host);   // 이 자리는 이제 이 링크를 그린다 — 남은 안내는 이번 한 번만 쓴다
  const arrived = left && left.root === root && left.to === rel ? left : null;
  const startHash = location.hash;   // 기다리는 사이 사람이 다른 화면으로 갔으면 끌고 오지 않는다(아래 옛 링크 넘기기)
  const current = env.isCurrent ?? ((): boolean => location.hash === startHash);

  const stage = el('div', { class: 'fpg-stage' }, el('div', { class: 'fpg-msg', text: '불러오는 중…' }));
  const side = el('aside', { class: 'fpg-info', 'aria-label': '정보', hidden: true });
  const acts = el('div', { class: 'fpg-acts' });
  const crumbBox = el('div', { class: 'fpg-crumbbox' }, crumb(root, rel, null));
  const icon = el('span', { class: 'fpg-ic' }, rel ? dashFileThumb(name) : dashFolderThumb());
  const titleEl = el('h1', { class: 'fpg-name', title: name, text: name });
  const head = el('header', { class: 'fpg-head' },
    el('div', { class: 'fpg-idbox' }, el('div', { class: 'fpg-titlerow' }, icon, titleEl), crumbBox),
    acts);
  const note = arrived
    ? el('div', { class: 'fpg-moved', role: 'status' },
      el('b', { text: '옮겨진 자리로 열었어요' }),
      el('span', { class: 'fpg-moved-from', text: '받은 링크의 예전 자리: ' + shareRootLabel(root) + ' / ' + arrived.from }))
    : null;
  replaceKids(host, el('div', { class: 'fpg' }, head, ...(note ? [note] : []), el('div', { class: 'fpg-main' }, stage, side)));

  //  정보(종류 · 크기 · 속한 곳 · 자료)는 서버 한 번 — 판정은 목록 · 내려받기와 같은 한 벌이고, 안 보이는 자리와 없는 자리는 같은 404 다.
  let info: FileInfo | null = null;
  let entry: Entry | null = null;
  try {
    info = await api('/api/ui/terminal/browse/info?' + browseQs(root, rel));
    entry = info;
  } catch (e: any) {
    if (!current()) return;
    if (e && e.status === 403 && e.body && e.body.code === 'app_consent_required' && e.body.app) {
      showConsent(stage, acts, root, rel, e.body.app, () => { void paintFileView(host, params, env); }, current, env);
      return;
    }
    if (!e || e.status !== 404) {
      replaceKids(stage, errorNote(e, '이 링크를 열지 못했습니다'));
      replaceKids(acts, ...tailActions(root, rel, 'file'));
      return;
    }
    //  이 게이트웨이의 404(못 봄 · 없음 — 같은 몸)면 그대로 «없음» 이다. code 가 없는 404 는 이 라우트가 없는 옛 게이트웨이다 — 부모 목록으로 다시 본다.
    entry = e.body && e.body.code === 'file_not_found' ? null : await listedEntry(root, rel);
  }
  if (!current()) return;
  if (!entry) {
    //  웹·API 로 옮긴 것이면 지금 자리로 넘긴다(#4688) — 넘어온 자리에서 또 못 찾았으면(arrived) 더 따라가지 않는다.
    const to = arrived ? null : await movedTo(root, rel);
    if (!current()) return;
    if (to) {
      movedNotices.set(host, { root, from: rel, to });
      if (env.replaceRoute) env.replaceRoute(fileLinkHash(root, to));
      else location.replace(fileLinkHash(root, to));
      return;
    }
    //  기록이 없으면(셸 `mv` 등) 근처의 같은 이름을 후보로 보인다(#4672) — 넘기지는 않는다.
    const near = await sameNameNear(root, rel);
    if (!current()) return;
    replaceKids(stage, el('div', { class: 'fpg-msg fpg-msg-empty' },
      el('b', { text: '이 링크의 대상을 찾을 수 없어요' }),
      el('span', { text: '파일이 옮겨졌거나 지워졌을 수 있어요. 볼 권한이 없을 때도 같게 보입니다 — 공유한 사람에게 확인해 주세요.' }),
      el('div', { class: 'fpg-msg-path', text: shareRootLabel(root) + ' / ' + rel }),
      near.length ? nearBox(root, near) : null));
    replaceKids(acts, ...tailActions(root, rel, 'file'));
    return;
  }
  if (info) {
    paintInfo(side, info, env);
    replaceKids(crumbBox, crumb(root, rel, info.place));
    //  프로젝트 폴더 · 앱 폴더 자신이면 이름은 그 프로젝트 · 앱의 이름이다 — 폴더 이름(4410 · crm)은 링크를 받은 사람에게 아무 말도 안 한다.
    const own = info.place.kind === 'project' && rel === info.place.folder ? info.place.name
      : info.place.kind === 'app' && rel === info.place.id ? info.place.name : '';
    if (own) titleEl.textContent = own;
  }
  if (entry.type === 'dir') {
    replaceKids(icon, dashFolderThumb());
    await showDir(root, rel, stage, acts);
    return;
  }
  await showFile(root, rel, name, entry, stage, acts, info ? info.address : null);
}

// ── 위치(브레드크럼) — 각 조각이 그 폴더의 링크다(같은 화면 안에서 위로 걸어 올라갈 수 있게) ─────────────
//  속한 곳을 알면 맨 앞 조각을 그 이름으로 바꾼다: 프로젝트 폴더는 «프로젝트 「이름」» · 앱 폴더는 «앱 「이름」». 경로 조각(project / 4670)을
//  그대로 보이면 링크를 받은 사람이 «이게 어느 프로젝트 것인가» 를 다시 물어야 한다.
function crumb(root: string, rel: string, place: FileInfo['place'] | null): any {
  const segs = rel ? rel.split('/') : [];
  const box = el('nav', { class: 'fpg-crumb', 'aria-label': '위치' });
  const seg = (href: string, text: string): any => el('a', { class: 'fpg-crumb-seg', href, text, title: text });
  const sep = (): any => el('span', { class: 'fpg-crumb-sep', text: '/' });
  let skip = 0;
  if (place && place.kind === 'project' && place.folder && (rel === place.folder || rel.startsWith(place.folder + '/'))) {
    skip = place.folder.split('/').length;
    box.append(seg(fileLinkHash(root, place.folder), '프로젝트 「' + place.name + '」'));
  } else if (place && place.kind === 'app' && root === 'apps' && segs.length) {
    skip = 1;
    box.append(seg(fileLinkHash(root, segs[0]), '앱 「' + place.name + '」'));
  } else {
    box.append(seg(fileLinkHash(root, ''), root === 'personal' ? '내 폴더' : shareRootLabel(root)));
  }
  let acc = segs.slice(0, skip).join('/');
  for (const s of segs.slice(skip)) {
    acc = acc ? acc + '/' + s : s;
    box.append(sep(), seg(fileLinkHash(root, acc), s));
  }
  return box;
}

// ── 정보 칸 ──────────────────────────────────────────────────────────────────
const KIND_BY_EXT: Record<string, string> = {
  md: 'Markdown 문서', markdown: 'Markdown 문서', txt: '텍스트', pdf: 'PDF 문서', html: 'HTML 문서', htm: 'HTML 문서',
  png: '그림', jpg: '그림', jpeg: '그림', gif: '그림', webp: '그림', svg: '그림(SVG)', heic: '그림',
  csv: '표(CSV)', tsv: '표(TSV)', xlsx: '엑셀 문서', xls: '엑셀 문서', docx: '워드 문서', doc: '워드 문서',
  pptx: '파워포인트 문서', ppt: '파워포인트 문서', hwp: '한글 문서', hwpx: '한글 문서',
  mp4: '영상', mov: '영상', webm: '영상', mp3: '소리', wav: '소리', m4a: '소리',
  zip: '압축 파일', gz: '압축 파일', tgz: '압축 파일', json: 'JSON', yaml: 'YAML', yml: 'YAML',
};
function kindText(info: FileInfo): string {
  if (info.type === 'dir') return '폴더';
  const i = info.name.lastIndexOf('.');
  const ext = i > 0 ? info.name.slice(i + 1).toLowerCase() : '';
  return KIND_BY_EXT[ext] || (ext ? ext.toUpperCase() + ' 파일' : '파일');
}

/** 이 링크를 누가 열 수 있나 — 복사 토스트(lib/sharelink copyFileLink)와 같은 축으로, 판정 결과(locked)를 더해 말한다. */
function audienceText(info: FileInfo): string {
  if (info.root === 'personal') return '나만 볼 수 있어요 — 개인 폴더 링크는 받은 사람 자신의 폴더로 열려요';
  if (info.root === 'apps') return '이 앱 사용에 동의한 사람이 볼 수 있어요';
  if (info.place.kind === 'project') return info.locked ? '이 프로젝트를 볼 수 있는 사람만 볼 수 있어요' : '이 워크스페이스 사람 모두가 볼 수 있어요';
  return info.locked ? '지정된 사람만 볼 수 있어요' : '이 워크스페이스 사람 모두가 볼 수 있어요';
}

function placeRow(info: FileInfo, env: FileViewEnv): any {
  const p = info.place;
  if (p.kind === 'project') {
    return el('div', { class: 'fpg-place' },
      el('span', { class: 'fpg-place-name', text: '프로젝트 「' + p.name + '」' }),
      el('a', { class: 'fpg-door', href: '#/projects2/p/' + p.id, title: '이 파일이 속한 프로젝트 화면으로 갑니다', text: '프로젝트로 가기 →' }));
  }
  if (p.kind === 'app') {
    const open = env.openApp;
    return el('div', { class: 'fpg-place' },
      el('span', { class: 'fpg-place-name', text: '앱 「' + p.name + '」 의 폴더' }),
      open ? el('button', { class: 'fpg-door', type: 'button', title: '이 파일이 속한 앱을 엽니다', text: '앱 열기 →', onclick: () => open(p.id, p.name) }) : null);
  }
  if (p.kind === 'personal') return el('span', { text: '내 폴더' });
  return el('span', { text: p.folder ? shareRootLabel(info.root) + ' › ' + p.folder : shareRootLabel(info.root) });
}

function addressRow(address: string): any {
  return el('div', { class: 'fpg-addr' },
    el('code', { class: 'fpg-addr-text', text: address, title: '세션 안 AI 에게 이 주소를 주면 같은 파일을 찾아요' }),
    el('button', { class: 'fpg-rowbtn', type: 'button', title: '주소 복사', 'aria-label': '주소 복사',
      onclick: async () => {
        try { await navigator.clipboard.writeText(address); toast('주소를 복사했어요'); }
        catch (_) { toast('복사하지 못했어요 — 주소를 직접 골라 복사해 주세요', true); }
      } }, copyIcon(13)));
}

/** 복사 그림 — 선 아이콘 표 한 벌(lib/icon-paths)의 copy. 링크 복사(🔗)와 다른 일이라 다른 그림이다. */
function copyIcon(size: number): any {
  const n = sv('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('path', { d: iconPath('copy') }));
  return n;
}

function paintInfo(side, info: FileInfo, env: FileViewEnv): void {
  const row = (k: string, v: any): any[] => [el('dt', { text: k }), el('dd', {}, v)];
  const rows: any[] = [
    ...row('종류', kindText(info)),
    ...(info.type === 'file' ? row('크기', fmtSize(info.size)) : []),
    ...(info.mtime ? row('고친 때', fmtFileDateFull(info.mtime)) : []),
    ...row('위치', placeRow(info, env)),
    ...(info.address ? row('주소', addressRow(info.address)) : []),
    ...row('볼 수 있는 사람', info.locked ? el('span', { class: 'fpg-locked', text: audienceText(info) }) : audienceText(info)),
  ];
  const parts: any[] = [el('h2', { class: 'fpg-info-h', text: '정보' }), el('dl', { class: 'fpg-dl' }, ...rows)];
  const s = info.source;
  if (s) {
    //  자료 한 건(#1881) — 이 파일이 자료로 등록돼 있으면(올린 파일 · AI 가 만든 파일) 누가 · 언제 · 거기서 나온 지식.
    const upName = (s.uploaderId && personDisplayName(s.uploaderId)) || shortName(s.uploaderName);
    const who = s.entry === 'generated' ? 'AI 세션이 만든 파일이에요' : upName ? upName + ' 님이 올렸어요' : '';
    const srow: any[] = [
      ...(who ? row('올린 사람', who) : []),
      ...(s.createdAt ? row('올린 때', fmtFileDateFull(Date.parse(s.createdAt))) : []),
    ];
    const href = env.sourceHref ? env.sourceHref(s.id) : '';
    //  말할 것이 하나도 없으면(클래식이라 자료 앱 문이 없고 · 올린 사람 · 때 · 지식이 모두 빔) «자료» 제목만 남기지 않는다.
    if (srow.length || href || s.knowledge.length) {
      parts.push(el('h2', { class: 'fpg-info-h', text: '자료' }),
        srow.length ? el('dl', { class: 'fpg-dl' }, ...srow) : null,
        href ? el('a', { class: 'fpg-door fpg-door-block', href, text: '자료 앱에서 보기 →', title: '자료 앱에서 이 자료를 엽니다 — 목록에서 앞뒤 자료를 훑을 수 있어요' }) : null);
    }
    if (s.knowledge.length) {
      parts.push(el('div', { class: 'fpg-kn' },
        el('div', { class: 'fpg-kn-h', text: '여기서 나온 지식 ' + s.knowledge.length + '건' }),
        ...s.knowledge.map((k) => el('a', { class: 'fpg-kn-row', href: '#/k/' + encodeURIComponent(k.name), text: k.title || k.name }))));
    }
  }
  replaceKids(side, ...parts);
  side.hidden = false;
}

/** 올린 사람 이름이 이메일이면 앞부분만(자료 앱 shortPerson 과 같은 자) */
function shortName(s: string | null): string {
  if (!s) return '';
  const at = s.indexOf('@');
  return at > 0 ? s.slice(0, at) : s;
}

// ── 앱 동의 안내(#4671 ③ 결정 1) — 그 앱은 보이는데 아직 동의하지 않았다 ──────────────────────────────
//  동의 창이 떠 있는 사이 사람이 다른 화면으로 갈 수 있다 — 동의한 뒤에는 **아직 이 자리일 때만** 다시 그린다(current). 안 그러면
//  그 탭의 지금 화면을 이 링크의 머리로 덮고, 다시 그리기는 자기 «아직 이 자리인가» 에서 멈춰 «불러오는 중» 에 굳는다.
//  클래식에는 동의 창이 없다 — 같은 링크를 새 화면(?ui=v2 — 이번 한 번만, 고른 화면은 그대로)으로 여는 문을 둔다.
function showConsent(stage, acts, root: string, rel: string, app: { id: string; title: string }, again: () => void, current: () => boolean, env: FileViewEnv): void {
  const consent = env.consent;
  replaceKids(stage, el('div', { class: 'fpg-msg fpg-msg-empty' },
    el('b', { text: '앱 「' + app.title + '」 사용에 동의하면 볼 수 있어요' }),
    el('span', { text: '앱 폴더의 파일은 그 앱 사용에 동의한 사람만 열 수 있어요. 한 번 동의하면 이 앱의 다른 파일 링크도 열려요.' }),
    consent
      ? el('button', { class: 'fpg-btn fpg-btn-primary fpg-btn-lg', type: 'button', text: '이 앱 사용에 동의하기',
        onclick: async () => { if (await consent(app.id, app.title) && current()) again(); } })
      : el('a', { class: 'fpg-btn fpg-btn-primary fpg-btn-lg', href: location.pathname + '?ui=v2' + fileLinkHash(root, rel),
        title: '새 화면은 그 자리에서 동의할 수 있어요 — 이번 한 번만 새 화면으로 열고, 고른 화면(클래식)은 그대로예요', text: '새 화면에서 열고 동의하기' })));
  replaceKids(acts, ...tailActions(root, rel, 'file'));
}

// ── 같은 이름 후보(#4672) ─────────────────────────────────────────────────────
function nearBox(root: string, items: SameName[]): any {
  return el('div', { class: 'fpg-near' },
    el('div', { class: 'fpg-near-h', text: '같은 이름이 근처에 있어요 — 옮긴 파일일 수 있어요' }),
    ...items.map((it) => {
      const at = it.path.includes('/') ? it.path.slice(0, it.path.lastIndexOf('/')) : '';
      const nm = it.path.split('/').pop() || it.path;
      return el('a', { class: 'fpg-row fpg-near-row', href: fileLinkHash(root, it.path), title: shareRootLabel(root) + ' / ' + it.path },
        el('span', { class: 'fpg-row-ic' }, it.type === 'dir' ? dashFolderThumb() : dashFileThumb(nm)),
        el('span', { class: 'fpg-row-nm' }, el('b', { text: nm }), el('span', { class: 'fpg-near-at', text: at ? at + '/' : shareRootLabel(root) })),
        el('span', { class: 'fpg-row-dt', text: fmtFileDateFull(it.mtime) }));
    }));
}

// 어느 화면에서나 붙는 꼬리 액션 — (파일이면) 내려받기 + 링크 복사.
//  워크스페이스 안 화면이 됐으므로(#4672) 종전의 «Lively ↗»(내비 없는 막다른 길에서 앱으로 나가는 문)는 두지 않는다.
function tailActions(root: string, rel: string, kind: 'file' | 'dir', dl?: () => void): any[] {
  const out: any[] = [];
  if (kind === 'file' && dl) {
    out.push(el('button', { class: 'fpg-btn fpg-btn-primary', type: 'button', text: '⬇ 내려받기', onclick: dl }));
  }
  out.push(el('button', { class: 'fpg-btn', type: 'button', title: '이 ' + (kind === 'dir' ? '폴더' : '파일') + '의 링크 복사',
    onclick: () => copyFileLink(root, rel, kind) }, shareLinkIcon(15), el('span', { text: '링크 복사' })));
  return out;
}

/**
 * 내려받기 — 주소가 있는 자리(공유 · 앱 폴더)는 **짧은 수명 서명 주소**(#4673 file_url)로 브라우저가 직접 받는다: 큰 파일도 화면 메모리를
 *  거치지 않고 바로 디스크로 간다(서명 주소는 attachment 로 내려 준다). 발급은 내려받기와 같은 판정을 지난다.
 *  개인 폴더(주소 없음) · 발급 실패는 종전 길(인증 fetch → blob)로 — <a download> 는 헤더를 실을 수 없어 blob 을 거친다.
 */
async function download(root: string, rel: string, name: string, address: string | null): Promise<void> {
  if (address) {
    try {
      const r = await api('/api/ui/files/url', { method: 'POST', body: JSON.stringify({ address, method: 'GET' }) });
      if (r && typeof r.url === 'string' && /^https?:\/\//.test(r.url)) {
        const a = el('a', { href: r.url, download: name, rel: 'noopener' });
        document.body.append(a); a.click(); a.remove();
        return;
      }
    } catch (_) { /* 종전 길로 */ }
  }
  try {
    const res = await fileFetch('/api/ui/terminal/browse/file?download=1&' + browseQs(root, rel));
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
  replaceKids(acts, ...tailActions(root, rel, 'dir'));
  let data: any;
  try { data = await api('/api/ui/terminal/browse?' + browseQs(root, rel)); }
  catch (e: any) { replaceKids(stage, errorNote(e, '폴더를 불러오지 못했습니다')); return; }
  const items = (data && data.items) || [];
  if (!items.length) { replaceKids(stage, el('div', { class: 'fpg-msg', text: '빈 폴더입니다.' })); return; }
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
  replaceKids(stage, list);
}

// ── 파일 ────────────────────────────────────────────────────────────────────
async function showFile(root: string, rel: string, name: string, entry: Entry, stage, acts, address: string | null): Promise<void> {
  const viewUrl = '/api/ui/terminal/browse/file?' + browseQs(root, rel);
  const dlUrl = '/api/ui/terminal/browse/file?download=1&' + browseQs(root, rel);
  const size = Number(entry && entry.size) || 0;
  const dl = (): void => { void download(root, rel, name, address); };
  const mkBtn = (label: string, onClick: () => void): any =>
    el('button', { class: 'fpg-btn', type: 'button', text: label, onclick: onClick });
  const tail = tailActions(root, rel, 'file', dl);
  replaceKids(acts, ...tail);

  let out;
  try {
    // 타입 판정·렌더·툴바 동작은 공용 렌더러가 소유한다(홈 모달·프로젝트 모달과 **같은 코드**).
    //  이 화면은 넓어서 PDF 썸네일 사이드바를 켜 둔다(모달과 달리 폭이 넉넉해 목차가 쓸모 있다).
    //  편집(save)은 주지 않는다 — 링크를 받은 사람의 읽기 화면이고, 편집 표면은 앱 안(모달)에 이미 있다.
    out = await buildFilePreview({
      name, size,
      fetchView: () => fileFetch(viewUrl),
      fetchDownload: () => fileFetch(dlUrl),
      path: rel, fetchRel: (p) => fileFetch('/api/ui/terminal/browse/file?' + browseQs(root, p)),   // #4582 md 상대경로 그림
      cls: { img: 'fpg-img', pdf: 'fpg-pdf', html: 'fpg-html', md: 'fpg-md', code: 'fpg-code', table: 'fpg-table', audio: 'fpg-audio', video: 'fpg-video', msg: 'fpg-msg' },
      pdfHash: '#toolbar=1&view=FitH',
      mkBtn,
    });
  } catch (e: any) {
    replaceKids(stage, el('div', { class: 'fpg-msg', text: '미리보기 실패 — ' + ((e && e.message) || e) }));
    return;
  }
  replaceKids(acts, ...out.tools, ...tail);
  replaceKids(stage, out.body);
  // 미리보기가 없는 형식이면 이 화면의 결론은 '내려받기'다 — 상단 바에만 두지 말고 본문 가운데에 크게 한 번 더.
  //  (공용 렌더러는 안내 문구만 만든다. '이 화면에서 무엇을 하라'는 화면 소관이라 여기서 붙인다.)
  if (out.tools.length === 0 && out.body.classList && out.body.classList.contains('fp-msg')) {
    out.body.classList.add('fpg-msg-empty');
    out.body.append(
      el('div', { class: 'fpg-msg-path', text: name + (size ? ' · ' + fmtSize(size) : '') }),
      el('button', { class: 'fpg-btn fpg-btn-primary fpg-btn-lg', type: 'button', text: '⬇ 내려받기', onclick: dl }));
  }
}

export { renderFilePage, renderFileView };
