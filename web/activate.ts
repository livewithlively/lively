// activate.ts — CLI · 앱 디바이스 로그인 승인 화면 (#880). `#/activate?code=XXXX-XXXX`.
//  CLI 나 데스크톱 앱이 표시한 코드를 사람이 브라우저(로그인된 세션)에서 승인 → 요청한 쪽이 폴링해 토큰을 받는다.
//  화면은 «이 컴퓨터를 연결할까요?» 한 장의 카드다(설치 흐름 시안 3 · 3b). 클라우드의 워크스페이스 고르기 칸은
//  자체 호스팅 게이트웨이엔 없으므로 왼쪽 칸(기기 · 코드 · 관리자 항목)만 한 줄로 쌓는다.
//
//  ⚠ 보안(설계 R1~R3):
//   · 승인은 이 페이지의 세션 자격으로 이뤄진다(서버가 tokenSource!=='static' 강제).
//   · client_label 은 요청 기기가 **스스로 주장**한 값 — el({text})(textContent)로만 렌더(innerHTML 금지).
//   · 양방향 피싱 경고: ① 남이 준 코드 승인 금지(내 계정 탈취) ② 남의 코드 승인 금지(그 기기가 나로 로그인).
//   · client_ip 는 서버가 안 준다(trust proxy 미설정이라 프록시 IP=모든 클라 동일 → 신뢰신호 무의미).
//   · control-plane(관리권한) 포함 승인은 비밀번호 재확인(step-up) — 서버가 검증.
//   · ★ 그 재확인은 **비밀번호를 가진 사람에게만** 묻는다(#2044). 서버는 이미 그렇게 판정하는데
//     (tokens-devices.ts: includeControlPlane && hasDangerous && hasCredential) 화면이 그걸 몰라서
//     소셜/SSO 로만 들어온 사람에게 **채울 수 없는 빈 칸**을 보여줬다. 빈 채로 눌러도 사실은 통과하지만,
//     사람은 "난 비번이 없는데" 하고 **체크를 풀어** 관리 권한 없는 토큰을 받는다 — 조용한 권한 손실이다.
//     그래서 /api/ui/me/logins 의 hasPassword 를 보고 칸 자체를 없앤다.
//   · 관리자 항목의 기본값은 **끔**이다(설치 흐름 시안 3 — 사용자 승인). 켜지 않아도 연결은 되고, 켰을 때만
//     비밀번호 칸이 나온다. 그래서 빈 칸을 미리 막지 않는다 — 비번 여부 조회가 실패해 «있다» 로 본 SSO 계정은
//     빈 채로 눌러야 통과한다(서버 판정이 정답).
import { api, busy, el, replaceKids, state, toast, usernameAnchor } from './core.js';
import { markShareGuideSeen, mountShareGuide } from './v2/share-guide.js';   // #5598 승인 직후 «누가 무엇을 보나요»

/** 카드의 머리(제목 · 부제 · 경고 · 코드 입력)를 결과에 따라 바꾸는 손잡이. */
interface ActivateFrame {
  title: HTMLElement; sub: HTMLElement; note: HTMLElement; entry: HTMLElement; icon: HTMLElement;
}

