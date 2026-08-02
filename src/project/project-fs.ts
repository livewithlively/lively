// 프로젝트 전용 폴더 — 공유 워크스페이스의 'project/<id>' 아래. 터미널 세션의 작업 디렉토리이자
//  공유 폴더의 실체. 폴더명 = 프로젝트 정수 id(불변·유일·경로안전: 공백·한글 없음). 사람 가독성은 폴더 내 AGENTS.md.
//  SHARED_BASE 는 terminal-sessions ROOTS 'shared' base 와 반드시 일치(순환 import 회피 위해 env 직접 읽음).
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { HttpError } from "../http-error.js";
import { isolationInfraReady } from "../terminal/terminal-isolation.js";

// 실배포는 deploy/install.sh(common.sh)가 .env 에 TERMINAL_ROOT_SHARED 를 세팅(디폴트 $HOME/workspace) → 폴백은 그 관례와 일치시킴(수기 셋업 대비 안전망).
export const PROJECT_SHARED_BASE = path.resolve(process.env.TERMINAL_ROOT_SHARED || path.join(os.homedir(), "workspace"));
export const PROJECT_SUBDIR = "project"; // 사용자 지정 — workspace/project/ 아래에 프로젝트 폴더(진행 중)
export const LEGACY_SUBDIR = "legacy-project"; // 완료 시 보관 — workspace/legacy-project/ 로 폴더 이동

// 'project/<id>' 상대경로(= 세션 subpath·DB folder) 반환 + 폴더 생성(멱등). id 는 불변·유일이라
//  충돌·공백·한글이 없어 절대경로가 항상 경로안전(웹 터미널 cwd 무관). 가독성은 폴더 내 AGENTS.md(제목·메타)가 담당.
export async function createProjectFolder(id: number): Promise<string> {
  const baseDir = path.join(PROJECT_SHARED_BASE, PROJECT_SUBDIR);
  await fsp.mkdir(baseDir, { recursive: true }).catch(() => { /* 이미 존재 */ });
  const folder = String(id);
  const dir = path.join(baseDir, folder);
  await fsp.mkdir(dir, { recursive: true });
  // ⚠ 프로젝트 세션은 생성자 box_<멤버> 로 격리 실행(#524 인증 프로필 단위) → 게이트웨이(lively)가 만든 이 폴더를
  //  box_ 가 cwd·rw 해야 한다. lively-shared 그룹 rwx + setgid(2770)로 — box_ 는 그 그룹 멤버. 자격증명은 여기 없음
  //  (각 box_ 홈 700 에 커널 격리). 그룹은 부모(/srv/lively/shared) setgid 로 상속. chmod 는 umask 에 안 깎이게 별도.
  //  (예전 0o700 = 소유자[lively]만 → 격리 세션이 cwd 진입 불가로 죽던 원인. 비격리 폴백 박스에도 무해.)
  await Promise.all([fsp.chmod(baseDir, SHARED_DIR_MODE).catch(() => {}), fsp.chmod(dir, SHARED_DIR_MODE).catch(() => {})]);
  return `${PROJECT_SUBDIR}/${folder}`;
}

// ── 공유폴더 **하위** 그룹 개방(#1246) ──
//  위 createProjectFolder 는 프로젝트 폴더 자체만 2770 으로 열고, 그 **안**에 게이트웨이가 만드는 산출물
//  (웹 '새 폴더'·업로드 파일·AGENTS.md·.lively 마커)은 umask(022)대로 755/644 — 그룹 쓰기가 없다. 격리 박스의
//  세션은 box_<멤버> uid 로 돌며 이 폴더를 lively-shared **그룹**으로만 접근하므로, 유저가 웹에서 만든 폴더에
//  세션 클로드가 파일을 못 쓴다(EACCES — 소유자 lively). 폴더 자체의 계약을 하위에도 잇는다: 디렉터리 2770 · 파일 660.
export const SHARED_DIR_MODE = 0o2770;   // rwxrwx--- + setgid(그룹 상속) — createProjectFolder 와 동일 계약
export const SHARED_FILE_MODE = 0o660;   // rw-rw----

// abs(게이트웨이가 방금 만든 항목)부터 stopBase(미포함) 직전까지 부모로 올라가며 그룹 rw 를 부여한다.
//  mkdir recursive·폴더 업로드가 중간 폴더 여러 단을 만들 수 있어 경로 전체를 훑는다(기존 디렉터리 재-chmod 는 멱등).
//  best-effort: 멤버(box_) 소유 항목은 EPERM 으로 조용히 실패 — 그건 만든 멤버가 이미 rw 라 목적 달성 상태다.
//  stopBase 밖/루트 자신은 방어적 no-op(호출부 resolveIn 이 이미 봉쇄하지만 chmod 는 한 번 더 조심한다).
export async function grantSharedGroupWrite(abs: string, stopBase: string, kind: "dir" | "file"): Promise<void> {
  const stop = path.resolve(stopBase);
  let cur = path.resolve(abs);
  if (cur === stop || !cur.startsWith(stop + path.sep)) return;
  if (kind === "file") {
    await fsp.chmod(cur, SHARED_FILE_MODE).catch(() => { /* best-effort */ });
    cur = path.dirname(cur);
  }
  while (cur !== stop && cur.startsWith(stop + path.sep)) {
    await fsp.chmod(cur, SHARED_DIR_MODE).catch(() => { /* best-effort */ });
    cur = path.dirname(cur);
  }
}

