// liv.ts — 리브 화면(#1631). **독립 전체화면**(#/liv) — 상단 내비·푸터를 걷고 화면 전부를 쓴다.
//
//  ── 이 화면이 무엇인가 ──
//  "지금 손볼 것"을 왼쪽 레일에 카드로 보여주고, 오른쪽에서 **리브에게 맡기면 실제로 해 주는** 화면.
//  카드의 [리브에게 맡기기]는 그 세션에 프롬프트를 주입한다 — 그래서 **사람이 터미널을 읽을 줄 몰라도
//  일이 진행된다**. 이게 v0 가 웹터미널을 재사용하면서도 성립하는 이유다.
//
//  ── 왜 홈이 아니라 별도 페이지인가(대표 결정) ──
//  처음엔 상태를 보고 **홈을 리브로 갈아치웠다**. 그건 과했다 — 사람이 기대한 화면이 아닌 게 뜨는 것은
//  그 자체로 고장으로 읽힌다. 이제 상단 내비의 [리브] 버튼으로 들어오는 자기 페이지이고, 홈은 늘 홈이다.
//  대신 여기서는 **크롬을 걷는다**: 대화가 주인공인 화면이라 탭·푸터가 높이를 먹으면 정작 말하기가 불편하다.
//
//  ── 판정은 여기서 하지 않는다 ──
//  무엇이 덜 됐는지(카드)는 서버가 이미 정해서 준다(GET /api/ui/me/liv).
//  화면이 자기 판정을 가지면 리브와 다른 답을 하고, 그게 #1618 이 잡아낸 실패다. 여기는 그리기만 한다.
import { api, el } from './core.js';
import { mountLivChat, livChatAsk } from './liv-chat.js';

export type LivMode = 'login' | 'liv' | 'dashboard';
export interface LivFinding {
  key: string; severity: 'p0' | 'p1'; scope: 'org' | 'member';
  title: string; detail: string; href?: string; prompt?: string;
}
/**
 * 리브가 지금 사람에게 받아야 하는 자격 하나. **값은 여기 오지 않는다** — 무엇이 필요한지만 온다.
 *
 * 이게 있으면 화면이 안전 입력칸을 띄운다. 그 값은 곧바로 금고로 가고 대화에는 남지 않는다.
 * (그래서 리브가 "시크릿을 여기 붙여넣어 주세요"라고 하거나 다른 탭으로 보낼 일이 없어진다.)
 */
export interface LivSecretAsk {
  kind?: 'secret' | 'choice' | 'upload';
  collector_id?: number; field?: string; label?: string; why?: string; hint?: string;
  /** 객관식 — 사람은 고르기만 하고, 그 답이 통계 축(key)으로 쌓인다. */
  key?: string; question?: string; multi?: boolean; allow_other?: boolean;
  options?: Array<{ id: string; label: string; hint?: string }>;
  /** 업로드 — 어떤 파일을 올리면 되는지 한 줄. */
  accept_hint?: string;
}

export interface LivStatus {
  mode: LivMode; reason: string; findings: LivFinding[]; total: number;
  context?: { isAdmin?: boolean; claudeLoggedIn?: boolean | null; nodes?: { registered: number; online: number } | null };
  secretAsk?: LivSecretAsk | null;
}

export async function livStatus(): Promise<LivStatus> {
  return await api('/api/ui/me/liv') as LivStatus;
}

// ── 대화 ─────────────────────────────────────────────────────────────────────
// v0 는 웹터미널 세션을 재사용했다(두뇌를 먼저 검증하려는 선택이었고, 그건 성공했다).
// v1 부터는 **세션을 만들지 않는다** — 턴마다 서버가 헤드리스를 띄우고 진행을 JSONL 로 남기며,
// 화면은 그걸 말풍선·액션카드로 그린다(web/liv-chat.ts). 그래서 여기 있던 것들이 통째로 사라졌다:
//   · 세션 찾기·만들기·죽은 세션 청소   → 세션이 없으니 청소할 것도 없다
//   · 여는 말 주입과 도달 확인 폴링      → 사람이 먼저 말을 건다(열자마자 리브가 떠들지 않는다)
//   · 프롬프트 주입(send-keys 규약)      → 대화창이 곧 입력이다
// 리브의 기억이 세션이 아니라 서버에 산다는 불변식(#1663) 덕분에 이 교체가 무손실이다.