export async function renderActivate(view: any): Promise<void> {
  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  const prefill = (params.get('code') || '').trim();

  const slot = el('div', { class: 'activate-result' });
  // 승인코드는 아이디도 비번도 아니다 — autocomplete 를 **명시하지 않아** el() 의 자동완성 차단을 받는다(#1250).
  //  (아래 비번 재확인칸 때문에 크롬이 이 칸을 아이디로 오인해 이메일을 채우던 자리.)
  const codeInput = el('input', {
    type: 'text', class: 'term-input dauth-code-input', spellcheck: 'false', 'aria-label': '연결 코드',
    placeholder: '앱이나 터미널에 표시된 코드 (예: MPQR-STVW)', value: prefill,
  });
  const goBtn = el('button', { class: 'btn btn-ghost', text: '확인' });
  const entry = el('div', { class: 'dauth-entry' }, codeInput, goBtn);
  const frame: ActivateFrame = {
    icon: el('span', { class: 'dauth-done-ic', 'aria-hidden': 'true', text: '✓' }),
    title: el('h2', { class: 'dauth-title', text: '이 컴퓨터를 연결할까요?' }),
    sub: el('p', { class: 'dauth-sub', text: '본인이 방금 앱이나 터미널에서 시작한 연결만 승인하세요.' }),
    // 피싱 경고 — 양방향(① 남이 보낸 코드 ② 남의 연결을 대신). 차분한 안내 상자로 둔다.
    note: el('div', { class: 'dauth-note' },
      el('p', { text: '다른 사람이 보내 준 코드는 승인하지 마세요. 그 사람의 기기가 내 계정으로 연결됩니다.' }),
      el('p', { text: '동료가 대신 승인해 달라고 해도 승인하지 마세요. 그 컴퓨터의 AI 가 내 이름으로 동작합니다.' })),
    entry,
  };
  frame.icon.style.display = 'none';
  // 코드를 받아 열린 경우엔 입력칸을 숨기고 바로 조회한다 — 못 찾으면(만료 등) 그때 입력칸을 다시 보인다.
  if (prefill) entry.style.display = 'none';

  const look = () => drawLookup(slot, (codeInput as HTMLInputElement).value, frame);
  goBtn.addEventListener('click', look);
  codeInput.addEventListener('keydown', (e: any) => { if (e.key === 'Enter') { e.preventDefault(); look(); } });

  replaceKids(view,
    el('div', { class: 'card dauth-card' },
      el('div', { class: 'dauth-head' }, frame.icon, el('div', { class: 'dauth-head-text' }, frame.title, frame.sub)),
      frame.note,
      entry,
      slot));

  if (prefill) look();
}

/** 끝난 상태(승인 · 거부)로 카드 머리를 바꾼다 — 경고와 입력칸은 더 할 일이 없으므로 걷는다. */
function finish(frame: ActivateFrame, slot: HTMLElement, title: string, sub: string, ok: boolean): void {
  frame.title.textContent = title;
  frame.sub.textContent = sub;
  frame.icon.style.display = ok ? '' : 'none';
  frame.note.style.display = 'none';
  frame.entry.style.display = 'none';
  replaceKids(slot);
}

