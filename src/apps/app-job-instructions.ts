// 작업별 앱 지시(#5082) — 매니페스트 ai.instructions(작업 이름 → 앱 묶음 안 파일)를 «부른 사람의 판» 에서 읽어 그 AI 실행의 시스템 지시로 준다.
//
//  왜 판에서 읽나: 에이전트 작업의 작업 폴더(앱 데이터 폴더)는 그 앱이 붙은 세션이면 누구나 · 작업 AI 자신도 고칠 수 있다. 거기 둔 지시(CLAUDE.md ·
//   .claude/skills)로는 «앱이 정한 지시» 를 보장하지 못한다. 판 파일은 앱 판(저장 · 공개)으로만 바뀐다. 지시를 실은 에이전트 작업은 작업 폴더의
//   지시 · 설정을 읽지 않는다(runner.claudeJobArgv — --setting-sources user).
//  어느 판: 표 · 도구 선언과 같은 규칙(app-view.viewAppFor) — 초안을 고친 사람은 초안 · 나머지는 공개 판, 앱 주소 · 앱 서버로 들어온 호출은
//   그 주소의 판(Viewer.address — capabilities/app-store 의 viewerOf 와 같다). 부르는 쪽(ai-runs/service.submitRun)이 **접수 때 한 번** 읽어
//   글을 실행에 싣는다 — 단발은 그 자리에서 쓰고, 에이전트 작업은 작업 행에 함께 적어 판이 받는다(agent-jobs store app_instructions). 그래서
//   접수 뒤 판이 바뀌어도(공개 · 되돌리기) 그 실행은 접수 때의 지시로 돈다(형식 재시도도 같은 글 — 격리 리뷰 B1 · N2 · N7).
//  선언했는데 못 읽으면 던진다 — 지시 없이 돌리지 않는다(닫힌 쪽). 파일이 묶음 안에 있는지 · 크기 · 글자는 설치 · 판 저장 때 loader 가 먼저 본다.
import { HttpError } from "../http-error.js";
import type { OrgApp } from "../org/store/apps.js";
import type { AppFile } from "./app-versions.js";
import { hasPendingDraft, type Viewer } from "./visibility.js";

/** 지시 파일 하나의 상한 — 시스템 지시 한 장이다. */
export const AI_INSTRUCTIONS_MAX_BYTES = 64 * 1024;

/** (순수) 그 작업 이름의 지시 파일 경로 — 선언이 없으면 null. 저장된 매니페스트를 읽는 자리라 던지지 않는다. */
export function instructionsPathOf(manifest: unknown, job: string | null | undefined): string | null {
  if (!job) return null;
  const map = (manifest as { ai?: { instructions?: unknown } } | null)?.ai?.instructions;
  if (!map || typeof map !== "object" || Array.isArray(map) || !Object.hasOwn(map, job)) return null;
  const v = (map as Record<string, unknown>)[job];
  return typeof v === "string" && v ? v : null;
}

/** (순수) 이 매니페스트가 작업별 지시 파일을 하나라도 선언했나 — 판 묶음을 남겨야 하는 앱인가(설치 · 판 떠 두기가 묻는다). */
export function declaresAiInstructions(manifest: unknown): boolean {
  const map = (manifest as { ai?: { instructions?: unknown } } | null)?.ai?.instructions;
  return !!map && typeof map === "object" && !Array.isArray(map) && Object.values(map).some((v) => typeof v === "string" && v !== "");
}

/**
 * (순수) 지시 파일의 글 — 상한을 넘거나 UTF-8 글이 아니거나 NUL 글자가 있으면 null(부르는 쪽이 까닭을 붙여 거절한다). 빈 글인지는 부르는 쪽이 따로 본다.
 *  NUL 을 막는 까닭: 글을 작업 행(org_agent_job.app_instructions)에 적는데 PostgreSQL 글 칸은 NUL 을 못 담는다(22021) — 그 작업 이름의 접수가
 *  까닭 없는 500 이 되지 않게 설치 · 판 저장(400)과 읽기(409)에서 이유를 보인다(격리 리뷰 · prompt 의 NUL 400 과 같은 자).
 */
