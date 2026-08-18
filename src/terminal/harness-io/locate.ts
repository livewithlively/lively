// 대화 파일 찾기 — 훅이 보고한 경로가 1급, 규약은 폴백 (#1746).
//
//  ── 원칙 ──
//  · **추측하지 않는다**(sessions.ts restore · #1059 원칙): 매핑(work-flag 훅 보고)이 정답 경로다. 훅은 세션 **안에서** 돌아 그 파일이 어느
//    홈(공유·프로필·격리)에 있는지 정확히 안다 — 서버가 홈을 짐작할 필요가 없다. 보고가 없을 때만 규약(어댑터 pathFor)으로 뿌리들을 훑는다.
//  · **보고 경로는 검증한다**: 절대경로 · 정규화 동일(`..` 없음) · NUL 없음 · 파일 이름이 어댑터 규약(filePattern) · **그 소유자의 뿌리 안**.
//    이걸 안 걸면 세션 소유자가 아무 경로나 보고해 게이트웨이 권한으로 그 파일을 읽어 가는 통로가 된다(격리 ON 이면 소유자 < 게이트웨이).
//    #1059 의 "누가 읽을 파일인가를 스코프에 넣어라"와 같은 원리 — 남의 홈·프로필 뿌리는 아예 후보가 아니다.
//  · 반환은 경로+크기만. 읽기는 라우트가(창·정렬은 window.ts).
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessSessionAdapter } from "./adapter.js";
import { MEMBER_HOME_BASE } from "../terminal-transcript.js";

/** 이 소유자의 세션이 쓸 수 있는 홈들 — 공유(게이트웨이) 홈 + 격리 홈(리눅스 /home/box_<slug>, terminal-transcript 와 같은 규칙). */
export function ownerHomes(owner: string, platform: string = process.platform): string[] {
  const homes = [os.homedir()];
  const me = String(owner || "").trim();
  const scanMemberHomes = platform === "linux" || !!process.env.LIVELY_MEMBER_HOME_BASE;
  if (me && scanMemberHomes) homes.push(path.join(MEMBER_HOME_BASE, `box_${me}`));
  return homes;
}

const isInside = (file: string, root: string): boolean => {
  const rel = path.relative(root, file);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** 훅이 보고한 경로가 이 어댑터·소유자 기준으로 믿을 만한가(순수 — 파일 존재는 안 본다). */
export function reportedPathOk(adapter: HarnessSessionAdapter, reported: string, roots: string[]): boolean {
  const p = String(reported || "");
  if (!p || p.includes("\0") || !path.isAbsolute(p) || path.normalize(p) !== p) return false;
  if (!adapter.filePattern.test(path.basename(p))) return false;
  return roots.some((r) => isInside(p, r));
}

export interface LocateCtx { cwd: string; convId: string; owner: string; reportedPath?: string | null }
export interface Located { file: string; size: number; via: "reported" | "convention" }

export async function locateTranscript(adapter: HarnessSessionAdapter, ctx: LocateCtx): Promise<Located | null> {
  const roots = adapter.roots(ownerHomes(ctx.owner), ctx.owner);
  const stat = async (file: string): Promise<number | null> => {
    try { const st = await fsp.stat(file); return st.isFile() ? st.size : null; } catch { return null; }
  };
  if (ctx.reportedPath && reportedPathOk(adapter, ctx.reportedPath, roots)) {
    const size = await stat(ctx.reportedPath);
    if (size !== null) return { file: ctx.reportedPath, size, via: "reported" };
  }
  if (adapter.pathFor && ctx.convId) {
    for (const root of roots) {
      const file = adapter.pathFor(root, { cwd: ctx.cwd, convId: ctx.convId });
      if (!file) continue;
      const size = await stat(file);
      if (size !== null) return { file, size, via: "convention" };
    }
  }
  return null;
}
