// lib/liv-work.ts — 위탁 워커 줄을 «리브가 한 일» 로 세우는 잣대 한 자리 — 순수 함수 (#4551, 원준 2026-10-05).
//
//  원준: "위탁 워커를 시킨 프로젝트로 보내는 거 좋은데, 사용자 입장에서는 내가 만들지 않은 세션이 생기는 거니까
//   이거는 우리 AI 에이전트인 «리브» 가 만들었다는 느낌을 주게 할 수 있을까?"
//
//  위탁 워커 = 세션 안의 AI 나 예약 작업이 무거운 일을 다른 컴퓨터에 넘길 때 그쪽에 뜨는 세션이다(src/sessions/session-kind.ts
//   의 task). 사람이 연 것이 아니라 프로젝트를 만들지 않는데, 그래서 여태 «프로젝트 없음» 에 `위탁 #4868` 같은 이름으로 섰다.
//  ⇒ ① 서버가 «누가 시켰나» 를 표식(task)으로 얹어 준다(src/node/task-origin.ts). 시킨 세션에 프로젝트가 있으면 워커는
//      사이드바에서 **그 프로젝트 아래**에 선다. 소속(projectId)은 안 바꾼다 — 설 자리(standId)만 따로 든다.
//    ② 시킨 세션이 없거나(예약 작업 · 기록이 없던 때의 위탁) 그 세션에 프로젝트가 없으면 「리브가 한 일」 묶음에 선다.
//    ③ 줄은 리브 그림을 달고, 이름은 `위탁 #N` 대신 «리브 작업 #N», 둘째 줄이 «리브가 대신 처리 · 〈시킨 세션〉에서 시작».
//  ⚠ 문구는 «리브가 만들었다» 가 아니라 **«대신 처리한다»** 다 — 워커를 띄우는 것은 그 세션의 AI 나 예약 작업이고,
//   내 계정의 AI 로 돈다. 사실과 다른 말을 하지 않는다.
//  잎 모듈인 이유는 home-pins · proj-none 과 같다(scripts/liv-work.test.mjs).

/** 시킨 프로젝트를 모르는 위탁 워커 묶음의 이름. */
export const LIV_BUCKET_NAME = '리브가 한 일';
/** 그 묶음의 카드 키 — 프로젝트 카드('p:<id>')와 섞이지 않게. */
export const LIV_CARD = 'liv';

/** 서버가 목록 행에 얹는 위탁 표식(src/node/task-origin.ts TaskMark 와 같은 모양). */
export interface TaskMark {
  id: number;
  originSession: string | null;
  originLabel: string | null;
  originProject: number | null;
  cron: string | null;
}

/** 서버 행의 `task` 칸 → 표식. 모양이 아니면 null(옛 서버는 이 칸을 안 싣는다 — 그때 화면은 종전 그대로다). */
export function taskMarkOf(raw: unknown): TaskMark | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const id = Number(t.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  const str = (v: unknown): string | null => { const s = typeof v === 'string' ? v.trim() : ''; return s || null; };
  const proj = Number(t.originProject);
  return { id, originSession: str(t.originSession), originLabel: str(t.originLabel), originProject: Number.isFinite(proj) && proj > 0 ? proj : null, cron: str(t.cron) };
}

/**
 * 위탁 워커가 **설** 프로젝트 — 제 소속이 있으면 그것, 없으면 시킨 세션의 프로젝트(화면이 아는 프로젝트일 때만).
 *  ⚠ 제 소속이 이긴다 — 사람이 그 워커를 다른 프로젝트로 옮겼으면 그 결정이 표식보다 앞선다.
 *  ⚠ `known` 에 없는 프로젝트로는 세우지 않는다 — 지워졌거나 내가 못 보는 프로젝트의 카드는 서지 않으므로,
 *   거기로 보내면 그 워커가 어느 카드에도 못 선다(«어디에도 없었다» — sess-fold 가 이미 두 번 고친 그 증상).
 */
export function standingProjectId(ownProjectId: unknown, mark: TaskMark | null, known?: { has(id: number): boolean }): number | null {
  const own = Number(ownProjectId);
  if (Number.isFinite(own) && own > 0) return own;
  if (!mark || !mark.originProject) return null;
  return !known || known.has(mark.originProject) ? mark.originProject : null;
}

/** 이 잣대들이 세션에게 묻는 것. */
export interface LivSessLike {
  /** **소속** — 서버가 아는 진짜 묶임. 보관 · 휴지통 · 옮기기 · 프로젝트 화면은 이 값만 본다. */
  projectId?: number | null;
  task?: TaskMark | null;
  /** **설 자리** — 사이드바가 이 줄을 세울 프로젝트(placeLivWork 가 적는다). 워커가 아니면 없다. */
  standId?: number | null;
}

/**
 * 사이드바가 이 줄을 세울 프로젝트 id. 워커가 아니면 소속 그대로다.
 *  ★ 소속(projectId)을 고쳐 쓰지 않는 이유 — 화면은 그 값으로 **행동**한다: 프로젝트를 보관하면 그 프로젝트의 내 세션을
 *   끄고, 휴지통은 함께 버리고, 세션 화면은 그 프로젝트의 자료 폴더를 붙인다. 워커는 그 프로젝트에 묶인 적이 없다.
 *   그래서 «어디에 세울까» 만 따로 든다.
 */
export function sideProjectId(s: LivSessLike): number {
  const v = s.task ? (s.standId ?? s.projectId) : s.projectId;
  return Number(v) > 0 ? Number(v) : 0;
}

/** 워커마다 설 자리를 적는다(그 자리에서 고친다). `known` = 화면이 아는 프로젝트 id. 워커가 아닌 줄은 안 건드린다. */
export function placeLivWork<T extends LivSessLike>(sessions: T[], known: { has(id: number): boolean }): T[] {
  for (const s of sessions) if (s.task) s.standId = standingProjectId(s.projectId, s.task, known);
  return sessions;
}

/** 「리브가 한 일」 묶음에 설 줄인가 — 위탁 워커인데 설 프로젝트가 없다. */
export function isLooseLivWork(s: LivSessLike): boolean {
  return !!s.task && sideProjectId(s) === 0;
}

//  서버가 워커에 붙이는 기본 이름(src/node/tasks.ts `위탁 #<taskId>`). 사람이나 AI 가 지은 이름은 이 꼴이 아니다.
const MACHINE_LABEL_RE = /^위탁\s*#\S*$/;

/** 줄 이름 — 기계가 붙인 `위탁 #N` · 빈 이름이면 «리브 작업 #N», 누가 지은 이름이 있으면 그 이름. */
export function livWorkName(label: string | null | undefined, mark: TaskMark): string {
  const l = String(label || '').trim();
  return !l || MACHINE_LABEL_RE.test(l) ? `리브 작업 #${mark.id}` : l;
}

/** 줄 둘째 칸 — 누가 넘긴 일인가. */
export function livWorkNote(mark: TaskMark): string {
  if (mark.cron) return '리브가 대신 처리 · 예약 작업';
  if (mark.originLabel) return `리브가 대신 처리 · ${mark.originLabel}에서 시작`;
  return '리브가 대신 처리';
}
