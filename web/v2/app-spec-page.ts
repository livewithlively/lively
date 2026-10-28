// v2/app-spec-page.ts — 앱 「개발 정보」(#4632, 원준 2026-10-26 «앱의 코드를 SSOT로 해서 코드 내용을 자연어로 번역해준 시트 … 회의록 앱에서
//  전사하기 위해 무슨 api를 쓰는지 … 다른 세션을 시켜서 바꿔도 자동으로 그 페이지의 명세가 바뀌도록»). 앱빌더 안 #/builder/spec/<앱>.
//  서버(GET /api/ui/apps/:id/spec · capabilities/apps.ts app_spec)가 보는 사람의 판 코드로 두 층을 준다 — 규칙은 lib/app-spec-view.
//   · 위: AI 가 쓴 쉬운 말 설명(한눈에 · 달라진 점 · 바깥 서비스와 API · 기능 · 화면 · 저장하는 정보 · 권한 · 한계)
//   · 아래: 코드에서 바로 읽은 것(호출과 그 자리 · 표와 칸 · 권한 · 파일) — 열 때마다 코드에서 읽으니 늘 맞다.
//  설명을 쓰는 중이면 6초마다 다시 묻는다(창이 붙어 있는 동안만).
import { api, el, toast } from '../core.js';
import { icon } from './icons.js';
import { callKindLabel, isCurrentSpec, mergeTables, regenToast, sizeText, specShouldPoll, specStateLine, whereText, type SpecResponse } from '../lib/app-spec-view.js';

const POLL_MS = 6000;
const POLL_MAX = 100;   // 10분
const FAIL_MAX = 5;   // 쓰는 중에 다시 묻기가 연달아 이만큼 실패하면 멈추고 「다시 불러오기」(감사 4-11)

type Kid = HTMLElement | null;
const kids = (xs: Kid[]): HTMLElement[] => xs.filter((x): x is HTMLElement => !!x);
const sec = (title: string, sub: string, ...body: Kid[]): HTMLElement =>
  el('section', { class: 'v2-spec-sec' }, el('h2', { text: title }, sub ? el('small', { text: sub }) : null), ...kids(body));
const code = (t: string): HTMLElement => el('code', { class: 'v2-spec-code', text: t });

