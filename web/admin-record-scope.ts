// admin-record-scope.ts — [AI 능력 ▸ 스킬 · 훅 ▸ 기록 범위] 조직 기본값 편집(#5016 후속).
//  구성원 컴퓨터에서 연 AI 에 라이블리를 붙일 폴더를 조직이 정한다 — 스킬 배포와 같은 모양:
//   조직(여기, 관리자) = 방식 하나 + 목록 둘. 구성원 = 컴퓨터마다 목록만 덮어쓴다([내 스킬 · 훅 ▸ 내 컴퓨터별 연결]) — 방식은 못 바꾼다.
//  방식: 작업 폴더에서만(기본 꺼짐 · 허용 목록) | 어디서나(기본 켜짐 · 제외 목록). 두 목록은 따로 남는다(방식을 바꿔도 지우지 않는다).
//  API: GET/POST /api/ui/org/record-scope (org_record_scope_get · org_record_scope_set — 관리자). 허용 목록은 org_runtime_config.work_roots 와 같은 칸.
import { api, cardHead, el, toast, uiText } from './core.js';

type Scope = 'work_folders' | 'anywhere';
const MODES: [Scope, string, string][] = [
  ['work_folders', '작업 폴더에서만',
    '기본 꺼짐 — 허용 목록에 든 폴더와 라이블리 프로젝트 폴더에서 연 AI만 라이블리에 연결합니다. 그 밖에서 연 AI는 라이블리가 꺼집니다(맥락 주입·기록·도구 없음).'],
  ['anywhere', '어디서나',
    '기본 켜짐 — 제외 목록에 든 폴더 말고는 어느 폴더에서 연 AI든 라이블리에 연결합니다. 개인 폴더에서 나눈 대화도 워크스페이스에 기록될 수 있습니다.'],
];

const linesOf = (v: string) => v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

