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
import { isWorkSession } from "../sessions/session-kind.js";
import { createProject } from "../v6/project-store.js";
import { getProjectRow } from "../v6/project-store.js";
import { ensureAgentsMd } from "../v6/agents-md.js";
import { claimProjectName } from "../v6/project-store.js";
import { executionSessionProject } from "../v6/execution-session-store.js";
// 임시 이름을 짓는 규칙(#2031) — 훅 project-auto-bind 와 같은 계약이라 한 곳(v6/project-name.ts)에 둔다.
import { shellNameFromPrompt } from "../v6/project-name.js";

/** 자동 생성 표식 — 정련 훅(project-bind-nudge)이 "아직 임시 껍데기"를 판별하는 유일한 근거(훅과 같은 문자열). */
export const AUTO_CREATED_MARK = "<!-- lively:auto-created-from-first-prompt -->";
const MAX_BODY = 3500;

/** 세션 생성 요청 중 이 판정에 필요한 것만(라우트의 CreateInput 을 그대로 받지 않는다 — 순수 유지). */
export interface FirstPromptPlanInput {
  // #2162 — 종류가 판정의 1급 근거다. 종전엔 appId·loginFor 를 각각 보고 '기계인가'를 되짚었는데,
  //  그러면 새 종류(위탁·상시)가 생길 때 여기 조건을 더하는 걸 잊어도 아무 신호가 없다.
  kind: string;
  projectId?: number | null;
  appId?: string;
  loginFor?: string;
  readOnly?: boolean;
  incognito?: boolean;
  rootKey?: string;
  subpath?: string;
  initialPrompt?: string;
}

/** 첫 지시가 없는 세션의 임시 이름 — 정련(project-bind-nudge)이 첫 쓰기에서 바꾼다. */
export const UNNAMED_PROJECT = "새 작업";

/**
 * 순수 — 이 세션 생성 요청에서 만들 프로젝트(이름·본문). 안 만드는 자리면 null.
 *
 *  ★ **미소속 세션이면 첫 지시가 없어도 만든다**(상민님 결정 2026-08-25: "빈 세션도 플젝 만들어야지 ·
 *   그냥 항상 만들어 · 껍데기 신경쓰지 말고"). 종전엔 '빈 세션 60%' 실측을 근거로 지시가 있을 때만 만들었는데,
 *   그 규칙은 **cwd 를 못 정한 세션을 남긴다** — cwd 는 한 번 정하면 못 바꾸므로(실행 중 프로세스는 inode 참조)
 *   나중에 그 세션이 진짜 작업을 시작해도 산출물이 개인 루트에 쌓인다. 빈 껍데기는 사람이 보드에서 지우면 되는
 *   **되돌릴 수 있는 비용**이고, 잘못 고른 cwd 는 그 세션 내내 못 되돌린다 — 비대칭이 "항상 만든다"를 정당화한다.
 *
 *  만들지 않는 자리(각각 이유가 다르다):
 *   · 이미 프로젝트가 정해짐 — 그 프로젝트 폴더에서 연다(중복 생성 금지).
 *   · 사람이 폴더를 골랐다(subpath) 또는 개인 루트가 아닌 root — **그 자리에서 열겠다는 뜻**이다.
 *   · 앱 세션 — 소속이 인스턴스 축에 따로 있다(#1780). 로그인 세션 — 자격 인증 절차지 작업이 아니다.
 *   · 읽기전용·인코그니토 — 조직에 아무것도 안 남기는 세션이다(훅과 같은 규칙).
 */
export function firstPromptProjectPlan(input: FirstPromptPlanInput): { name: string; description: string } | null {
  if (Number(input.projectId ?? 0) > 0) return null;
  // #2162 — **사람의 작업 세션만** 프로젝트를 갖는다. 위탁·상시·앱·로그인은 전부 여기서 걸린다.
  //  종전엔 `appId || loginFor` 둘만 봐서 위탁 워커가 통과했다(그건 이 문을 안 지나 별개로 샜다) —
  //  이제 종류를 모르는 호출자는 human 으로 떨어지고(normalize), 기계 경로는 전부 명시한다.
  if (!isWorkSession(input.kind)) return null;
  if (input.readOnly || input.incognito) return null;
  if (String(input.subpath ?? "").trim()) return null;
  const root = String(input.rootKey ?? "").trim();
  if (root && root !== "personal") return null;
  // 첫 지시가 제목 재료가 못 되면(없거나 슬래시/뱅/주입물) 임시 이름으로 만든다 — **만들기는 한다**.
  return shellProjectFromPrompt(input.initialPrompt) ?? unnamedShellProject();
}

