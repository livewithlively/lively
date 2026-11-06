// v2/setup-watch.ts — 처음 설정에서 올린 파일이 **지식이 되기까지** 를 화면 구석의 띠로 잇는다(#5167).
//
//  왜: 올리기가 끝나면 띠는 사라지고, 리브는 0~5분 뒤 말없이 열리고, 정리 잡이 자격 없음으로 멈춰도 화면엔 아무것도 없었다
//   (2026-10-30 lively-agent-5·-2 실측). 사람은 «언제까지 기다리나 · 되고 있나» 를 모른다.
//  판정은 서버가 한다(GET /api/ui/me/welcome/setup — org/liv/setup-status.ts). 여기는 그 단계를 한 줄로 말하고 갈 곳을 준다.
//
//  · 언제 보나: 처음 설정을 파일과 함께 끝낸 브라우저(startSetupWatch) — 새로고침·다시 들어와도 하루 동안은 이어 본다(표지 · resumeSetupWatch).
//  · 얼마나 자주: 처음 10분은 15초, 그 뒤 1분. 탭이 가려져 있으면 묻지 않는다. 끝(done)·멈춤(stopped)·말할 것 없음(null)이면 그친다.
//    못 읽으면(오류) 단계를 그대로 두고 다시 묻는다 — «못 읽음» 을 «끝» 으로 읽지 않는다.
import { api } from '../core.js';
import { wsKey } from '../lib/net.js';
import { bgSetupLine, bgUploadOnChange, bgUploadState, type BgSetupLine } from './bg-upload.js';

const POLL_MS = 15_000;
/** 표지의 수명 — 리브 2턴의 상한(하루)과 같다. 그 뒤엔 서버도 기다리지 않는다. */
const FLAG_TTL_MS = 24 * 60 * 60_000;
const flagName = (): string => wsKey('lively-setup-watch');

export type SetupPhase = 'uploading' | 'waiting' | 'connecting' | 'working' | 'organizing' | 'needs-ai' | 'done' | 'stopped';
export interface SetupStatus { phase: SetupPhase; session_id: string | null; backlog: number | null; note: string | null }

/**
 * (순수) 단계 → 띠의 둘째 줄. null 이면 걷는다.
 *  uploading 은 이 브라우저가 지금 올리는 중이면 첫째 줄이 이미 말한다 — 그때는 비운다. 이 브라우저가 올리지 않는데 서버가 아직
 *  «올리는 중» 이면(창을 닫았다 · 다른 기기) 이어 올리는 법을 말한다.
 */
export function setupLine(s: SetupStatus | null, uploadingHere: boolean): BgSetupLine | null {
  if (!s) return null;
  const liv = { href: '#/liv', label: '리브 대화 보기' };
  switch (s.phase) {
    case 'uploading':
      return uploadingHere ? null
        : { text: '올리던 파일이 아직 다 오지 않았어요. 같은 폴더를 [자료]에서 다시 올리면 이어서 올라가요 — 그대로 두면 1시간 반 뒤 올라온 것만으로 정리를 시작해요.', keep: true };
    case 'waiting': return { text: '다 올렸어요. 리브가 곧 올린 파일을 읽고 카테고리와 정리 규칙을 세워요(보통 1분 안).', keep: true };
    case 'connecting': return { text: '앱 연결 대화를 마치면 리브가 올린 파일 정리를 시작해요.', keep: true, ...liv };
    case 'working': return { text: '리브가 올린 파일을 읽고 카테고리와 정리 규칙을 세우고 있어요(보통 10분 안).', keep: true, ...liv };
    case 'organizing':
      return { text: `올린 파일을 지식으로 정리하는 중 · 남은 자료 ${(s.backlog ?? 0).toLocaleString('ko-KR')}개 (10분마다 조금씩 정리돼요)`, keep: true, ...liv };
    case 'needs-ai':
      return { text: '정리가 멈췄어요 — 자리에 없을 때도 정리하려면 AI 승인이 한 번 더 필요해요.', keep: true, href: '#/me/ai', label: '승인하기' };
    case 'done': return { text: '올린 파일을 지식으로 정리했어요.', keep: false, ...liv };
    case 'stopped':
      return { text: '리브가 정리를 시작하지 못했어요. 리브에게 «올린 파일 정리해 줘» 라고 말해 주세요.', keep: false, ...liv };
    default: return null;
  }
}
/** (순수) 더 볼 필요가 없는 단계인가. */
export const setupSettled = (s: SetupStatus | null): boolean => !s || s.phase === 'done' || s.phase === 'stopped';

