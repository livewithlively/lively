// 노드 세션 업로드의 **게이트웨이 좌표**(#3787) — 순수 판정.
//
// ── 왜 ──────────────────────────────────────────────────────────────────────
//  터미널 드래그앤드랍은 `PUT /terminal/sessions/:id/file` 로 오고, 노드 세션이면 게이트웨이가 바이트를
//  **전부 손에 쥔 채**(NODE_RELAY_MAX 까지 버퍼) 노드로 넘기고 자기 사본은 안 썼다. 그 결과:
//   · 게이트웨이에 실물이 없다 → 자료함에 안 뜨고 매니페스트에도 없다
//   · 중앙에 닿는 유일한 길이 push 훅 하나뿐 → **하네스가 안 돌면 영영 안 온다**
//  실측(2026-09-14, 원준님): 윈도우 노드에서 크레딧이 떨어져 LLM 이 안 돌던 동안 드롭한 파일이 몇 시간째
//  로컬에만 있었다. 크레딧을 채우고 그 세션이 한 턴을 마쳐 Stop 훅이 돌고 나서야 자료함에 떴다.
//  훅은 전부 하네스가 굴리므로 **하네스가 죽으면 동기화도 같이 죽는다** — 업로드가 그것에 기대면 안 된다.
//
//  업로드는 브라우저 → 게이트웨이 → 노드 방향이라 **게이트웨이가 정본을 쓸 수 있다**(노드에서 «만들어진»
//  파일과 반대다 — 그건 게이트웨이가 못 읽어서 push 훅이 필요하다). 그래서 이 방향만 규약대로 되돌린다:
//  게이트웨이가 먼저 쓰고, 노드 배달은 pull 이 한다.
//
// ── 왜 릴레이를 «같이» 하지 않나 ────────────────────────────────────────────
//  노드 op `fsWrite` 는 mtime 을 못 맞춘다. 양쪽에 쓰면 노드 사본과 서버 사본의 mtime 이 다른데 원장 기준선이
//  없어, 다음 pull 이 «공통 조상 없는 두 판본» 으로 보고 **영구 거짓 충돌**을 만든다. 게이트웨이만 쓰고 pull 이
//  나르면 불변식 *로컬 mtime == 서버 mtime == 기준선* 이 그대로 선다.
//  배달 지연도 없다: 드롭은 경로를 입력창에 꽂기만 하고 사람이 엔터를 친다 → UserPromptSubmit →
//  project-pull-turn 이 **모델이 지시를 보기 전에** 받아둔다(그 훅이 정확히 이 창을 위해 있다).

/** 경로 구분자 무관 정규화 — 노드가 윈도우면 `C:\Users\…\project\3966` 처럼 온다. */
const slash = (p: string): string => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * 세션 작업폴더가 그 프로젝트의 폴더(또는 그 하위)인가 — 맞으면 프로젝트 폴더 기준 **오프셋**을 준다.
 *  · `…/project/3966`        → ""           (드롭 rel 이 그대로 프로젝트 rel)
 *  · `…/project/3966/sub/a`  → "sub/a"      (그만큼 앞에 붙여야 프로젝트 rel)
 *  · 그 밖(개인 폴더 세션·레포 워크트리 밖) → null = **게이트웨이 정본 없음**, 종전대로 릴레이만.
 *  ⚠ 이름 추측이 아니라 좌표 규약이다 — 프로젝트 폴더는 어느 노드에서나 `<공유 루트>/project/<id>` 다
 *   (project-agents-inject 의 refoldAbs 와 **같은 규칙**: 한쪽만 고치면 두 판정이 갈린다).
 */
export function projectOffsetOfSessionDir(dir: string, projectId: number): string | null {
  if (!dir || !Number.isInteger(projectId) || projectId <= 0) return null;
  const s = slash(dir);
  //  legacy-project 도 같은 자리다(#1436 — 옛 폴더 이름). 둘 다 받는다.
  const m = s.match(/\/(?:project|legacy-project)\/(\d+)(?:\/(.+))?$/);
  if (!m || Number(m[1]) !== projectId) return null;
  return m[2] ? m[2] : "";
}

/**
 * 드롭 상대경로(세션 cwd 기준) → 프로젝트 폴더 기준 상대경로. 탈출(`..`)이면 null.
 *  오프셋이 있는 세션(프로젝트 하위 폴더에서 뜬 세션)은 그만큼 앞에 붙는다.
 */
export function projectRelForUpload(offset: string, rel: string): string | null {
  const r = slash(rel).replace(/^\/+/, "");
  if (!r) return null;
  const joined = offset ? `${offset}/${r}` : r;
  if (joined.split("/").some((seg) => seg === "..")) return null;
  return joined;
}
