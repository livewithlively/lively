// 세션 ↔ 프로젝트 소속을 **나중에** 바꾼다 (#1719 홈 입력창 — "일단 프로젝트 없이 열고, 언제든 붙인다").
//
//  ── 모델 ──
//  세션 전용 폴더(<루트>/sessions/<세션id>)는 세션의 것이고 **cwd 는 바뀌지 않는다.** 프로젝트 소속은 세 자리에 적는다:
//   ① tmux `@box_project`(+`@box_project_src`) — 목록·귀속·복원의 표시값(종전 프로젝트 세션과 같은 자리).
//   ② 세션 폴더 **안** — `.lively/project.json` 마커(훅·CLI 가 cwd 에서 위로 찾는 그 마커, 단 `kind:"session"`·`project_dir`
//      를 함께 적어 "이 폴더가 프로젝트 폴더"로 오독되지 않게) + `project` 링크(POSIX 심링크 / Windows 정션) +
//      AGENTS.md·CLAUDE.md 셔틀(다음에 뜨는 하네스가 프로젝트 규칙을 읽게).
//   ③ DB `session_project`(시간구간 — 재바인딩은 새 구간, 과거 작업은 옛 프로젝트에 남는다) — 게이트웨이 라우트가 적는다(노드엔 DB 없음).
//
//  ── 왜 cwd 자체를 프로젝트 폴더로 심링크하지 않나(대표 제안 검토) ──
//   · 실행 중 프로세스의 cwd 는 **inode 참조**라 링크를 갈아끼워도 따라오지 않는다(재시작 전엔 무효). 그러면 "언제든 바꾼다"가
//     "바꾸면 하네스를 다시 띄운다"가 되고, 이어받기 id·트랜스크립트 키(cwd 물리경로 기준)가 프로젝트마다 갈려 복원이 위험해진다.
//   · 이미 만들어 둔 파일을 옮겨야 링크로 바꿀 수 있다(비어 있지 않은 폴더는 링크로 대체 불가).
//   · 관리형(#1437)에선 세션 컨테이너 마운트가 기동 시 고정이라 어차피 "폴더 안 링크 + 공유 루트 마운트"가 필요하다.
//   그래서 cwd 는 세션 것으로 두고, 소속은 그 **안**의 링크·마커·DB 로 표현한다 — 어느 환경(박스·관리형·맥/윈 노드)에서도 같은 코드다.
//
//  ── 노드(맥·윈 로컬 세션) ──
//  게이트웨이가 `setProject` op 로 릴레이하면 노드가 이 모듈의 applySessionProject 를 자기 파일시스템·mux 에 그대로 적용한다
//  (정책=게이트웨이 F7, 실행=노드). 프로젝트 폴더가 그 머신에 없으면 링크는 건너뛴다(마커·옵션만).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { PROJECT_SHARED_BASE } from "../project/project-fs.js";
import { HttpError } from "../http-error.js";
import { getOpt, tmux, tmuxQuiet, sessionDir } from "./tmux-exec.js";
import { ownerId } from "./profiles.js";
import type { LivelyUser } from "../context.js";

/** <루트>/sessions/<세션id> — 세션 전용 폴더가 사는 하위 이름(createSession · restore 가 같은 이름을 쓴다). */
export const SESSION_DIR_SUBDIR = "sessions";
/** 세션 폴더 안의 프로젝트 링크 이름. */
export const PROJECT_LINK_NAME = "project";
const OWNED_MARK = "<!-- lively:session-project -->";   // 우리가 쓴 셔틀 파일의 첫 줄 — 이 줄이 있을 때만 덮어쓰거나 지운다

export interface SessionProjectBind { projectId: number; folder: string; name?: string | null; src?: "v6" | "org" }