let watching = false;
/** 걸어 둔 다음 묻기 — 당겨 묻기(poke)가 그것을 치우고 새로 건다(두 고리가 같이 돌지 않게). */
let timer: ReturnType<typeof setTimeout> | null = null;
let startedAt = 0;
/** 처음 10분은 15초, 그 뒤는 1분 — 정리는 10분마다 조금씩 되므로 몇 시간 동안 15초로 물을 까닭이 없다. */
const nextDelay = (): number => (Date.now() - startedAt < 10 * 60_000 ? POLL_MS : 60_000);

function setFlag(on: boolean): void {
  try { if (on) localStorage.setItem(flagName(), String(Date.now())); else localStorage.removeItem(flagName()); } catch (_) { /* 프라이빗 창 — 이 페이지 동안만 본다 */ }
}
function flagFresh(): boolean {
  try { const t = Number(localStorage.getItem(flagName()) || 0); return t > 0 && Date.now() - t < FLAG_TTL_MS; } catch (_) { return false; }
}
const schedule = (ms: number): void => { if (timer) clearTimeout(timer); timer = setTimeout(() => void tick(), ms); };

async function tick(): Promise<void> {
  timer = null;
  if (!watching) return;
  if (document.visibilityState === 'hidden') { schedule(nextDelay()); return; }
  let s: SetupStatus | null = null;
  try { s = (((await api('/api/ui/me/welcome/setup')) as { setup?: SetupStatus | null } | null)?.setup) ?? null; }
  catch (_) {
    //  못 읽었다 — 단계를 그대로 두고(지우지도 «끝» 으로 읽지도 않는다) 다시 묻는다. 서버도 못 읽은 것을 0 으로 접지 않는다.
    if (watching && !timer) schedule(nextDelay());
    return;
  }
  if (!watching) return;
  const line = setupLine(s, bgUploadState().running);
  bgSetupLine(line && s ? { ...line, key: s.phase } : null);
  if (setupSettled(s)) { watching = false; setFlag(false); if (timer) clearTimeout(timer); timer = null; return; }
  if (!timer) schedule(nextDelay());
}
/** 지금 한 번 묻는다(걸어 둔 묻기는 치운다). */
const poke = (): void => { if (watching) schedule(0); };

let hooked = false;
/** 이 브라우저의 올리기가 끝나는 순간 당겨 묻는다 — 안 그러면 «다 올렸어요» 와 «리브가 곧» 사이에 띠가 걷혔다 다시 뜬다. */
function hookUploads(): void {
  if (hooked) return;
  hooked = true;
  let was = bgUploadState().running;
  bgUploadOnChange((st) => { if (was && !st.running) poke(); was = st.running; });
}
function begin(): void {
  watching = true;
  startedAt = Date.now();
  hookUploads();
  schedule(0);
}

/** 처음 설정을 파일과 함께 끝냈다 — 지금부터 본다(이 브라우저에 표지를 남겨 새로고침 뒤에도 잇는다). */
export function startSetupWatch(): void {
  setFlag(true);
  if (watching) { poke(); return; }
  begin();
}
/** 셸이 뜰 때 — 표지가 살아 있으면 이어 본다. 없으면 아무것도 묻지 않는다(대부분의 사람은 요청 0). */
export function resumeSetupWatch(): void {
  if (!watching && flagFresh()) begin();
}
