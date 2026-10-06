// 프로젝트 폴더에서 여는 세션은 **그 프로젝트의 세션**이다 (#4551, 원준 2026-10-06).
//
//  실측: 원준 계정의 9/9 세션 하나가 `/work/shared/project/3516` 에서 도는데 소속 기록이 없어 사이드바 「기타 (미분류)」에
//   섰다. 프로젝트 #3516 은 멀쩡히 있었다.
//  원인: 홈 입구(POST /api/ui/terminal/sessions)는 cwd 를 **좌표**(rootKey · subpath)로만 받고, 소속은 projectId 가 실려
//   올 때만 적는다(«cwd 는 좌표이며 프로젝트 소속과 독립이다» — session-launch.ts). 그래서 폴더를 직접 골라
//   «공유 폴더 › project/3516» 으로 열면 그 프로젝트 폴더에서 일하는데도 소속이 비었다. 같은 좌표를 다시 쓰는 길
//   (설정 기억 · 직접 호출)도 같은 결과를 낸다.
//  ⇒ 그 좌표가 프로젝트 폴더이고 **여는 사람이 그 프로젝트를 볼 수 있으면** 소속을 적는다. 프로젝트 입구
//   (POST …/projects/:id/sessions)가 하는 일과 같은 결과다 — 어느 문으로 들어오든 같은 폴더면 같은 소속이다.
//
//  ⚠ 못 보는 프로젝트 · 없는 프로젝트 · 휴지통의 프로젝트면 **아무것도 안 한다**(종전 그대로 소속 없이 연다).
//   폴더 좌표만으로 남의 프로젝트 멤버십을 얻는 길이 되면 안 된다 — 프로젝트 입구가 «타 프로젝트 폴더로 열어
//   멤버십을 도용하는 걸 차단» 하려고 폴더를 봉쇄하는 것과 같은 걱정이다. 여기서는 봉쇄가 아니라 **보임 검사**로 지킨다.
import { itemsPool } from "../db/client.js";
import { LEGACY_SUBDIR, PROJECT_SUBDIR } from "./project-fs.js";
import { canSeeProjectRow, effectiveViewer } from "../v6/visibility.js";
import { logger } from "../log.js";

/**
 * 순수 — 세션 좌표가 프로젝트 폴더(또는 그 안)이면 그 프로젝트의 folder(`project/<이름>`). 아니면 null.
 *  · 공유 루트(`shared`)의 좌표만 본다 — 프로젝트 폴더는 거기에만 있다.
 *  · 하위 폴더(`project/3516/lively`)도 그 프로젝트다(레포 워크트리에서 여는 세션).
 *  ★ **실제로 폴더를 여는 쪽(terminal/profiles.resolveRootPath)과 똑같이 읽는다.** 그쪽은 앞의 `/` · `\` 만 떼고
 *   `path.resolve` 에 넘긴다 — 다듬지도(trim), `\` 를 구분자로 보지도 않는다(POSIX). 여기서 더 너그럽게 읽으면
 *   `project\3516` 이나 ` project/3516` 처럼 **프로젝트 폴더가 아닌 낯선 폴더**에서 도는 세션에 소속이 붙고,
 *   소속이 붙은 세션은 폴더 신뢰 확인(autoTrustWorkspace)을 건너뛴다. 그래서 의심스러운 조각이 하나라도 있으면 읽지 않는다:
 *   `..` · `.` · 빈 조각 · 역슬래시 · 앞뒤 공백 · NUL.
 */
export function projectFolderOfCoord(rootKey: string | null | undefined, subpath: string | null | undefined): string | null {
  if (rootKey !== "shared") return null;
  const parts = String(subpath ?? "").replace(/^[/\\]+/, "").replace(/\/+$/, "").split("/");
  if (parts.length < 2) return null;
  if (parts.some((p) => !p || p === "." || p === ".." || p !== p.trim() || /[\\\0]/.test(p))) return null;
  if (parts[0] !== PROJECT_SUBDIR && parts[0] !== LEGACY_SUBDIR) return null;
  return `${parts[0]}/${parts[1]}`;
}

/** 이 판정이 프로젝트 행에게 묻는 것. */
export interface FolderProjectRow { id: number; trashed_at?: string | Date | null }

/** 순수 — 후보 행들 중 묶을 프로젝트. 휴지통 것은 뺀다. 둘 이상이면(있어선 안 된다) 묶지 않는다 — 어느 쪽인지 지어내지 않는다. */
export function pickFolderProject(rows: readonly FolderProjectRow[]): number | null {
  const alive = rows.filter((r) => !r.trashed_at);
  return alive.length === 1 ? Number(alive[0].id) : null;
}

/** 조회 둘 — 시험이 가짜를 끼운다(createShellProject 의 ShellCreateDeps 와 같은 결). */
export interface FolderBindDeps {
  /** 그 folder 를 **정확히** 가진 프로젝트 행들. */
  rowsByFolder: (folder: string) => Promise<FolderProjectRow[]>;
  /** 보는 사람이 그 프로젝트를 볼 수 있나. viewer null = 전체 열람 권한(긴급 열람 반영 뒤). */
  canSee: (projectId: number, viewer: string | null) => Promise<boolean>;
  /** 조회 실패를 알린다(묶지 않고 지나가되, 흔적은 남긴다). */
  warn?: (err: unknown, folder: string) => void;
}

const liveDeps: FolderBindDeps = {
  //  ⚠ folder 는 **정확히** 맞춘다(보관으로 옮겨진 반대 꼴은 안 본다) — 좌표가 이미 특정 폴더라, `project/3516` 으로 열었는데
  //   `legacy-project/3516` 인 프로젝트에 묶으면 그 프로젝트의 폴더가 아닌 자리에서 도는 세션이 그 프로젝트의 것이 된다.
  rowsByFolder: async (folder) =>
    (await itemsPool.query(`SELECT id, trashed_at FROM project WHERE folder = $1 AND level='project'`, [folder])).rows as FolderProjectRow[],
  canSee: async (id, viewer) => { const v = await effectiveViewer(viewer); return v === null || (await canSeeProjectRow(id, v)); },
  warn: (err, folder) => logger.warn({ err, folder }, "프로젝트 폴더 좌표의 소속 조회 실패 — 소속 없이 연다(비치명)"),
};

/**
 * 이 좌표로 여는 세션이 묶일 프로젝트 id — 묶을 것이 없으면 null(호출자는 종전대로 소속 없이 연다).
 *  `viewer` 는 capabilities/principal.viewerOf 가 준 값(null = 전체 열람 권한). 조회 실패는 null — 세션 생성을 막지 않는다.
 */
export async function projectIdForSessionCoord(
  rootKey: string | null | undefined, subpath: string | null | undefined, viewer: string | null, deps: FolderBindDeps = liveDeps,
): Promise<number | null> {
  const folder = projectFolderOfCoord(rootKey, subpath);
  if (!folder) return null;
  try {
    const id = pickFolderProject(await deps.rowsByFolder(folder));
    if (!id) return null;
    return (await deps.canSee(id, viewer)) ? id : null;
  } catch (e) { deps.warn?.(e, folder); return null; }
}
