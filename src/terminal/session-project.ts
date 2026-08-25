// 실행 중 세션에 프로젝트 소속을 적용하는 **로컬 실행 표면**.
// DB execution_session이 정본이고 tmux @box_project는 목록/복원 호환 캐시다.
// cwd 안의 project.json·AGENTS.md·CLAUDE.md·project 링크는 만들거나 고치지 않는다.
import { HttpError } from "../http-error.js";
import { getOpt, tmux, tmuxQuiet } from "./tmux-exec.js";
import { ownerId } from "./profiles.js";
import type { LivelyUser } from "../context.js";

export interface SessionProjectBind {
  projectId: number;
  folder: string;
  name?: string | null;
  src?: "v6" | "org";
}

export interface SessionProjectRuntime {
  getOpt(id: string, key: string): Promise<string>;
  tmux(args: string[]): Promise<unknown>;
  tmuxQuiet(args: string[]): Promise<unknown>;
}
const defaultRuntime: SessionProjectRuntime = { getOpt, tmux, tmuxQuiet };

/** 소유자 확인 뒤 tmux 표시값만 갱신한다. 파일시스템과 cwd는 프로젝트 전환의 일부가 아니다. */
export async function applySessionProject(
  user: LivelyUser, id: string, bind: SessionProjectBind | null, runtime: SessionProjectRuntime = defaultRuntime,
): Promise<{ ok: true; projectId: number | null; linked: false; projectDir: null; sessionDir: false }> {
  const owner = await runtime.getOpt(id, "@box_owner");
  if (!owner || owner !== ownerId(user)) throw new HttpError(403, "본인 세션이 아닙니다");
  if (bind) {
    await runtime.tmux(["set-option", "-t", id, "@box_project", String(bind.projectId)]);
    await runtime.tmux(["set-option", "-t", id, "@box_project_src", bind.src === "org" ? "org" : "v6"]);
  } else {
    await runtime.tmuxQuiet(["set-option", "-t", id, "-u", "@box_project"]);
    await runtime.tmuxQuiet(["set-option", "-t", id, "-u", "@box_project_src"]);
  }
  return { ok: true, projectId: bind ? bind.projectId : null, linked: false, projectDir: null, sessionDir: false };
}
