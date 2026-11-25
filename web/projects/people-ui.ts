// projects/people-ui.ts — 프로젝트의 «사람» 한 벌(#5630, 원준 2026-11-22 «팀원이라는 프로젝트 안의 사람 요소를 격상»).
//
//  프로젝트가 기본 초대제(#5598)가 되자 «누가 이 프로젝트에 있나» 가 곧 «누가 보나» 다. 그런데 화면은 그걸 두 군데로 갈라 말했다 —
//   이름 뒤 알약(«나만» · «2명과 공유») 과 저 멀리 사람 칸(만든 사람 얼굴 하나, 또는 빈 팀원 칸). 이제 사람 칸 하나가 둘 다 말한다:
//   · 리드(만든 사람) 얼굴이 맨 앞 — 테두리로 갈린다. 그 뒤에 함께하는 사람(팀원) 얼굴. 넘치면 +N.
//   · 얼굴만 그린다 — 이름은 올렸을 때(title). 원준 2026-11-22 «아바타 뒤에 이름까지 글자로 보여줄 필요 없을 것 같아».
//   · 자물쇠(«나만» · «초대받음» 표시)는 그리지 않는다 — 원준 같은 날 «자물쇠 때문에 열 위치가 안 맞고 짜친다».
//     누가 보는지는 얼굴이 곧 말하고(얼굴 하나 = 나만), 공개 범위는 프로젝트 화면 사람 줄 · [공유] 가 말한다.
//  리스트(sess-table) · 테이블(rows.ts) · 보드 카드 · 타임라인 · 상세가 이 함수 하나를 부른다.
import { el, personDisplayName, personFace, state } from '../core.js';
import { isPrivateProj, projAccessBadge } from '../lib/proj-access.js';
import { openProjectSharePopover } from './access-ui.js';
import { projPeople } from '../lib/proj-relation.js';

const meIdOf = (): string => String((state.me && ((state.me as any).userId || (state.me as any).email)) || '');

/** 행에 실린 팀원 이름 → 명부 이름 → id 순으로 이름을 찾는다. 나는 «나». */
export function peopleNamer(p: any): (id: string) => string {
  const m = new Map<string, string>();
  for (const x of (p && p.members) || []) {
    const id = typeof x === 'string' ? x : String(x?.member_id ?? x?.id ?? '');
    const nm = typeof x === 'string' ? '' : String(x?.display_name ?? '');
    if (id && nm) m.set(id, nm);
  }
  const me = meIdOf();
  return (id) => (id && id === me ? '나' : m.get(id) || personDisplayName(id) || id);
}

export interface PeopleOpts {
  /** 얼굴 몇 개까지(리드 포함). 기본 4. */
  max?: number;
  /** 옆 글자(이름)를 그릴까. 기본 false — 얼굴만. */
  label?: boolean;
  /** 얼굴 크기 — 's'(18) · 'm'(22, 기본) · 'l'(28). */
  size?: 's' | 'm' | 'l';
}

/** 사람 묶음 — 리드 + 함께. 사람을 모르면(만든 사람 없음) null. */
export function projPeopleStack(p: any, o: PeopleOpts = {}): HTMLElement | null {
  const { lead, crew } = projPeople(p);
  if (!lead && !crew.length) return null;
  const nameOf = peopleNamer(p);
  const max = Math.max(1, o.max ?? 4);
  const ids = [lead, ...crew].filter(Boolean);
  const faces = el('span', { class: 'pj-ppl-faces' });
  ids.slice(0, max).forEach((id, i) => {
    const f = personFace(id, 'pj-ppl-face' + (i === 0 && lead ? ' lead' : ''), nameOf(id));
    faces.append(f);
  });
  if (ids.length > max) faces.append(el('span', { class: 'pj-ppl-face more', text: '+' + (ids.length - max) }));
  const leadName = lead ? nameOf(lead) : '';
  const text = !crew.length ? leadName
    : crew.length === 1 ? `${leadName} · ${nameOf(crew[0])}`
    : `${leadName} 외 ${crew.length}명`;
  const tip = (lead ? `리드 ${nameOf(lead)}` : '') + (crew.length ? ` · 함께 ${crew.map(nameOf).join(', ')}` : ' · 함께하는 사람 없음')
    + (isPrivateProj(p) ? ' — 이 사람들만 봐요' : '');
  return el('span', { class: 'pj-ppl pj-ppl-' + (o.size || 'm'), title: tip, 'aria-label': text },
    faces,
    o.label ? el('span', { class: 'pj-ppl-t', text }) : null);
}