/** 순수 — 첫 지시 없이 연 세션의 껍데기(이름은 임시, 본문이 그 사정을 말한다). */
export function unnamedShellProject(): { name: string; description: string } {
  return {
    name: UNNAMED_PROJECT,
    description: [
      "> ⚙ 세션을 열 때 **자동 생성**된 프로젝트입니다 — 첫 지시가 없어 이름이 임시값입니다.",
      "",
      "이 세션의 작업 폴더가 이 프로젝트 폴더이고, 여기서 남기는 지식·작업기록·산출물이 이 프로젝트에 귀속됩니다.",
      "무엇을 하는 일인지 정해지면 제목·본문·분류를 보강하세요(첫 쓰기 때 안내가 한 번 나갑니다).",
      "",
      AUTO_CREATED_MARK,
    ].join("\n"),
  };
}

/**
 * 순수 — 첫 지시 한 덩이에서 '임시 껍데기 프로젝트'의 이름·본문. 자격이 없으면 null.
 *
 *  ⚠ **길이로 거르지 않는다**(2026-08-25 실측으로 바로잡음): 훅(`project-auto-bind`)의 12자 게이트는 "이 프롬프트가
 *   제목이 될 만한가"를 보는 규칙인데, 그것을 **작업 폴더를 정하는 데** 쓰면 짧게 말을 건 세션("안뇽 너느누구")이
 *   개인 루트에서 열려 그 세션의 산출물이 프로젝트 밖에 쌓인다 — 제목 품질과 작업면은 다른 축이다.
 *   길이 게이트가 훅에 필요한 이유는 훅이 **세션 도중 아무 프롬프트에서나** 발화하기 때문이고("응"·"계속"으로
 *   프로젝트가 생기면 안 된다), 여기는 **새 세션의 첫 지시**라는 것이 이미 확정된 자리다. 그래서 게이트가 다르다.
 *   짧은 제목은 정련(project-bind-nudge)이 고친다 — 되돌리기 싼 쪽이다.
 */
