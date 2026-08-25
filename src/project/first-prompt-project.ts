// 첫 지시를 들고 여는 세션은 **프로젝트를 먼저 만들고 그 폴더에서 연다** (#1867 · 발의 윤상민 2026-08-24).
//
//  ── 왜 서버가 먼저 만드나 ─────────────────────────────────────────────────
//  홈 입력창에서 지시를 치고 Enter 를 누르면 그 지시가 **세션 생성 요청에 이미 들어 있다**. 그런데 종전엔
//   ① 개인 루트(`~/box/<나>`)에서 세션을 띄우고 ② 첫 프롬프트 훅(project-auto-bind)이 **뒤늦게** 프로젝트를 만들어
//   소속만 붙였다. 그래서 그 세션이 만드는 파일·워크트리·산출물이 전부 **개인 루트에 흩어졌다** — 프로젝트는
//   있는데 그 프로젝트의 폴더는 비어 있는 상태다(2026-08-25 상민님 지적: "왜 ~/box/yoon 에서 실행되니").
//  설계([[workspace-project-binding-v2-design]] §세션 생성)의 결론이 정확히 이것이었다: **첫 실질 지시가 세션 생성
//   요청에 이미 포함된 경로에서만** 프로젝트를 선생성하고 그 canonical 폴더를 cwd 로 준다.
//
//  ── 왜 '모든 세션'이 아니라 '첫 지시가 있을 때만' 인가 ────────────────────
//  실측(2026-08-24): 미소속 세션 85개 중 51개(60%)가 **작업이 없는 빈 세션**이었다. 열기만 한 세션까지 프로젝트를
//   만들면 빈 껍데기가 구조적으로 늘어난다. 그래서 지시가 실제로 있는 경우만 만든다 — 나머지는 종전대로
//   개인 루트에서 열고, 나중에 붙이거나 훅이 첫 지시에 만든다.
//
//  ⚠ 이 파일의 판정 규칙(길이·접두)과 본문 형식은 **훅 `project-auto-bind` 와 같은 계약**이다(그쪽은 외부 하네스용
//   폴백으로 남는다). 한쪽만 바꾸면 같은 지시가 입구에 따라 다른 프로젝트가 된다 — 바꾸려면 둘 다 바꾼다.
import { createProject } from "../v6/project-store.js";
import { getProjectRow } from "../v6/project-store.js";
import { ensureAgentsMd } from "../v6/agents-md.js";

/** 자동 생성 표식 — 정련 훅(project-bind-nudge)이 "아직 임시 껍데기"를 판별하는 유일한 근거(훅과 같은 문자열). */
export const AUTO_CREATED_MARK = "<!-- lively:auto-created-from-first-prompt -->";
const MIN_PROMPT_CHARS = 12;   // 이보다 짧으면 제목이 될 수 없다("ㄱㄱ"·"응"·"계속")
const MAX_TITLE = 70;
const MAX_BODY = 3500;

/** 세션 생성 요청 중 이 판정에 필요한 것만(라우트의 CreateInput 을 그대로 받지 않는다 — 순수 유지). */
export interface FirstPromptPlanInput {
  projectId?: number | null;
  appId?: string;
  loginFor?: string;
  readOnly?: boolean;
  incognito?: boolean;
  rootKey?: string;
  subpath?: string;
  initialPrompt?: string;
}

/**
 * 순수 — 이 세션 생성 요청이 '첫 지시로 프로젝트를 먼저 만들' 자리인가. 아니면 null.
 *
 *  만들지 않는 자리(각각 이유가 다르다):
 *   · 이미 프로젝트가 정해짐 — 그 프로젝트 폴더에서 연다(중복 생성 금지).
 *   · 사람이 폴더를 골랐다(subpath) 또는 개인 루트가 아닌 root — **그 자리에서 열겠다는 뜻**이다.
 *   · 앱 세션·로그인 세션 — 작업 세션이 아니다.
 *   · 읽기전용·인코그니토 — 조직에 아무것도 안 남기는 세션이다(훅과 같은 규칙).
 *   · 짧은 지시·슬래시/뱅 커맨드·하네스 주입물(`<`) — 사람의 실질 지시가 아니다.
 */
export function firstPromptProjectPlan(input: FirstPromptPlanInput): { name: string; description: string } | null {
  if (Number(input.projectId ?? 0) > 0) return null;
  if (input.appId || input.loginFor) return null;
  if (input.readOnly || input.incognito) return null;
  if (String(input.subpath ?? "").trim()) return null;
  const root = String(input.rootKey ?? "").trim();
  if (root && root !== "personal") return null;
  return shellProjectFromPrompt(input.initialPrompt);
}

/** 순수 — 첫 지시 한 덩이에서 '임시 껍데기 프로젝트'의 이름·본문. 자격이 없으면 null(훅과 같은 규칙·같은 형식). */
export function shellProjectFromPrompt(promptRaw: string | null | undefined): { name: string; description: string } | null {
  const prompt = String(promptRaw ?? "").trim();
  if (!prompt || prompt.length < MIN_PROMPT_CHARS) return null;
  if (prompt.startsWith("/") || prompt.startsWith("!") || prompt.startsWith("<")) return null;
  const first = prompt.split(/\r?\n/).map((s) => s.trim()).find((s) => s) || prompt;
  const t = first.replace(/\s+/g, " ").trim();
  const name = t.length > MAX_TITLE ? t.slice(0, MAX_TITLE - 1).trimEnd() + "…" : t;
  const description = [
    "> ⚙ 세션의 첫 지시에서 **자동 생성**된 프로젝트입니다 — 제목·본문·분류는 작업이 구체화되면 보강됩니다.",
    "",
    "## 첫 지시(원문)",
    "",
    prompt.length > MAX_BODY ? prompt.slice(0, MAX_BODY) + "\n\n…(이하 생략)" : prompt,
    "",
    AUTO_CREATED_MARK,
  ].join("\n");
  return { name, description };
}

/**
 * 껍데기 프로젝트를 실제로 만들고 **cwd 로 쓸 canonical 폴더**까지 확보한다(폴더·AGENTS.md·folder 컬럼).
 *  실패는 null — 세션 생성 자체를 막지 않는다(종전대로 개인 루트에서 열리고, 훅이 다음 턴에 붙인다).
 */
export async function createShellProject(
  spec: { name: string; description: string }, actor: string,
): Promise<{ id: number; folder: string } | null> {
  try {
    const project = await createProject({ name: spec.name, description: spec.description }, { actor, source: "web" });
    // 폴더·AGENTS.md 확보 + project.folder 확정(resolveProjectBase) — 이게 있어야 cwd 로 쓸 수 있다.
    await ensureAgentsMd(project.id);
    const folder = (await getProjectRow(project.id))?.folder ?? "";
    if (!folder) return null;                                   // 폴더를 못 만들었으면 cwd 로 쓸 수 없다
    return { id: project.id, folder };
  } catch (e) {
    console.warn("[first-prompt-project] 첫 지시 프로젝트 선생성 실패 — 개인 루트에서 연다:", (e as Error)?.message ?? e);
    return null;
  }
}
