// onboarding-headless.ts — 처음 설정 «AI 잇기» 의 **사람 없이 도는 작업** 허용 칸 (#4012 T12 · #4051).
//
//  ── 왜 이 칸이 있나 ─────────────────────────────────────────────────────────
//  매니지드의 맥락 잡(증류·분류·관리)은 중앙 샌드박스 판에서 돈다. 그 판은 대화형 로그인(~/.claude/.credentials.json)을
//  빌리지 않고, 따로 허용한 자격(claude_setup_token · codex_auth_json)만 쓴다. Anthropic 에서도 둘은 **별개의 허용**이다
//  (`claude auth login` ↔ `claude setup-token`). 그래서 로그인을 마친 자리에서 한 번 더 허용을 받는다.
//
//  ── 왜 «곁다리» 가 아니라 «다음 걸음» 인가 ────────────────────────────────────
//  실측(상민님 2026-09-17, 새 워크스페이스): 종전 칸은 «연결됐어요.» 제목 아래의 보조 버튼 [연결하기]였다.
//  사람은 제목을 믿고 주 버튼 [계속]을 눌렀고, 헤드리스 자격은 끝내 없었다(증류가 no_credential 로 멈춘다).
//  이제 허용이 남았으면 장면의 제목·주 버튼이 그 사실을 말하고, 절차는 **누르지 않아도** 시작된다.
//  ⚠ 가두지는 않는다 — 장면에는 늘 «지금은 건너뛸게요» 문이 있고, [내 AI 계정]에 같은 [연결]이 있다.
//
//  ── 경계 ────────────────────────────────────────────────────────────────────
//  이 파일은 칸 **하나**만 안다. 장면의 제목·버튼은 온보딩이 `pending()` 을 읽어 그린다 — 두 곳이 같은 사실을 보도록
//  상태(seen)는 여기 한 벌만 둔다. 주고받는 일(시작·폴링·붙여넣기)은 공용 한 벌(lib/ai-login-inline)이 한다.
import { api } from '../core.js';   // 장면(onboarding.ts)과 같은 문 — 대역(welcome-demo · 시험)이 한 자리에서 갈아 끼운다
import { HEADLESS_INLINE, startInlineAiLogin, type InlineLoginHandle } from '../lib/ai-login-inline.js';

/** 고른 AI 의 헤드리스 자격 — GET /api/ui/me/headless 의 그 행. */
export interface HeadlessSeen {
  harness: string;
  /** 판이 쓸 수 있다(저장돼 있고, 그 뒤로 인증 실패가 없다). */
  connected: boolean;
  /** 저장은 돼 있는데 인증이 실패했다 — 다시 허용받는다. */
  failed: boolean;
}

/** 이만큼 안에 잰 값은 다시 묻지 않는다 — checkAi 가 방금 잰 값으로 칸을 그린다(요청 한 번). */
export const HEADLESS_FRESH_MS = 5_000;
/** [새 주소 받기] 연타 간격 — 짧은 간격의 두 시작은 서버에서 러너 둘이 잠깐 같은 파일을 두고 겨룬다(리뷰 #4051). */
const RETRY_GAP_MS = 2_500;

const esc = (s: unknown): string => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** (순수) 상태 응답에서 그 하네스의 행을 읽는다. 행이 없거나 모양이 다르면 null(모름 — 구 서버). */
export function headlessSeenOf(st: unknown, h: string): HeadlessSeen | null {
  const rows = st && typeof st === 'object' ? (st as { harnesses?: unknown }).harnesses : null;
  if (!Array.isArray(rows)) return null;
  const row = rows.find((r) => r && typeof r === 'object' && (r as { key?: unknown }).key === h) as
    { connected?: unknown; failure?: unknown } | undefined;
  if (!row) return null;
  const failed = !!row.failure;
  return { harness: h, connected: row.connected === true && !failed, failed };
}

export interface HeadlessOffer {
  /** 상태를 묻는다(`maxAgeMs` 안에 같은 하네스를 쟀으면 묻지 않는다). 실패하면 «모름»(null)으로 둔다. */
  load(h: string, maxAgeMs?: number): Promise<void>;
  /** 로그인 뒤의 **주된 다음 일**이 이 허용인가. 모르면 false — 장면은 종전대로 그린다. */
  pending(h: string): boolean;
  /** 칸을 채우고, 허용이 남았으면 누르지 않아도 절차를 띄운다. */
  paint(box: HTMLElement, h: string, label: string): Promise<void>;
  /** 지금 아는 값(시험·진단용). */
  seen(): HeadlessSeen | null;
}

