// lib/proj-access.ts — 프로젝트를 «누가 보나» 를 화면이 말하는 한 자리(#5598, 상민 2026-11-18).
//
//  «프로젝트가 기본 전체 공개라, 적어 둔 것이 부지불식간에 공유될 수 있다는 불안» 을 줄이는 것이 이 모듈의 일이다.
//   그래서 목록 · 상세 · 세션 초대 · 새로 만들기가 전부 **같은 말**로 «지금 누가 보는지» 를 말한다 — 자리마다 말이 다르면
//   사람은 가장 넓은 쪽을 믿는다.
//
//  서버 규칙(src/v6/visibility.ts privateProjectSql · src/v6/project-access.ts):
//   · 초대제(invite_only) 또는 초안(draft)인 프로젝트 = **만든 사람과 팀원만** 본다. 팀원이 곧 초대한 사람이다.
//   · 초안은 무언가를 남기면 풀린다. 초대제가 아닌 초안은 풀리는 순간 전체 공개가 된다 — 이 차이를 꼭 말한다.
//   · 그 밖 = 전체 공개(잠긴 리스트 안이면 그 리스트 대상만 — 그건 리스트 설정이 말한다).
//   · 워크스페이스의 «새 프로젝트 공개 방식»(초대제 | 전체 공개)은 새 프로젝트의 기본값일 뿐이다.
//   · 프로젝트 공개범위 축이 꺼진 워크스페이스(enforced=false)에서는 아무것도 가려지지 않는다 — 그때 «나만 봅니다» 라고
//     말하면 거짓 안심이라 아무 표시도 하지 않는다.
//  잎 모듈(import 0) — proj-draft.ts 와 같은 까닭이다(화면 코드 안에 있으면 시험할 데가 없다).

/** 이 판정이 프로젝트 행(서버 목록 · 상세 응답 그대로)에게 묻는 것. */
export interface AccessLike {
  draft?: boolean | null;
  invite_only?: boolean | null;
  created_by?: string | null;
  /** 팀원 — 목록 응답은 {member_id, display_name}, 화면에 따라 id 글자 배열. */
  members?: ReadonlyArray<unknown> | null;
  /** 이 프로젝트가 든 리스트(또는 그 조상 폴더)가 잠겨 있다 — 서버가 단다(src/capabilities/projects-v6.ts markListLocked). */
  list_locked?: boolean | null;
}

/** 워크스페이스 설정(GET /api/ui/v6/project-access). */
export interface AccessConfig {
  mode: 'invite' | 'open';
  /** 프로젝트 공개범위 축이 켜져 있나. false 면 초대제 표시가 아무것도 가리지 않는다. */
  enforced: boolean;
}

/** 설정을 아직 못 받았을 때의 값 — 서버 기본값과 같다(초대제 · 켜짐). */
export const ACCESS_CONFIG_DEFAULT: AccessConfig = { mode: 'invite', enforced: true };

export const ACCESS_LABEL_OPEN = '전체 공개';
export const ACCESS_LABEL_INVITE = '초대한 사람만';

const idOf = (m: unknown): string =>
  typeof m === 'string' ? m : String((m as any)?.member_id ?? (m as any)?.id ?? '');

/** 이 프로젝트를 «만든 사람과 팀원만 보는» 상태인가(서버 privateProjectSql 과 같은 말). */
export function isPrivateProj(p: AccessLike | null | undefined): boolean {
  return !!p && (p.invite_only === true || p.draft === true);
}

/** 풀리면 전체 공개가 되는 닫힘인가 — 초대제가 아닌 초안. */
export function isPendingOpen(p: AccessLike | null | undefined): boolean {
  return !!p && p.draft === true && p.invite_only !== true;
}

/** 이 프로젝트를 보는 사람(만든 사람 + 팀원) — 겹침 없이, 만든 사람이 맨 앞. */
export function projAudience(p: AccessLike | null | undefined): string[] {
  if (!p) return [];
  const out: string[] = [];
  const push = (id: string): void => { if (id && !out.includes(id)) out.push(id); };
  push(String(p.created_by ?? ''));
  for (const m of p.members || []) push(idOf(m));
  return out;
}

export type AccessKind = 'only_me' | 'shared' | 'invited' | 'list' | 'open';

/** 잠긴 리스트 안의 (초대제 · 초안이 아닌) 프로젝트 — «전체 공개» 가 아니다. */
export const ACCESS_LABEL_LIST = '리스트 대상만';

