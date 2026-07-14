// start.ts — 구성원 온보딩 (#846 / 태스크 850)
//  "온보딩은 여기서 시작해서 여기서 끝난다" — 유일한 **진입·완주 표면**.
//
//  ⚠ 화면은 SoT 가 아니다. 상태의 SoT 는 서버 `computeMemberOnboarding`(src/org/onboarding.ts) 한 함수이고
//   이 화면과 AI 온보딩 스킬이 **같은 REST(/api/ui/me/onboarding)** 를 읽는다 → 둘이 어긋나지 않는다.
//   (화면이 상태를 계산하기 시작하면 AI 가 "3/4 하셨네요" 할 때 화면은 2/4 를 보여주는 일이 생긴다.)
//
//  ⚠ 이 페이지는 **값을 편집하지 않는다.** 케이스별로 관리탭·프로젝트로 보내는 **딥링크 런처**다
//   (편집 UI 를 두면 관리탭과 두 개의 진실이 생긴다).
//
//  판정: 자동(서버가 아는 것) 위주 + AI 보고(서버가 볼 수 없는 로컬 이관). 수동 마킹은 ⋯ 메뉴 안에만 둔다
//   (기본 동선에 노출하지 않음 — 사용자가 손으로 체크하는 게 기본이 되면 진행률이 의미를 잃는다).
import { api, el, pageHead, toast } from './core.js';
const ICON = { done: '✓', skipped: '—', todo: '○' };
const TONE = { done: '#3a9d6e', skipped: '#9aa0a6', todo: '#c9ccd1' };
function bar(pct) {
    return el('div', { style: 'height:8px;background:#ececec;border-radius:4px;overflow:hidden;margin:10px 0' }, el('div', { style: `height:100%;width:${pct}%;background:#3a9d6e;transition:width .3s` }));
}
// 조직 축(관리자가 채우는 5단계) 배지 — 구성원 온보딩을 다 해도 **회사 맥락이 비어 있으면** AI 는
//  baseline 안내만 한다. ②③만 하고 ①을 잊는 실수를 화면에서도 막는다(kit/setup/온보딩.md 3층 표와 같은 이유).
async function orgBadge() {
    try {
        const s = await api('/api/ui/org/onboarding');
        if (!s || s.complete)
            return null; // 조직이 다 됐으면 조용히 사라진다
        return el('a', { href: '#/onboarding', class: 'card', style: 'display:block;text-decoration:none;color:inherit;border-left:3px solid #d9a441' }, el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px' }, el('span', {}, el('strong', { text: `회사 설정 ${s.done}/${s.total}` }), ' — 아직 채우는 중입니다'), el('span', { class: 'accent', text: '보기 →' })), el('p', { class: 'admin-hint', style: 'margin:6px 0 0', text: '이게 다 채워져야 AI 가 우리 회사 맥락(도메인·지식·규칙)을 알고 대답합니다. 관리자가 하는 일이라 기다리셔도 되고, 관리자면 눌러서 이어가세요.' }));
    }
    catch {
        return null;
    }
}
async function mark(step, state, view) {
    await api('/api/ui/me/onboarding', { method: 'POST', body: JSON.stringify({ step, state, by: 'self' }) });
    toast(state === 'reset' ? '다시 열었습니다' : state === 'skipped' ? '해당 없음으로 표시했습니다' : '완료로 표시했습니다');
    await renderStart(view); // 서버가 돌려준 최신 상태로 다시 그린다(화면이 상태를 들고 있지 않다)
}
function stepCard(it, view) {
    const tone = TONE[it.state] || TONE.todo;
    // ⋯ = escape hatch. 기본 동선이 아니다 — AI 보고·자동 판정이 주(主)이고, 이건 "의도적으로 마킹하고 싶을 때".
    const more = el('details', { class: 'ob-more', style: 'position:relative' }, el('summary', { style: 'list-style:none;cursor:pointer;color:#9aa0a6;padding:2px 8px', text: '⋯' }), el('div', { class: 'card', style: 'position:absolute;right:0;top:26px;z-index:5;padding:6px;min-width:150px;display:flex;flex-direction:column;gap:2px' }, it.state !== 'done' ? el('button', { class: 'btn btn-ghost', style: 'justify-content:flex-start', text: '완료로 표시', onclick: () => mark(it.key, 'done', view) }) : null, it.state !== 'skipped' && !it.required ? el('button', { class: 'btn btn-ghost', style: 'justify-content:flex-start', text: '해당 없음', onclick: () => mark(it.key, 'skipped', view) }) : null, it.state !== 'todo' ? el('button', { class: 'btn btn-ghost', style: 'justify-content:flex-start', text: '다시 열기', onclick: () => mark(it.key, 'reset', view) }) : null));
    const badges = el('span', { style: 'display:inline-flex;gap:6px;align-items:center;margin-left:8px' }, it.required ? el('span', { class: 'admin-hint', style: 'font-size:11px', text: '필수' }) : null, 
    // 누가 채웠는지 — AI 가 채운 건 그렇게 보여준다(왕복이 보이면 신뢰가 생긴다).
    it.state === 'done' && it.by === 'ai' ? el('span', { class: 'admin-hint', style: 'font-size:11px', text: 'AI가 완료' }) : null, it.state === 'done' && it.by === 'auto' ? el('span', { class: 'admin-hint', style: 'font-size:11px', text: '확인됨' }) : null, it.state === 'skipped' ? el('span', { class: 'admin-hint', style: 'font-size:11px', text: '해당 없음' }) : null);
    return el('div', { class: 'card', style: `border-left:3px solid ${tone}` }, el('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:10px' }, el('div', { style: 'display:flex;align-items:center;gap:10px;min-width:0' }, el('span', { style: `color:${tone};font-weight:700;width:16px;text-align:center`, text: ICON[it.state] || '○' }), el('strong', { text: it.label }), badges), more), el('p', { class: 'admin-hint', style: 'margin:8px 0 0 26px', text: it.how }), it.note ? el('p', { class: 'admin-hint', style: 'margin:4px 0 0 26px;font-style:italic', text: it.note }) : null, it.href && it.state !== 'done' ? el('div', { style: 'margin:10px 0 0 26px' }, el('a', { class: 'btn', href: it.href, text: '해보기 →' })) : null);
}
export async function renderStart(view) {
    const head = pageHead('시작하기', '라이블리를 쓸 준비가 얼마나 됐는지 한눈에 봅니다. AI 도 같은 현황을 읽으니, AI 에게 "온보딩 도와줘" 라고 하면 이어서 도와줍니다.');
    const slot = el('div', {});
    view.replaceChildren(head, slot);
    let d;
    try {
        d = await api('/api/ui/me/onboarding');
    }
    catch (e) {
        slot.replaceChildren(el('p', { class: 'admin-hint', text: '현황을 불러오지 못했습니다 — ' + e.message }));
        return;
    }
    const s = d.status;
    const done = s.complete
        ? el('div', { class: 'card', style: 'border-left:3px solid #3a9d6e' }, el('strong', { text: '준비 끝 — 이제 그냥 쓰시면 됩니다.' }), el('p', { class: 'admin-hint', style: 'margin:6px 0 0', text: '아래 선택 항목은 필요할 때 하시면 됩니다. AI 에게 한국어로 물어보세요 — 회사 맥락을 알고 답합니다.' }))
        : null;
    slot.replaceChildren(el('div', { class: 'card' }, el('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, el('strong', { text: `${s.done}/${s.total} 완료` }), el('span', { class: 'admin-hint', text: s.complete ? '필수 항목을 다 하셨어요' : '필수 항목만 마치면 시작할 수 있어요' })), bar(s.pct)), await orgBadge(), done, ...s.items.map((it) => stepCard(it, view)));
}
// #/start/migrate — "예전 환경 가져오기" 스텝의 안내. **여기서 이관을 하지 않는다**(로컬 파일은 웹이 못 만진다).
//  AI 에게 시키는 법만 알려주고, 실제 작업·완료 보고는 lively-onboarding 스킬이 한다.
export async function renderStartMigrate(view) {
    view.replaceChildren(pageHead('예전에 쓰던 AI 환경 가져오기', '이 일은 AI 가 합니다 — 웹에서는 할 수 없어요(내 컴퓨터의 파일을 웹이 읽을 수 없으니까요).'), el('div', { class: 'card' }, el('strong', { text: '내 컴퓨터에서 AI 를 켜고, 이렇게 말해보세요' }), el('pre', { style: 'background:#f6f7f8;padding:12px;border-radius:6px;margin:10px 0', text: '온보딩 도와줘' }), el('p', { class: 'admin-hint', style: 'margin:0', text: 'AI 가 예전 작업 메모·직접 만든 스킬·연결해 둔 서비스·쓰던 코드 저장소를 읽기만 해서 보여주고, 무엇을 회사 위키로 올리고 무엇을 그대로 둘지 하나씩 같이 정합니다. 원본은 건드리지 않습니다(복사만 하고 지우지 않습니다). 다 끝나면 이 화면에도 자동으로 완료 표시가 됩니다.' })), el('div', { class: 'card' }, el('strong', { text: '"예전 기억이 사라졌어요"' }), el('p', { class: 'admin-hint', style: 'margin:6px 0 0', text: '사라지지 않았습니다. AI 의 작업 메모는 폴더마다 따로 저장돼서, 다른 폴더에서 켜면 안 보일 뿐입니다. 위 도우미가 다른 폴더에 있던 것까지 찾아서 보여줍니다.' })), el('div', { class: 'card' }, el('strong', { text: '웹 [터미널] 탭에서 쓰고 계신가요?' }), el('p', { class: 'admin-hint', style: 'margin:6px 0 0', text: '그 세션은 회사 서버에서 돌아갑니다 — 그래서 내 노트북에 있던 예전 환경을 볼 수 없습니다. 가져오시려면 내 컴퓨터에 설치한 뒤 거기서 도우미를 부르세요. 가져올 게 없다면 이 항목은 건너뛰셔도 됩니다.' }), el('div', { style: 'margin-top:10px' }, el('a', { class: 'btn', href: '#/start/setup', text: '내 컴퓨터에 설치하기 →' }))));
}
