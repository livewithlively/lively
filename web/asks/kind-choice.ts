// asks/kind-choice.ts — 세션 요청 ▸ 객관식 카드(#1631 → #5713). 서버 짝: src/asks/kinds/choice.ts.
//  종전엔 리브 카드(web/liv-cards.ts livChoiceCard)였다 — 어느 세션이든 쓰게 풀면서 이리로 옮겼다. 생김새 · 규칙은 그대로다.
import { api, el, sv } from '../core.js';
import { rowView, type ConnectAppIn } from '../lib/connect-routes-view.js';   // 앱 한 줄 말은 [외부 앱 연결] 목록과 한 벌
import { iconPath } from '../lib/icon-paths.js';
import { svcTile } from '../svc-icons.js';   // #5059 — 객관식 앱 카드도 [외부 앱 연결]과 같은 공식 로고 타일
import { SVC_LOGO } from '../svc-logos.js';
import type { Ask } from './api.js';
import { askToast, registerAskKind, type AskCtx } from './registry.js';

interface ChoicePayload {
  key?: string; question?: string; why?: string; multi?: boolean; allow_other?: boolean;
  options?: Array<{ id: string; label: string; hint?: string }>;
}
type ConnectApp = ConnectAppIn;
//  펼침 자리의 DOM id — 같은 요청이 두 자리(사이드바 «요청» 탭 · 요청 화면)에 동시에 그려질 수 있어 요청 id 가 아니라 카드마다 센다.
let moreSeq = 0;

/**
 * 객관식 질문 — **사람은 고르기만 한다.**
 *
 * 실측에서 사람이 가장 오래 멈춘 자리가 자유서술이었다("어디에 쌓고 계셨나요?"). 없는 말을 지어내야 하니
 * 어렵고, 답이 제각각이라 우리도 개선점을 못 뽑는다. 고르게 하면 둘 다 풀린다 — 쉽고, **답이 저절로
 * 구조화된다**. 그래서 이 카드가 곧 통계 수집기다.
 *
 * 생김새(#5059, 원준 2026-10-27 «짜치다 — 외부 앱 연결 화면 정도는 돼야 한다»):
 *  · 선택지가 앱이면 [외부 앱 연결]과 **같은 공식 로고 타일**(svcTile)을 단다 — 글자만 늘어선 단추는 누를 마음이 안 생긴다.
 *  · 고른 것은 테두리 + 오른쪽 체크로 보인다(색만으로 가르지 않는다). 이미 연결된 앱은 «연결됨» 을 단다(서버 판정 그대로).
 *  · «그 외» 는 늘 펼친 빈칸이 아니라 마지막 카드 [+ 다른 앱] 이다 — 빈칸이 맨 앞에 크게 있으면 «뭘 적어야 하나» 로 읽혔다.
 *    펼치면 라이블리가 연결할 수 있는데 목록에 없는 앱(예: Zotero)을 로고로 고르고, 그래도 없으면 이름을 적는다.
 */
