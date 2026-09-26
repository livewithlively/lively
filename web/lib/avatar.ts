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
  if (!s) return '?';
  if (/[가-힣]/.test(s[0])) return s.slice(0, 1);
  const parts = s.split(/\s+/);
  if (parts.length >= 2 && parts[1][0]) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}
function avatarColor(seed) {
  const s = String(seed || ''); let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return 'hsl(' + h + ', 50%, 60%)';
}
// 배경이 밝으면 글자를 어둡게(2026-09-20) — 프로필에서 **아무 색이나** 고를 수 있게 되면서, 노랑처럼 밝은
//  색을 고르면 기본 흰 글자(--on-fill)가 아예 안 보인다(#ffe08a 에서 1.3:1).
//  ⚠ **이 규칙은 표의 12색에도 닿는다** — «표는 다 어두우니 안 닿는다» 가 아니다(그렇게 적었다가 실측에
//   틀렸다). 흰 글자가 3:1 아래인 프리셋이 여섯이다: #22c55e 2.28 · #f59e0b 2.15 · #06b6d4 2.43 ·
//   #0ea5e9 2.77 · #14b8a6 2.49 · #f97316 2.80. 그 여섯만 어두운 글자가 되고 대비가 5.6~7.3 으로 오른다.
//   나머지 여섯(#6c8cff 3.07 · #ef4444 · #a855f7 · #ec4899 · #64748b · #8b5cf6)은 **그대로 흰 글자**다.
//  경계를 «흰 글자와 어두운 글자의 대비가 같아지는 점»(L=0.2148)이 아니라 **«흰 글자가 3:1 아래로
//   떨어지는 점»(L=0.30)에 둔 이유**: 앞쪽을 쓰면 흰 글자가 멀쩡한 파랑·보라까지 뒤집혀, 이미 그 색을
//   쓰고 있는 사람의 얼굴이 이유 없이 바뀐다. 고치려는 것은 «안 보인다» 이지 «최대 대비» 가 아니다.
//  ⚠ 이름에서 자동으로 뽑는 색(avatarColor 의 hsl)은 이 규칙 밖이다 — 그건 우리가 고르는 중간 톤이고,
//   여기에 규칙을 걸면 전 구성원의 얼굴이 한꺼번에 바뀐다(이 변경의 범위가 아니다).
//  빈 문자열을 돌려주면 스타일시트의 기본 글자색을 그대로 쓴다.
function avatarInk(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex || '')) return '';
  const n = parseInt(String(hex).slice(1), 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return L > 0.30 ? '#15233b' : '';        // 1.05/(L+0.05) < 3 인 지점
}
// 원형 아바타 element. avatar(data URL)면 <img>, 없으면 색상+글자. cls 로 크기 변형(topbar-ava 등).
//  opts.char/opts.color — 프로필 설정의 커스텀 글자·배경색(이미지 없을 때만). 없으면 이름 이니셜 + id 해시색 폴백.
function profileAvatar(avatar, name, seed, cls?, opts?) {
  const wrap = el('span', { class: 'pava' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' });
  if (avatar) { wrap.append(el('img', { src: avatar, alt: '' })); }
  else {
    const o = opts || {};
    const ch = o.char != null ? String(o.char).trim() : '';
    const custom = (o.color && /^#[0-9a-fA-F]{6}$/.test(o.color)) ? o.color : '';
    wrap.style.background = custom || avatarColor(seed || name);
    wrap.style.color = avatarInk(custom);
    wrap.textContent = ch || initials(name);
  }
  return wrap;
}

// ── 사람 아바타 단일 소스(#473 후속) — id→멤버(글자·색·이미지) 맵. 칩·얼굴·작성자 등 모든 '사람' 아바타가 여기서 커스텀 반영. ──
//  기존엔 곳곳이 avatarColor(id)+initials(name) 를 인라인 복제해 커스텀이 안 먹었다 → personFace 한 경로로 통일.
const _peopleAvatars: Record<string, any> = {};
let _peopleLoadP: Promise<any> | null = null;
function loadPeopleAvatars() {
  if (_peopleLoadP) return _peopleLoadP;
  _peopleLoadP = api('/api/ui/dash/members')
    .then((d) => { for (const m of (d && d.members) || []) if (m && m.id) _peopleAvatars[String(m.id)] = m; return _peopleAvatars; })
    .catch(() => _peopleAvatars);
  return _peopleLoadP;
}
// 프로필 저장 등으로 한 사람 아바타가 바뀌면 즉시 맵 갱신(다음 렌더부터 반영).
function setPersonAvatar(id, m) { if (id) _peopleAvatars[String(id)] = Object.assign({}, _peopleAvatars[String(id)], m || {}); }
function paintFace(wrap, id, name) {
  const m = _peopleAvatars[String(id)] || {};
  const nm = m.display_name || name || id || '';
  wrap.title = nm;
  // 얼굴 내용(텍스트·이미지)만 교체하고 뱃지 등 다른 자식(요소)은 보존 — self-heal 재칠 시 뱃지 안 지워지게.
  Array.from(wrap.childNodes).forEach((n: any) => { if (n.nodeType === 3 || (n.nodeType === 1 && n.tagName === 'IMG')) wrap.removeChild(n); });
  if (m.avatar) { wrap.style.background = ''; wrap.style.color = ''; wrap.insertBefore(el('img', { src: m.avatar, alt: '' }), wrap.firstChild); }
  else {
    const ch = m.avatar_char != null ? String(m.avatar_char).trim() : '';
    const custom = (m.avatar_color && /^#[0-9a-fA-F]{6}$/.test(m.avatar_color)) ? m.avatar_color : '';
    wrap.style.background = custom || avatarColor(id || nm);
    wrap.style.color = avatarInk(custom);
    wrap.insertBefore(document.createTextNode(ch || initials(nm)), wrap.firstChild);
  }
}
// 사람 아바타 얼굴 — 호출부의 기존 클래스(pjv-ava·project-face·cmt-ava 등)를 유지하되 글자·색·이미지는 맵에서. 맵 미로드면 로드 후 self-heal.
function personFace(id, cls, name?) {
  const wrap = el('span', { class: (cls || 'pava') + ' pv-face' });
  paintFace(wrap, id, name);
  if (!_peopleAvatars[String(id)]) loadPeopleAvatars().then(() => paintFace(wrap, id, name));
  return wrap;
}
// 명부의 표시 이름(main #4135 허브와 같은 함수, stage 에 없어 #4233 자료 사이드바가 함께 싣는다). 맵이 아직 안 왔으면 ''.
function personDisplayName(id: string): string {
  const m = _peopleAvatars[String(id)];
  return m && m.display_name ? String(m.display_name) : '';
}

export {
  avatarColor,
  avatarInk,
  initials,
  loadPeopleAvatars,
  personDisplayName,
  personFace,
  profileAvatar,
  setPersonAvatar,
};
