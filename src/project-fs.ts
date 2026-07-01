// 프로젝트 전용 폴더 — 공유 워크스페이스의 'project/<id>' 아래. 터미널 세션의 작업 디렉토리이자
//  공유 폴더의 실체. 폴더명 = 프로젝트 정수 id(불변·유일·경로안전: 공백·한글 없음). 사람 가독성은 폴더 내 AGENTS.md.
//  SHARED_BASE 는 terminal-sessions ROOTS 'shared' base 와 반드시 일치(순환 import 회피 위해 env 직접 읽음).
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { HttpError } from "./capabilities/rest-util.js";

export const PROJECT_SHARED_BASE = path.resolve(process.env.TERMINAL_ROOT_SHARED || path.join(os.homedir(), ".openclaw", "workspace"));
export const PROJECT_SUBDIR = "project"; // 사용자 지정 — workspace/project/ 아래에 프로젝트 폴더(진행 중)
export const LEGACY_SUBDIR = "legacy-project"; // 완료 시 보관 — workspace/legacy-project/ 로 폴더 이동

// 'project/<id>' 상대경로(= 세션 subpath·DB folder) 반환 + 폴더 생성(멱등). id 는 불변·유일이라
//  충돌·공백·한글이 없어 절대경로가 항상 경로안전(웹 터미널 cwd 무관). 가독성은 폴더 내 AGENTS.md(제목·메타)가 담당.
export async function createProjectFolder(id: number): Promise<string> {
  const baseDir = path.join(PROJECT_SHARED_BASE, PROJECT_SUBDIR);
  await fsp.mkdir(baseDir, { recursive: true }).catch(() => { /* 이미 존재 */ });
  const folder = String(id);
  await fsp.mkdir(path.join(baseDir, folder), { recursive: true, mode: 0o700 });
  return `${PROJECT_SUBDIR}/${folder}`;
}

// 저장된 상대경로(folder)를 절대경로로 — 파일 API·세션 검증용. project/ 또는 legacy-project/ 하위만 허용
//  (완료 프로젝트는 legacy-project/ 로 이동되므로 둘 다 허용). .. 탈출·범위이탈 차단.
export function projectAbsPath(folder: string): string {
  const rel = String(folder || "").replace(/^[/\\]+/, "");
  const abs = path.resolve(PROJECT_SHARED_BASE, rel);
  const pbase = path.join(PROJECT_SHARED_BASE, PROJECT_SUBDIR);
  const lbase = path.join(PROJECT_SHARED_BASE, LEGACY_SUBDIR);
  const inProject = abs === pbase || abs.startsWith(pbase + path.sep);
  const inLegacy = abs === lbase || abs.startsWith(lbase + path.sep);
  if (!inProject && !inLegacy) throw new HttpError(400, "프로젝트 폴더 범위를 벗어났습니다");
  return abs;
}

// 세션 작업 디렉토리(절대경로)가 프로젝트 폴더(project/ 또는 legacy-project/ 하위)인지 — 터미널 탭 숨김·게이트용.
export function isProjectSessionDir(dir: string): boolean {
  if (!dir) return false;
  const abs = path.resolve(dir);
  const p = path.join(PROJECT_SHARED_BASE, PROJECT_SUBDIR);
  const l = path.join(PROJECT_SHARED_BASE, LEGACY_SUBDIR);
  return abs === p || abs.startsWith(p + path.sep) || abs === l || abs.startsWith(l + path.sep);
}

// 세션 dir(절대) → 프로젝트 folder 상대경로('project/<name>' 또는 'legacy-project/<name>'). 범위 밖이면 null.
export function dirToProjectFolder(dir: string): string | null {
  if (!isProjectSessionDir(dir)) return null;
  return path.relative(PROJECT_SHARED_BASE, path.resolve(dir));
}

// folder('project/<name>' 또는 'legacy-project/<name>')의 양형 변형 — 원본 + 반대 prefix 형(있으면).
//  입장 게이트가 아카이브(project↔legacy) 드리프트에도 같은 프로젝트를 찾게 하는 폴백용(과허용 아님 — 멤버십은 별도 검증).
export function folderVariants(folder: string): string[] {
  const rel = String(folder || "").replace(/^[/\\]+/, "");
  const out = [rel];
  const pPre = PROJECT_SUBDIR + "/", lPre = LEGACY_SUBDIR + "/";
  if (rel.startsWith(pPre)) out.push(lPre + rel.slice(pPre.length));
  else if (rel.startsWith(lPre)) out.push(pPre + rel.slice(lPre.length));
  return out;
}

// 완료(archive=true: project/ → legacy-project/) 또는 복귀(false: 반대)로 폴더 이동. 새 상대경로 반환.
//  대상에 같은 이름 있으면 -2,-3 회피(덮어쓰기 금지). 원본 폴더가 없으면(이미 이동/삭제) 목표 경로만 관용 반환.
export async function moveProjectFolder(folder: string, archive: boolean): Promise<string> {
  const rel = String(folder || "").replace(/^[/\\]+/, "");
  const fromAbs = projectAbsPath(rel); // 범위 검증(project/ 또는 legacy-project/ 하위)
  const toSubdir = archive ? LEGACY_SUBDIR : PROJECT_SUBDIR;
  const toBaseDir = path.join(PROJECT_SHARED_BASE, toSubdir);
  const name = path.basename(fromAbs);
  await fsp.mkdir(toBaseDir, { recursive: true }).catch(() => { /* 이미 존재 */ });
  let target = name, n = 1;
  while (fs.existsSync(path.join(toBaseDir, target))) {
    n += 1; target = `${name}-${n}`;
    if (n > 999) throw new HttpError(409, "보관 폴더 이름이 충돌합니다");
  }
  try { await fsp.rename(fromAbs, path.join(toBaseDir, target)); }
  catch (e: any) {
    if (e && e.code === "ENOENT") return `${toSubdir}/${target}`; // 원본 부재 → 목표 경로만 기록(관용)
    throw e;
  }
  return `${toSubdir}/${target}`;
}