// ── 화면 ─────────────────────────────────────────────────────────────────────

/** 셸이 이미 크롬(사이드바·우측 패널)을 주는 자리에 끼울 때의 선택지(#1719 v2).
 *  · rail — 카드("지금 손볼 것")를 그릴 바깥 호스트. 주면 본문은 대화 한 열만 남고, 카드는 그 호스트에 산다.
 *    v2 셸에선 우측 패널이 그 자리다 — 다른 페이지(본문 가운데·패널 오른쪽)와 같은 문법이 된다.
 *  · embedded — 나가는 길([← 라이블리])을 그리지 않는다(사이드바가 이미 있다). */
export interface RenderLivOpts { rail?: HTMLElement | null; embedded?: boolean }

export async function renderLiv(view: HTMLElement | null, opts: RenderLivOpts = {}): Promise<void> {
  if (!view) return; // 라우터가 넘기는 $view() 는 셸이 아직 없으면 null 이다(대시보드와 같은 계약)
  view.replaceChildren();
  document.body.dataset.route = 'liv';

  // 상단 내비를 걷었으니 **나가는 길이 화면 안에 있어야 한다** — 없으면 사람이 뒤로가기를 찾는다.
  //  하나만 둔다: 어디로 가는지가 분명한 [← 라이블리]. 탭을 여기 다시 그리면 크롬을 걷은 뜻이 없어진다.
  const head = el('div', { class: 'liv-head' },
    el('div', { class: 'liv-title' }, el('span', { class: 'liv-dot' }), el('b', { text: '리브' }),
      opts.embedded ? el('span', { class: 'liv-title-sub', text: '워크스페이스 담당자' }) : null),
    opts.embedded ? null : el('div', { class: 'liv-head-acts' },
      el('a', {
        class: 'btn btn-sm btn-ghost', href: '#/dashboard', text: '← 라이블리',
        title: '라이블리 홈으로 돌아갑니다. 리브는 상단 [리브] 버튼으로 다시 열 수 있습니다.',
      })));

  // 카드는 **왼쪽 레일**(이슈 목록 문법), 대화가 남은 폭·높이를 전부 먹는다. 카드가 위에 있으면 대화가
  //  절반으로 눌려 정작 리브와 말하기가 불편해진다 — 이 화면의 주인공은 대화다.
  const cards = el('div', { class: 'liv-cards' }, skeletonLine(), skeletonLine());
  // 리브가 던진 물음이 앉는 자리 — 대화와 **같은 칸**, 입력 바로 위(스크롤에 떠내려가지 않는다).
  const askHost = el('div', { class: 'liv-askdock' });
  const chatWrap = el('div', { class: 'liv-chat' },
    el('div', { class: 'liv-chat-body', id: 'liv-chat-body' }, el('div', { class: 'liv-chat-boot', text: '세션을 준비하고 있습니다…' })));

  // rail 을 받았으면 카드는 그쪽(셸의 우측 패널)에, 본문은 대화 한 열. 안 받았으면 종전 그대로 왼쪽 레일.
  if (opts.rail) {
    opts.rail.replaceChildren(cards);
    view.append(el('div', { class: 'liv-wrap' }, head, el('div', { class: 'liv-body liv-body-solo' }, chatWrap)));
  } else {
    view.append(el('div', { class: 'liv-wrap' }, head,
      el('div', { class: 'liv-body' }, el('aside', { class: 'liv-rail' }, cards), chatWrap)));
  }

  // 카드와 세션은 **독립적으로** 로드한다. 세션이 못 떠도 무엇이 문제인지는 보여야 하고,
  //  카드 조회가 느려도 대화는 먼저 시작될 수 있다(위젯 독립 실패 원칙과 같은 결).
  refreshLiv = () => { void fillLivCards(cards, askHost); };
  refreshLiv();
  mountLivChat(chatWrap.querySelector('.liv-chat-body') as HTMLElement, askHost);

  // 리브가 대화 중에 자격을 요청하면(me_liv_ask_secret) 화면이 그걸 알아야 입력칸이 뜬다.
  //  터미널은 iframe 이라 출력에서 신호를 읽을 수 없다 — 서버 상태를 가볍게 되묻는 쪽이 견고하다.
  //  ⚠ 사람이 타이핑 중인 입력칸을 갈아치우지 않는다(fillLivCards 가 그 경우 그냥 넘어간다).
  const poll = setInterval(() => {
    if (document.body.dataset.route !== 'liv') { clearInterval(poll); return; }  // 라우트를 떠나면 끝
    refreshLiv();
  }, 6000);
}

