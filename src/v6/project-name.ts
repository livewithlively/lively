// 프로젝트 이름을 **짓는 규칙**과 그 **걸쇠** — 한 곳 (#2031 · 발의 장원준 2026-08-26).
//
//  ── 왜 이 파일이 생겼나 ───────────────────────────────────────────────────
//  #1867 이후 세션은 첫 지시로 **프로젝트를 자동 생성**한다. 그 이름은 지시문 첫 줄을 70자에서 자른
//   기계값이라 보드·사이드바에 "지금 그냥 새 작업으로 시키면 프로젝트가 붙는데, 프로젝트가 자동생성되는건…"
//   같은 **문장 토막**이 그대로 걸린다(2026-08-26 프로덕션 실측: 자동생성 프로젝트 63건 중 49건(78%)이
//   아직 지시문 그대로, 이름 평균 46자). 정련은 첫 쓰기 훅(project-bind-nudge)이 다섯 가지 중 하나로
//   권고할 뿐이라 대부분 안 일어난다 — 권고는 기본값이 아니다(#1824 가 같은 결론을 생성에서 이미 냈다).
//
//  ── 그래서 무엇을 하나 ────────────────────────────────────────────────────
//  세션 이름과 **같은 방식**으로 뒤집는다(#1979): 이미 도는 그 세션이 첫 지시 턴에 스스로 이름을 지어
//   `project_rename_v6` 로 등록한다. 헤드리스 스폰이 0이라 '이름짓기 프롬프트가 또 프로젝트를 만드는'
//   오염 경로가 구조적으로 없고, 그 세션에는 첫 지시 + 주입된 AGENTS.md·팀 지식이 이미 들어와 있다.
//
//  ── 걸쇠(name_source) ─────────────────────────────────────────────────────
//  이름 옆에 **누가 지었나**를 같이 남기고, 낮은 쪽이 높은 쪽을 못 덮게 한다:
//
//      rule(1) < session(2) < agent(3) < human(4)
//
//   · rule    — 첫 지시를 자른 기계값.
//   · session — 세션이 **자기 이름을 지으면서 그대로 베낀 것**(relabelSession → renameShellProjectForSession).
//               기계값보다는 낫지만 "이 세션에서 무엇을 시켰나"라서 일의 이름으론 좁다. 그래서 한 칸 아래다.
//   · agent   — 그 세션이 **이 일의 이름으로** 따로 지은 것(project_rename_v6). 위의 것을 한 번 이긴다.
//   · human   — 사람이 지시한 개명(웹 편집 · project_update_v6).
//
//   · human 은 늘 이긴다(사람의 개명을 막을 이유가 없다).
//   · 그 밖은 **순위가 올라갈 때만** 이긴다 → 같은 출처가 자기를 못 덮는다 = "한 번만 지어진다"가
//     문자열 우연이 아니라 표로 고정된다. ★두 번째 세션이 자기 이름으로 같은 프로젝트를 또 개명하는 일이
//     여기서 막힌다 — 표식(AUTO_CREATED_MARK)만으로 거르면 그 표식은 사라지지 않으므로 매 세션 덮어쓴다.
//
//  ⚠ **모르는 값·NULL 은 `human`** 이다 — 세션(session-label-source)의 기본값이 `rule` 인 것과 **반대**다.
//   세션 행은 전부 우리가 만든 것이라 낮게 가정해야 에이전트가 한 번은 다듬을 수 있지만, 프로젝트 행에는
//   사람이 손으로 만든 것·커넥터가 미러한 클릭업 프로젝트 662건이 섞여 있다. 거기에 낮은 기본값을 주면
//   **남이 지은 이름을 에이전트가 갈아치운다** — 되돌리기 비싼 쪽으로 기본값을 두지 않는다.
//   자동 생성 껍데기만 스키마 백필이 명시적으로 `rule` 로 표시한다(v6/schema/project.ts §5h).
//
//  ⚠ DB 를 안 부른다(순수) — 판정을 표로 못박으려고. 집행은 project-store.claimProjectName 이 한다.
export type ProjectNameSource = "rule" | "session" | "agent" | "human";