function choiceCard(req: Ask, ctx: AskCtx): HTMLElement {
  const ask = req.payload as ChoicePayload;
  const options = ask.options ?? [];
  const picked = new Set<string>();
  // [+ 다른 앱] 에서 고른 앱 이름 — 서버엔 other 로 간다. 계약이 choices(저장된 선택지 id) · other(그 밖) 둘뿐이라,
  //  라이블리가 연결할 수 있는 앱이라도 리브가 목록에 안 넣었으면 other 다(집계의 «커넥터 후보» 엔 이미 있는 앱도 섞인다 — 감수).
  const extras = new Set<string>();
  const svcs = options.map((o) => svcKeyOf(o.id, o.label));
  // 앱 질문인가 — 로고가 붙는 선택지가 둘 이상이면 앱 카드로 그린다. 아니면(«어떤 서랍으로?») 같은 카드에 타일만 뺀다.
  const appMode = svcs.filter(Boolean).length >= 2;

  //  (#5058) 종전 이름 «이걸로» 는 무엇을 하는 버튼인지 말하지 않았고, [나중에] 오른쪽이 아니라 왼쪽에 있어
  //   사람이 다 고른 뒤 오른쪽의 [나중에]를 «확인» 으로 알고 눌렀다(원준님 2026-10-27). 확정은 **오른쪽 끝**, 이름은 «선택 완료»,
  //   몇 개 골랐는지 함께 보여 준다.
  const SEND = '선택 완료';
  const send = el('button', { class: 'btn btn-primary liv-pick-send liv-ask-go', type: 'button', text: SEND }) as HTMLButtonElement;
  const count = el('span', { class: 'liv-pick-count', 'aria-live': 'polite' });
  const otherIn = el('input', {
    class: 'liv-ask-input liv-pick-in', type: 'text', autocomplete: 'off', maxlength: '80',
    placeholder: appMode ? '목록에 없는 앱 이름 (예: 카카오톡)' : '목록에 없으면 직접 적어 주세요', 'aria-label': '그 외',
  }) as HTMLInputElement;
  const otherText = (): string => [...extras, ...(otherIn.value.trim() ? [otherIn.value.trim()] : [])].join(', ').slice(0, 200);
  const grid = el('div', { class: 'liv-pick-grid' + (appMode ? ' is-apps' : '') });
  const extraRow = el('div', { class: 'liv-pick-extras' });
  // 단일 선택은 **답이 하나**다 — 선택지 · 알약 · 적은 이름 셋 중 마지막에 손댄 것만 남긴다
  //  (안 그러면 알약을 켜 둔 채 선택지를 누르면 choices 와 other 가 같이 가고, 서버는 그걸 받는다 — 격리 리뷰 지적).
  const clearPicked = (): void => { picked.clear(); grid.querySelectorAll('.liv-pick.on:not(.liv-pick-add)').forEach((x) => x.classList.remove('on')); };
  const clearExtras = (): void => { extras.clear(); extraRow.querySelectorAll('.liv-pick-chip.on').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); }); };
  // 보내는 동안엔 카드 안 단추를 다 잠근다 — 단일 선택은 누르면 바로 가서, 두 번째 클릭이 두 번째 답이 된다.
  const lock = (on: boolean): void => {
    for (const b of [...grid.querySelectorAll('button'), ...extraRow.querySelectorAll('button')] as HTMLButtonElement[]) b.disabled = on;
    otherIn.disabled = on;
  };
  const sync = (): void => {
    const n = picked.size + extras.size + (otherIn.value.trim() ? 1 : 0);
    send.disabled = n === 0;
    if (!send.textContent?.endsWith('…')) send.textContent = ask.multi && n > 0 ? `${SEND} (${n})` : SEND;
    count.textContent = ask.multi && !n ? '여러 개 골라도 돼요' : '';   // 고른 수는 확정 단추가 말한다(#5058)
  };

  const submit = async (): Promise<void> => {
    send.disabled = true; lock(true); const was = send.textContent; send.textContent = '보내는 중…';
    try {
      // ⚠ 보내기 전에 비우고 포커스를 뗀다 — 답이 처리되면 자리가 다시 그려지는데, 칸에 글이 남아 있으면 «치는 중» 으로 읽힌다.
      const body = { choices: [...picked], other: otherText() || undefined };
      await ctx.submit(body);
      otherIn.value = ''; otherIn.blur();
    } catch (e) {
      lock(false); send.textContent = was ?? SEND; sync();
      askToast(String((e as Error)?.message ?? e));
    }
  };

  // 카드 한 장 — 타일 · 이름 · 한 줄 설명 · 오른쪽 표시(복수 선택=체크 동그라미 · 단일 선택=›).
  //  앱 키 → «연결됨» 자리들(상태는 나중에 온다). 여럿일 수 있다 — Gmail·드라이브는 둘 다 «Google» 한 줄이다.
  const marks = new Map<string, HTMLElement[]>();
  options.forEach((o, i) => {
    const svc = svcs[i];
    const st = el('span', { class: 'liv-pick-st' });
    if (svc) marks.set(statusKey(svc), [...(marks.get(statusKey(svc)) ?? []), st]);
    const b = el('button', { class: 'liv-pick', type: 'button', 'aria-pressed': ask.multi ? 'false' : null },
      appMode ? (svc ? svcTile(svc, o.label, true) : neutralTile(o.id, o.label)) : null,
      el('span', { class: 'liv-pick-tx' },
        el('span', { class: 'liv-pick-nm' }, el('b', { text: o.label }), st),
        o.hint ? el('span', { class: 'liv-pick-hint', text: o.hint }) : null),
      el('span', { class: 'liv-pick-mk' + (ask.multi ? '' : ' go'), 'aria-hidden': 'true' }, ask.multi ? lineIcon('check') : lineIcon('chevR'))) as HTMLButtonElement;
    b.onclick = () => {
      if (ask.multi) {
        const on = !picked.has(o.id);
        if (on) picked.add(o.id); else picked.delete(o.id);
        b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
        sync();
      } else { clearPicked(); clearExtras(); otherIn.value = ''; picked.add(o.id); b.classList.add('on'); void submit(); }
    };
    grid.append(b);
  });

  // [+ 다른 앱] — 누르면 아래가 펼쳐진다. 펼친 자리: 라이블리가 연결할 수 있는데 목록에 없는 앱(로고) + 이름 적는 칸.
  const more = el('div', { class: 'liv-pick-more', id: 'liv-pick-more-' + (++moreSeq), hidden: 'hidden' });
  if (ask.allow_other) {
    const moreBtn = el('button', { class: 'liv-pick liv-pick-add', type: 'button', 'aria-expanded': 'false', 'aria-controls': more.id },
      appMode ? el('span', { class: 'svc-tile liv-pick-tile-add', 'aria-hidden': 'true' }, lineIcon('plus')) : null,
      el('span', { class: 'liv-pick-tx' },
        el('span', { class: 'liv-pick-nm' }, el('b', { text: appMode ? '다른 앱' : '그 밖의 것' })),
        el('span', { class: 'liv-pick-hint', text: appMode ? '목록 밖의 앱 고르기 · 직접 적기' : '목록에 없으면 직접 적어요' }))) as HTMLButtonElement;
    moreBtn.onclick = () => {
      // 고른 알약·적은 이름이 있으면 접지 않는다 — 접힌 채로 보내지면 사람은 무엇이 갔는지 못 본다.
      if (!more.hidden && (extras.size || otherIn.value.trim())) { otherIn.focus(); return; }
      const open = more.hidden;
      more.hidden = !open; moreBtn.classList.toggle('on', open); moreBtn.setAttribute('aria-expanded', String(open));
      if (open) otherIn.focus();
    };
    grid.append(moreBtn);
    more.append(extraRow, el('div', { class: 'liv-pick-inrow' }, otherIn));
  }
  otherIn.oninput = () => { if (!ask.multi && otherIn.value.trim()) { clearPicked(); clearExtras(); } sync(); };
  // isComposing — 한글 조합 중의 Enter 는 글자를 맺는 키다(보내면 마지막 글자가 빠진 채 간다).
  otherIn.onkeydown = (ev: KeyboardEvent) => { if (ev.key === 'Enter' && !ev.isComposing && !send.disabled) { ev.preventDefault(); void submit(); } };
  send.onclick = () => void submit();
  sync();

  // 연결 상태 — [외부 앱 연결] 목록과 같은 판정(rowView). 못 읽으면 표시만 없다(카드는 그대로 쓴다).
  if (appMode) void (async () => {
    let apps: ConnectApp[] = [];
    try { const r: any = await api('/api/ui/org/connect-status'); apps = Array.isArray(r?.apps) ? r.apps : []; } catch (_) { return; }
    for (const a of apps) {
      if (rowView(a).bucket !== 'on') continue;
      for (const m of marks.get(statusKey(a.app)) ?? []) { m.textContent = '연결됨'; m.classList.add('on'); }
    }
    if (!ask.allow_other) return;
    // 목록 밖 앱 — 리브가 넷만 골라 보였어도 사람이 쓰는 건 다섯째일 수 있다(실측: Zotero 를 직접 쳐야 했다).
    const shown = new Set(svcs.filter(Boolean).map((s) => statusKey(s as string)));
    //  «연결할 수 있는» 앱만 — 준비가 필요한 앱(soon: 관리자가 먼저 · 길이 없음)과 못 읽은 앱은 뺀다.
    const rest = apps.filter((a) => !shown.has(statusKey(a.app)) && ['on', 'half', 'off'].includes(rowView(a).bucket));
    if (!rest.length) return;
    extraRow.append(el('span', { class: 'liv-pick-extras-h', text: '라이블리에서 연결할 수 있는 다른 앱' }),
      el('div', { class: 'liv-pick-chips' }, ...rest.map((a) => {
        const name = a.label || a.app;
        const c = el('button', { class: 'liv-pick-chip', type: 'button', 'aria-pressed': 'false' },
          svcTile(a.app, name, true), el('span', { text: name })) as HTMLButtonElement;
        c.onclick = () => {
          const on = !extras.has(name);
          if (!ask.multi) { clearExtras(); clearPicked(); otherIn.value = ''; }
          if (on) extras.add(name); else extras.delete(name);
          c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on));
          sync();
        };
        return c;
      })));
  })();

  return el('div', { class: 'liv-ask liv-pick-card' },
    el('div', { class: 'liv-pick-head' },
      el('b', { class: 'liv-pick-q', text: ask.question ?? '' }),
      ask.why ? el('div', { class: 'liv-pick-why', text: ask.why }) : null),
    grid,
    ask.allow_other ? more : null,
    el('div', { class: 'liv-pick-foot liv-ask-acts' },
      ctx.later(), count, (ask.multi || ask.allow_other) ? send : null));
}