/** 이 호스트에서 프로젝트 폴더의 절대경로(있으면). folder 는 'project/<id>' 꼴 상대경로. */
export function projectDirOnThisHost(folder: string): string | null {
  const rel = String(folder || "").replace(/^[/\\]+/, "");
  if (!rel) return null;
  const abs = path.resolve(PROJECT_SHARED_BASE, rel);
  if (abs !== PROJECT_SHARED_BASE && !abs.startsWith(PROJECT_SHARED_BASE + path.sep)) return null;   // 워크스페이스 밖이면 안 잇는다
  return fs.existsSync(abs) ? abs : null;
}

/** 이 파일이 우리가 만든 셔틀인가(첫 줄 표식). 없거나 우리 것이면 true(써도 된다). */
async function ownedOrAbsent(file: string): Promise<boolean> {
  try { const head = (await fsp.readFile(file, "utf8")).slice(0, 200); return head.startsWith(OWNED_MARK); }
  catch { return true; }
}
async function rmIfOwned(file: string): Promise<void> {
  if (await ownedOrAbsent(file)) await fsp.rm(file, { force: true }).catch(() => { /* 없음 */ });
}

/** 세션 폴더 안의 표현(마커·링크·셔틀)을 프로젝트에 맞춘다. bind=null 이면 걷어낸다. 순수 FS — tmux·DB 는 안 만진다. */
export async function applySessionProjectFs(dir: string, sessionId: string, bind: SessionProjectBind | null): Promise<{ linked: boolean; projectDir: string | null }> {
  const markerDir = path.join(dir, ".lively");
  const marker = path.join(markerDir, "project.json");
  const link = path.join(dir, PROJECT_LINK_NAME);
  const agents = path.join(dir, "AGENTS.md");
  const claude = path.join(dir, "CLAUDE.md");
  // 링크는 늘 걷어낸 뒤 다시 건다(대상이 바뀌었을 수 있다). 링크가 아니라 진짜 폴더면 건드리지 않는다(사용자 것).
  try { const st = await fsp.lstat(link); if (st.isSymbolicLink()) await fsp.unlink(link); } catch { /* 없음 */ }
  if (!bind) {
    await fsp.rm(marker, { force: true }).catch(() => { /* 없음 */ });
    await rmIfOwned(agents); await rmIfOwned(claude);
    return { linked: false, projectDir: null };
  }
  const projectDir = projectDirOnThisHost(bind.folder);
  await fsp.mkdir(markerDir, { recursive: true });
  // 마커 — 훅(세션 기록 귀속)·CLI(워크트리 슬롯) 가 cwd 에서 위로 찾는 그 파일. `kind:"session"` + `project_dir` 로 "이 폴더는
  //  세션 폴더이고 프로젝트 폴더는 저기"를 말한다. sync:"none" — 공유폴더 pull/push 훅이 이 폴더에 서버 파일을 쓰지 않게(fail-safe).
  const meta = { kind: "session", session_id: sessionId, project_id: bind.projectId, project_dir: projectDir, sync: "none", bound_at: new Date().toISOString() };
  await fsp.writeFile(marker, JSON.stringify(meta, null, 2) + "\n");
  let linked = false;
  if (projectDir) {
    // Windows 는 정션(관리자 권한 불요·절대경로 필수) · 그 밖은 디렉터리 심링크. 실패해도 마커는 남는다(링크는 편의).
    try { await fsp.symlink(projectDir, link, process.platform === "win32" ? "junction" : "dir"); linked = true; }
    catch (e) { console.warn(`[terminal] 프로젝트 링크 실패(${sessionId} → ${projectDir}) — 마커만 남긴다:`, (e as Error)?.message ?? e); }
  }
  // 셔틀 — 다음에 이 폴더에서 뜨는(또는 이어받는) 하네스가 프로젝트 규칙을 읽게. 실행 중 하네스는 다음 세션부터 본다
  //  (Claude Code 는 CLAUDE.md 를 시작 때 읽는다). 우리가 쓴 파일(첫 줄 표식)만 덮어쓴다.
  const title = bind.name ? `#${bind.projectId} «${bind.name}»` : `#${bind.projectId}`;
  const projAgents = projectDir ? path.join(projectDir, "AGENTS.md") : null;
  const hasProjAgents = !!projAgents && fs.existsSync(projAgents);
  const agentsBody = [
    OWNED_MARK,
    `# 이 세션은 프로젝트 ${title} 에 속합니다`,
    "",
    "> 라이블리가 세션↔프로젝트 소속을 바꿀 때 자동으로 다시 씁니다(사람이 편집하지 마세요 — 지워집니다).",
    "",
    projectDir
      ? `- 프로젝트 폴더: \`./${PROJECT_LINK_NAME}\` → \`${projectDir}\`${linked ? "" : " (링크를 걸지 못해 절대경로로 가세요)"}`
      : "- 프로젝트 폴더는 이 컴퓨터에 없습니다 — 프로젝트 본문·지식은 lively MCP(`project_get_v6`)로 봅니다.",
    `- 프로젝트 상세·태스크·필요지식: \`project_get_v6(${bind.projectId})\` (lively MCP)`,
    hasProjAgents ? `- 프로젝트 규칙·레포·필요지식 요약은 \`./${PROJECT_LINK_NAME}/AGENTS.md\` 에 있습니다 — 먼저 읽으세요.` : "",
    "- 산출물은 이 세션 폴더가 아니라 **프로젝트 폴더 안**에 두면 프로젝트를 보는 모두가 봅니다.",
    "",
  ].filter((l) => l !== "").join("\n") + "\n";
  if (await ownedOrAbsent(agents)) await fsp.writeFile(agents, agentsBody);
  if (await ownedOrAbsent(claude)) {
    const lines = [OWNED_MARK, "@AGENTS.md"];
    if (hasProjAgents && linked) lines.push(`@${PROJECT_LINK_NAME}/AGENTS.md`);
    await fsp.writeFile(claude, lines.join("\n") + "\n");
  }
  return { linked, projectDir };
}