// (순수 — 테스트 seam) 소급 보정 find argv. 셸 미경유(spawn argv 직행) — 인젝션 표면 없음.
//  게이트웨이 소유(-user)이면서 그룹 rw 가 빠진 것만: 디렉터리는 g+rwx+setgid 미달(-perm -2070), 파일은 g+rw
//  미달(-perm -0060). 추가(g+)만 하고 다른 비트는 안 건드린다 — 이미 열린 트리(umask 0002 로 받은 레포 등)는
//  필터에 안 걸려 exec 없이 스캔만 지나간다.
export function backfillGroupWriteArgv(roots: string[], user: string): string[] {
  return ["find", ...roots, "-xdev", "-user", user,
    "(", "-type", "d", "!", "-perm", "-2070", "-exec", "chmod", "g+rwxs", "{}", "+", ")", "-o",
    "(", "-type", "f", "!", "-perm", "-0060", "-exec", "chmod", "g+rw", "{}", "+", ")"];
}

// 기존 항목 소급 보정(#1246) — grantSharedGroupWrite 도입 전에 게이트웨이가 만들어 둔 755/644 를 부팅 때
//  백그라운드로 고친다(#522 공유 클론 retrofit 과 동형). box_ 격리가 실제로 있는 박스(Linux + box-spawn)에서만
//  의미가 있어 그 외(맥 개발 등)는 스킵. 큰 트리여도 부팅을 안 막게 fire-and-forget. 시작 여부를 반환(로그용).
export function backfillSharedGroupWrite(base: string = PROJECT_SHARED_BASE): boolean {
  if (process.platform !== "linux" || !isolationInfraReady()) return false;
  const roots = [path.join(base, PROJECT_SUBDIR), path.join(base, LEGACY_SUBDIR)].filter((p) => fs.existsSync(p));
  if (!roots.length) return false;
  const argv = backfillGroupWriteArgv(roots, os.userInfo().username);
  const child = spawn(argv[0], argv.slice(1), { stdio: "ignore" });
  child.on("error", () => { /* find 부재 등 — best-effort */ });
  child.unref();
  return true;
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

// ── 구 마커 sync 백필(#905 P1-②) — 이 박스가 만든 프로젝트 폴더의 마커에 sync:"pull" 을 stamp. ──
//  왜 서버가 해야 하나: pull 훅은 마커의 sync 로 '이 폴더에 서버 파일을 써도 되는가'를 판정하고, sync 가 없는
//   구 마커는 **폴더 소유권**으로 폴백 판정한다. 그런데 그 폴백은 `~/lively/projects/<id>`(멤버 PC — work.mjs 가
//   만드는 꼴이 고정)만 인정한다. 박스 폴더는 folder 값이 임의라 구조로 알아볼 수가 없다 — 실측: 286개 마커 중
//   'project/관리탭 수정'·'project/오케이-3'·'legacy-project/프로젝트 탭 만들기' 등 12개가 id 가 아닌 이름 기반이다
//   (project_create_v6 가 folder 를 받고 projectAbsPath 가 project/ 하위면 통과시키므로 신규도 그럴 수 있다).
//   그렇다고 '부모가 project/ 면 소유'로 넓히면 사용자의 흔한 `~/projects/<무언가>` 가 걸려 무음 파괴가 난다.
//   ⇒ 자기 폴더가 어디인지 아는 유일한 자(=서버)가 명시적으로 stamp 한다. 그 뒤 박스 폴더는 폴백에 의존하지 않는다.
//  실패해도 파괴가 아니라 '그 폴더의 자동 pull 이 멈춤'(가시적·복구가능)이다 — 비가역 파괴보다 이 실패를 택한다.
//  멱등: sync 가 이미 있으면 절대 안 건드린다(사람이 none 으로 꺼둔 걸 되살리지 않는다). 마커 없음·파손·권한실패는 건너뜀.
export async function backfillMarkerSync(base: string = PROJECT_SHARED_BASE): Promise<{ scanned: number; stamped: number }> {
  let scanned = 0, stamped = 0;
  for (const sub of [PROJECT_SUBDIR, LEGACY_SUBDIR]) {
    const dir = path.join(base, sub);
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; } // 하위폴더 자체가 없음
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = path.join(dir, e.name, ".lively", "project.json");
      let raw: string;
      try { raw = await fsp.readFile(file, "utf8"); } catch { continue; } // 마커 없는 폴더 — 대상 아님
      scanned++;
      let meta: Record<string, unknown>;
      try { meta = JSON.parse(raw); } catch { continue; }                 // 파손 마커는 손대지 않는다
      if (!meta || typeof meta !== "object" || !meta.project_id) continue;
      if (typeof meta.sync === "string" && meta.sync.trim()) continue;    // 이미 명시 → 보존(멱등)
      meta.sync = "pull";
      try { await fsp.writeFile(file, JSON.stringify(meta, null, 2) + "\n"); stamped++; } catch { /* 권한 등 — 건너뜀 */ }
    }
  }
  return { scanned, stamped };
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
  await fsp.chmod(toBaseDir, SHARED_DIR_MODE).catch(() => { /* project/ 와 동일 계약(#1246) — 격리 세션 접근 보장 */ });
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