export async function recordScopeEditor(h: HTMLElement) {
  let cur: { scope: Scope; work_roots: string[]; exclude_roots: string[] };
  try { cur = ((await api('/api/ui/org/record-scope')) as any).record_scope; }
  catch (e: any) { h.replaceChildren(el('p', { class: 'admin-hint', text: '불러오지 못했습니다 — ' + ((e && e.message) || '') })); return; }

  const save = async (patch: Record<string, unknown>, msg: string) => {
    try {
      const r: any = await api('/api/ui/org/record-scope', { method: 'POST', body: JSON.stringify(patch) });
      if (r && r.record_scope) cur = r.record_scope;
      paint();
      toast(msg);
      return true;
    } catch (e: any) { toast((e && e.message) || '저장하지 못했습니다', true); return false; }
  };

  const seg = el('div', { class: 'tm-seg', role: 'group', 'aria-label': '조직 기록 방식' });
  const hint = el('div', { class: 'tm-hint' });
  for (const [mode, label] of MODES) {
    const b = el('button', { type: 'button', class: 'tm-seg-btn', text: label, 'aria-pressed': 'false' });
    (b as any).dataset.scope = mode;
    b.addEventListener('click', () => {
      if (mode === cur.scope) return;
      const warn = mode === 'anywhere'
        ? '«어디서나» 로 바꿀까요?\n\n모든 구성원 컴퓨터에서 제외 목록 밖의 폴더라면 어디서 연 AI든 라이블리에 연결됩니다. 개인 폴더의 대화도 워크스페이스에 기록될 수 있습니다.\n구성원 컴퓨터의 다음 세션부터 적용됩니다.'
        : '«작업 폴더에서만» 으로 바꿀까요?\n\n모든 구성원 컴퓨터에서 허용 목록(과 구성원이 직접 등록한 작업 폴더)·라이블리 프로젝트 폴더 밖에서 연 AI는 라이블리가 꺼집니다.\n구성원 컴퓨터의 다음 세션부터 적용됩니다.';
      if (!confirm(warn)) return;
      void save({ scope: mode }, `기록 방식을 «${label}» 으로 바꿨습니다. 구성원 컴퓨터의 다음 세션부터 적용됩니다.`);
    });
    seg.append(b);
  }

  // 목록 하나 — 한 줄에 경로 하나. 지금 방식에서 안 쓰는 목록도 보여 주되 흐리게(방식을 바꾸면 그 목록을 쓴다).
  const listBox = (key: 'work_roots' | 'exclude_roots', title: string, desc: string, placeholder: string) => {
    const ta = el('textarea', { class: 'aud-inp', rows: '4', style: 'width:100%; font-family:var(--mono, monospace); font-size:12px', placeholder, 'aria-label': title }) as HTMLTextAreaElement;
    const btn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '저장' }) as HTMLButtonElement;
    const note = el('p', { class: 'admin-hint', style: 'margin:4px 0 0' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await save({ [key]: linesOf(ta.value) }, `${title}을 저장했습니다. 구성원 컴퓨터의 다음 세션부터 적용됩니다.`);
      btn.disabled = false;
    });
    const wrap = el('div', { style: 'margin-top:12px' },
      el('b', { style: 'font-size:13px', text: title }),
      el('p', { class: 'admin-hint', style: 'margin:2px 0 6px' }, ...uiText(desc)),
      ta, el('div', { style: 'display:flex; justify-content:flex-end; margin-top:6px' }, btn), note);
    const fill = () => {
      ta.value = (cur[key] || []).join('\n');
      const used = (key === 'work_roots') === (cur.scope === 'work_folders');
      wrap.style.opacity = used ? '1' : '0.55';
      note.replaceChildren(...uiText(used ? '' : '지금 방식에서는 쓰지 않습니다 — 방식을 바꾸면 이 목록을 씁니다(지우지 않고 남겨 둡니다).'));
    };
    return { wrap, fill };
  };
  const allow = listBox('work_roots', '허용 목록 (작업 폴더)',
    '«작업 폴더에서만» 방식에서 라이블리를 켜는 폴더입니다. 한 줄에 절대경로나 ~ 로 시작하는 경로 하나(예: ~/company · /Users/shared/repo). ~ 는 구성원마다 자기 홈으로 펴집니다.',
    '~/company\n/Users/shared/repo');
  const deny = listBox('exclude_roots', '제외 목록 (제외 폴더)',
    '«어디서나» 방식에서 라이블리를 끄는 폴더입니다. 한 줄에 절대경로나 ~ 로 시작하는 경로 하나(예: ~/personal · ~/Downloads). 그 아래 폴더도 모두 꺼집니다(라이블리 프로젝트 폴더는 켜집니다).',
    '~/personal\n~/Downloads');

  const paint = () => {
    for (const b of seg.children as any) {
      const on = b.dataset.scope === cur.scope;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const found = MODES.find(([m]) => m === cur.scope) || MODES[0];
    hint.replaceChildren(...uiText(found[2]));
    allow.fill(); deny.fill();
  };
  paint();

  h.replaceChildren(el('div', { class: 'card' },
    cardHead('기록 범위'),
    el('p', { class: 'admin-hint', style: 'margin:0 0 10px' }, ...uiText(
      '구성원 컴퓨터에서 연 AI 세션에 라이블리(회사 맥락 주입·기록·도구)를 붙일 폴더의 조직 기본값입니다. '
      + '구성원은 컴퓨터마다 목록만 덮어쓸 수 있습니다 — 자기 폴더를 더하거나 빼고, 조직 줄을 그 컴퓨터에서만 끌 수 있습니다. 방식은 바꿀 수 없습니다. '
      + '라이블리가 띄운 세션과 라이블리 프로젝트 폴더는 방식과 상관없이 켜집니다.')),
    el('div', { class: 'tm-policy' },
      el('div', { style: 'display:flex; align-items:center; gap:10px; flex-wrap:wrap' },
        el('b', { style: 'font-size:13px; margin-right:auto', text: '기록 방식' }), seg), hint),
    allow.wrap, deny.wrap,
    el('p', { class: 'admin-hint', style: 'margin:12px 0 0' }, ...uiText(
      '구성원 컴퓨터의 다음 세션부터 적용됩니다. 허용 목록은 [세션 주입 ▸ 작업 중]의 작업 폴더(work-roots)와 같은 목록입니다.'))));
}