export function instructionsText(bytes: Uint8Array): string | null {
  if (bytes.byteLength > AI_INSTRUCTIONS_MAX_BYTES) return null;
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
  return text.includes("\u0000") ? null : text;
}

/** 판의 파일 하나를 바이트로(utf8 · base64). */
export function appFileBytes(f: Pick<AppFile, "content" | "encoding">): Uint8Array {
  return f.encoding === "base64" ? Buffer.from(f.content, "base64") : Buffer.from(f.content, "utf8");
}

/** 읽기에 쓰는 바깥 일 — 시험이 바꿔 끼운다. */
export interface InstructionsDeps {
  viewAppFor(app: OrgApp, who: Viewer): Promise<{ view: string; app: OrgApp }>;
  /** 판 행 하나에서 그 판의 내용 해시와 파일 하나 — 판 행이 없으면 null · 파일이 없으면 file null. */
  versionFile(appId: string, versionNo: number, file: string): Promise<{ contentHash: string | null; file: Pick<AppFile, "content" | "encoding"> | null } | null>;
}

/**
 * 그 사람(주소)의 판에서 그 작업의 지시를 읽는다 — 그 판이 지시를 선언하지 않았으면 null, 선언했는데 못 읽으면 409, 앱을 볼 수 없으면 404.
 *  설치된 판(초안)은 판 행이 지금 상태 그대로일 때만 믿는다(내용 해시) — 판을 남기지 않는 길로 바뀐 앱은 옛 판의 지시가 말없이 실리지 않게 409.
 *  선언이 어디에도 없을 수밖에 없는 앱(설치된 매니페스트가 선언하지 않았고 따로 볼 공개 판도 없다)은 아무것도 읽지 않는다.
 */
export async function resolveJobInstructions(app: OrgApp, who: Viewer, job: string | null | undefined, deps?: InstructionsDeps): Promise<string | null> {
  if (!job) return null;
  if (!instructionsPathOf(app.manifest, job) && !hasPendingDraft(app)) return null;
  const d = deps ?? (await liveInstructionsDeps());
  const { view, app: shown } = await d.viewAppFor(app, who);
  if (view === "none") throw new HttpError(404, `앱 없음: ${app.id}`);
  const file = instructionsPathOf(shown.manifest, job);
  if (!file) return null;
  const versionNo = shown.current_version_no;
  const got = versionNo == null ? null : await d.versionFile(app.id, versionNo, file);
  if (!got || got.contentHash == null || got.contentHash !== shown.content_hash) {
    throw new HttpError(409, `작업 '${job}' 의 앱 지시를 읽을 판이 없습니다(지금 상태가 판으로 남아 있지 않습니다) — 앱을 다시 저장하세요`);
  }
  if (!got.file) throw new HttpError(409, `작업 '${job}' 의 앱 지시 파일(${file})을 그 판에서 찾지 못했습니다 — 앱을 다시 저장하세요`);
  const text = instructionsText(appFileBytes(got.file));
  if (text === null) throw new HttpError(409, `작업 '${job}' 의 앱 지시 파일(${file})이 ${AI_INSTRUCTIONS_MAX_BYTES / 1024}KiB 이하의 UTF-8 글(NUL 없이)이 아닙니다`);
  if (!text.trim()) throw new HttpError(409, `작업 '${job}' 의 앱 지시 파일(${file})이 비어 있습니다 — 지시를 적거나 ai.instructions 에서 빼세요`);
  return text;
}

async function liveInstructionsDeps(): Promise<InstructionsDeps> {
  const store = await import("../org/store/apps.js");
  const { viewAppFor } = await import("./app-view.js");
  const { versionFiles } = await import("./app-version-files.js");
  return {
    viewAppFor: (app, who) => viewAppFor(app, who),
    versionFile: async (appId, versionNo, file) => {
      //  판 묶음 행은 옛 코어 호환 사본(files)을 읽지 않는다 — 옛 판(묶음 없음)만 files 로.
      const head = await store.getAppVersionBundle(appId, versionNo);
      if (!head) return null;
      const row = head.bundle ? { ...head, files: [] } : await store.getAppVersion(appId, versionNo);
      if (!row) return null;
      return { contentHash: head.content_hash, file: (await versionFiles(row, [file]))[0] ?? null };
    },
  };
}
