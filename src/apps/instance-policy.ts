// AppInstance 프로젝트 귀속 정책 — manifest 선언을 OS가 집행하는 순수 규칙(#1780 v2.1).
import { HttpError } from "../http-error.js";
import type { LivelyAppManifest } from "./manifest.js";

export type AppProjectAffinity = "global" | "optional" | "required";
export const APP_INSTANCE_STATE_MAX_BYTES = 128 * 1024;

export function appProjectAffinity(manifest: LivelyAppManifest): AppProjectAffinity {
  return manifest.instances?.project ?? "optional";
}

/** projectId의 형식과 manifest 정책만 판정한다. 존재·가시성은 capability 경계에서 DB로 확인한다. */
export function normalizeInstanceProject(manifest: LivelyAppManifest, raw: unknown): number | null {
  const projectId = raw === null || raw === undefined || raw === "" || raw === 0 ? null : Number(raw);
  if (projectId !== null && (!Number.isInteger(projectId) || projectId <= 0)) {
    throw new HttpError(400, "project_id 형식 오류");
  }
  const affinity = appProjectAffinity(manifest);
  if (affinity === "global" && projectId !== null) {
    throw new HttpError(400, "이 앱은 전체 범위 앱이라 프로젝트에 소속시킬 수 없습니다");
  }
  if (affinity === "required" && projectId === null) {
    throw new HttpError(400, "이 앱은 프로젝트 소속이 필요합니다");
  }
  return projectId;
}

/** AppInstance 복원 상태의 단일 요청 상한. 문자열 길이가 아니라 저장·전송되는 UTF-8 바이트로 잰다. */
export function normalizeInstanceState(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "state 는 객체여야 합니다");
  if (Buffer.byteLength(JSON.stringify(raw), "utf8") > APP_INSTANCE_STATE_MAX_BYTES) {
    throw new HttpError(400, "state 는 128KiB 이하여야 합니다");
  }
  return raw as Record<string, unknown>;
}
