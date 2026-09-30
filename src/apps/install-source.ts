// 앱 패키지 소스 → 스테이지 디렉터리. loader 는 하나이므로(loader.ts 머리 주석) git clone·게이트웨이 로컬 경로·
//  inline 파일 묶음을 같은 스테이지 디렉터리로 수렴시킨다. 업로드(tar) 는 후속(멀티파트 라우트 선행).
//  inline(#4224): 매니지드에선 게이트웨이가 CP 호스트에서 돌아 세션(노드)이 쓴 폴더를 못 읽는다(path 설치 실측 실패
//   2026-09-22 «경로가 디렉터리가 아닙니다»). 그래서 세션이 만든 파일 묶음(매니페스트·HTML·스킬)을 **요청 본문에 실어** 올린다.
//  보안(v1 = honest-but-curious, 관리자 게이트): git 은 https:// 스킴만 허용(SSRF 완화), 얕은 clone,
//   타임아웃, .git 제거(콘텐츠 해시 결정성 + 히스토리 미보관). shell 미경유(execFile 인자 배열).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HttpError } from "../http-error.js";

const execFileP = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

export interface InlineFile { path: string; content: string; encoding?: "utf8" | "base64" }

export type AppSource =
  | { kind: "git"; url: string; ref?: string }
  | { kind: "path"; path: string }
  | { kind: "inline"; files: InlineFile[] };

// inline 묶음 상한 — 앱 하나 = 매니페스트 + 화면 HTML 몇 장 + 스킬 몇 개. 넘으면 git 설치를 쓰라고 알린다.
export const INLINE_MAX_FILES = 200;
export const INLINE_MAX_BYTES = 8 * 1024 * 1024;   // 풀어 쓴 합계(바이트). REST 본문 상한과 맞춘다(index.ts).

/**
 * inline 파일 경로 정규화(순수) — 패키지 루트 기준 상대경로만. 절대경로·`..`·역슬래시·빈 조각·숨김 `.git` 은 거부한다.
 *  반환 = `a/b/c.html` 꼴(POSIX). 거부는 400.
 */
export function normalizeInlinePath(raw: unknown): string {
  const p = String(raw ?? "").trim();
  if (!p) throw new HttpError(400, "inline 파일에 path 가 필요합니다");
  if (p.includes("\\") || p.includes("\0")) throw new HttpError(400, `inline 파일 경로에 쓸 수 없는 문자가 있습니다: ${p}`);
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw new HttpError(400, `inline 파일 경로는 패키지 안의 상대경로여야 합니다: ${p}`);
  const parts = p.split("/").filter((x) => x !== "" && x !== ".");
  if (!parts.length) throw new HttpError(400, `inline 파일 경로가 비었습니다: ${p}`);
  for (const part of parts) {
    if (part === "..") throw new HttpError(400, `inline 파일 경로에 '..' 를 쓸 수 없습니다: ${p}`);
    if (part === ".git") throw new HttpError(400, `inline 파일 경로에 .git 을 쓸 수 없습니다: ${p}`);
    if (part.length > 255) throw new HttpError(400, `inline 파일 경로 조각이 너무 깁니다: ${p}`);
  }
  if (parts.length > 16) throw new HttpError(400, `inline 파일 경로가 너무 깊습니다: ${p}`);
  return parts.join("/");
}

