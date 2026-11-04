// 앱 동의 창 «AI 실행» 줄 — 이 앱의 AI 가 실제로 어느 계정으로 도는지 말한다 — 순수 규칙.
//
//  왜: 종전 문구는 하나였다 — «워크스페이스 API 키가 있으면 그 돈으로, 없으면 내 Claude 구독으로 돌아요». 실행 계정은 게이트웨이가
//   작업별 > 앱별 > 워크스페이스 기본값 > (있으면) API 키 순으로 고르고(src/ai-runs/plan.ts resolveAccount), **묻는 사람의 구독으로 넘어가는 길은 없다.**
//   그래서 공용 시트로 도는 앱에서도 동의 창이 «내 Claude 구독» 이라고 말했고, Claude 를 잇지 않은 구성원이 «나는 못 쓰나 · 내 돈이 나가나» 하고
//   멈칫했다(고객사 첫 사용자 배포 준비 · 2026-11-04). 거꾸로 정해진 계정이 없으면 동의해도 AI 실행이 409 로 막히는데 창은 아무 말도 안 했다.
//  재료는 app_ai_account(GET /api/ui/ai-account) — 구성원 누구나 읽고 동의 전에도 읽힌다(app_ai_targets 는 동의가 있어야 해서 쓸 수 없다).
//   못 읽었으면(옛 게이트웨이 · 조회 실패) 어느 계정이라고 단정하지 않는 문구로 접는다.
//  ⚠ 고르는 순서는 resolveAccount 와 같아야 한다 — 그쪽을 바꾸면 여기도 같이 고친다(시험: scripts/ai-run-consent.test.mjs).

export type AiRunAccount = { kind: 'api_key' } | { kind: 'subscription'; member: string };

/** app_ai_account 응답에서 쓰는 칸만. */
export interface AiAccountSnapshot {
  settings?: {
    default?: AiRunAccount;
    apps?: Record<string, { default?: AiRunAccount; jobs?: Record<string, AiRunAccount> } | undefined>;
  };
  api_key_registered?: boolean;
  seats?: Array<{ member: string; on: boolean }>;
}

const LEAD = '이 앱이 AI에게 일을 시킬 수 있어요.';
const TAIL = '실행 기록은 이 앱의 AI 실행 목록에 남아요.';
const MINE_ONLY = '내가 이 앱에 물은 요청만 내 이름으로 돌아요';

function isAccount(v: unknown): v is AiRunAccount {
  if (!v || typeof v !== 'object') return false;
  const a = v as { kind?: unknown; member?: unknown };
  return a.kind === 'api_key' || (a.kind === 'subscription' && typeof a.member === 'string' && a.member.trim() !== '');
}

/** resolveAccount 와 같은 순서 — 작업별 > 앱별 > 워크스페이스 기본값 > (등록돼 있으면) API 키. 없으면 null. */
function resolve(s: AiAccountSnapshot, appId: string, job: string | null): AiRunAccount | null {
  const app = s.settings?.apps?.[appId];
  const byJob = job ? app?.jobs?.[job] : undefined;
  const byApp = app?.default;
  const byWorkspace = s.settings?.default;
  if (isAccount(byJob)) return byJob;
  if (isAccount(byApp)) return byApp;
  if (isAccount(byWorkspace)) return byWorkspace;
  return s.api_key_registered ? { kind: 'api_key' } : null;
}

//  mine_seat = 내 구독이 켜진 공용 시트다 — 서버는 구성원 누구의 요청이든 이 구독으로 돌린다(plan.ts subscriptionRefusal 의 공용 시트 갈래).
type Kind = 'none' | 'api_key' | 'mine' | 'mine_seat' | 'seat' | 'seat_off' | 'other';
function kindOf(a: AiRunAccount | null, s: AiAccountSnapshot, meId: string): Kind {
  if (!a) return 'none';
  if (a.kind === 'api_key') return 'api_key';
  const seat = (s.seats ?? []).find((x) => x && x.member === a.member);
  if (meId && a.member === meId) return seat?.on ? 'mine_seat' : 'mine';
  if (seat) return seat.on ? 'seat' : 'seat_off';
  return 'other';
}

/** 한 계정만 쓸 때의 문장(LEAD · TAIL 사이). */
function sentence(k: Kind, member: string): string {
  switch (k) {
    case 'none': return '지금은 이 앱의 실행 계정이 정해지지 않아 AI 실행이 되지 않아요(관리자가 정합니다).';
    case 'api_key': return '워크스페이스 API 키로 돌아요(워크스페이스가 비용을 내요). 내 Claude 구독은 쓰지 않아요.';
    case 'mine': return `내 Claude 구독으로 돌아요(${MINE_ONLY}).`;
    case 'mine_seat': return '내 Claude 구독으로 돌아요. 이 구독은 워크스페이스 공용 계정으로 지정돼 있어 구성원 누구의 요청이든 이 구독으로 돌아요.';
    case 'seat': return `워크스페이스 공용 계정(${member})의 Claude 구독으로 돌아요. 내 Claude 구독은 쓰지 않아요.`;
    case 'seat_off': return `${member}님의 Claude 구독으로 돌아요. 공용 계정 지정이 아직 켜지지 않아, ${member}님 본인이나 그분 세션에 초대받은 사람이 보낸 요청만 돌아요.`;
    case 'other': return `${member}님의 Claude 구독으로 돌아요. ${member}님 본인이나 그분 세션에 초대받은 사람이 보낸 요청만 돌아요.`;
  }
}

/** 작업마다 계정이 다를 때 한 계정의 짧은 이름. */
function label(k: Kind, member: string): string {
  switch (k) {
    case 'none': return '정해지지 않음(AI 실행 안 됨)';
    case 'api_key': return '워크스페이스 API 키';
    case 'mine': return '내 Claude 구독';
    case 'mine_seat': return '내 Claude 구독(공용 계정)';
    case 'seat': return `공용 계정(${member})`;
    case 'seat_off': case 'other': return `${member}님의 Claude 구독`;
  }
}

/**
 * 동의 창 «AI 실행» 줄의 글.
 *  snap = app_ai_account 응답(못 읽었으면 null) · appId = 이 앱 · meId = 지금 사람(state.me.userId — 모르면 '').
 *  작업별로 덮어쓴 계정이 있으면 그 작업들까지 본다 — 계정이 하나면 한 문장, 여럿이면 짧은 이름을 늘어놓는다.
 */
export function aiRunConsentText(snap: AiAccountSnapshot | null | undefined, appId: string, meId: string): string {
  if (!snap || typeof snap !== 'object') {
    return `${LEAD} 워크스페이스가 정한 실행 계정(워크스페이스 API 키 · 공용 계정 · 구성원의 Claude 구독)으로 돌아요. ${TAIL}`;
  }
  const jobs = Object.keys(snap.settings?.apps?.[appId]?.jobs ?? {}).sort();
  const seen = new Map<string, { k: Kind; member: string }>();
  for (const job of [null, ...jobs]) {
    const a = resolve(snap, appId, job);
    const k = kindOf(a, snap, meId);
    const member = a && a.kind === 'subscription' ? a.member : '';
    const key = `${k}:${member}`;
    if (!seen.has(key)) seen.set(key, { k, member });
  }
  const list = [...seen.values()];
  if (list.length === 1) return `${LEAD} ${sentence(list[0]!.k, list[0]!.member)} ${TAIL}`;
  return `${LEAD} 작업마다 실행 계정이 달라요 — ${list.map((x) => label(x.k, x.member)).join(' · ')}. ${TAIL}`;
}
