// 공유폴더 잠금(#1291 v2 · 트랙 C) — 공유 워크스페이스 **경로 단위** 열람 가시성의 단일 SoT.
//
//  왜 필요한가: 공유 워크스페이스(터미널 'shared' 루트)는 지금까지 **항상 전원 공개**였다. 대시보드 홈의
//  '팀 공유 폴더' 위젯에서 클릭 두 번이면 조직 전체의 파일을 목록·다운로드·업로드·삭제까지 할 수 있다.
//  고객사 A처럼 제품조직 밖(영업본부 등)까지 쓰기 시작한 조직에선 이게 그대로 사고 표면이다.
//
//  ## 두 축이 한 경로에서 만난다
//  ① `project/<id>` · `legacy-project/<id>` 하위 = **프로젝트 폴더** → 별도 설정이 아니라 그 프로젝트의 가시성을
//     그대로 물려받는다(사용자 원문: "프로젝트 내의 공유폴더는 해당 프로젝트의 가시성을 상속받는 게 맞을듯").
//     그래서 이 서브트리는 여기서 ACL 을 **설정할 수 없다** — 두 곳에서 따로 잠그면 어느 쪽이 이겼는지 아무도 모른다.
//  ② 그 밖의 일반 폴더 = `shared_folder_acl` 경로 체인.
//
//  ## 상속 = 단조 축소(AND)
//  유효 대상 = 자기 설정 ∩ 조상 전부. 상위가 'members' 면 하위는 무조건 잠긴다 — 하위에서 다시 넓힐 수 없다.
//  (설계 D2. "리스트만 비공개면 스페이스가 껍데기로 전체에 보인다"의 파일 판(版)이다.)
//
//  ## 비파괴
//  ACL 행이 없으면 'open' 이다. 아무도 안 잠근 조직에선 blocked 집합이 **빈 셋**이라 동작이 완전히 동일하다.
//
//  ## 이 잠금의 한계(정직하게 적어둔다)
//  중앙 박스의 AI 세션은 **셸을 가진다** — API 를 막아도 `ls`/`cat` 은 그대로 된다(설계 R4-#1). 여기서 닫는 것은
//  웹·MCP 표면이고, 진짜 경계는 §4.7 OS 강제(setfacl)가 따로 닫는다. 그렇다고 이 층이 무의미하진 않다:
//  대시보드 위젯의 '클릭 두 번' 노출과 MCP 를 통한 AI 의 무심한 열람·반출이 실제 사고 경로였다.
import { itemsPool } from "../db/client.js";
import { q, withTx } from "../db/client.js";
import { HttpError } from "../http-error.js";
import { PROJECT_SUBDIR, LEGACY_SUBDIR, folderVariants } from "../project/project-fs.js";
import { effectiveViewer, hiddenProjects, PUBLIC_VIEWER, type Viewer } from "./visibility.js";
import { axisOn } from "./visibility-axes.js";

// ── 스키마(멱등·additive) ────────────────────────────────────────────────────
//  여기서 lazy 하게 보장한다(connectors/run-tracker 와 같은 패턴). 이 기능만 쓰는 테이블 두 개라 v6/schema.ts 의
//  거대 부팅 블록에 얹지 않아도 되고, 트랙 병렬 진행 중에도 서로의 마이그레이션을 건드리지 않는다.
//  ON UPDATE CASCADE 가 중요하다 — 폴더 rename 은 acl.path 만 갱신하면 대상(member) 행이 따라온다.
// 스키마는 **부팅 시 중앙 마이그레이션**(v6/schema.ts)이 만든다 — 이 레포의 규약이다.
//  여기서 lazy CREATE 를 하면 같은 DDL 이 두 곳에 살아 드리프트가 생기고, 첫 요청이 DDL 을 기다리게 된다.
//  호출부는 의도를 드러내려고 남겨 두되(어떤 테이블에 의존하는지 읽히게) 실제로는 아무 일도 하지 않는다.

export type FolderVisibility = "open" | "members";

// ── 경로 정규화 ──────────────────────────────────────────────────────────────
/**
 * 공유 루트 기준 상대경로를 저장·비교용 정규형으로. 앞뒤 슬래시·중복 슬래시·'.' 제거, 백슬래시는 '/' 로.
 * 루트 자신은 빈 문자열("")이다. `..` 은 거부한다 — 정규화가 조용히 상위로 새면 잠금 판정이 통째로 무너진다
 * (라우트가 이미 realpath 로 봉쇄하지만, 판정 함수는 스스로도 안전해야 한다).
 */