const RANK: Record<ProjectNameSource, number> = { rule: 1, session: 2, agent: 3, human: 4 };

/** 저장된 값 → ProjectNameSource. 모르는 값·NULL 은 `human`(위 ⚠ 참고 — 남이 지은 이름을 지키는 쪽). */
export function normalizeProjectNameSource(v: unknown): ProjectNameSource {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "rule" || s === "session" || s === "agent" || s === "human" ? s : "human";
}

/** `next` 가 `cur` 를 덮어도 되나. human 은 늘 참, 그 밖은 순위가 **올라갈 때만**(같은 순위 재작성 금지). */
export function canRenameProject(cur: unknown, next: ProjectNameSource): boolean {
  if (next === "human") return true;
  return RANK[next] > RANK[normalizeProjectNameSource(cur)];
}

// ── 에이전트가 지은 이름 ────────────────────────────────────────────────────
//  ⚠ **거절하지 않는다 — 다듬는다.** 이 툴은 사용자 턴 **안에서** 불린다(session_rename 과 같은 자리).
//   여기서 4xx 를 내면 모델이 형식을 맞추려 다시 부르느라 사람이 기다리는 시간만 늘어난다.
//  30자인 이유: 사람이 직접 지은 기존 프로젝트 이름의 실측 분포(2026-08-26, 자동생성 제외 599건)에서
//   "회의록"·"앱 알림 기능"·"구 설정기능 새 ui으로 옮기기" 처럼 대부분 30자 안에 들어온다. 그보다 길면
//   보드 카드·사이드바가 어차피 잘라 보여준다.
const AGENT_MAX = 30;

/** 에이전트가 준 이름 → 쓸 수 있는 프로젝트 이름. 못 쓰면 ""(호출자는 지금 이름을 그대로 둔다). */
export function projectNameFromAgent(raw: string | null | undefined): string {
  const first = String(raw || "").split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
  // 끝은 **한 번에** 벗긴다 — 따옴표와 마침표가 섞여 있어(`"결제 백오프".`) 순서대로 지우면 하나가 남는다.
  const bare = first.replace(/^[\s"'「『([]+/, "").replace(/[\s"'」』)\].。!?？…]+$/, "").trim();
  if (!bare) return "";
  return bare.length > AGENT_MAX ? bare.slice(0, AGENT_MAX).trimEnd() : bare;
}

// ── 기계가 짓는 임시 이름(첫 지시에서) ──────────────────────────────────────
//  에이전트가 이름을 지어 주기 전까지, 그리고 훅이 꺼진 하네스에서는 **영영** 이것이 그 프로젝트의 이름이다.
//  그래서 짧게 자른다: 28자는 세션 이름 규칙(session-name.ts)과 같은 값이고, 근거도 같다 —
//  그 이상은 사이드바·보드 카드·탭 어디서도 안 보이면서 목록만 밀어낸다(종전 70자가 그 상태였다).
//  ⚠ 이 규칙은 훅 `project-auto-bind` 와 **같은 계약**이다(kit/hooks/examples/project-auto-bind.org-hook.mjs).
//   한쪽만 바꾸면 같은 지시가 입구(서버 선생성 / 외부 하네스 훅)에 따라 다른 이름을 갖는다.
const SHELL_MAX = 28;

/** 첫 지시 → 껍데기 프로젝트의 임시 이름. 이름으로 쓸 게 없으면 ""(호출자가 폴백을 정한다). */
export function shellNameFromPrompt(promptRaw: string | null | undefined): string {
  const prompt = String(promptRaw ?? "").trim();
  if (!prompt) return "";
  const first = prompt.split(/\r?\n/).map((s) => s.trim()).find((s) => s) || prompt;
  // 한 줄로 접고 끝의 문장부호를 뗀다 — 잘린 자리에 남는 `?`·`.` 는 이름이 아니라 문장의 흔적이다.
  const one = first.replace(/\s+/g, " ").trim().replace(/[.。!?？…]+$/, "").trim();
  if (!one) return "";
  return one.length > SHELL_MAX ? one.slice(0, SHELL_MAX - 1).trimEnd() + "…" : one;
}
