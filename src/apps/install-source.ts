// 앱 패키지 소스 → 스테이지 디렉터리. loader 는 하나이므로(loader.ts 머리 주석) git clone·게이트웨이 로컬 경로를
//  같은 스테이지 디렉터리로 수렴시킨다. 업로드(tar) 는 후속(멀티파트 라우트 선행).
//  보안(v1 = honest-but-curious, 관리자 게이트): git 은 https:// 스킴만 허용(SSRF 완화), 얕은 clone,
//   타임아웃, .git 제거(콘텐츠 해시 결정성 + 히스토리 미보관). shell 미경유(execFile 인자 배열).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HttpError } from "../http-error.js";

const execFileP = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

export type AppSource =
  | { kind: "git"; url: string; ref?: string }
  | { kind: "path"; path: string };

export interface StagedSource {
  dir: string;                    // loadAppPackage 에 넘길 스테이지 디렉터리
  meta: Record<string, unknown>;  // org_app.source 에 저장할 출처 기록
  cleanup: () => Promise<void>;   // 임시 자원 정리(path 는 no-op)
}

/** 입력 소스를 검증·정규화한다(zod 통과 후 런타임 형태 확정). */
export function parseAppSource(raw: unknown): AppSource {
  const s = (raw ?? {}) as Record<string, unknown>;
  const kind = String(s.kind ?? "");
  if (kind === "git") {
    const url = String(s.url ?? "").trim();
    if (!url) throw new HttpError(400, "git 소스는 url 이 필요합니다");
    const ref = s.ref == null ? undefined : String(s.ref).trim() || undefined;
    return { kind: "git", url, ref };
  }
  if (kind === "path") {
    const p = String(s.path ?? "").trim();
    if (!p) throw new HttpError(400, "path 소스는 path 가 필요합니다");
    return { kind: "path", path: p };
  }
  throw new HttpError(400, `알 수 없는 앱 소스 kind: ${kind || "(없음)"}`);
}

/**
 * 소스를 스테이지 디렉터리로 물질화한다. 반환한 cleanup() 을 **반드시** finally 에서 호출한다.
 *  - path: 게이트웨이 로컬 절대/상대 경로를 그 자리에서 사용(cleanup=no-op). 관리자 운영·테스트용.
 *  - git:  https:// 만. 임시 디렉터리에 얕은 clone → .git 제거 → 그 디렉터리를 스테이지로.
 */
export async function stageAppSource(source: AppSource): Promise<StagedSource> {
  if (source.kind === "path") {
    const dir = path.resolve(source.path);
    const st = await stat(dir).catch(() => null);
    if (!st || !st.isDirectory()) throw new HttpError(400, `경로가 디렉터리가 아닙니다: ${dir}`);
    return { dir, meta: { kind: "path", path: dir }, cleanup: async () => { /* no-op */ } };
  }
  const url = source.url.trim();
  if (!/^https:\/\//i.test(url)) throw new HttpError(400, "git 소스는 https:// URL 만 허용합니다");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "lively-app-"));
  const args = ["clone", "--depth", "1", "--single-branch"];
  if (source.ref) args.push("--branch", source.ref);
  args.push("--", url, tmp);
  try {
    await execFileP("git", args, { timeout: GIT_TIMEOUT_MS });
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ });
    throw new HttpError(400, `git clone 실패: ${(e as Error)?.message ?? e}`);
  }
  // .git 제거 — 콘텐츠 해시(hashAppPackage) 결정성 + 히스토리 미보관. 실패해도 설치는 계속(해시만 영향).
  await rm(path.join(tmp, ".git"), { recursive: true, force: true }).catch(() => { /* noop */ });
  return {
    dir: tmp,
    meta: { kind: "git", url, ref: source.ref ?? null },
    cleanup: async () => { await rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ }); },
  };
}
