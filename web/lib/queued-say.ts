// 일하는 중에 친 사람 말 — Claude Code 의 끼워 넣기 줄(queued_command)에서 사람 말을 읽는다 (#4850).
//
//  무엇이 문제였나(상민님 2026-10-16): 하네스가 일하는 동안 보낸 말은 기록에 사람 말 줄(type:user)이 아니라 끼워 넣기 줄
//   `{"type":"attachment","attachment":{"type":"queued_command","prompt":"…","commandMode":"prompt","origin":{"kind":"human"}}}`
//   로만 남는다(이 맥미니 기록 실측: 사람 말 끼워 넣기 68줄 — 같은 정체성의 사람 말 줄은 0줄). 대화창은 그 줄 가운데 작업 끝 알림
//   (<task-notification>)만 그려서, 세션을 다시 열면 그 말이 대화에서 사라졌다 — AI 의 답은 그 말을 받아 이어지는데 사람이 한 말이 없다.
//  터미널은 그 줄을 첫 지시와 **똑같은** `❯ 말`(바탕 253 · 글자 16)로, 파일의 그 자리(도구 결과 다음 · 답 앞)에 그린다 — 라이브도
//   다시 열기(--resume)도 같다(Claude Code 2.1.301 tmux 실측 2026-10-16). 그래서 대화창도 이 줄을 사람 말 줄과 같은 길로 그린다.
//   (줄의 timestamp 는 사람이 친 때 — 큐에 넣은 때(queue-operation enqueue)와 같고, 줄은 끼워 넣은 뒤 다음 요청 때 파일에 적힌다.)
//
//  무엇이 사람 말인가 — Claude Code 2.1.301 이 이 줄을 «사람 말 틀(frame human)» 로 그리는 판정(실행 파일의 출처 판정)을 옮겼다:
//   출처 = attachment.origin. 없으면 commandMode 가 task-notification 일 때만 작업 알림, 아니면 표식 없는 사람 말(옛 판의 줄).
//   · isMeta 끼워 넣기는 사람 말이 아니다 — 하위 에이전트 보고(peer)·다른 세션의 말·채널 중계가 이 표식으로 온다.
//   · 출처가 human · auto-continuation(계획 승인 뒤 «Implement the following plan» 같은 하네스의 이어 가기 — 메타가 아닐 때만)이면 사람 말 틀이다.
//   · 그 밖의 출처(task-notification · peer · channel · coordinator …)는 사람 말이 아니다 — 작업 끝 알림은 chat-tui 의 lineNotice 가 한 줄로 그린다.
//   · commandMode 는 prompt 만 받는다(실측 사람 말 끼워 넣기는 전부 prompt — 셸 명령 모드 등은 끼워 넣지 않는다).
//  한 번 보낸 말의 정체성 = 사람 말 줄의 uuid 또는 끼워 넣기 줄의 attachment.source_uuid — Claude Code 도 되감기·다시 띄운 뒤 남은 말
//   (carried prompts)을 이 열쇠 하나로 맞춘다. 같은 열쇠가 두 번 오면 한 번만 그린다. 사람이 같은 글을 **다시 보낸** 것은 열쇠가 달라
//   두 번 그린다(터미널도 두 번 보인다 — 실측 두 건: 첫 번째가 로그인 오류로 끝나 다시 보냄 · 고쳐서 다시 보냄).

/** 끼워 넣기 줄에서 읽은 사람 말 — text 는 사람 말 줄의 글과 같은 규칙(글 블록을 줄바꿈으로 잇는다), id 는 그 말의 정체성(없으면 빈 글). */
export interface QueuedSay { text: string; id: string }

/** 끼워 넣기 줄의 글 — 문자열이거나 블록 배열(그림을 붙이면 [{type:'text'}, …그림])이다. 글 블록만 잇는다. */
function promptText(p: unknown): string {
  if (typeof p === 'string') return p;
  if (!Array.isArray(p)) return '';
  return p.filter((b) => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text')
    .map((b) => String((b as { text?: unknown }).text ?? '')).join('\n');
}

/** (순수) 대화 파일 한 줄이 «일하는 중에 친 사람 말» 끼워 넣기 줄이면 그 말, 아니면 null. */
export function queuedSay(line: unknown): QueuedSay | null {
  if (!line || typeof line !== 'object') return null;
  const o = line as Record<string, unknown>;
  if (o.type !== 'attachment' || o.isSidechain === true) return null;
  const a = o.attachment;
  if (!a || typeof a !== 'object') return null;
  const at = a as Record<string, unknown>;
  if (at.type !== 'queued_command' || at.isMeta === true) return null;
  if (at.commandMode !== undefined && at.commandMode !== 'prompt') return null;
  if (at.origin != null) {
    const kind = typeof at.origin === 'object' ? (at.origin as { kind?: unknown }).kind : undefined;
    if (kind !== 'human' && kind !== 'auto-continuation') return null;
  }
  const text = promptText(at.prompt);
  if (!text.trim()) return null;
  return { text, id: String(at.source_uuid || o.uuid || '') };
}

/**
 * (순수) 끼워 넣은 말을 **시간순으로 세울 때** 쓰는 시각. 그 줄의 timestamp 는 친 때라(줄은 끼워 넣은 뒤 다음 요청 때 적힌다) 파일에서 앞선
 *  줄들보다 이르다(이 맥미니 기록 사람 끼워 넣기 68줄 중 67줄 — 중앙값 15초 · 최대 401초 앞). 발자취가 시간순으로 다시 세우면(sortByTime) 앞
 *  턴의 도구 사용이 이 말 아래로 넘어온다 — 그래서 파일에서 앞선 줄들의 가장 늦은 시각(prevMaxMs)과 견줘 늦은 쪽을 쓴다(파일 순서와 같은 자리).
 *  앞선 시각을 모르면(-Infinity · NaN) 제 시각 그대로. 제 시각을 못 읽으면 앞선 시각.
 */
export function sayOrderTs(ts: unknown, prevMaxMs: number): string | undefined {
  const own = Date.parse(String(ts ?? ''));
  if (Number.isFinite(prevMaxMs) && (!Number.isFinite(own) || prevMaxMs > own)) return new Date(prevMaxMs).toISOString();
  return typeof ts === 'string' ? ts : undefined;
}

/** (순수) 사람 말 줄(type:user)의 정체성 — 그 줄의 uuid(없으면 빈 글). 끼워 넣기 줄의 source_uuid 와 같은 열쇠 공간이다. */
export function sayIdOf(line: unknown): string {
  if (!line || typeof line !== 'object') return '';
  const o = line as Record<string, unknown>;
  if (o.type === 'attachment') return queuedSay(o)?.id ?? '';
  return o.type === 'user' ? String(o.uuid || '') : '';
}