export function normalizeSharedPath(rel: string): string {
  const raw = String(rel ?? "").replace(/\\/g, "/");
  const segs = raw.split("/").filter((s) => s && s !== ".");
  if (segs.some((s) => s === "..")) throw new HttpError(400, "경로가 올바르지 않습니다");
  return segs.join("/");
}

/** 자기 자신 + 모든 조상(루트 "" 포함). AND 판정은 이 전부를 통과해야 한다. */
function selfAndAncestors(rel: string): string[] {
  const out = [""];
  const segs = rel ? rel.split("/") : [];
  let cur = "";
  for (const s of segs) { cur = cur ? `${cur}/${s}` : s; out.push(cur); }
  return out;
}

/** 이 경로가 프로젝트 폴더 서브트리인가 — 그렇다면 그 프로젝트의 folder 상대경로('project/<id>')를 돌려준다. */
export function projectFolderOf(rel: string): string | null {
  const segs = normalizeSharedPath(rel).split("/").filter(Boolean);
  if (segs.length < 2) return null;                                  // 'project' 자체는 그냥 컨테이너(하위가 판정 대상)
  if (segs[0] !== PROJECT_SUBDIR && segs[0] !== LEGACY_SUBDIR) return null;
  return `${segs[0]}/${segs[1]}`;
}

/** 프로젝트 상속 구간이라 여기서 ACL 을 설정하면 안 되는 경로인가(설정 UI·API 가 이걸로 거절한다). */
export function isProjectManagedPath(rel: string): boolean {
  const segs = normalizeSharedPath(rel).split("/").filter(Boolean);
  return segs.length >= 1 && (segs[0] === PROJECT_SUBDIR || segs[0] === LEGACY_SUBDIR);
}

// ── 판정(게이트) ─────────────────────────────────────────────────────────────
/**
 * 한 뷰어의 경로 판정기. **목록 1회에 한 번만 만들어** 항목마다 동기로 물어본다.
 *  왜 배치인가: 폴더 목록 한 번이 수십~수백 항목이다. 항목마다 DB 를 때리면 브라우저 클릭 한 번에 쿼리가 수백 개
 *  나간다(설계 R5-#5 가 잡은 함수-SoT 핫패스 문제와 같은 함정). 잠긴 것이 없으면 두 집합이 모두 비어 비용은 0에 가깝다.
 */
export interface SharedFolderGate {
  /** 이 상대경로(폴더든 파일이든)를 이 뷰어가 볼 수 있나. */
  ok(rel: string): boolean;
  /**
   * 이 경로가 '일부공개'인가 — 자기 ACL 또는 조상 ACL 이 'members'. 폴더 브라우저의 🔒 배지용이다.
   *  조상 때문에 잠긴 하위도 참을 돌려준다: 사용자가 "여긴 전체공개인 줄 알고" 파일을 올리는 사고가
   *  바로 그 지점에서 난다(원문: "헷갈리지 않기 위해 아이콘에 일부공개임을 표시해야 하고").
   *  프로젝트 폴더 축은 여기 안 들어온다 — restrictedProjectFolders() 가 따로 준다(판정 소스가 다르다).
   */
  restricted(rel: string): boolean;
}

const ALLOW_ALL: SharedFolderGate = { ok: () => true, restricted: () => false };

/**
 * 뷰어별 게이트 생성.
 *  - viewer=null(내부 시스템 경로) 또는 전체 스코프 긴급열람이면 전부 통과.
 *  - 프로젝트 축은 `hiddenProjects`(= visibleListIds 의 배치형)를 쓴다. 경로마다 canSeeProjectRow 를 부르는 것과
 *    답은 같고 쿼리는 1회다. 긴급열람·폴더 상속도 그 안에서 이미 반영된다.
 *  - ⚠ 판정 불가(DB 장애)면 **throw 해서 요청을 실패시킨다**. "판정을 못 하겠으니 일단 보여주자"는 잠금을
 *    무력화하는 방향이라 택하지 않는다(설계 fail-closed).
 */