// ── 선택지 → 서비스 로고 ─────────────────────────────────────────────────────────────
//  리브가 짓는 선택지는 id 가 슬러그(notion · gdrive)이거나 라벨이 사람 말(노션 · 메일(Gmail))이다. 둘 다 본다.
//  표에 없으면 null — 카드는 타일 없이(앱 질문이면 중립 타일로) 그린다.
const SVC_ALIAS: Record<string, string> = {
  gdrive: 'google-drive', google_drive: 'google-drive', 'google drive': 'google-drive', drive: 'google-drive', '구글 드라이브': 'google-drive', '드라이브': 'google-drive',
  gmail: 'google-gmail', '지메일': 'google-gmail',
  gcal: 'google-calendar', google_calendar: 'google-calendar', 'google calendar': 'google-calendar', '구글 캘린더': 'google-calendar', '캘린더': 'google-calendar',
  '구글': 'google', '노션': 'notion', '슬랙': 'slack', '리니어': 'linear', '깃허브': 'github', '깃랩': 'gitlab',
  '클릭업': 'clickup', '피그마': 'figma', '조테로': 'zotero', '아웃룩': 'outlook',
};
const NOT_APPS = new Set(['prometheus', 'claude-headless']);
function svcKeyOf(...names: string[]): string | null {
  // Object.hasOwn — 라벨 낱말이 «constructor» 같은 이름이면 표의 원형(prototype)에 걸린다.
  const hit = (s: string): string | null => (Object.hasOwn(SVC_LOGO, s) && !NOT_APPS.has(s)) ? s : (Object.hasOwn(SVC_ALIAS, s) ? SVC_ALIAS[s] : null);
  for (const raw of names) {
    const s = String(raw ?? '').trim().toLowerCase();
    if (!s) continue;
    const whole = hit(s);
    if (whole) return whole;
    // 라벨 속 낱말 — «메일(Gmail)» · «Notion 위키»
    for (const w of s.split(/[\s()/·,]+/)) { const k = w && hit(w); if (k) return k; }
  }
  return null;
}
/** 연결 상태 표의 앱 키 — 구글 셋(드라이브·메일·캘린더)은 [외부 앱 연결]에서 «Google» 한 줄이다. */
function statusKey(svc: string): string { return svc.startsWith('google-') ? 'google' : svc; }

