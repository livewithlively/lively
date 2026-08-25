// 실행 중 세션에 프로젝트 소속을 적용하는 **로컬 실행 표면**.
// DB execution_session이 정본이고 tmux @box_project는 목록/복원 호환 캐시다.
// cwd 안의 project.json·AGENTS.md·CLAUDE.md·project 링크는 만들거나 고치지 않는다.
import fs from "node:fs";
import path from "node:path";
import { PROJECT_SHARED_BASE } from "../project/project-fs.js";
import { HttpError } from "../http-error.js";
import { getOpt, tmux, tmuxQuiet } from "./tmux-exec.js";
import { ownerId } from "./profiles.js";
import type { LivelyUser } from "../context.js";

/** 이 호스트에서 프로젝트 폴더가 놓이는 절대경로. folder 는 'project/<id>' 꼴 상대경로. 워크스페이스 밖이면 null.
 *  ⚠ **존재 여부는 보지 않는다** — 경로 계산과 존재 판정은 다른 질문이다(아래 projectDirOnThisHost). */
export function projectDirPath(folder: string): string | null {
  const rel = String(folder || "").replace(/^[/\\]+/, "");
  if (!rel) return null;
  const abs = path.resolve(PROJECT_SHARED_BASE, rel);
  if (abs !== PROJECT_SHARED_BASE && !abs.startsWith(PROJECT_SHARED_BASE + path.sep)) return null;   // 워크스페이스 밖이면 안 잇는다
  return abs;
}

/** 이 호스트에 **실재하는** 프로젝트 폴더의 절대경로(없으면 null).
 *  ⚠ projectDirPath 와 의도적으로 다른 함수다 — 이름 하나로 합치지 마라. "있는 것만 만진다"가 곧 안전인 자리가 쓴다:
 *   세션 완전삭제(#1850)는 이 값으로 폴더를 `rm -rf` 하므로, 존재 확인 없이 경로만 받으면 그 안전 가정이 사라진다. */
export function projectDirOnThisHost(folder: string): string | null {
  const abs = projectDirPath(folder);
  return abs && fs.existsSync(abs) ? abs : null;
}

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