export interface AccessBadge {
  kind: AccessKind;
  /** 닫혀 있나(자물쇠를 그리나). */
  locked: boolean;
  /** 짧은 글 — 목록 줄 · 칩에 그대로 쓴다. */
  label: string;
  /** 올렸을 때의 설명 한두 문장. */
  tip: string;
  /** 나 말고 함께 보는 사람 수(닫힌 프로젝트만 뜻이 있다). */
  others: number;
}

/**
 * 이 프로젝트의 «누가 보나» 표시.
 *  nameOf — 사람 id → 표시 이름(없으면 id 그대로). 설명(tip)에 이름을 적는 데만 쓴다.
 */
export function projAccessBadge(p: AccessLike | null | undefined, meId: string, nameOf: (id: string) => string = (id) => id): AccessBadge {
  if (!isPrivateProj(p)) {
    //  잠긴 리스트 안이면 «전체 공개» 라고 말하지 않는다 — 그 리스트를 볼 수 있는 사람만 본다(리스트 공개범위).
    if (p && p.list_locked === true) {
      return { kind: 'list', locked: true, label: ACCESS_LABEL_LIST, others: 0,
        tip: '이 프로젝트가 든 리스트를 볼 수 있는 사람만 봐요 — 리스트의 공개범위가 걸려 있어요.' };
    }
    return { kind: 'open', locked: false, label: ACCESS_LABEL_OPEN, tip: '워크스페이스 구성원 모두가 보는 프로젝트예요.', others: 0 };
  }
  const audience = projAudience(p);
  const others = audience.filter((id) => id !== meId);
  const mine = !!meId && String(p!.created_by ?? '') === meId;
  const pending = isPendingOpen(p);
  //  풀리면 열리는 초안 — «지금은 닫혀 있다» 와 «언제 열리나» 를 한 문장에 같이 말한다(닫혔다는 말만 하면 열릴 때 놀란다).
  const pendingTail = pending ? ' 초안인 동안만 닫혀 있어요 — 작업을 남기거나 제목 · 본문을 정리하면 전체 공개돼요.' : '';
  const names = (ids: string[]): string => {
    const ns = ids.map(nameOf);
    return ns.length > 3 ? `${ns.slice(0, 3).join(', ')} 외 ${ns.length - 3}명` : ns.join(', ');
  };
  if (!others.length) {
    return { kind: 'only_me', locked: true, others: 0,
      label: pending ? '초안 동안 나만' : '나만',
      tip: (pending ? '지금은 나만 보는 프로젝트예요.' : '나만 보는 프로젝트예요. 초대한 사람만 함께 볼 수 있어요.') + pendingTail };
  }
  if (mine) {
    return { kind: 'shared', locked: true, others: others.length,
      label: `${others.length}명과 공유`,
      tip: `나와 초대한 ${others.length}명(${names(others)})만 봐요.` + pendingTail };
  }
  const owner = String(p!.created_by ?? '');
  return { kind: 'invited', locked: true, others: others.length,
    label: '초대받음',
    tip: (owner ? `${nameOf(owner)}님이 만든 프로젝트예요. ` : '') + `초대받은 사람만 봐요(나 포함 ${audience.includes(meId) ? audience.length : audience.length + 1}명).` + pendingTail };
}

/**
 * 이 표시를 그릴까.
 *  · 축이 꺼진 워크스페이스 — 아무것도 안 그린다(가려지는 게 없는데 자물쇠를 그리면 거짓이다).
 *  · 닫힌 프로젝트 — 늘 그린다(«나만 본다» 를 확인할 수 있어야 한다).
 *  · 열린 프로젝트 — 초대제 워크스페이스에서만 그린다. 거기서는 «전체 공개» 가 예외라 눈에 띄어야 하고,
 *    전체 공개 워크스페이스에서는 그게 보통이라 줄마다 적으면 소음이다.
 */
export function showAccessBadge(b: AccessBadge, cfg: AccessConfig): boolean {
  if (!cfg.enforced) return false;
  return b.locked || cfg.mode === 'invite';
}