/** 화면 갱신 진입점 하나. 카드가 제출 뒤 자기 자신을 새로 그릴 때 **어느 칸에 사는지 알 필요가 없다** —
 *  물음은 대화 칸, 할 일은 레일로 갈렸는데 그 사실을 카드마다 인자로 나르면 한 자리만 틀려도 조용히 안 갱신된다. */
let refreshLiv: () => void = () => { /* renderLiv 전 */ };

/**
 * 물음을 **치우는 길**. 이게 없으면 리브가 건 물음은 답하기 전엔 영원히 남는다 —
 * 대화 칸에 고정한 뒤로는 그게 '리브가 지금 기다리는 것'이 아니라 **영구 가구**로 보인다(대표 지적).
 * 접으면 서버가 declined 에도 남겨, 다음 대화의 리브가 곧바로 다시 묻지 않는다.
 */
function livDismissBtn(): HTMLElement {
  return el('button', {
    class: 'btn btn-sm btn-ghost liv-ask-later', type: 'button', text: '나중에',
    title: '지금은 넘어갑니다. 리브가 이걸 다시 곧바로 묻지 않습니다.',
    onclick: async (ev: Event) => {
      const b = ev.currentTarget as HTMLButtonElement;
      b.disabled = true;
      await api('/api/ui/me/liv/ask-dismiss', { method: 'POST', body: '{}' }).catch(() => { /* 비치명 */ });
      refreshLiv();
    },
  });
}

function skeletonLine(): HTMLElement { return el('div', { class: 'liv-card liv-card-skel' }); }

/**
 * 레일에는 **서 있는 일**(지금 손볼 것)만 그린다. 리브가 지금 던진 물음은 여기가 아니다 — askHost 로 간다.
 *
 * ⚠ 왜 갈랐나(실측 2026-08-15): 리브가 "어디에 쌓아 두셨어요?"를 물었는데 그 물음이 **대화와 다른 칸**에
 *  떴다. 사람은 오른쪽에서 리브의 말을 읽는데 정작 고를 것은 왼쪽 끝에 있었고, 선택지 9개가 레일을 통째로
 *  먹어 '지금 손볼 것'을 화면 밖으로 밀어냈다. 물음이 대화 밖에 있으면 그건 대화가 아니라 서식이다.
 *  → 리브가 던진 물음은 **말하는 자리 바로 위**에 붙인다(대화와 같은 칸, 스크롤에 떠내려가지 않는 자리).
 */
export async function fillLivCards(host: HTMLElement, askHost: HTMLElement): Promise<void> {
  // 사람이 자격을 입력하는 중이면 손대지 않는다 — 다시 그리면 타이핑하던 값이 사라진다.
  const typing = askHost.querySelector('.liv-ask-input') as HTMLInputElement | null;
  if (typing && (typing.value !== '' || document.activeElement === typing)) return;

  let st: LivStatus;
  try { st = await livStatus(); }
  catch {
    host.replaceChildren(el('div', { class: 'liv-note', text: '지금 상태를 읽지 못했습니다. 옆에서 리브에게 직접 물어보셔도 됩니다.' }));
    return;
  }
  // 리브가 기다리는 물음 — 대화 칸의 입력 바로 위에. 이게 떠 있으면 리브는 그걸 기다리느라 멈춰 있다.
  const ask = st.secretAsk
    ? (st.secretAsk.kind === 'choice' ? livChoiceCard(st.secretAsk, askHost)
      : st.secretAsk.kind === 'upload' ? livUploadCard(st.secretAsk, askHost)
        : livSecretCard(st.secretAsk, askHost))
    : null;
  askHost.replaceChildren(...(ask ? [ask] : []));

  if (!st.findings.length) {
    host.replaceChildren(el('div', { class: 'liv-note' },
      el('b', { text: '지금 손볼 것은 없습니다.' }),
      el('span', { text: ' 옆에서 리브에게 무엇이든 물어보세요.' })));
    return;
  }
  host.replaceChildren(
    el('div', { class: 'liv-cards-title', text: `지금 손볼 것 ${st.total}` }),
    ...st.findings.map((f) => livCard(f, host)));
}