/**
 * 칸 하나의 상태와 그리기.
 *  · rerender — 장면을 다시 그린다(허용이 끝났거나, 그린 뒤 사실이 바뀌었을 때). 온보딩의 renderScene 이다.
 *  · toast    — 한 줄 알림.
 */
export function createHeadlessOffer(o: { rerender: () => void; toast: (m: string) => void; now?: () => number }): HeadlessOffer {
  const now = o.now ?? (() => Date.now());
  let seen: HeadlessSeen | null = null;
  //  마지막으로 물은 때 — 답이 «모름»(null)이어도 센다. 안 세면 «남음 → 모름 → 남음» 으로 장면이 오락가락할 때마다 되묻는다.
  let asked: { harness: string; at: number } | null = null;
  let inflight: Promise<void> | null = null;
  let handle: InlineLoginHandle | null = null;

  async function load(h: string, maxAgeMs = 0): Promise<void> {
    if (!HEADLESS_INLINE[h]) { seen = null; asked = null; return; }
    if (asked && asked.harness === h && now() - asked.at < maxAgeMs) {
      //  방금 물었다 — 답이 오는 중이면 그 답을 기다린다(낡은 값으로 칸을 그리지 않게).
      if (inflight) await inflight;
      return;
    }
    asked = { harness: h, at: now() };
    const p = (async () => {
      try { seen = headlessSeenOf(await api('/api/ui/me/headless'), h); }
      catch (_) { seen = null; }
    })();
    inflight = p;
    try { await p; } finally { if (inflight === p) inflight = null; }
  }

  function pending(h: string): boolean {
    return !!HEADLESS_INLINE[h] && !!seen && seen.harness === h && !seen.connected;
  }

  async function paint(box: HTMLElement, h: string, label: string): Promise<void> {
    await load(h, HEADLESS_FRESH_MS);
    if (!box.isConnected) return;
    //  장면은 그릴 때 아는 값으로 제목·버튼을 정했다(data-wait). 그 사이 사실이 바뀌었으면(다른 탭에서 연결 · 조회 실패)
    //   장면째 다시 그린다 — 다시 그린 장면은 같은 값을 보므로(되묻지 않는다) 한 번으로 끝난다.
    if ((box.dataset.wait === '1') !== pending(h)) { o.rerender(); return; }
    const s = seen && seen.harness === h ? seen : null;
    //  모르면 칸을 안 연다 — 구 서버(상태 조회 없음)에서 누를 수 없는 버튼을 만들지 않는다.
    if (!s) { box.hidden = true; return; }
    box.hidden = false;
    if (s.connected) {
      box.innerHTML = `<p class="ob-ok">자리를 비우신 동안 도는 작업(증류·분류)도 ${esc(label)} 계정으로 연결돼 있어요.</p>`;
      return;
    }
    const hint = h === 'claude'
      ? '방금처럼 주소를 열어 Authorize 를 누르면 코드가 나와요. 그 코드를 아래에 붙여넣으면 끝나요.'
      : '주소를 열고 아래 코드를 넣은 뒤 ChatGPT 계정으로 허용하세요. 끝나면 이 자리가 저절로 바뀌어요.';
    box.innerHTML = `
      <p class="ob-note" id="hlNote">${s.failed ? `저장해 둔 허용이 더는 통하지 않아요. ` : ''}로그인과 별개로, 자리를 비우신 동안 제가 자료를 정리하는 일(증류·분류)은 <b>따로 허용한 계정</b>으로만 돌아요. 아래 주소에서 한 번 더 허용해 주시면 그 일도 ${esc(label)} 구독으로 돌아갑니다.</p>
      <div id="hlSteps">
        <div class="ob-lg-addr"><code id="hlAddr">주소를 받는 중이에요…</code><a class="ob-btn ob-btn-pri ob-btn-inline" id="hlOpen" target="_blank" rel="noopener" hidden>열기 ↗</a></div>
        <p class="ob-lg-d" style="margin-top:8px">${hint}</p>
        ${h === 'codex' ? '<div style="margin-top:9px"><button type="button" class="ob-copychip" id="hlCodeChip" hidden><span id="hlCode"></span><small>누르면 복사</small></button></div>' : ''}
        ${h === 'claude' ? '<div class="ob-lg-row" id="hlPasteRow" hidden><input id="hlIn" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="브라우저에 나온 코드 붙여넣기"><button class="ob-btn ob-btn-pri ob-btn-inline" id="hlPut">넣기</button></div>' : ''}
      </div>
      <p class="ob-err" id="hlErr"></p>
      <div class="ob-lg-fb">잘 안 되면 <button type="button" id="hlRetry">새 주소 받기</button></div>`;
    const q1 = <T extends HTMLElement>(sel: string): T | null => box.querySelector(sel) as T | null;
    const addr = q1('#hlAddr'), open = q1<HTMLAnchorElement>('#hlOpen');
    const chip = q1('#hlCodeChip'), codeEl = q1('#hlCode'), pasteRow = q1('#hlPasteRow');
    const inp = q1<HTMLInputElement>('#hlIn'), put = q1<HTMLButtonElement>('#hlPut'), err = q1('#hlErr'), retry = q1('#hlRetry');
    const say = (t: string): void => { if (err) err.textContent = t || ''; };
    if (chip && codeEl) chip.onclick = async () => {
      try { await navigator.clipboard.writeText(codeEl.textContent || ''); } catch (_) { o.toast(codeEl.textContent || ''); }
      const sm = chip.querySelector('small'); if (sm) { sm.textContent = '복사했어요 ✓'; setTimeout(() => { sm.textContent = '누르면 복사'; }, 1600); }
    };
    if (put && inp) {
      const submit = async (): Promise<void> => {
        const v = inp.value.trim(); if (!v) { inp.focus(); return; }
        put.disabled = true; put.textContent = '넣는 중…';
        try {
          if (!handle) throw new Error('아직 시작 전이에요');
          await handle.paste(v);
          put.textContent = '넣었어요'; say('');
        } catch (e) { put.disabled = false; put.textContent = '넣기'; say(`코드를 넣지 못했어요 — ${(e as Error)?.message || e}`); }
      };
      put.onclick = () => { void submit(); };
      inp.onkeydown = (ev) => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); void submit(); } };
    }
    let startedAt = 0;
    const start = (restart: boolean): void => {
      startedAt = now();
      handle?.stop();
      say('');
      if (addr) { addr.textContent = '주소를 받는 중이에요…'; delete addr.dataset.url; }
      if (open) open.hidden = true;
      if (chip) chip.hidden = true;
      if (put && inp) { put.disabled = false; put.textContent = '넣기'; inp.value = ''; }
      handle = startInlineAiLogin(h, {
        url: (u) => {
          if (!addr || addr.dataset.url === u) return;
          addr.dataset.url = u; addr.textContent = u.replace(/^https?:\/\//, '');
          if (open) { open.href = u; open.hidden = false; }
        },
        code: (c) => { if (codeEl) codeEl.textContent = c; if (chip) chip.hidden = false; },
        needsPaste: () => { if (pasteRow) pasteRow.hidden = false; if (inp) setTimeout(() => inp.focus(), 100); },
        //  끝났다 — 서버가 저장했다. 장면을 «연결됐어요» 로 다시 그린다(제목·주 버튼·다른 AI 카드가 돌아온다).
        done: () => {
          seen = { harness: h, connected: true, failed: false };
          asked = { harness: h, at: now() };
          o.toast(`연결했어요. 자리를 비우신 동안에도 ${label} 계정으로 정리합니다.`);
          o.rerender();
        },
        failed: (m) => say(`${m} — [새 주소 받기]를 누르시거나, 지금은 건너뛰고 나중에 내 AI 계정에서 연결하셔도 됩니다.`),
        stalled: () => say('주소가 늦네요. 조금만 더 기다려 주세요.'),
      }, {
        //  ⚠ 자동 시작은 **이어받기**다(restart 없음) — 도는 시도가 있으면 서버 시작 스크립트가 `running` 으로 그대로 둔다.
        //   장면을 다시 그리거나 새로고침해도 사람이 이미 연 주소·받은 코드가 죽지 않는다.
        //   새로 띄우는 것은 사람이 [새 주소 받기]를 눌렀을 때뿐이다(지난 시도의 주소가 죽었을 수 있다, #2232).
        restart, purpose: 'headless', alive: () => box.isConnected,
      });
    };
    if (retry) retry.onclick = () => {
      if (now() - startedAt < RETRY_GAP_MS) return;
      start(true);
    };
    start(false);   // ★ 누르지 않아도 시작한다 — 이것이 «곁다리» 였던 종전 칸과의 차이다
  }

  return { load, pending, paint, seen: () => seen };
}