/** 초안 뱃지의 설명 — 초대제인 초안은 풀려도 공개되지 않으므로 «공개됩니다» 라고 말하지 않는다. */
export function draftTipFor(p: AccessLike | null | undefined): string {
  return p && p.invite_only === true
    ? '세션 첫 지시로 자동 생성된 프로젝트입니다. 아직 정리 전이라는 표시일 뿐이에요 — 작업을 남겨 초안에서 풀려도 초대한 사람만 봅니다.'
    : '세션 첫 지시로 자동 생성된 프로젝트입니다. 나와 초대한 사람에게만 보이고, 작업을 남기거나 제목 · 본문을 정리하면 모두에게 공개됩니다.';
}

/**
 * 세션에 사람을 초대하는 자리에서 미리 하는 말 — «세션에 초대하면 프로젝트에도 초대된다».
 *  서버가 그렇게 한다(src/sessions/session-state.ts syncPrivateInviteMembers — 안 넣으면 초대받은 사람이 그 세션에 못 들어온다).
 *  열린 프로젝트는 이미 다 보므로 말할 것이 없다(null).
 */
export function sessionInviteProjectNote(p: (AccessLike & { name?: string | null }) | null | undefined, cfg: AccessConfig = ACCESS_CONFIG_DEFAULT): string | null {
  if (!p || !cfg.enforced || !isPrivateProj(p)) return null;
  const nm = String(p.name ?? '').replace(/\s+/g, ' ').trim();
  return `초대한 사람은 이 세션이 속한 프로젝트${nm ? ` «${nm}»` : ''}도 함께 보게 돼요 — 본문 · 태스크 · 파일까지요. 프로젝트의 다른 세션은 따로 초대해야 보여요.`;
}

/** 프로젝트를 아직 모르는 자리(새 세션 — 프로젝트가 함께 생긴다)에서 하는 같은 말. */
export const SESSION_INVITE_PROJECT_NOTE_GENERIC = '초대한 사람은 이 세션이 속한 프로젝트도 함께 보게 돼요.';

/** 그 말을 할까 — 축이 꺼진 워크스페이스에서는 모든 프로젝트를 이미 전원이 보므로 말하지 않는다(''). */
export function sessionInviteGenericNote(cfg: AccessConfig = ACCESS_CONFIG_DEFAULT): string {
  return cfg.enforced ? SESSION_INVITE_PROJECT_NOTE_GENERIC : '';
}

/** 초대 뒤 토스트에 덧붙이는 말(닫힌 프로젝트일 때만). */
export function sessionInviteProjectToast(p: (AccessLike & { name?: string | null }) | null | undefined, cfg: AccessConfig = ACCESS_CONFIG_DEFAULT): string {
  if (!p || !cfg.enforced || !isPrivateProj(p)) return '';
  const nm = String(p.name ?? '').replace(/\s+/g, ' ').trim();
  return nm ? ` 프로젝트 «${nm}»도 함께 볼 수 있어요.` : ' 이 세션의 프로젝트도 함께 볼 수 있어요.';
}

/** 새로 만드는 자리의 한 줄 — «이 프로젝트를 누가 보게 되나». auto = 세션과 함께 저절로 생기는 프로젝트(초안으로 태어난다). */
export function newProjectAccessHint(cfg: AccessConfig, auto = false): string {
  if (!cfg.enforced) return '';
  if (cfg.mode === 'invite') {
    return auto
      ? '함께 생기는 프로젝트는 나만 봐요 — 초대한 사람만 함께 볼 수 있어요.'
      : '새 프로젝트는 나만 봐요 — 만든 뒤 [공유]에서 초대한 사람만 함께 볼 수 있어요.';
  }
  return auto
    ? '함께 생기는 프로젝트는 초안인 동안 나만 보고, 작업을 남기면 워크스페이스 전체에 공개돼요.'
    : '새 프로젝트는 워크스페이스 구성원 모두가 봐요.';
}

/** 관리탭 설정의 두 선택지 — 이름과 설명. */
export const ACCESS_MODE_OPTIONS: ReadonlyArray<{ mode: 'invite' | 'open'; title: string; desc: string }> = [
  { mode: 'invite', title: '초대제',
    desc: '새 프로젝트는 만든 사람만 봅니다. 초대한 사람만 함께 보고, 만든 사람이 «전체 공개» 로 바꾸기 전까지 저절로 공개되지 않습니다.' },
  { mode: 'open', title: '전체 공개',
    desc: '새 프로젝트는 워크스페이스 전원이 봅니다. 세션 첫 지시로 자동 생성된 초안만 만든 사람이 보다가, 작업을 남기면 자동으로 공개됩니다.' },
];
