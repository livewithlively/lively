// 세션 → «이 노드에서의 프로젝트 폴더» 판정의 순수 부분(#4135, 2026-09-25 실측).
//
//  ★ 배경. 자료 동기화 훅(project-push·pull)은 `project-context?node=<LIVELY_NODE_ID>` 로 폴더·동기화 모드를 묻는데,
//   노드에서 뜬 세션의 pane 엔 LIVELY_NODE_ID 가 **없다**(노드 에이전트 프로세스에만 있다). node 가 빠지면 서버가
//   folder·sync 를 안 돌려줘 훅이 조용히 아무것도 안 했다 — «세션이 만든 파일이 자료 칸에 안 뜬다» 의 두 번째 원인
//   (첫째는 세션 토큰 부재 #1066). 게이트웨이는 세션 행(org_session_state.node_id)으로 그 세션의 노드를 **이미 안다** —
//   호출자가 안 밝히면 행에서 읽는다. pane env 에 싣는 길은 격리 세션 호스트의 sudoers env_keep 까지 건드려야 해서 뒤로.
//  ★ 둘째. 세션 행은 그 세션이 **어느 폴더에서 도는지**(dir · root_key · subpath)도 안다. 세션이 공유 루트의
//   프로젝트 폴더(subpath = project.folder)에서 돌면 그 dir 이 곧 이 노드의 프로젝트 폴더다 — 훅이 제 env
//   (TERMINAL_ROOT_SHARED)로 슬롯을 다시 조립할 필요가 없다(옛 루트가 env 에 남은 세션은 엉뚱한 폴더를 봤다).
//   ⚠ 이 값은 응답의 **별도 필드(session_dir)** 로 나간다. `folder_abs_path` 는 사람이 `lively init` 으로 명시한
//    바인딩만 싣는 약속이고, 훅은 그 유무로 «라이블리 소유 슬롯인가(없으면 만들어도 되나)» 를 가른다 — 행에서 읽은
//    dir 을 거기 섞으면 슬롯이 사람 폴더로 오인돼 폴더가 없을 때 만들지 않는다(리뷰 지적, 2026-09-25).

export interface SessionRowLike {
  node_id?: string | null;
  dir?: string | null;
  root_key?: string | null;
  subpath?: string | null;
}

const NODE_ID_MAX = 128;

/** 문맥 조회가 쓸 노드 id — 호출자가 밝힌 값(다듬어 128자)이 먼저, 없으면 세션 행의 node_id, 그것도 없으면 ''(중앙). */
export function contextNodeId(raw: unknown, row: SessionRowLike | null | undefined): string {
  const given = String(raw ?? "").trim().slice(0, NODE_ID_MAX);
  if (given) return given;
  return String(row?.node_id ?? "").trim().slice(0, NODE_ID_MAX);
}

/** 세션이 **그 프로젝트의 공유 폴더에서 돈다** 면 그 절대경로(행의 dir), 아니면 null(슬롯 조립은 훅 몫).
 *  공유 루트(root_key=shared) 아래 subpath 가 project.folder 와 정확히 같을 때만 — 하위 워크트리·다른 프로젝트·
 *  개인 폴더에서 도는 세션의 dir 을 프로젝트 폴더로 우기지 않는다. */
export function sessionDirFromRow(folder: string, row: SessionRowLike | null | undefined): string | null {
  const f = String(folder ?? "").trim();
  if (!f || !row) return null;
  const dir = String(row.dir ?? "").trim();
  if (!dir) return null;
  if (String(row.root_key ?? "") !== "shared") return null;
  if (String(row.subpath ?? "").trim() !== f) return null;
  return dir;
}

/** 폴더·동기화 모드를 **답할 것인가** — 노드를 알거나(호출자·행), 행이 폴더를 알면 답한다. 둘 다 모르면 종전처럼 침묵(중앙 세션).
 *  세션 호스트(sesshost)의 세션은 행에 node_id 가 없지만 dir 은 안다 — 그 훅도 이 답이 있어야 자료를 올린다(2026-09-25 실측:
 *  `/work/shared/project/4135` 행의 node_id 가 비어 있었다). */
export function answersFolder(nodeId: string, sessionDir: string | null): boolean {
  return !!nodeId || !!sessionDir;
}
