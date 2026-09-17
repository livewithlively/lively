// lib/person-select.ts — **사람 한 명 고르기**(#4052): 이름으로 찾아 고르는 드롭다운. 값은 구성원 id, 보이는 건 이름.
//
//  왜(상민님 2026-09-17): 증류·분류의 «실행 계정» 칸이 «구성원 id» 를 치라는 글자칸이었다. 그런데 구성원 id 는
//   화면 어디에도 나오지 않는다 — 무엇을 쳐야 하는지 알 길이 없었다. 사람은 이름으로 고른다.
//
//  계약:
//   · 칸을 누르면 명부가 바로 펼쳐진다(찾을 말을 몰라도 고를 수 있다). 치면 이름·id 로 좁힌다(초성 포함 — lib/find).
//   · 고른 사람은 얼굴 + 이름으로 보인다. id 는 칸에 안 나온다(툴팁에만).
//   · 명부에 없는 값(옛 설정·나간 사람·AI 계정)은 **지우지 않고** 값 그대로 보이며, 명부에 없다고 말한다.
//   · 명부를 못 불러오면 종전처럼 글자로 받는다 — 칸이 죽어서 설정을 못 하는 것보다 낫다.
//   · 값이 바뀔 때만 이 칸에서 `change` 가 올라간다(검색어 타이핑은 밖으로 새지 않는다 — 폼의 «저장 안 된 변경»·
//     미리보기 새로고침이 검색어마다 돌지 않게).
//  목록은 body 에 붙는 떠 있는 층(position:fixed)이다 — 카드·접힘(details)의 overflow 에 잘리지 않고 모달 위에도 뜬다.
//  행·얼굴 모양은 초대 피커(.proj-mp-*)를 그대로 쓴다(새 모양을 만들지 않는다). 순수 규칙은 lib/person-pick.
import { el } from './dom.js';
import { api } from './net.js';
import { state } from './state.js';
import { personFace } from './avatar.js';
import { pickLabel, pickMatches, toPickPeople, type PickPerson } from './person-pick.js';

/**
 * 명부 출처.
 *  · `people`   — 활성 **사람** 구성원(/api/ui/dash/members, memory 권한). 맥락 관리 화면의 실행 계정이 쓴다.
 *  · `profiles` — 관리자 전용 명부(/api/ui/terminal/profiles). AI 구성원도 들어 있고 AI 로그인 상태를 함께 보인다.
 */
export type PersonSource = 'people' | 'profiles';

export interface PersonSelect {
  el: HTMLElement;
  /** 고른 구성원 id. 비었으면 ''. */
  value(): string;
  /** 밖에서 값을 바꾼다(`change` 는 안 올린다). */
  set(id: string | null): void;
}

export interface PersonSelectOpts {
  value?: string | null;
  /** 찾는 중(칸에 포커스)일 때 보일 안내. 기본 «이름으로 찾기». */
  placeholder?: string;
  /** 아무도 안 골랐을 때 칸에 보일 말 — 비워 두면 무슨 일이 생기는지(예: «비워 두면 …의 계정으로 돕니다»). */
  emptyText?: string;
  source?: PersonSource;
  /** 스크린리더용 이름. */
  label?: string;
  /** 비우기 단추를 둘까(기본 true). */
  clearable?: boolean;
  onChange?: (id: string) => void;
}

// 명부 캐시 — 한 화면에 칸이 여러 개여도 한 번만 부른다. 오래 열어 둔 화면에서 새 구성원이 안 보이지 않게 1분만 믿는다.
const CACHE_MS = 60_000;
const cache: Partial<Record<PersonSource, { at: number; p: Promise<PickPerson[]> }>> = {};

function profileSub(p: any): string {
  const s = (p && p.status) || {};
  const login = s.loggedIn ? 'AI 로그인됨' : (s.provisioned ? 'AI 로그인 전' : '');
  return [p && p.kind === 'agent' ? 'AI 구성원' : '', login].filter(Boolean).join(' · ');
}

export function loadPersonDirectory(src: PersonSource = 'people'): Promise<PickPerson[]> {
  const hit = cache[src];
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.p;
  const p = (src === 'profiles'
    ? api('/api/ui/terminal/profiles').then((r: any) => toPickPeople(((r && r.profiles) || [])
      .map((x: any) => ({ id: x.id, name: x.name, sub: profileSub(x) }))))
    : api('/api/ui/dash/members').then((r: any) => toPickPeople(((r && r.members) || [])
      .map((x: any) => ({ id: x.id, name: x.display_name })))))
    .catch((e: unknown) => { if (cache[src]?.p === p) delete cache[src]; throw e; });
  cache[src] = { at: Date.now(), p };
  return p;
}

