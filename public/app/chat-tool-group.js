// chat-tool-group.ts — 접힌 도구 줄의 **한 줄 요약 문구**(#1822). 순수 함수 — DOM 없음.
//
//  ── 왜 chat-view.ts 에서 떼어냈나 ──
//  ① 이 문구가 틀려도 화면은 멀쩡해 보인다 — 접힌 줄은 '그럴듯한 한 줄'이라 아무도 버그로 신고하지 않는다(조용한 회귀).
//  ② chat-view.ts 는 최상단에서 core.js(→ location)를 만져 **Node 에서 import 되지 않는다** — 테스트가 붙을 자리가 없다.
//   그래서 문구 계산만 DOM 없는 모듈로 내려 scripts/chat-tool-group.test.mjs 가 산출물을 그대로 부른다.
//
//  ── 무엇이 바뀌었나(#1822) ──
//  종전엔 여럿이면 무조건 `도구 5개 사용함` 이라 **무슨 도구를 불렀는지가 접힌 줄에서 통째로 사라졌다.** 그래서 대화를 눈으로
//  훑어서는 "이 세션이 라이블리를 불렀나"를 알 수 없고, 묶음을 하나씩 펼쳐 봐야 했다(실측: lively MCP 호출 27건이 전부
//  렌더돼 있는데도 사람이 못 찾았다 — 프로젝트 #1822 의 계기).
//  이제 **무엇을 몇 개 썼는지**를 말한다: `라이블리 5개 · 명령 2개 · 읽기 사용함`.
//  접는 이유(대화가 슬립에 묻히지 않게 — 실측 지적 "너무 많이 뜬다")는 그대로다: 여전히 **한 줄**이고, 종류가 많으면 잘라 낸다.
//
//  ⚠ 브라우저 찾기(Ctrl+F)는 이 문구와 무관하다 — 닫힌 <details> 는 Chromium 이 찾을 때 자동으로 펼친다(실측 Chrome 151:
//   단일·중첩 모두 열림). 즉 접힘은 '검색을 막는 것'이 아니라 '**눈으로 훑기**를 막는 것'이었고, 여기서 고치는 건 후자다.
/** 접힌 줄에 이름을 몇 종까지 늘어놓나 — 넘으면 `외 N종`. 한 줄을 넘기지 않기 위한 상한. */
const MAX_KINDS = 3;
const named = (it) => (it.label || '도구') + (it.detail ? ' ' + it.detail : '');
/**
 * 접힌 도구 줄의 한 줄 요약.
 * - 도는 중이면 **지금 도는 것**을 말한다(종전 그대로 — 끝난 것보다 도는 것이 궁금하다).
 * - 끝났으면 **무엇을 썼는지**를 종류별 개수로 말한다. 한 장뿐이면 대상까지 붙인다.
 */
export function toolGroupSummary(items) {
    const n = items.length;
    if (!n)
        return '';
    const running = items.filter((it) => it.running);
    if (running.length) {
        const cur = running[running.length - 1];
        return n === 1 ? `${named(cur)} 실행 중` : `${cur.label || '도구'} 실행 중 · ${n}개째`;
    }
    const errs = items.filter((it) => it.err).length;
    const tail = errs ? ` · 실패 ${errs}` : '';
    if (n === 1)
        return `${named(items[0])} 사용함${tail}`;
    // 종류별 개수 — 처음 나온 순서대로(시간 순서가 곧 읽는 순서다).
    const byLabel = new Map();
    for (const it of items) {
        const l = it.label || '도구';
        byLabel.set(l, (byLabel.get(l) ?? 0) + 1);
    }
    const parts = [...byLabel].map(([l, k]) => (k > 1 ? `${l} ${k}개` : l));
    const head = parts.length > MAX_KINDS
        ? `${parts.slice(0, MAX_KINDS).join(' · ')} 외 ${parts.length - MAX_KINDS}종`
        : parts.join(' · ');
    return `${head} 사용함${tail}`;
}