/** 이 세션이 세션 전용 폴더에서 도는가(@box_session_dir) — 그럴 때만 폴더 안을 만진다. */
export async function isSessionDirSession(id: string): Promise<boolean> {
  return (await getOpt(id, "@box_session_dir")) === "1";
}

/**
 * 이 호스트의 세션에 프로젝트 소속을 적용한다 — tmux 옵션 + (세션 전용 폴더면) 폴더 안 표현.
 *  인가는 호출자(라우트 = 소유자, 노드 op = 게이트웨이가 검증) 몫이지만 assertManage 로 한 번 더 막는다(소유자 아니면 throw).
 *  DB 는 안 만진다(노드엔 없다) — 게이트웨이 라우트가 recordSessionProject·desired-state 를 적는다.
 */
export async function applySessionProject(user: LivelyUser, id: string, bind: SessionProjectBind | null): Promise<{ ok: true; projectId: number | null; linked: boolean; projectDir: string | null; sessionDir: boolean }> {
  // 소유자만(sessions.ts assertManage 와 같은 규칙 — 방향 규약상 이 모듈은 sessions.ts 를 import 하지 않아 tmux 메타로 판정).
  const owner = await getOpt(id, "@box_owner");
  if (!owner || owner !== ownerId(user)) throw new HttpError(403, "본인 세션이 아닙니다");
  if (bind) {
    await tmux(["set-option", "-t", id, "@box_project", String(bind.projectId)]);
    await tmux(["set-option", "-t", id, "@box_project_src", bind.src === "org" ? "org" : "v6"]);
  } else {
    await tmuxQuiet(["set-option", "-t", id, "-u", "@box_project"]);
    await tmuxQuiet(["set-option", "-t", id, "-u", "@box_project_src"]);
  }
  const inSessionDir = await isSessionDirSession(id);
  let linked = false; let projectDir: string | null = null;
  if (inSessionDir) {
    const dir = await sessionDir(id);
    ({ linked, projectDir } = await applySessionProjectFs(dir, id, bind));
  }
  return { ok: true, projectId: bind ? bind.projectId : null, linked, projectDir, sessionDir: inSessionDir };
}
