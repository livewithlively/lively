// asks/kind-secret.ts — 세션 요청 ▸ 자격 입력칸 카드(#1631 → #5713). 서버 짝: src/asks/kinds/secret.ts.
//  종전엔 리브 카드(web/liv-cards.ts livSecretCard)였다 — 어느 세션이든 쓰게 풀면서 이리로 옮겼다.
import { el } from '../core.js';
import type { Ask } from './api.js';
import { registerAskKind, type AskCtx } from './registry.js';

interface SecretPayload {
  label?: string; why?: string; hint?: string;
  /** 저장 위치 — **서버가 만든 문장**(본인 금고 대상). label·why·hint 는 AI 가 쓴 말이라 값이 갈 곳을 말해 줄 수 없다 — 그래서 다른 칸에 보인다. */
  dest?: string;
}

/**
 * 자격 입력칸 — **이 화면에서 끝내기 위한 장치**.
 *
 * 실측 2회 모두 리브는 시크릿을 채팅에 붙여넣으라고 했고(대화 기록에 남는다), 화면으로 돌릴 때는
 * 없는 메뉴 경로를 지어냈다. 안내를 다듬어 고칠 문제가 아니라 **여기서 받을 자리가 없던 것**이 원인이다.
 *
 * 계약: 넣을 자리는 서버가 저장해 둔 요청에서만 온다(브라우저가 대상을 못 바꾼다). 값은 전송 즉시
 * 암호화 저장되고 화면에서도 지운다. 저장되면 요청을 건 세션에 **사람 대신 한 마디 건네** 대화가 이어진다.
 */
function secretCard(req: Ask, ctx: AskCtx): HTMLElement {
  const ask = req.payload as SecretPayload;
  const input = el('input', {
    class: 'liv-ask-input', type: 'password', autocomplete: 'off', spellcheck: 'false',
    placeholder: ask.hint || '여기에 붙여넣어 주세요', 'aria-label': ask.label,
  }) as HTMLInputElement;
  const msg = el('div', { class: 'liv-ask-msg' });
  const save = el('button', { class: 'btn btn-sm btn-primary liv-ask-go', type: 'button', text: '저장' }) as HTMLButtonElement;

  const submit = async (): Promise<void> => {
    const value = input.value;
    if (!value.trim()) { input.focus(); return; }
    save.disabled = true; input.disabled = true; save.textContent = '저장 중…';
    try {
      await ctx.submit({ value });
      input.value = '';  // 화면에서도 즉시 지운다
      // 확인은 카드 밖(토스트)에 뜬다 — 카드는 곧 다시 그려져 사라진다(registry.ts submitAndTell).
    } catch (e) {
      save.disabled = false; input.disabled = false; save.textContent = '저장';
      msg.replaceChildren(el('span', { class: 'liv-ask-err', text: String((e as Error)?.message ?? e) }));
      input.focus();
    }
  };
  save.onclick = () => void submit();
  input.onkeydown = (ev: KeyboardEvent) => { if (ev.key === 'Enter') { ev.preventDefault(); void submit(); } };

  return el('div', { class: 'liv-ask' },
    el('div', { class: 'liv-ask-head' }, el('b', { text: ask.label })),
    //  저장 위치는 리브의 말(label·why) 사이가 아니라 이름 바로 아래 제 칸에 — 긴 why 에 밀려 안 보이거나 리브의 문장과 섞이지 않게.
    ask.dest ? el('div', { class: 'liv-ask-dest', text: ask.dest }) : null,
    ask.why ? el('div', { class: 'liv-ask-why', text: ask.why }) : null,
    el('div', { class: 'liv-ask-row' }, input),
    el('div', { class: 'liv-ask-row liv-ask-acts' }, ctx.later(), save),
    el('div', { class: 'liv-ask-note', text: '입력하신 값은 잠긴 보관함으로 바로 들어가고, 대화 기록에는 남지 않습니다.' }),
    msg);
}

registerAskKind('secret', { render: secretCard });
