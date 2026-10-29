// 작업별 앱 지시(#5082) — 매니페스트 ai.instructions(작업 이름 → 앱 묶음 안 파일)를 «부른 사람의 판» 에서 읽어 그 AI 실행의 시스템 지시로 준다.
//
//  왜 판에서 읽나: 에이전트 작업의 작업 폴더(앱 데이터 폴더)는 그 앱이 붙은 세션이면 누구나 · 작업 AI 자신도 고칠 수 있다. 거기 둔 지시(CLAUDE.md ·
//   .claude/skills)로는 «앱이 정한 지시» 를 보장하지 못한다. 판 파일은 앱 판(저장 · 공개)으로만 바뀐다. 지시를 실은 에이전트 작업은 작업 폴더의
//   지시 · 설정을 읽지 않는다(runner.claudeJobArgv — --setting-sources user).
//  어느 판: 표 · 도구 선언과 같은 규칙(app-view.viewAppFor — 초안을 고친 사람은 초안 · 나머지는 공개 판). 부른 사람은 늘 구성원이다(앱 서버가 보낸
//   요청도 그 사람 이름 — ai-runs/service.requesterOf).
//  선언했는데 못 읽으면 던진다 — 지시 없이 돌리지 않는다(닫힌 쪽). 파일이 묶음 안에 있는지 · 크기 · 글자는 설치 · 판 저장 때 loader 가 먼저 본다.
import { HttpError } from "../http-error.js";
import type { OrgApp } from "../org/store/apps.js";
import type { AppFile } from "./app-versions.js";
import type { Viewer } from "./visibility.js";

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

/** (순수) 지시 파일의 글 — 상한을 넘거나 UTF-8 글이 아니면 null(부르는 쪽이 까닭을 붙여 거절한다). */
export function instructionsText(bytes: Uint8Array): string | null {
  if (bytes.byteLength > AI_INSTRUCTIONS_MAX_BYTES) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}

/** 판의 파일 하나를 바이트로(utf8 · base64). */
export function appFileBytes(f: Pick<AppFile, "content" | "encoding">): Uint8Array {
  return f.encoding === "base64" ? Buffer.from(f.content, "base64") : Buffer.from(f.content, "utf8");
}

/** 읽기에 쓰는 바깥 일 — 시험이 바꿔 끼운다. */
export interface InstructionsDeps {
  getApp(appId: string): Promise<OrgApp | null>;
  viewer(member: string): Promise<Viewer>;
  viewAppFor(app: OrgApp, who: Viewer): Promise<{ view: string; app: OrgApp }>;
  versionFile(appId: string, versionNo: number, file: string): Promise<Pick<AppFile, "content" | "encoding"> | null>;
}

/**
 * 그 사람의 판에서 그 작업의 지시를 읽는다 — 그 판이 지시를 선언하지 않았으면 null, 선언했는데 못 읽으면 409(그 앱 · 판이 사라짐 · 파일 없음 · 상한 · 글자).
 *  앱을 볼 수 없게 됐으면 404 — 접수 뒤에 앱이 «나만» 으로 바뀌었거나 지워진 것이다.
 */
export async function readJobInstructions(appId: string, requester: string, job: string | null | undefined, deps?: InstructionsDeps): Promise<string | null> {
  if (!job) return null;
  const d = deps ?? (await liveInstructionsDeps());
  const app = await d.getApp(appId);
  if (!app) throw new HttpError(404, `앱 없음: ${appId}`);
  const { view, app: shown } = await d.viewAppFor(app, await d.viewer(requester));
  if (view === "none") throw new HttpError(404, `앱 없음: ${appId}`);
  const file = instructionsPathOf(shown.manifest, job);
  if (!file) return null;
  const versionNo = shown.current_version_no;
  const f = versionNo == null ? null : await d.versionFile(app.id, versionNo, file);
  if (!f) throw new HttpError(409, `작업 '${job}' 의 앱 지시 파일(${file})을 그 판에서 찾지 못했습니다 — 앱을 다시 저장하세요`);
  const text = instructionsText(appFileBytes(f));
  if (text === null) throw new HttpError(409, `작업 '${job}' 의 앱 지시 파일(${file})이 ${AI_INSTRUCTIONS_MAX_BYTES / 1024}KiB 이하의 UTF-8 글이 아닙니다`);
  return text;
}

async function liveInstructionsDeps(): Promise<InstructionsDeps> {
  const store = await import("../org/store/apps.js");
  const { getMember } = await import("../org/store/members.js");
  const { viewAppFor } = await import("./app-view.js");
  const { versionFiles } = await import("./app-version-files.js");
  return {
    getApp: (id) => store.getApp(id),
    viewer: async (member) => {
      const m = await getMember(member);
      return { userId: member, scopes: Array.isArray(m?.scopes) ? m!.scopes : [] };
    },
    viewAppFor: (app, who) => viewAppFor(app, who),
    versionFile: async (appId, versionNo, file) => {
      const row = await store.getAppVersion(appId, versionNo);
      if (!row) return null;
      return (await versionFiles(row, [file]))[0] ?? null;
    },
  };
}
