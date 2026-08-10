// lib/avatar.ts — 사람·엔티티 아바타 단일 소스(#1313 R29b). core.ts 에서 **verbatim 이동**(로직 변경 0).
//  ⚠ _peopleAvatars/_peopleLoadP 는 **모듈 전역 캐시**다 — 이 맵을 읽고 쓰는 loadPeopleAvatars·setPersonAvatar·
//   paintFace·personFace 는 반드시 여기 동거한다(가르면 화면마다 다른 사본을 보게 된다).
//  ⚠ R30 이 지적한 중복(web/projects/files.ts 의 동명 initials/avatarColor)은 **바이트 동일**임을 확인하고
//   여기로 일원화했다 — files.ts 는 이 모듈에서 받아 그대로 재수출한다(projects.ts 의 import 문 무변경).
//  소비 파일은 종전대로 './core.js' 에서 받는다(core 의 배럴 재수출).
import { el } from './dom.js';
import { api } from './net.js';
// ── 아바타(프로필 원형) — 셀프 업로드 이미지가 있으면 그걸, 없으면 이름 이니셜+결정적 색상. ──
//  구 projects 계열의 동명 헬퍼(web/projects/files.ts)와 **바이트 동일한 사본**이었다 → R29b 에서 이 한 벌로
//  일원화(같은 seed→같은 색/이니셜이라는 불변식을 사본 동기화가 아니라 단일 정의로 보장).
//  projects.ts 가 admin.js 를 import 하므로 여기(lib, 무순환 leaf 계열)에 둬 main/admin 이 순환 없이 공유.
function initials(name) {
    const s = String(name || '').trim();
    if (!s)
        return '?';
    if (/[가-힣]/.test(s[0]))
        return s.slice(0, 1);
    const parts = s.split(/\s+/);
    if (parts.length >= 2 && parts[1][0])
        return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
}
function avatarColor(seed) {
    const s = String(seed || '');
    let h = 0;
    for (let i = 0; i < s.length; i++)
        h = (h * 31 + s.charCodeAt(i)) % 360;
    return 'hsl(' + h + ', 50%, 60%)';
}
// 원형 아바타 element. avatar(data URL)면 <img>, 없으면 색상+글자. cls 로 크기 변형(topbar-ava 등).
//  opts.char/opts.color — 프로필 설정의 커스텀 글자·배경색(이미지 없을 때만). 없으면 이름 이니셜 + id 해시색 폴백.
function profileAvatar(avatar, name, seed, cls, opts) {
    const wrap = el('span', { class: 'pava' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' });
    if (avatar) {
        wrap.append(el('img', { src: avatar, alt: '' }));
    }
    else {
        const o = opts || {};
        const ch = o.char != null ? String(o.char).trim() : '';
        wrap.style.background = (o.color && /^#[0-9a-fA-F]{6}$/.test(o.color)) ? o.color : avatarColor(seed || name);
        wrap.textContent = ch || initials(name);
    }
    return wrap;
}
// ── 사람 아바타 단일 소스(#473 후속) — id→멤버(글자·색·이미지) 맵. 칩·얼굴·작성자 등 모든 '사람' 아바타가 여기서 커스텀 반영. ──
//  기존엔 곳곳이 avatarColor(id)+initials(name) 를 인라인 복제해 커스텀이 안 먹었다 → personFace 한 경로로 통일.
const _peopleAvatars = {};
let _peopleLoadP = null;
function loadPeopleAvatars() {
    if (_peopleLoadP)
        return _peopleLoadP;
    _peopleLoadP = api('/api/ui/dash/members')
        .then((d) => { for (const m of (d && d.members) || [])
        if (m && m.id)
            _peopleAvatars[String(m.id)] = m; return _peopleAvatars; })
        .catch(() => _peopleAvatars);
    return _peopleLoadP;
}
// 프로필 저장 등으로 한 사람 아바타가 바뀌면 즉시 맵 갱신(다음 렌더부터 반영).
function setPersonAvatar(id, m) { if (id)
    _peopleAvatars[String(id)] = Object.assign({}, _peopleAvatars[String(id)], m || {}); }
function paintFace(wrap, id, name) {
    const m = _peopleAvatars[String(id)] || {};
    const nm = m.display_name || name || id || '';
    wrap.title = nm;
    // 얼굴 내용(텍스트·이미지)만 교체하고 뱃지 등 다른 자식(요소)은 보존 — self-heal 재칠 시 뱃지 안 지워지게.
    Array.from(wrap.childNodes).forEach((n) => { if (n.nodeType === 3 || (n.nodeType === 1 && n.tagName === 'IMG'))
        wrap.removeChild(n); });
    if (m.avatar) {
        wrap.style.background = '';
        wrap.insertBefore(el('img', { src: m.avatar, alt: '' }), wrap.firstChild);
    }
    else {
        const ch = m.avatar_char != null ? String(m.avatar_char).trim() : '';
        wrap.style.background = (m.avatar_color && /^#[0-9a-fA-F]{6}$/.test(m.avatar_color)) ? m.avatar_color : avatarColor(id || nm);
        wrap.insertBefore(document.createTextNode(ch || initials(nm)), wrap.firstChild);
    }
}
// 사람 아바타 얼굴 — 호출부의 기존 클래스(pjv-ava·project-face·cmt-ava 등)를 유지하되 글자·색·이미지는 맵에서. 맵 미로드면 로드 후 self-heal.
function personFace(id, cls, name) {
    const wrap = el('span', { class: (cls || 'pava') + ' pv-face' });
    paintFace(wrap, id, name);
    if (!_peopleAvatars[String(id)])
        loadPeopleAvatars().then(() => paintFace(wrap, id, name));
    return wrap;
}
// 사람 표시명 — 같은 맵의 텍스트 판. 아바타를 그릴 자리가 없는 목록 메타 등에서 '누가'를 글자로 쓴다.
//  ⚠ 동기 함수라 맵이 아직 안 왔으면 id 를 돌려준다 — 이름이 처음부터 필요한 화면은 렌더 전에
//   loadPeopleAvatars() 를 await 하라(personFace 처럼 self-heal 하지 않는다).
function personName(id, fallback) {
    const k = String(id || '');
    if (!k)
        return fallback || '';
    const m = _peopleAvatars[k];
    return (m && m.display_name) || fallback || k;
}
export { avatarColor, initials, loadPeopleAvatars, personFace, personName, profileAvatar, setPersonAvatar, };