/** user_code(8자, 대시 없음) → 앱 · 터미널이 보여 주는 꼴(XXXX-XXXX). */
function prettyCode(raw: string): string {
  const c = String(raw || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

// 코드 조회 → 기기 정보 + 승인/거부.
async function drawLookup(slot: any, raw: string, frame: ActivateFrame): Promise<void> {
  const code = String(raw || '').trim();
  if (!code) {
    frame.entry.style.display = '';
    replaceKids(slot, el('p', { class: 'dauth-msg', text: '코드를 입력하세요.' }));
    return;
  }
  busy(slot, el('p', { class: 'dauth-msg', text: '요청을 찾는 중입니다…' }));
  let info: any;
  try {
    info = await api('/api/ui/cli/device/lookup?code=' + encodeURIComponent(code));
  } catch (e: any) {
    frame.entry.style.display = '';
    replaceKids(slot, el('p', { class: 'install-token-err', text: e?.message || '요청을 찾지 못했습니다. 코드를 확인하세요. 시간이 지나 만료됐을 수 있습니다.' }));
    return;
  }
  frame.entry.style.display = 'none';

  // control-plane opt-in — admin/runtime 보유 멤버만 노출.
  const scopes: string[] = Array.isArray(state.me?.scopes) ? state.me.scopes : [];
  const canCp = scopes.includes('admin') || scopes.includes('runtime');
  // 이 계정에 **로컬 비밀번호가 있나** — step-up 을 물을지의 유일한 근거(서버 판정과 같은 축).
  //  못 물어보면(일시 오류) **있다고 본다**: 없는데 물으면 한 번 더 누르면 되지만, 있는데 안 물으면 게이트가 사라진다.
  let hasPassword = true;
  if (canCp) {
    try { hasPassword = (await api('/api/ui/me/logins'))?.hasPassword !== false; } catch { /* 보수적으로 유지 */ }
  }
  const cpChk = el('input', { type: 'checkbox', class: 'dauth-adm-chk' }) as HTMLInputElement;
  // ★ 기본은 **끔**이다(설치 흐름 시안 3 — 사용자 승인. #2044 의 기본 켬을 뒤집는다). 켜지 않아도 연결은 되고,
  //  관리자 기능이 필요한 사람만 켜서 비밀번호를 한 번 더 넣는다. 체크박스는 애초에 그 권한을 가진 사람에게만 보이고(canCp),
  //  발급 상한도 서버가 멤버 LIVE scope 와 교집합해 정한다(확대 불가).
  cpChk.checked = false;
  // 여긴 진짜 계정 비밀번호(step-up)다 → autocomplete 를 명시해 브라우저가 **제대로** 돕게 둔다.
  //  단, 아이디칸을 명시하지 않으면 크롬이 위 승인코드칸을 아이디로 오인하므로 숨은 앵커를 바로 앞에 둔다(#1250).
  //  앵커는 숨는 상자(.dauth-pw) 밖에 둔다 — 부모가 display:none 이면 파서가 앵커째 걸러낼 수 있다.
  const pwInput = el('input', { type: 'password', class: 'term-input', id: 'dauth-pw',
    placeholder: '라이블리에 로그인할 때 쓰는 비밀번호', autocomplete: 'current-password' }) as HTMLInputElement;
  const pwAnchor = usernameAnchor();
  // 비번이 없는 계정엔 칸 자체를 만들지 않는다 — 못 채우는 칸은 안내가 아니라 장벽이다.
  const pwBox = el('div', { class: 'dauth-pw' },
    ...(hasPassword
      ? [el('label', { for: 'dauth-pw', text: '라이블리 비밀번호' }), pwInput,
         el('p', { class: 'dauth-d', text: '관리자 기능을 허용할 때만 비밀번호를 한 번 더 확인합니다.' })]
      : [el('p', { class: 'dauth-d', text: '이 계정은 회사 계정이나 소셜 로그인으로 들어와 있어 비밀번호를 다시 확인하지 않습니다.' })]));
  pwBox.style.display = 'none';
  const cpBlock = canCp ? el('div', { class: 'dauth-adm' },
    el('label', { class: 'dauth-adm-row' }, cpChk,
      el('div', null,
        el('div', { class: 'dauth-adm-t' }, 'AI 에게 관리자 기능 허용', el('span', { class: 'dauth-opt', text: '선택' })),
        el('p', { class: 'dauth-d', text: '이 워크스페이스의 관리자에게만 보이는 항목입니다. 켜면 이 컴퓨터의 AI 가 구성원 초대, 연결 설정 같은 관리자 기능도 쓸 수 있습니다. 켜지 않아도 연결됩니다.' }))),
    hasPassword ? pwAnchor : null,
    pwBox) : null;
  if (cpBlock) cpChk.addEventListener('change', () => {
    cpBlock.classList.toggle('on', cpChk.checked);
    pwBox.style.display = cpChk.checked ? '' : 'none';
    if (cpChk.checked && hasPassword) pwInput.focus();
  });

  const approveBtn = el('button', { class: 'btn btn-primary', text: '연결 승인' }) as HTMLButtonElement;
  const denyBtn = el('button', { class: 'btn btn-ghost', text: '거부' }) as HTMLButtonElement;

  approveBtn.addEventListener('click', async () => {
    approveBtn.disabled = true; denyBtn.disabled = true;
    try {
      const body: any = { user_code: code };
      if (canCp && cpChk.checked) {
        body.include_control_plane = true;
        if (hasPassword) body.password = pwInput.value;   // 비번이 없으면 필드 자체를 안 보낸다
      }
      await api('/api/ui/cli/device/approve', { method: 'POST', body: JSON.stringify(body) });
      finish(frame, slot, '연결을 승인했습니다', '앱이나 터미널로 돌아가면 설정이 이어집니다.', true);
      void showShareGuideAfterApprove(slot);
    } catch (e: any) {
      approveBtn.disabled = false; denyBtn.disabled = false;
      toast(e?.message || '승인하지 못했습니다. 다시 시도하세요.', true);
    }
  });
  denyBtn.addEventListener('click', async () => {
    approveBtn.disabled = true; denyBtn.disabled = true;
    try { await api('/api/ui/cli/device/deny', { method: 'POST', body: JSON.stringify({ user_code: code }) }); } catch { /* */ }
    finish(frame, slot, '연결 요청을 거부했습니다', '앱이나 터미널의 연결 요청은 취소됩니다.', false);
  });

  replaceKids(slot,
    el('div', { class: 'dauth-kvs' },
      el('div', { class: 'dauth-kv' },
        el('div', { class: 'dauth-k', text: '요청한 기기' }),
        el('div', { class: 'dauth-v', text: info.client_label || '이름 없는 기기' }),   // ← textContent (el text) — XSS 안전
        el('div', { class: 'dauth-h', text: `요청 시각 ${whenText(info.created_at)}` })),
      el('div', { class: 'dauth-kv' },
        el('div', { class: 'dauth-k', text: '연결 코드 · 앱 화면과 같은지 확인하세요' }),
        el('div', { class: 'dauth-v dauth-v-code', text: prettyCode(info.user_code || code) }))),
    cpBlock,
    el('div', { class: 'dauth-foot' }, denyBtn, approveBtn));
}

/**
 * #5598 — 승인 직후, 아직 «누가 무엇을 보나요» 를 확인하지 않은 사람에게 그 안내를 승인 카드 바로 아래에 붙인다.
 *  CLI · 데스크톱 앱으로 설치하는 사람도 로그인 승인 때 브라우저를 한 번은 반드시 연다(kit/cli/lively.mjs cmdLogin — 기기 승인).
 *  그래서 웹을 쓰지 않는 사람이 안내를 볼 수 있는 자리가 여기다. 이미 확인했으면 붙이지 않는다 · 못 읽으면 붙이지 않는다(막지 않는다).
 */
async function showShareGuideAfterApprove(slot: HTMLElement): Promise<void> {
  try {
    const p: any = await api('/api/ui/me/liv-profile');
    if (p?.share_guide_seen_at) return;
  } catch { return; }
  try { mountAfterApprove(slot); } catch (e) { console.warn('[activate] 안내를 붙이지 못했다 — 승인은 이미 끝났다', e); }
}
function mountAfterApprove(slot: HTMLElement): void {
  const host = el('div', { class: 'sg-inline' });
  (slot.closest('.card') || slot).after(host);
  const g = mountShareGuide(host, {
    finishLabel: '확인 · 앱이나 터미널로',
    onFinish: () => {
      markShareGuideSeen();
      g.destroy();
      replaceKids(host, el('p', { class: 'admin-hint', style: 'text-align:center', text: '확인했습니다. 앱이나 터미널로 돌아가면 설정이 이어집니다.' }));
    },
  });
}

/** «오후 3:12 · 2분 전» — 시계 시각과 지난 시간을 같이 보여 준다(앱 화면에서 방금 시작한 요청인지 맞춰 보게). */
function whenText(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '방금';
  const clock = new Date(t).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  return `${clock} · ${timeAgo(t)}`;
}

function timeAgo(t: number): string {
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  return `${Math.floor(s / 3600)}시간 전`;
}