export async function sharedFolderGate(viewer: Viewer): Promise<SharedFolderGate> {
  if (viewer === null) return ALLOW_ALL;
  if (!(await axisOn("shared_folder"))) return ALLOW_ALL;   // 축 꺼짐(#1291) — 공유폴더는 종전처럼 전원 공개
  const eff = await effectiveViewer(viewer);          // 전체 스코프 긴급열람 → 특권 승격
  if (eff === null) return ALLOW_ALL;

  const hidden = await hiddenProjects(eff);           // 실패 시 throw(fail-closed) — 위 주석 참고
  const rows = await q(itemsPool, `
    SELECT a.path,
           EXISTS(SELECT 1 FROM shared_folder_member m
                   WHERE m.path = a.path
                     AND ((m.subject_kind = 'member' AND m.member_id = $1)
                       OR (m.subject_kind = 'team' AND EXISTS(SELECT 1 FROM team_member tm
                             WHERE tm.team_id::text = m.member_id AND tm.member_id = $1)))) AS granted
      FROM shared_folder_acl a
     WHERE a.visibility = 'members'`, [eff]);

  const locked = new Set<string>(rows.map((r) => String(r.path)));
  const blocked = new Set<string>(rows.filter((r) => !r.granted).map((r) => String(r.path)));

  return {
    ok(rel: string): boolean {
      let norm: string;
      try { norm = normalizeSharedPath(rel); } catch { return false; }   // 이상한 경로는 통과시키지 않는다
      // ① 프로젝트 축 — 그 프로젝트가 이 뷰어에게 안 보이면 폴더도 안 보인다(project/ ↔ legacy-project/ 양형 확인:
      //   완료 프로젝트는 폴더가 legacy-project/ 로 옮겨지는데 DB 의 folder 값이 아직 옛 prefix 일 수 있다).
      const pf = projectFolderOf(norm);
      if (pf && folderVariants(pf).some((v) => hidden.folders.has(v))) return false;
      // ② ACL 축 — 자기 자신 또는 조상 중 하나라도 막혀 있으면 차단(단조 축소 AND).
      if (blocked.size) for (const anc of selfAndAncestors(norm)) if (blocked.has(anc)) return false;
      return true;
    },
    restricted(rel: string): boolean {
      if (!locked.size) return false;
      let norm: string;
      try { norm = normalizeSharedPath(rel); } catch { return false; }
      return selfAndAncestors(norm).some((a) => locked.has(a));
    },
  };
}

// ── 프로젝트 폴더의 '일부공개' 표시(배지 전용) ───────────────────────────────
//  ⚠ 이건 **접근 판정이 아니다** — 접근은 위 gate.ok 의 프로젝트 축(hiddenProjects)이 한다. 여기서 필요한 건
//   "나는 볼 수 있지만 전원 공개는 아닌 폴더"를 표시하는 것뿐이라, 뷰어와 무관한 조직 공통 집합이면 충분하다.
//   그래서 뷰어별 캐시가 아니라 전역 TTL 캐시다(폴더 브라우저는 열어두고 새로고침을 반복하는 화면이다).
//  ⚠ 판정을 여기서 손으로 짜지 마라(#1291). 처음엔 리스트 + **직속** 폴더만 보는 SQL 이었는데, 그러면
//   스페이스▸폴더▸리스트로 걸린 프로젝트에 배지가 안 붙는다 — 즉 잠긴 폴더를 두고 "전원 공개"라고
//   **말해 주는** 셈이다. 배지가 존재하는 이유가 바로 그 혼동을 없애는 것이라 근사로 넘길 자리가 아니다.
//   답이 뷰어와 무관하므로 술어 SoT 의 재귀 판정을 PUBLIC_VIEWER 로 한 번 물어 그대로 쓴다(그쪽도 캐시된다).
const RPF_TTL_MS = 15_000;
let rpfCache: { at: number; v: Set<string> } | null = null;
export async function restrictedProjectFolders(): Promise<Set<string>> {
  const now = Date.now();
  if (rpfCache && now - rpfCache.at < RPF_TTL_MS) return rpfCache.v;
  let v = new Set<string>();
  try {
    const ids = [...(await hiddenProjects(PUBLIC_VIEWER)).ids];
    if (ids.length) {
      const rows = await q(itemsPool, `
        SELECT folder FROM project
         WHERE id = ANY($1::int[]) AND level='project' AND folder IS NOT NULL AND folder <> ''`, [ids]);
      v = new Set(rows.map((r) => String(r.folder)));
    }
  } catch { v = rpfCache?.v ?? new Set(); }   // 배지 실패는 조용히(접근 판정이 아니다 — 여기서 요청을 죽이지 않는다)
  rpfCache = { at: now, v };
  return v;
}

