// 공유 폴더 매니페스트 — 프로젝트 폴더를 재귀 walk 해 동기화 대상 파일 목록을 만든다(로컬 작업 PC 의 pull diff 기준).
//  project-routes.ts(HTTP 라우트)에서 분리 — 순수 fs 로직이라 DB/WS 없이 단위테스트 가능(#828).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const MANIFEST_FILE_CAP = 5000;

export interface ManifestFile { path: string; mtime: number; size: number; }
export interface Manifest { files: ManifestFile[]; truncated: boolean; }

// 디렉터리가 git 레포 루트인가(.git 은 clone 이면 디렉터리·worktree 면 gitdir 포인터 파일 — 존재만으로 판정).
export async function isGitRepoRoot(dir: string): Promise<boolean> {
  try { await fsp.stat(path.join(dir, ".git")); return true; } catch { return false; }
}

// 공유 폴더 전체의 재귀 매니페스트(파일만, 숨김 제외). path=상대경로, mtime=ms epoch, size=바이트.
//  숨김(.lively/.git/.DS_Store/시크릿 등)은 동기화 대상 아님.
//  ⚠ provision 된 레포/워크트리(.git 보유 디렉터리)는 서브트리 통째로 제외한다(#828). 워크트리는 프로젝트 폴더
//   안(project-provision.ts, project/<id>/<repo>)에 생기므로, 그 working-tree 코드 파일이 문서 sync 에 쓸려
//   들어가면 매니페스트가 부풀어(#714: 레포 4,965개가 5,002개 매니페스트의 99%) pull 이 순차 다운로드 타임아웃 나고
//   정작 올린 문서가 안 내려온다. 코드는 git 이 로컬에서 재구성(work.mjs)하므로 문서 sync 대상이 아니다.
//   truncated=파일 상한(cap) 도달 → 문서가 조용히 매니페스트에서 탈락했을 수 있다는 신호(클라이언트가 경고에 사용).
export async function manifestFiles(base: string, limit = MANIFEST_FILE_CAP): Promise<Manifest> {
  const out: ManifestFile[] = [];
  let truncated = false;
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (depth > 24) return;
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) { truncated = true; return; }
      if (e.name.startsWith(".")) continue;
      const childRel = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) {
        // provision 레포/워크트리(.git 보유)는 문서 sync 대상 아님 — git 이 로컬에서 재구성. 서브트리 통째 스킵(#828).
        const child = path.join(dir, e.name);
        if (await isGitRepoRoot(child)) continue;
        await walk(child, childRel, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      try { const st = await fsp.stat(path.join(dir, e.name)); out.push({ path: childRel, mtime: Math.floor(st.mtimeMs), size: st.size }); }
      catch { /* 읽기 불가 — 스킵 */ }
    }
  }
  await walk(base, "", 0);
  return { files: out, truncated };
}