let seq = 0;

export function personSelect(o: PersonSelectOpts = {}): PersonSelect {
  const src: PersonSource = o.source || 'people';
  const clearable = o.clearable !== false;
  const searchPh = o.placeholder || '이름으로 찾기';
  const listId = 'psel-' + (++seq);
  let cur = String(o.value ?? '').trim();
  let people: PickPerson[] = [];
  let loaded: 'wait' | 'ok' | 'fail' = 'wait';
  let focused = false;
  let open = false;
  let query = '';
  let rows: PickPerson[] = [];
  let active = -1;
  const meId = (): string => String((state.me && state.me.userId) || '');

  const face = el('span', { class: 'psel-face', 'aria-hidden': 'true', hidden: true });
  const input = el('input', {
    type: 'text', class: 'psel-in', role: 'combobox', spellcheck: 'false',
    'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId,
    'aria-label': o.label || '사람 고르기',
  }) as HTMLInputElement;
  const clear = el('button', { type: 'button', class: 'psel-clear', title: '비우기', 'aria-label': '비우기', text: '×', hidden: true }) as HTMLButtonElement;
  const caret = el('span', { class: 'psel-caret', 'aria-hidden': 'true', text: '▾' });
  const box = el('div', { class: 'psel-box' }, face, input, clear, caret);
  const note = el('p', { class: 'psel-note', hidden: true });
  const root = el('div', { class: 'psel' }, box, note) as HTMLElement;
  const menu = el('div', { class: 'proj-mp-menu psel-menu', role: 'listbox', id: listId, hidden: true }) as HTMLElement;

  // ── 칸 ──────────────────────────────────────────────────────────────────
  function paintValue(): void {
    const lab = loaded === 'fail' ? null : pickLabel(people, cur);
    face.replaceChildren();
    if (lab) face.append(personFace(lab.id, 'proj-mp-ava proj-mp-ava-sm', lab.name));
    (face as HTMLElement).hidden = !lab;
    if (!focused) input.value = loaded === 'fail' ? cur : (lab ? lab.name : '');
    input.title = lab ? (lab.known ? `${lab.name} (${lab.id})` : lab.id) : '';
    input.placeholder = focused ? searchPh : (o.emptyText || searchPh);
    clear.hidden = !(clearable && cur && loaded !== 'fail');
    if (loaded === 'fail') {
      note.textContent = '구성원 목록을 불러오지 못했습니다 — 구성원 id 를 직접 적어 주세요.';
      note.hidden = false;
    } else if (lab && !lab.known && loaded === 'ok') {
      note.textContent = `구성원 목록에 없는 계정(${lab.id})입니다. 사람을 새로 고르거나 비워 두세요.`;
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  }

  function commit(id: string): void {
    const next = String(id || '').trim();
    const changed = next !== cur;
    cur = next;
    query = '';
    closeMenu();
    paintValue();
    if (!changed) return;
    try { o.onChange?.(cur); } catch { /* 호출부 오류가 칸을 망가뜨리지 않게 */ }
    root.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── 목록 ────────────────────────────────────────────────────────────────
  function place(): void {
    if (!open) return;
    const r = box.getBoundingClientRect();
    if (!box.isConnected || (r.width === 0 && r.height === 0) || r.bottom < 0 || r.top > window.innerHeight) { closeMenu(); return; }
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 260) - 8)) + 'px';
    menu.style.width = Math.max(r.width, 260) + 'px';
    const h = Math.min(menu.scrollHeight || 236, 236);
    const below = window.innerHeight - r.bottom - 8;
    if (below < h && r.top - 8 > below) { menu.style.top = ''; menu.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
    else { menu.style.bottom = ''; menu.style.top = (r.bottom + 4) + 'px'; }
  }
  const onScroll = (e: Event): void => { if (!menu.contains(e.target as Node)) place(); };
  function openMenu(): void {
    if (!open) {
      open = true;
      document.body.append(menu);
      menu.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', place);
    }
    paintMenu();
    place();
  }
  function closeMenu(): void {
    if (!open) return;
    open = false;
    menu.hidden = true;
    menu.remove();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', place);
  }
  function paintMenu(): void {
    const empty = (text: string): void => { rows = []; active = -1; menu.replaceChildren(el('div', { class: 'proj-mp-empty', text })); };
    if (loaded === 'wait') return empty('구성원 목록을 불러오는 중입니다…');
    if (loaded === 'fail') return empty('구성원 목록을 불러오지 못했습니다 — 구성원 id 를 직접 적어 주세요.');
    rows = pickMatches(people, query, meId());
    if (!rows.length) return empty(people.length ? '이름이 맞는 사람이 없습니다.' : '고를 수 있는 구성원이 없습니다.');
    if (active >= rows.length) active = rows.length - 1;
    const me = meId();
    menu.replaceChildren(...rows.map((p, i) => {
      const on = p.id === cur;
      return el('div', {
        class: 'proj-mp-row psel-opt' + (on ? ' on' : '') + (i === active ? ' is-active' : ''),
        role: 'option', id: `${listId}-${i}`, 'aria-selected': on ? 'true' : 'false', title: p.id,
        // mousedown + preventDefault — 누르는 순간 칸이 blur 로 목록을 닫아 클릭이 씹히는 것을 막는다(초대 피커와 같은 처방).
        onmousedown: (e: MouseEvent) => { e.preventDefault(); commit(p.id); },
      },
      personFace(p.id, 'proj-mp-ava', p.name),
      el('span', { class: 'proj-mp-name' }, p.name, p.id === me ? el('span', { class: 'psel-me', text: ' (나)' }) : null),
      p.sub ? el('span', { class: 'psel-sub', text: p.sub }) : null,
      el('span', { class: 'proj-mp-check' + (on ? ' on' : ''), 'aria-hidden': 'true', text: on ? '✓' : '' }));
    }));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `${listId}-${active}`);
      (menu.children[active] as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  // ── 입력 ────────────────────────────────────────────────────────────────
  input.addEventListener('focus', () => {
    focused = true;
    query = '';
    active = -1;
    paintValue();
    input.select();
    openMenu();
  });
  input.addEventListener('blur', () => {
    focused = false;
    // 목록 행은 mousedown 에서 이미 골랐다 — 여기서는 찾던 글을 버리고 고른 이름으로 되돌린다.
    setTimeout(() => { if (focused) return; closeMenu(); query = ''; paintValue(); }, 0);
  });
  input.addEventListener('input', (e) => {
    e.stopPropagation();   // 검색어는 값이 아니다 — 폼의 입력 감지로 새지 않게
    if (loaded === 'fail') {
      // 명부가 없으면 친 글이 곧 값이다(종전 글자칸 동작).
      const v = input.value.trim();
      if (v !== cur) { cur = v; try { o.onChange?.(cur); } catch { /* */ } root.dispatchEvent(new Event('change', { bubbles: true })); }
      return;
    }
    query = input.value;
    active = query.trim() ? 0 : -1;
    openMenu();
  });
  input.addEventListener('change', (e) => e.stopPropagation());   // 글자칸 자체의 change 도 값 변경이 아니다
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;   // 한글 조합 중의 Enter·화살표는 조합을 끝내는 키다
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) openMenu();
      if (rows.length) { active = Math.min(active + 1, rows.length - 1); paintMenu(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length) { active = Math.max(active - 1, 0); paintMenu(); }
    } else if (e.key === 'Enter') {
      if (open && active >= 0 && rows[active]) { e.preventDefault(); commit(rows[active].id); }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); e.stopPropagation(); closeMenu(); query = ''; paintValue(); input.select(); }
    } else if (e.key === 'Tab') {
      closeMenu();
    }
  });
  // 칸의 빈 자리(얼굴·▾)를 눌러도 찾기가 열린다.
  box.addEventListener('mousedown', (e) => {
    const t = e.target as Node;
    if (t === input || clear.contains(t)) return;
    e.preventDefault();
    if (document.activeElement === input) { if (open) closeMenu(); else openMenu(); }
    else input.focus();
  });
  clear.addEventListener('mousedown', (e) => e.preventDefault());
  clear.addEventListener('click', () => commit(''));

  paintValue();
  loadPersonDirectory(src)
    .then((ps) => { people = ps; loaded = 'ok'; })
    .catch(() => { loaded = 'fail'; })
    .finally(() => { paintValue(); if (open) { paintMenu(); place(); } });

  return {
    el: root,
    value: () => cur,
    set: (id) => { cur = String(id ?? '').trim(); paintValue(); if (open) paintMenu(); },
  };
}