// 로고가 없는 선택지(«컴퓨터 폴더에 파일로» · «딱히 없어요»)의 타일 — 앱 카드들 사이에서 줄이 어긋나지 않게 같은 틀에 선 아이콘.
const NEUTRAL_ICON: Record<string, string> = {
  files: 'folder', file: 'folder', folder: 'folder', local: 'folder', upload: 'upload',
  git: 'code', repo: 'code', code: 'code', mail: 'mailopen', email: 'mailopen', head: 'spark', none: 'minus',
};
function neutralTile(id: string, label: string): HTMLElement {
  const ic = NEUTRAL_ICON[String(id).toLowerCase()];
  return el('span', { class: 'svc-tile liv-pick-tile-plain', 'aria-hidden': 'true' },
    // 글자 타일은 id 의 첫 글자를 먼저 쓴다 — «디스코드» 의 «디» 보다 discord 의 «D» 가 그 서비스로 읽힌다.
    ic ? lineIcon(ic) : el('span', { class: 'svc-tile-ini', text: (/^[a-z]/i.test(id) ? id : String(label || '?').trim()).slice(0, 1).toUpperCase() }));
}
function lineIcon(name: string): SVGElement {
  return sv('svg', { class: 'liv-pick-ic', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('path', { d: iconPath(name) })) as SVGElement;
}

registerAskKind('choice', { render: choiceCard });