/** 단건 판정(라우트 진입 게이트용). 목록처럼 여러 번 물을 자리엔 sharedFolderGate 를 한 번만 만들어 쓴다. */
export async function pathAudience(rel: string, viewer: Viewer): Promise<boolean> {
  return (await sharedFolderGate(viewer)).ok(rel);
}

// ── 조회 ─────────────────────────────────────────────────────────────────────
export interface SharedFolderAcl {
  path: string;
  visibility: FolderVisibility;
  members: string[];
  /** 이 경로보다 위에서 잠긴 가장 가까운 조상(없으면 null) — "여기선 더 좁힐 수만 있다"를 UI 가 설명하게. */
  inherited_from: string | null;
  updated_by: string | null;
  updated_at: string | null;
  /** 프로젝트 가시성 상속 구간이라 여기선 설정할 수 없는가. */
  project_managed: boolean;
}

/** 한 경로의 자기 설정 + 상속 상태. 행이 없으면 open 으로 답한다(비파괴 기본값). */
export async function getSharedFolderAcl(rel: string): Promise<SharedFolderAcl> {
  const path = normalizeSharedPath(rel);
  const [own] = await q(itemsPool,
    `SELECT path, visibility, updated_by, updated_at FROM shared_folder_acl WHERE path = $1`, [path]);
  const members = own
    ? (await q(itemsPool,
      `SELECT member_id FROM shared_folder_member WHERE path = $1 AND subject_kind='member' ORDER BY member_id`, [path]))
      .map((r) => String(r.member_id))
    : [];
  // 조상 중 잠긴 것 — 가장 가까운(경로가 긴) 것 하나만 보여준다(원인 폴더를 짚어주는 게 목적).
  const anc = selfAndAncestors(path).filter((p) => p !== path);
  const [locked] = anc.length
    ? await q(itemsPool,
      `SELECT path FROM shared_folder_acl WHERE visibility='members' AND path = ANY($1::text[])
        ORDER BY length(path) DESC LIMIT 1`, [anc])
    : [];
  return {
    path,
    visibility: own?.visibility === "members" ? "members" : "open",
    members,
    inherited_from: locked ? String(locked.path) : null,
    updated_by: own?.updated_by ? String(own.updated_by) : null,
    updated_at: own?.updated_at ? new Date(own.updated_at).toISOString() : null,
    project_managed: isProjectManagedPath(path),
  };
}

/**
 * 이 뷰어에게 **보이는** 잠긴 폴더 목록 — 폴더 브라우저가 🔒 배지를 그리는 데 쓴다.
 *  안 보이는 경로는 애초에 목록에서 빠지므로 여기서 굳이 감출 필요는 없지만, 경로 이름 자체가 단서가 될 수 있어
 *  게이트를 한 번 더 통과시킨다(존재 은닉 일관성).
 */
export async function listSharedFolderAcls(viewer: Viewer): Promise<Array<{ path: string; visibility: FolderVisibility }>> {
  const gate = await sharedFolderGate(viewer);
  const rows = await q(itemsPool,
    `SELECT path, visibility FROM shared_folder_acl WHERE visibility='members' ORDER BY path`, []);
  return rows
    .filter((r) => gate.ok(String(r.path)))
    .map((r) => ({ path: String(r.path), visibility: "members" as const }));
}

// ── 변경 ─────────────────────────────────────────────────────────────────────
/**
 * 경로의 공개범위 + 대상을 통째로 교체.
 *  ⚠ **한 트랜잭션**이다(설계 R2-#7). 대상 교체가 DELETE→INSERT 2단인데 그 사이에 죽으면 'members 인데 대상 0명'
 *   = 아무도 못 보는 폴더가 남는다(관리자 긴급열람 말고는 되돌릴 사람이 없다). 교체 중 들어온 조회가 '대상 없음'으로
 *   오판하는 것도 같은 이유로 막힌다.
 *  대상 검증(실재하는 구성원인가·비었나·본인이 포함됐나)은 호출부(capability)가 한다 — 스토어는 저장만 한다.
 */