export function shellProjectFromPrompt(promptRaw: string | null | undefined): { name: string; description: string } | null {
  const prompt = String(promptRaw ?? "").trim();
  if (!prompt) return null;
  if (prompt.startsWith("/") || prompt.startsWith("!") || prompt.startsWith("<")) return null;
  // 이름은 28자에서 자른다(#2031) — 종전 70자는 지시문 한 문장을 통째로 보드에 걸었다. 원문은 아래 본문에 남는다.
  const name = shellNameFromPrompt(prompt);
  if (!name) return null;
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
    // ⚠ dedupe:false — 이름이 임시값("새 작업")이라 서로 같아서, 켜 두면 30초 안에 연 두 세션이 **한 프로젝트를 공유**한다
    //  (2026-08-25 dev 실측: 빈 세션과 슬래시 세션이 project/2009 를 함께 받았다). 세션마다 자기 작업면이어야 한다.
    //  name_source='rule'(#2031) — 이름이 **기계값**이라는 표시다. 이 표시가 있는 프로젝트만 그 세션이 첫 턴에
    //  project_rename_v6 로 한 번 다듬을 수 있다(사람이 지은 이름은 그 걸쇠에 막힌다).
    const project = await createProject(
      { name: spec.name, description: spec.description, dedupe: false, name_source: "rule" }, { actor, source: "web" });
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

/**
 * 순수 — 세션 이름이 정해졌을 때 **그 프로젝트 이름도 따라 바꿀 자리인가**(#1867, 상민님 제안 2026-08-25).
 *
 *  왜: 자동 생성 프로젝트의 이름은 **첫 지시를 기계적으로 자른 것**이라 "PROJECT AUTO BIND 에서 하는일이 정확히…"
 *   처럼 읽기 나쁘다. 반면 세션 이름은 **그 세션 자신이** 지시·주입된 프로젝트 맥락을 보고 짓는다(#1979 `session_rename`).
 *   같은 재료로 더 좋은 이름이 이미 나오는데 프로젝트만 기계값으로 남을 이유가 없다.
 *
 *  ⚠ 사람이 손댄 프로젝트는 절대 건드리지 않는다 — 두 겹으로 막는다:
 *   ① `AUTO_CREATED_MARK` 가 본문에 남아 있어야 한다(정련하면 사람이 본문을 바꾸며 사라지거나, 최소한 제목이 바뀐다).
 *   ② `expectName` 을 주면 **지금 이름이 그때 우리가 넣은 값 그대로**여야 한다(그 사이 누가 고쳤으면 물러난다).
 *  세션 이름과 같아지는 것이 맞는 이유: 이 프로젝트는 그 세션 하나를 담으려고 방금 만든 껍데기다(여러 세션이 모인
 *   프로젝트에 세션 이름을 덮는 것과는 다른 이야기 — 그건 #1808 이 금지한 반대 방향이다).
 */
export function shouldRenameShellProject(
  project: { name?: string | null; description?: string | null } | null | undefined,
  next: string,
  opts: { expectName?: string } = {},
): boolean {
  if (!project) return false;
  const now = String(project.name ?? "").trim();
  const name = String(next ?? "").trim();
  if (!name || name === now) return false;
  if (!String(project.description ?? "").includes(AUTO_CREATED_MARK)) return false;   // 사람이 정련한 프로젝트
  if (opts.expectName !== undefined && now !== String(opts.expectName).trim()) return false;
  return true;
}

/**
 * 세션 이름이 정해졌다 — 그 세션이 붙은 **자동 생성 껍데기** 프로젝트의 이름도 같은 것으로 바꾼다.
 *  바꿨으면 그 id, 아니면 null. 실패는 전부 삼킨다(이름은 부가정보고, 세션·기록이 먼저다).
 *  노드(멤버 PC) 세션도 덮는다 — 이름짓기가 게이트웨이의 capability 로 들어오기 때문이다(#1979 이전엔
 *   노드에서 이름을 지어 이 승계가 no-op 이었다).
 */
export async function renameShellProjectForSession(args: {
  executionId: string; owner: string; name: string; expectProjectId?: number; expectName?: string;
}): Promise<number | null> {
  try {
    const current = await executionSessionProject(args.executionId, args.owner);
    const pid = Number(current?.project_id ?? 0);
    if (!(pid > 0)) return null;
    if (args.expectProjectId !== undefined && pid !== args.expectProjectId) return null;   // 그새 다른 프로젝트로 옮겼다
    const row = await getProjectRow(pid);
    if (!shouldRenameShellProject(row, args.name, { expectName: args.expectName })) return null;
    // ⚠ 걸쇠를 통과시킨다(#2031) — 표식(AUTO_CREATED_MARK)은 이름을 지어도 본문에 그대로 남으므로, 표식만으로
    //  거르면 **그 프로젝트에 세션이 하나 더 붙을 때마다** 그 세션의 이름으로 다시 덮어쓴다. 출처 순위
    //  (rule < session < agent < human)가 그걸 한 번으로 못박고, 사람이 지은 이름·이 일의 이름으로 따로 지어진
    //  이름(project_rename_v6)도 이 승계가 갈아치우지 못하게 한다. 못 이기면 조용한 no-op — 이 함수는 실패를 만들지 않는다.
    const { applied } = await claimProjectName(pid, args.name, "session", { actor: args.owner, source: "web" });
    if (!applied) return null;
    await ensureAgentsMd(pid).catch(() => { /* 제목이 digest 에 반영되는 것뿐 — 다음 pull 이 채운다 */ });
    return pid;
  } catch (e) {
    console.warn("[first-prompt-project] 껍데기 프로젝트 이름 승계 실패(비치명):", (e as Error)?.message ?? e);
    return null;
  }
}