/**
 * 객관식 질문 — **사람은 고르기만 한다.**
 *
 * 실측에서 사람이 가장 오래 멈춘 자리가 자유서술이었다("어디에 쌓고 계셨나요?"). 없는 말을 지어내야 하니
 * 어렵고, 답이 제각각이라 우리도 개선점을 못 뽑는다. 고르게 하면 둘 다 풀린다 — 쉽고, **답이 저절로
 * 구조화된다**. 그래서 이 카드가 곧 통계 수집기다.
 */
function livChoiceCard(ask: LivSecretAsk, host: HTMLElement): HTMLElement {
  const picked = new Set<string>();
  const opts = el('div', { class: 'liv-ask-opts' });
  const send = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '이걸로' }) as HTMLButtonElement;
  // 복수 선택이면 고른 게 있어야 보낼 수 있다. 단일 선택은 누르는 즉시 보낸다(한 번 덜 누르게).
  const sync = (): void => { send.disabled = picked.size === 0 && !otherIn.value.trim(); };

  const submit = async (): Promise<void> => {
    send.disabled = true; const was = send.textContent; send.textContent = '보내는 중…';
    try {
      const r = await api('/api/ui/me/liv-answer', {
        method: 'POST',
        body: JSON.stringify({ choices: [...picked], other: otherIn.value.trim() || undefined }),
      }) as { labels?: string[]; other?: string };
      const said = [...(r.labels ?? []), ...(r.other ? [r.other] : [])].join(', ');
      // ⚠ 비우고 포커스를 뗀다 — 안 그러면 '타이핑 중이면 갱신하지 않는다' 가드에 걸려
      //  답을 보냈는데도 질문 카드가 그대로 남는다(실측).
      otherIn.value = ''; otherIn.blur();
      livToast('고르신 걸 전했습니다.');
      // 사람이 다시 타이핑하지 않아도 대화가 이어지게 — 무엇을 골랐는지 리브에게 그대로 말해 준다.
      if (said) livChatAsk(said);
      setTimeout(() => refreshLiv(), 600);
    } catch (e) {
      send.disabled = false; send.textContent = was ?? '이걸로';
      livToast(String((e as Error)?.message ?? e));
    }
  };

  for (const o of ask.options ?? []) {
    const b = el('button', { class: 'btn btn-sm liv-opt', type: 'button' },
      el('b', { text: o.label }), o.hint ? el('span', { class: 'liv-opt-hint', text: o.hint }) : null) as HTMLButtonElement;
    b.onclick = () => {
      if (ask.multi) {
        if (picked.has(o.id)) { picked.delete(o.id); b.classList.remove('liv-opt-on'); }
        else { picked.add(o.id); b.classList.add('liv-opt-on'); }
        sync();
      } else { picked.clear(); picked.add(o.id); void submit(); }
    };
    opts.append(b);
  }

  const otherIn = el('input', {
    class: 'liv-ask-input', type: 'text', autocomplete: 'off',
    placeholder: '목록에 없으면 여기 적어 주세요', 'aria-label': '그 외',
  }) as HTMLInputElement;
  otherIn.oninput = sync;
  otherIn.onkeydown = (ev: KeyboardEvent) => { if (ev.key === 'Enter') { ev.preventDefault(); void submit(); } };
  send.onclick = () => void submit();
  sync();

  return el('div', { class: 'liv-card liv-ask' },
    el('div', { class: 'liv-ask-head' }, el('b', { text: ask.question ?? '' })),
    ask.why ? el('div', { class: 'liv-ask-why', text: ask.why }) : null,
    opts,
    // '그 외'는 탈출구다 — 여기 적히는 것이 곧 다음에 만들 커넥터 후보라 버리지 않고 쌓는다.
    ask.allow_other ? el('div', { class: 'liv-ask-row' }, otherIn) : null,
    el('div', { class: 'liv-ask-row' }, (ask.multi || ask.allow_other) ? send : null, livDismissBtn()),
    ask.multi ? el('div', { class: 'liv-ask-note', text: '해당하는 걸 모두 고르셔도 됩니다.' }) : null);
}