// ── 프로젝트 화면 — 제목 밑 «사람 줄» + 오른쪽 위 [공유] ─────────────────────────────
//  종전엔 사람이 속성 띠의 칩 아홉 개 중 하나(👤 얼굴 하나)였고, «누가 보나» 는 또 다른 칩이었다. 둘을 걷어 위계를 올린다:
//   · 제목 바로 밑 한 줄 = «리드 [얼굴 이름]  함께 [얼굴 이름] [얼굴 이름] … [＋ 초대]  ·  자물쇠 초대한 사람만 봐요».
//   · 오른쪽 위 액션 줄 맨 앞 = [얼굴 묶음 공유] — 세션 화면 문패의 [공유] 와 같은 자리 · 같은 창(openProjectSharePopover).

/** members = 상세 응답의 팀원({member_id, display_name}). onChanged = 공유 창에서 저장한 뒤 다시 그리기. */
export function projPeopleRow(p: any, members: any[], onChanged: () => void): HTMLElement {
  const row = { ...p, members };
  const nameOf = peopleNamer(row);
  const { lead, crew } = projPeople(row);
  //  얼굴만(이름은 올렸을 때) — 목록과 같은 문법.
  const person = (id: string, role?: string): HTMLElement => personFace(id, 'pj-ppl-face pjh-face' + (role === 'lead' ? ' lead' : ''), nameOf(id));
  const b = projAccessBadge(row, meIdOf(), nameOf);
  const share = (anchor: HTMLElement): void => openProjectSharePopover(anchor, row, onChanged);
  const invite = el('button', { class: 'pjh-invite', type: 'button', title: '함께할 사람 초대 — 공유 창이 열려요', 'aria-label': '함께할 사람 초대' }, el('span', { text: '＋' })) as HTMLButtonElement;
  invite.onclick = () => share(invite);
  const shown = crew.slice(0, 6);
  //  3판(원준 2026-11-22 «너무 글이 많으면 안 보고 싶어») — 얼굴 · [＋] · 두세 글자. «리드» «함께» «아직 없음» 은 올렸을 때(title) 말한다.
  const acc = b.kind === 'list' ? '리스트 대상만' : b.locked ? (crew.length ? '초대한 사람만' : '나만') : '전체 공개';
  const tip = (lead ? '리드 ' + nameOf(lead) : '') + (crew.length ? ' · 함께 ' + crew.map(nameOf).join(', ') : ' · 함께하는 사람 없음');
  return el('div', { class: 'pjh-people', title: tip },
    el('span', { class: 'pj-ppl-faces pjh-crew' }, lead ? person(lead, 'lead') : null, ...shown.map((id) => person(id))),
    crew.length > shown.length ? el('span', { class: 'pjh-people-more', text: '+' + (crew.length - shown.length), title: crew.slice(6).map(nameOf).join(', ') }) : null,
    invite,
    el('span', { class: 'pjh-people-acc' + (b.locked ? ' locked' : ''), title: b.tip, text: acc }));
}

/** 오른쪽 위 [공유] — 얼굴 묶음(글자 없이) + «공유». 누르면 공유 창. */
export function projShareButton(p: any, members: any[], onChanged: () => void): HTMLElement {
  const row = { ...p, members };
  const stack = projPeopleStack(row, { max: 3, size: 's' });
  const btn = el('button', { class: 'btn btn-sm pjh-share-btn', type: 'button', title: '공유 — 함께할 사람 · 공개 범위' },
    stack, el('span', { text: '공유' })) as HTMLButtonElement;
  btn.onclick = () => openProjectSharePopover(btn, row, onChanged);
  return btn;
}
