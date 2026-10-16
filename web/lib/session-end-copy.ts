// lib/session-end-copy.ts — 꺼진 세션을 **무엇이라고 부르나** 의 한 자리 (#4783).
//
//  세션 화면은 꺼진 세션에 한 줄 안내를 단다(대화창 위 · 입력칸 위). 종전엔 그 말이 상태 이름에서만 나와서
//   («중단된 세션이에요») 사람이 끝낸 것·시스템이 끈 것·고장이 같은 말을 했다. 이제 서버가 끝낸 자리에서 적은 사유
//   (src/sessions/session-end.ts — 목록 행 endNote · 액자가 넘긴 end)로 고른다. 판정은 session-status.ts sessEndKind 한 곳이다.
//  잎 모듈이다(DOM 없음) — 문구 표를 시험이 그대로 고정한다.
import { sessEndKind, type SessLike } from '../session-status.js';

/** 액자(terminal.html)가 «세션 없음» 과 함께 넘기는 사실(web/standalone/terminal.ts endFactsOf 와 같은 모양). */
export interface EndFactsMsg {
  exitedByUser?: boolean;
  oomKilled?: boolean;
  endWhy?: string;
  endCode?: number | null;
  stopWhy?: string;
}

/** 액자가 넘긴 사실 → 판정이 읽는 모양. 모르는 값은 안 옮긴다. */
export function sessLikeOfFacts(f: EndFactsMsg | null | undefined): SessLike {
  const x = f && typeof f === 'object' ? f : {};
  return {
    exitedByUser: !!x.exitedByUser,
    oomKilled: !!x.oomKilled,
    ...(x.endWhy ? { endNote: { why: String(x.endWhy), ...(typeof x.endCode === 'number' ? { code: x.endCode } : {}) } } : {}),
    ...(x.stopWhy ? { stopNote: { why: String(x.stopWhy) } } : {}),
  };
}

/**
 * 꺼진 세션의 이름(«…세션») — 사유를 모르면 '' (부르는 쪽이 종전 말로 떨어진다 — 모르는 것을 지어내지 않는다).
 *  문장 끝(«이에요 — 아래에 말을 걸면 이어서 열립니다»)은 부르는 쪽이 붙인다.
 */
export function endedSessPhrase(s: SessLike | null | undefined): string {
  if (!s) return '';
  const k = sessEndKind(s);
  const why = s.endNote && typeof s.endNote.why === 'string' ? s.endNote.why : '';
  if (k === 'user') return '직접 끝낸 세션';
  if (k === 'error') {
    if (why === 'launch_fail') return 'AI 가 뜨자마자 끝난 세션';
    if (why === 'lost') return '돌던 곳에 문제가 생겨 끊긴 세션';
    if (why === 'harness_crash') return 'AI 가 오류로 끝난 세션';
    return '메모리가 모자라 멈춘 세션';
  }
  if (k === 'system') return s.stopNote && s.stopNote.why === 'asking' ? '답을 기다리다 잠시 꺼 둔 세션' : '작업이 끝나 잠시 꺼 둔 세션';
  return '';
}