/**
 * 파일 올리기 — **로컬 폴더를 뒤지는 대신 끌어다 놓는다**(대표 판단).
 *
 * 글자 파일만 받는다. PDF·이미지는 브라우저에서 글자를 못 뽑아 **올린 척만 하고 빈 자료가 쌓이므로**,
 * 되는 척하지 않고 그 자리에서 거른다.
 */
function livUploadCard(ask: LivSecretAsk, host: HTMLElement): HTMLElement {
  const TEXT_RE = /\.(md|markdown|txt|csv|tsv|json|ya?ml|log|rtf|html?|tex|org)$/i;
  const msg = el('div', { class: 'liv-ask-msg' });
  const input = el('input', { class: 'liv-upload-in', type: 'file', multiple: 'multiple' }) as HTMLInputElement;

  input.onchange = async (): Promise<void> => {
    const files = [...(input.files ?? [])];
    if (!files.length) return;
    const ok = files.filter((f) => TEXT_RE.test(f.name));
    const skipped = files.filter((f) => !TEXT_RE.test(f.name));
    input.disabled = true;
    let saved = 0; const failed: string[] = [];
    for (const f of ok) {
      try {
        const body_md = await f.text();
        if (!body_md.trim()) { failed.push(`${f.name}(비어 있음)`); continue; }
        await api('/api/ui/sources', { method: 'POST', body: JSON.stringify({
          kind: 'upload', title: f.name, body_md,
          occurred_at: new Date(f.lastModified).toISOString(),
        }) });
        saved++;
      } catch (e) { failed.push(`${f.name}(${(e as Error)?.message ?? e})`); }
    }
    input.disabled = false; input.value = '';
    const parts = [`${saved}개 올렸습니다`];
    if (skipped.length) parts.push(`${skipped.length}개는 글자 파일이 아니라 건너뛰었습니다`);
    if (failed.length) parts.push(`${failed.length}개 실패`);
    msg.replaceChildren(el('span', { class: failed.length ? 'liv-ask-err' : 'liv-ask-ok', text: parts.join(' · ') }));
    if (saved) {
      livChatAsk(`파일 ${saved}개 올렸어요: ${ok.slice(0, 10).map((f) => f.name).join(', ')}`);
      setTimeout(() => refreshLiv(), 1200);
    }
  };

  return el('div', { class: 'liv-card liv-ask' },
    el('div', { class: 'liv-ask-head' }, el('b', { text: ask.label ?? '파일 올리기' })),
    ask.why ? el('div', { class: 'liv-ask-why', text: ask.why }) : null,
    el('div', { class: 'liv-ask-row' }, input),
    el('div', { class: 'liv-ask-row' }, livDismissBtn()),
    el('div', { class: 'liv-ask-note', text: ask.accept_hint || '글자로 된 파일만 됩니다 — 메모·문서(.txt·.md)·표(.csv) 등. PDF·이미지는 아직 안 됩니다.' }),
    msg);
}

/**
 * 자격 입력칸 — **이 화면에서 끝내기 위한 장치**.
 *
 * 실측 2회 모두 리브는 시크릿을 채팅에 붙여넣으라고 했고(대화 기록에 남는다), 화면으로 돌릴 때는
 * 없는 메뉴 경로를 지어냈다. 안내를 다듬어 고칠 문제가 아니라 **여기서 받을 자리가 없던 것**이 원인이다.
 *
 * 계약: 넣을 자리는 서버가 저장해 둔 요청에서만 온다(브라우저가 대상을 못 바꾼다). 값은 전송 즉시
 * 암호화 저장되고 화면에서도 지운다. 저장되면 리브에게 **사람 대신 한 마디 건네** 대화가 이어진다.
 */