/** 개발 정보 화면을 host 에 세운다. back = 「‹ 앱빌더」. 돌려주는 함수를 부르면 다시 묻기를 멈춘다. */
export function renderAppSpec(host: HTMLElement, appId: string, back: () => void): () => void {
  const head = el('div', { class: 'v2-spec-top' });
  const body = el('div', { class: 'v2-spec-body' }, el('p', { class: 'v2-bld-empty', text: '불러오는 중…' }));
  const root = el('div', { class: 'v2-spec' }, head, el('div', { class: 'v2-spec-scroll' }, body));
  host.replaceChildren(root);
  let timer = 0; let polls = 0; let stopped = false; let fails = 0; let last: SpecResponse | null = null;
  const stop = (): void => { stopped = true; window.clearTimeout(timer); };
  const backBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: back }, el('span', { text: '‹ 앱빌더' }));
  head.replaceChildren(backBtn, el('h1', { text: '개발 정보' }));

  let painted = false;
  const load = async (method: 'GET' | 'POST' = 'GET'): Promise<void> => {
    window.clearTimeout(timer);
    let r: SpecResponse;
    try {
      r = await api('/api/ui/apps/' + encodeURIComponent(appId) + '/spec', method === 'POST' ? { method: 'POST', body: JSON.stringify({ regenerate: true }) } : undefined) as SpecResponse;
    } catch (e: any) {
      if (stopped || !root.isConnected) return;
      //  쓰는 중에 다시 묻기가 실패했다(네트워크 한 번) — 멈추지 않고 정해진 횟수 안에서 다시 묻는다. 그래도 안 되면 도는 표시를 멈추고 「다시 불러오기」(감사 4-11).
      if (painted && last && specShouldPoll(last.spec_state) && method === 'GET' && !(e && e.status === 404)) {
        fails++;
        if (fails < FAIL_MAX) { timer = window.setTimeout(() => { if (root.isConnected) void load(); else stop(); }, POLL_MS); return; }
        paint(last, 'lost'); return;
      }
      //  이미 그린 화면이 있으면(다시 만들기 실패) 지우지 않고 알리기만 — 코드에서 읽은 것은 그대로 쓸 수 있다.
      if (painted && !(e && e.status === 404)) { toast('개발 정보를 다시 불러오지 못했어요. ' + (e && e.message ? e.message : ''), true); return; }
      body.replaceChildren(el('p', { class: 'v2-bld-empty', text: e && e.status === 404 ? '이 앱을 찾을 수 없어요. 지워졌거나 볼 수 없는 앱이에요.' : '개발 정보를 불러오지 못했어요. 잠시 후 다시 시도해주세요.' }));
      return;
    }
    if (stopped || !root.isConnected) return;
    painted = true; fails = 0; last = r;
    if (method === 'POST') { const t = regenToast(r); toast(t.text, t.warn); }
    const more = specShouldPoll(r.spec_state) && polls < POLL_MAX;
    paint(r, specShouldPoll(r.spec_state) && !more ? 'slow' : '');
    if (more) { polls++; timer = window.setTimeout(() => { if (root.isConnected) void load(); else stop(); }, POLL_MS); }
  };

  //  stop = 묻기를 멈췄다 — 'slow' 쓰는 중인데 10분 동안 끝나지 않았다 · 'lost' 다시 묻기가 연달아 실패했다. 도는 표시 대신 「다시 불러오기」.
  const paint = (r: SpecResponse, halt: '' | 'slow' | 'lost' = ''): void => {
    const gaveUp = !!halt;
    const doc = r.spec && r.spec.doc ? r.spec.doc : null;
    const f = r.facts;
    const line = halt === 'slow' ? { tone: 'warn' as const, text: '설명을 쓰는 데 오래 걸리고 있어요. 「다시 불러오기」를 눌러 확인해 주세요.' }
      : halt === 'lost' ? { tone: 'warn' as const, text: '설명이 다 됐는지 확인하지 못했어요. 「다시 불러오기」를 눌러 주세요.' } : specStateLine(r);
    head.replaceChildren(...kids([backBtn, el('h1', {}, el('span', { text: '「' + (r.title || r.app_id) + '」 개발 정보' })),
      el('span', { class: 'v2-studio-sp' }),
      r.spec_state === 'failed' ? el('button', { class: 'v2-bld-pri sm', type: 'button', text: '다시 만들기', onclick: () => { polls = 0; void load('POST'); } }) : null,
      gaveUp ? el('button', { class: 'v2-bld-pri sm', type: 'button', text: '다시 불러오기', onclick: () => { polls = 0; fails = 0; void load(); } }) : null]));
    const state = el('div', { class: 'v2-spec-state ' + line.tone }, !gaveUp && specShouldPoll(r.spec_state) ? el('span', { class: 'v2-spec-spin', 'aria-hidden': 'true' }) : null, el('span', { text: line.text }));
    const tables = mergeTables(f.tables, doc);
    const aiOnly = (t: string): HTMLElement => el('p', { class: 'v2-bld-mini', text: t });
    const waitNote = doc ? null : aiOnly(specShouldPoll(r.spec_state) && !gaveUp ? 'AI 설명을 쓰는 중이에요.' : '설명이 없어 이 칸은 비어 있어요.');

    body.replaceChildren(...kids([
      state,
      el('p', { class: 'v2-bld-mini', text: '이 페이지는 앱의 코드를 기준으로 만들어요. 어느 세션에서 코드를 고쳐도 새 버전이 저장되면 설명을 저절로 다시 써요.' }),
      sec('한눈에', '', doc ? el('p', { class: 'v2-spec-lead', text: doc.summary }) : waitNote),
      doc && isCurrentSpec(r) && doc.changes.length ? sec('이번 버전에서 달라진 점', '', el('ul', { class: 'v2-spec-ul' }, ...doc.changes.map((t) => el('li', { text: t })))) : null,
      sec('바깥 서비스와 API', '이 앱이 라이블리나 바깥과 주고받는 것',
        doc ? (doc.external.length ? el('div', { class: 'v2-spec-cards' }, ...doc.external.map((x) => el('div', { class: 'v2-spec-card' },
          el('b', { text: x.what }),
          x.how ? el('p', {}, el('span', { class: 'k', text: '무엇으로' }), el('span', { text: x.how })) : null,
          x.data ? el('p', {}, el('span', { class: 'k', text: '주고받는 것' }), el('span', { text: x.data })) : null,
          x.code ? el('p', {}, el('span', { class: 'k', text: '코드' }), code(x.code)) : null))) : aiOnly('바깥과 주고받는 일이 없어요.')) : waitNote),
      doc && doc.features.length ? sec('기능', '누르면 일어나는 일', ...doc.features.map((x) => el('div', { class: 'v2-spec-card' },
        el('b', { text: x.name }), x.steps.length ? el('ol', { class: 'v2-spec-ul' }, ...x.steps.map((t) => el('li', { text: t }))) : null,
        x.code ? el('p', {}, el('span', { class: 'k', text: '코드' }), code(x.code)) : null))) : null,
      sec('화면', '',
        doc && doc.screens.length ? el('div', { class: 'v2-spec-cards' }, ...doc.screens.map((x) => el('div', { class: 'v2-spec-card' }, el('b', { text: x.name }), x.where ? el('small', { text: x.where }) : null, x.what ? el('p', { text: x.what }) : null)))
          : f.pages.length ? el('ul', { class: 'v2-spec-ul' }, ...f.pages.map((p) => el('li', {}, el('span', { text: (p.title || p.key) + (p.places.length ? ' (' + p.places.join(', ') + ')' : '') + ' ' }), code(p.entry)))) : aiOnly('화면이 없는 앱이에요.')),
      sec('저장하는 정보', '앱의 표와 칸. 이름과 종류는 코드 그대로예요',
        tables.length ? el('div', { class: 'v2-spec-tables' }, ...tables.map((t) => el('div', { class: 'v2-spec-card' },
          el('b', {}, code(t.name)), t.what ? el('p', { text: t.what }) : null,
          el('div', { class: 'v2-spec-tw' }, el('table', { class: 'v2-spec-t' },
            el('thead', {}, el('tr', {}, el('th', { text: '칸' }), el('th', { text: '종류' }), el('th', { text: '뜻' }))),
            el('tbody', {}, ...t.columns.map((c) => el('tr', {}, el('td', {}, code(c.name)), el('td', { text: c.type }), el('td', { text: c.what })))))))))
          : aiOnly('저장하는 표가 없어요.')),
      sec('권한', '이 앱이 쓰도록 적어 둔 것',
        doc && doc.permissions.length ? el('ul', { class: 'v2-spec-ul' }, ...doc.permissions.map((x) => el('li', {}, el('b', { text: x.name }), el('span', { text: x.why ? ' ' + x.why : '' }))))
          : f.perms.length ? el('ul', { class: 'v2-spec-ul' }, ...f.perms.map((p) => el('li', { text: p.label }))) : aiOnly('따로 적어 둔 권한이 없어요.')),
      doc && doc.limits.length ? sec('한계와 주의할 점', '', el('ul', { class: 'v2-spec-ul' }, ...doc.limits.map((t) => el('li', { text: t })))) : null,
      el('h2', { class: 'v2-spec-div' }, icon('code', 'v2-ic'), el('span', { text: '코드에서 바로 읽은 것' }), el('small', { text: 'AI 없이 코드를 읽어 바로 보여 줘요. 열 때마다 지금 코드에서 읽어요.' })),
      sec('찾은 호출', '종류, 이름, 코드 속 자리',
        f.calls.length ? el('div', { class: 'v2-spec-tw' }, el('table', { class: 'v2-spec-t' },
          el('thead', {}, el('tr', {}, el('th', { text: '종류' }), el('th', { text: '이름' }), el('th', { text: '하는 일' }), el('th', { text: '자리' }))),
          el('tbody', {}, ...f.calls.map((c) => el('tr', {}, el('td', { text: callKindLabel(c.kind) }), el('td', {}, code(c.name)), el('td', { text: c.label }), el('td', { class: 'w', text: whereText(c) }))))))
          : aiOnly('코드에서 찾은 호출이 없어요.')),
      f.server ? sec('앱 서버', '', el('p', {}, el('span', { text: '서버 코드가 있어요. ' }), f.server.start ? code(f.server.start) : null, f.server.dir ? el('span', { text: ' (' + f.server.dir + ' 폴더)' }) : null)) : null,
      sec('AI 지침', '', aiOnly(f.instructions ? '세션에 붙으면 AI가 이 앱의 지침을 함께 읽어요.' : '이 앱에는 AI가 읽을 지침이 없어요.')),
      sec('파일', r.version_no != null ? '이 버전의 파일 ' + f.files.length + '개' : '',
        el('ul', { class: 'v2-spec-files' }, ...f.files.map((x) => el('li', {}, code(x.path), el('small', { text: sizeText(x.size) }))))),
      r.spec && r.spec.made_at ? el('p', { class: 'v2-bld-mini', text: '설명은 AI가 코드를 읽고 쓴 거예요. 이름과 자리는 「코드에서 바로 읽은 것」이 기준이에요. ' + new Date(r.spec.made_at).toLocaleString('ko-KR') + '에 씀' + (r.spec.model ? ' (' + r.spec.model + ')' : '') }) : null,
    ]));
  };

  void load();
  return stop;
}
