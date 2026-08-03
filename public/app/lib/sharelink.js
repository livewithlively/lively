// lib/sharelink.ts — 공유 링크(#1436): 공유/개인 폴더의 파일·폴더 하나를 가리키는 **주소 한 개**와 그 복사 UI.
//
// ## 주소 형태
//   <이 앱이 놓인 경로>#/f?root=<shared|personal>&path=<루트기준 상대경로>
//
// ## 왜 root+path 인가 (세션 id·프로젝트 id 를 주소에 넣지 않는 이유)
//  공유 워크스페이스·개인 폴더가 **파일의 유일한 좌표**다. 프로젝트 폴더는 공유 루트의 `project/<id>/…` 한 경로이고
//  (src/project/project-fs.ts), 세션 작업폴더도 그 루트 하위다 — 즉 홈·프로젝트·터미널 세 탐색기가 같은 파일에
//  대해 **같은 링크**를 만든다. 반대로 `?session=<id>` 나 `?project=<id>` 로 주소를 잡으면 세션을 종료하거나
//  프로젝트를 보관(project/ → legacy-project/)하는 순간 이미 뿌린 링크가 죽는다. 링크는 공유되면 회수할 수 없으니
//  가장 오래 사는 좌표를 택한다.
//
// ## 인가는 이 링크가 아니라 서버가 정한다
//  링크에는 비밀이 없다(경로일 뿐이다). 열람 판정은 파일을 읽는 순간 기존 게이트가 그대로 한다 —
//  공유폴더 ACL + 프로젝트 가시성(src/v6/shared-folder-store.ts). 그래서 **링크를 받아도 볼 권한이 없으면 안 보인다**
//  (거부는 404 = 존재 은닉). 로그인하지 않은 사람은 앱 로그인 게이트를 먼저 만난다.
//  ⚠ 그러므로 이 버튼의 문구는 "누구나 볼 수 있는 링크"가 아니라 "권한 있는 팀원이 열 수 있는 링크"여야 한다.
//
// ## 개인 폴더 링크는 '나만'이다 (정직하게 말한다)
//  개인 루트는 멤버별로 갈린 폴더라(ROOTS personal.perUser) 같은 root+path 를 남이 열면 **그 사람의** 개인 폴더를
//  가리킨다 — 즉 남에게 건네도 내 파일이 보이지 않는다. 그래서 복사 토스트가 대상 범위를 매번 말해 준다.
//
// leaf 규약: 여기서 페이지 모듈(core·learn 등)을 import 하지 않는다 — lib/ 안(dom·overlay)만 딛는다.
import { el, sv } from './dom.js';
import { toast } from './overlay.js';
const SHARE_ROOTS = { shared: '공유 워크스페이스', personal: '개인 폴더' };
/** 루트 키의 사람용 이름. 모르는 키는 그대로(방어적). */
function shareRootLabel(root) {
    return SHARE_ROOTS[String(root)] || String(root || '');
}
/** 경로 조각을 잇는다(빈 조각 무시) — 'a' + 'b/c' → 'a/b/c'. */
function joinRel(...parts) {
    return parts.map((p) => String(p ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
}
/** 앱 해시 경로(라우터가 받는 형태). */
function fileLinkHash(root, rel) {
    return '#/f?root=' + encodeURIComponent(root) + '&path=' + encodeURIComponent(String(rel || ''));
}
/**
 * 붙여 보낼 절대 주소.
 *  base 는 `location.origin + location.pathname` — 지금 이 화면이 놓인 자리다. 그래서 프리뷰 서브패스
 *  (/preview/<id>/ui/, #1036)에서 만든 링크는 그 프리뷰를 가리키고, 라이브에서 만든 링크는 라이브를 가리킨다
 *  (주소를 손으로 조립하면 그 구분이 깨진다 — lib/net.ts 의 apiUrl 이 같은 이유로 접두사를 유도한다).
 */
function fileLinkUrl(root, rel) {
    return location.origin + location.pathname + fileLinkHash(root, rel);
}
// 클립보드 실패 폴백 — 주소를 **보여주고** 직접 복사하게 한다. 비보안 컨텍스트(http)·권한 거부에서
//  navigator.clipboard 가 없거나 던지는데, 그때 아무 일도 안 일어나면 사용자는 버튼이 고장 났다고 읽는다.
function shareFallbackBox(url) {
    const input = el('input', { class: 'sharelink-input', type: 'text', readonly: '', value: url, spellcheck: 'false' });
    const back = el('div', { class: 'sharelink-back', onclick: (e) => { if (e.target === back)
            back.remove(); } }, el('div', { class: 'sharelink-box', role: 'dialog', 'aria-label': '공유 링크' }, el('div', { class: 'sharelink-title', text: '공유 링크' }), el('p', { class: 'sharelink-hint', text: '브라우저가 자동 복사를 막았어요 — 아래 주소를 복사해 보내세요.' }), input, el('div', { class: 'sharelink-acts' }, el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '전체 선택', onclick: () => { input.focus(); input.select(); } }), el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '닫기', onclick: () => back.remove() }))));
    document.body.append(back);
    setTimeout(() => { input.focus(); input.select(); }, 0);
}
/**
 * 링크 복사 — 성공하면 **대상 범위까지 말해 주는** 토스트, 실패하면 주소를 보여주는 폴백 박스.
 *  kind('file'|'dir')는 문구만 가른다.
 */
async function copyFileLink(root, rel, kind) {
    const url = fileLinkUrl(root, rel);
    const what = kind === 'dir' ? '폴더' : '파일';
    // 개인 폴더는 멤버별로 갈린 자리라 남이 열면 자기 폴더를 본다 — 링크를 건네도 내 파일은 안 보인다(위 헤더 주석).
    const who = root === 'personal'
        ? '개인 폴더라 이 링크는 나만 열 수 있어요'
        : '볼 권한이 있는 팀원이 열 수 있어요';
    try {
        if (!navigator.clipboard || !navigator.clipboard.writeText)
            throw new Error('no clipboard');
        await navigator.clipboard.writeText(url);
        toast(what + ' 링크를 복사했어요 — ' + who);
    }
    catch (_) {
        shareFallbackBox(url);
    }
}
// 🔗 아이콘 — 액션 열의 다른 아이콘(다운로드·이름변경·삭제)과 같은 선 굵기·크기(dash/icons.ts 규격).
function shareLinkIcon(size) {
    const s = size || 14;
    const n = sv('svg', { viewBox: '0 0 24 24', width: s, height: s, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L10.7 5.24' }), sv('path', { d: 'M14 11a5 5 0 0 0-7.07 0L4.81 13.12a5 5 0 0 0 7.07 7.07l1.41-1.41' }));
    return n;
}
export { copyFileLink, fileLinkHash, fileLinkUrl, joinRel, shareLinkIcon, shareRootLabel };