function livSecretCard(ask: LivSecretAsk, host: HTMLElement): HTMLElement {
  const input = el('input', {
    class: 'liv-ask-input', type: 'password', autocomplete: 'off', spellcheck: 'false',
    placeholder: ask.hint || '여기에 붙여넣어 주세요', 'aria-label': ask.label,
  }) as HTMLInputElement;
  const msg = el('div', { class: 'liv-ask-msg' });
  const save = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '저장' }) as HTMLButtonElement;

  const submit = async (): Promise<void> => {
    const value = input.value;
    if (!value.trim()) { input.focus(); return; }
    save.disabled = true; input.disabled = true; save.textContent = '저장 중…';
    try {
      await api('/api/ui/me/liv-secret', { method: 'POST', body: JSON.stringify({ value }) });
      input.value = '';  // 화면에서도 즉시 지운다
      // ⚠ 확인은 **카드 밖**(토스트)에 띄운다 — 카드 안에 쓰면 바로 뒤의 갱신이 카드째 지워서
      //  사람은 아무 일도 안 일어난 것처럼 본다(실측: 저장은 됐는데 화면엔 흔적이 없었다).
      livToast('저장했습니다. 리브가 이어서 확인합니다.');
      // 사람이 다시 타이핑하지 않아도 대화가 이어지게 한마디 건넨다 — 값은 절대 안 보낸다.
      livChatAsk('자격 저장했어요. 확인해 주세요.');
      setTimeout(() => refreshLiv(), 600);
    } catch (e) {
      save.disabled = false; input.disabled = false; save.textContent = '저장';
      msg.replaceChildren(el('span', { class: 'liv-ask-err', text: String((e as Error)?.message ?? e) }));
      input.focus();
    }
  };
  save.onclick = () => void submit();
  input.onkeydown = (ev: KeyboardEvent) => { if (ev.key === 'Enter') { ev.preventDefault(); void submit(); } };

  return el('div', { class: 'liv-card liv-ask' },
    el('div', { class: 'liv-ask-head' }, el('b', { text: ask.label })),
    ask.why ? el('div', { class: 'liv-ask-why', text: ask.why }) : null,
    el('div', { class: 'liv-ask-row' }, input, save, livDismissBtn()),
    el('div', { class: 'liv-ask-note', text: '입력하신 값은 잠긴 보관함으로 바로 들어가고, 대화 기록에는 남지 않습니다.' }),
    msg);
}

function livCard(f: LivFinding, host: HTMLElement): HTMLElement {
  const acts = el('div', { class: 'liv-card-acts' });
  if (f.prompt) {
    acts.append(el('button', {
      class: 'btn btn-sm btn-primary', type: 'button', text: '리브에게 맡기기',
      onclick: (ev: Event) => void livDelegate(ev.currentTarget as HTMLButtonElement, f),
    }));
  }
  if (f.href) acts.append(el('a', { class: 'btn btn-sm', href: f.href, text: f.prompt ? '직접 보기' : '보러 가기' }));
  // '나중에' 는 이 화면에서 그 카드를 접어 둘 뿐, 서버에 거절로 남기지 않는다 — 거절 기록은 리브가
  //  대화에서 사람 뜻을 확인하고 남길 일이다(화면 버튼 한 번으로 영구 침묵시키면 그게 더 위험하다).
  acts.append(el('button', {
    class: 'btn btn-sm btn-ghost', type: 'button', text: '나중에',
    onclick: (ev: Event) => { (ev.currentTarget as HTMLElement).closest('.liv-card')?.remove(); if (!host.querySelector('.liv-card')) refreshLiv(); },
  }));
  return el('div', { class: 'liv-card liv-card-' + f.severity },
    el('div', { class: 'liv-card-title' }, el('span', { class: 'liv-card-mark', text: f.severity === 'p0' ? '!' : '·' }), el('b', { text: f.title })),
    f.detail ? el('div', { class: 'liv-card-detail', text: f.detail }) : null,
    acts);
}

// 카드에서 맡긴 일은 **대화로 이어진다** — 무엇을 시켰는지 사람이 보고, 리브의 진행도 같은 자리에서 본다.
function livDelegate(btn: HTMLButtonElement, f: LivFinding): void {
  // 카드에서 맡긴 일은 **대화로 이어진다** — 무엇을 시켰는지 사람이 보고, 진행도 같은 자리에서 본다.
  //  종전엔 터미널 세션에 프롬프트를 주입했다. 표면이 바뀌었으니 들어가는 문도 대화창 하나다.
  livChatAsk(f.prompt as string);
  btn.disabled = true;
  btn.textContent = '맡겼습니다';
  btn.closest('.liv-card')?.classList.add('liv-card-done');
}

function livToast(msg: string): void {
  const t = el('div', { class: 'liv-toast', text: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}