/** inline 묶음 검증·디코드(순수). 중복 경로·상한 초과·매니페스트 누락을 거부한다. */
export function decodeInlineFiles(files: unknown): Array<{ path: string; bytes: Buffer }> {
  if (!Array.isArray(files) || files.length === 0) throw new HttpError(400, "inline 소스는 files(파일 목록)가 필요합니다");
  if (files.length > INLINE_MAX_FILES) throw new HttpError(400, `inline 파일이 너무 많습니다(${files.length}개 > ${INLINE_MAX_FILES}개) — git 설치를 쓰세요`);
  const seen = new Set<string>();
  const out: Array<{ path: string; bytes: Buffer }> = [];
  let total = 0;
  for (const f of files) {
    const o = (f ?? {}) as Record<string, unknown>;
    const rel = normalizeInlinePath(o.path);
    if (seen.has(rel)) throw new HttpError(400, `inline 파일 경로가 중복입니다: ${rel}`);
    seen.add(rel);
    if (typeof o.content !== "string") throw new HttpError(400, `inline 파일 '${rel}' 에 content(문자열)가 필요합니다`);
    const enc = o.encoding == null ? "utf8" : String(o.encoding);
    if (enc !== "utf8" && enc !== "base64") throw new HttpError(400, `inline 파일 '${rel}' 의 encoding 은 utf8 또는 base64 여야 합니다`);
    const bytes = Buffer.from(o.content, enc);
    total += bytes.length;
    if (total > INLINE_MAX_BYTES) throw new HttpError(400, `inline 묶음이 너무 큽니다(${INLINE_MAX_BYTES}B 초과) — git 설치를 쓰세요`);
    out.push({ path: rel, bytes });
  }
  if (!seen.has("lively-app.json")) throw new HttpError(400, "inline 묶음에 lively-app.json(매니페스트)이 없습니다");
  return out;
}

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
  if (kind === "inline") {
    // 여기서 한 번 검증해 두면(경로·중복·상한) stage 전에 400 이 난다. 실제 디코드는 stage 가 다시 한다(순수 함수라 싸다).
    decodeInlineFiles(s.files);
    return { kind: "inline", files: s.files as InlineFile[] };
  }
  throw new HttpError(400, `알 수 없는 앱 소스 kind: ${kind || "(없음)"}`);
}

/**
 * 소스를 스테이지 디렉터리로 물질화한다. 반환한 cleanup() 을 **반드시** finally 에서 호출한다.
 *  - path: 게이트웨이 로컬 절대/상대 경로를 그 자리에서 사용(cleanup=no-op). 관리자 운영·테스트용.
 *  - git:  https:// 만. 임시 디렉터리에 얕은 clone → .git 제거 → 그 디렉터리를 스테이지로.
 *  - inline: 요청 본문의 파일 묶음을 임시 디렉터리에 풀어 스테이지로(#4224).
 */
export async function stageAppSource(source: AppSource): Promise<StagedSource> {
  if (source.kind === "path") {
    const dir = path.resolve(source.path);
    const st = await stat(dir).catch(() => null);
    if (!st || !st.isDirectory()) throw new HttpError(400, `경로가 디렉터리가 아닙니다: ${dir}`);
    return { dir, meta: { kind: "path", path: dir }, cleanup: async () => { /* no-op */ } };
  }
  if (source.kind === "inline") {
    const files = decodeInlineFiles(source.files);
    const tmp = await mkdtemp(path.join(os.tmpdir(), "lively-app-inline-"));
    try {
      for (const f of files) {
        const abs = path.resolve(tmp, f.path);
        // 정규화를 통과했어도 한 번 더 — 스테이지 밖에 쓰는 일은 어떤 경로로도 없어야 한다.
        if (!abs.startsWith(tmp + path.sep)) throw new HttpError(400, `inline 파일 경로가 패키지 밖을 가리킵니다: ${f.path}`);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, f.bytes, { flag: "wx" });
      }
    } catch (e) {
      await rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ });
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, `inline 파일을 풀지 못했습니다: ${(e as Error)?.message ?? e}`);
    }
    // 출처 기록엔 내용이 아니라 모양만 남긴다(내용의 지문은 content_hash 가 맡는다) — org_app.source 가 부풀지 않게.
    const bytes = files.reduce((n, f) => n + f.bytes.length, 0);
    return {
      dir: tmp,
      meta: { kind: "inline", files: files.length, bytes },
      cleanup: async () => { await rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ }); },
    };
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