export async function setSharedFolderAcl(
  rel: string,
  visibility: FolderVisibility,
  members: string[],
  ctx?: { actor?: string | null },
): Promise<SharedFolderAcl> {
  const path = normalizeSharedPath(rel);
  if (!path) throw new HttpError(400, "대상 폴더 경로가 필요합니다");
  if (isProjectManagedPath(path)) {
    throw new HttpError(400, "프로젝트 폴더는 해당 프로젝트의 공개범위를 그대로 따릅니다 — 프로젝트에서 설정하세요");
  }
  const actor = ctx?.actor ?? null;
  const uniq = [...new Set((members || []).map((m) => String(m).trim()).filter(Boolean))];
  await withTx(async (c) => {
    await c.query(`
      INSERT INTO shared_folder_acl(path, visibility, updated_by, updated_at) VALUES($1,$2,$3,now())
      ON CONFLICT (path) DO UPDATE SET visibility = EXCLUDED.visibility, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [path, visibility, actor]);
    await c.query(`DELETE FROM shared_folder_member WHERE path = $1`, [path]);
    for (const m of uniq) {
      await c.query(
        `INSERT INTO shared_folder_member(path, subject_kind, member_id) VALUES($1,'member',$2)`, [path, m]);
    }
  });
  return await getSharedFolderAcl(path);
}

// ⚠ **삭제 때는 ACL 을 지우지 않는다**(의도). 지워 두면 같은 이름으로 폴더를 다시 만드는 순간 전원 공개가 되는데,
//  그건 fail-open 방향이다. 남겨 두면 재생성된 폴더가 옛 잠금을 그대로 물려받는다(fail-closed) — 대상자가 폴더를
//  지웠다 다시 만드는 흔한 조작에서 내용이 조용히 새는 것보다, '왜 아직 잠겨 있지'가 낫다(설정에서 바로 풀 수 있다).
//  그 대가로 없어진 경로의 행이 남지만, 브라우저는 실제 디렉터리만 그리므로 사용자에겐 보이지 않는다.
/**
 * 폴더 rename/이동에 맞춰 ACL 경로를 따라 옮긴다(자기 자신 + 하위 전부, prefix 치환).
 *  이걸 안 하면 잠긴 폴더의 이름만 바꿔도 ACL 이 고아가 되어 **폴더가 전원 공개로 풀린다** — fail-open 방향이라
 *  절대 놓치면 안 되는 동기화다. (셸 `mv` 로 어긋나는 건 여기서 못 잡는다 — §4.7 OS 강제와 함께 닫는다.)
 *  대상 경로에 이미 ACL 이 있으면(예: 지웠다 같은 이름으로 다시 만든 폴더) PK 충돌이 나므로 먼저 치운다.
 *  member 행은 FK ON UPDATE CASCADE 로 따라온다.
 */
export async function renameSharedFolderAclPrefix(fromRel: string, toRel: string): Promise<number> {
  const from = normalizeSharedPath(fromRel);
  const to = normalizeSharedPath(toRel);
  if (!from || !to || from === to) return 0;
  return await withTx(async (c) => {
    const like = from.replace(/([\\%_])/g, "\\$1") + "/%";   // LIKE 메타문자 이스케이프(폴더명에 _ 는 흔하다)
    const moved = await c.query(
      `SELECT path FROM shared_folder_acl WHERE path = $1 OR path LIKE $2 ESCAPE '\\'`, [from, like]);
    if (!moved.rowCount) return 0;
    const sources = new Set<string>(moved.rows.map((r: { path: string }) => String(r.path)));
    // 목적지에 이미 ACL 이 있으면(지웠다 같은 이름으로 다시 만든 폴더 등) PK 충돌이 나므로 먼저 치운다.
    //  ⚠ 옮길 원본과 겹치는 경로는 빼고 지운다 — 안 그러면 지금 옮기려는 행을 먼저 지워 잠금이 통째로 사라진다.
    const targets = [...sources].map((p) => to + p.slice(from.length)).filter((p) => !sources.has(p));
    if (targets.length) await c.query(`DELETE FROM shared_folder_acl WHERE path = ANY($1::text[])`, [targets]);
    const upd = await c.query(
      //  오프셋을 JS 에서 세지 않는다 — from.length 는 UTF-16 코드유닛인데 substring 은 **문자** 단위라
      //  이모지가 든 폴더명에서 어긋나 경로가 잘린다. 같은 쪽(PG)에서 세게 한다.
      `UPDATE shared_folder_acl SET path = $1 || substring(path from length($2) + 1) WHERE path = $2 OR path LIKE $3 ESCAPE '\\'`,
      [to, from, like]);
    return upd.rowCount ?? 0;
  });
}
