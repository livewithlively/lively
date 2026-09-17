// ── AGENTS.md 생성 — 프로젝트 digest(자동) + 규칙(사람). 공유 폴더에 쓰며 동기화로 각 PC 에 전달. ──
//  ⚠ 레포 '경로'는 절대 넣지 않는다(머신마다 달라). 여기엔 이름·메타·태스크 인덱스·조회 key + 코드 확보 '방법'(툴)만 —
//   경로는 그 머신에서 lively_local_repo_worktree 가 해석한다(codeWorkSection).
//  호출처: (1) project-routes 의 매니페스트/규칙 엔드포인트, (2) projects-v6 캐퍼빌리티(생성·상태·팀원·레포·카테고리 변경 직후).
//  저장소(store)를 주면 그대로 쓰고, 안 주면 프로젝트 folder 를 해결(없으면 물리 폴더 생성)해 만든 사람 권한으로 연다.
//  ★ #4064 — AGENTS.md·CLAUDE.md 는 **일반 파일과 같은 자리**에 산다(project-storage). 매니지드에선 그 자리가 세션이
//   일하는 멤버 저장소라, 세션이 직접 만든 AGENTS.md·CLAUDE.md 를 만날 수 있다 — 사람이 쓴 내용은 덮지 않는다(readRules·CLAUDE.md 절).
import fsp from "node:fs/promises";
import path from "node:path";
import {
  getProject as getProjectV6, setProjectFolder,
  upsertProjectFolderBinding, SHARED_BINDING_MEMBER,
} from "./project-store.js";
import { createProjectFolder, grantSharedGroupWrite } from "../project/project-fs.js";
import { projectStorage, type ProjectStorage } from "../project/project-storage.js";
import { RULES_MARK, RULES_PLACEHOLDER, pickRules, nextClaudeMd, type RulesSource } from "./agents-md-rules.js";
// 폴더 바인딩의 환경 id — 박스(게이트웨이 호스트)는 'central'(CENTRAL_NODE_ID 와 같은 어휘). 노드 스케줄러를
//  import 하면 registry/WS 체인이 딸려 와 순환 위험이 있어, 이 leaf 에서는 리터럴로 둔다(값은 한 낱말·불변).
const CENTRAL_NODE = "central";

// 프로젝트 마무리(close-out) 루틴 — 모든 프로젝트 공통이라 digest(자동 섹션)에 박는다. 프로젝트 폴더에서만 노출돼
//  '플젝 세션일 때만' 보이고(플젝 밖 0비용), 전역 always 주입의 과주입·미작동(라이브 템플릿 ${rules} 부재)을 피한다.
//  단일출처: 절차·인자는 project-closeout 스킬 본문에만 두고, 여기엔 흐름 한 줄 + 스킬 트리거만 — 드리프트 표면 제거(#334 후속).
//  closeout 은 #878 에서 지식→스킬로 이동(진화전파·발견성 정밀화). done 순간은 프로젝트 세션(=이 AGENTS.md 가 뜨는 그 세션)이라
//  여기서 스킬을 가리키는 게 정확한 타겟 발견 경로다(전역 WIKI 인덱스·벡터회수보다 노이즈 적음).
const CLOSEOUT_SECTION = [
  "## 마무리 (이 프로젝트를 끝낼 때 — done 처리 전후)",
  "본문 보강(원문유지·append) → 산출/필요지식 연결 → 태스크·프로젝트 `done` → 범위 밖 후속은 **사용자에게 물어** 새 프로젝트로.",
  "절차·최신 인자(MCP `list_id`/`follow_up` 등)는 **`project-closeout` 스킬**을 따른다(마무리·done 처리 시 이 스킬을 invoke).",
].join("\n");

// 코드 작업 진입 — 프로젝트 세션은 코드가 체크아웃되지 않은 폴더에서 뜬다(#918: 세션 생성이 워크트리를 만들지 않는다).
//  그래서 '코드를 어떻게 확보하나'를 프로젝트 폴더에서 항상 알려준다. 이게 없으면 에이전트가 공유 base 를 ls 로 더듬거나
//  (#906) base 에서 직접 작업하는 사고로 간다 — 발견을 전역 WIKI 인덱스 제목 한 줄의 운에 맡기지 않는다.
//  repos 미연결 프로젝트도 대상이다: 사용자가 레포를 안 붙였을 뿐 코드가 필요할 수 있다(#918 자신이 그 케이스였다).
//  마커(provisioned)를 1순위로 가리키지 않는다 — 명시적 provision 을 한 프로젝트에만 있고(실측 40% 결손), 워크트리가
//  회수돼도 남아 죽은 경로를 가리킬 수 있다. 툴은 이미 뜬 워크트리를 재사용하므로 그냥 툴이 1순위다.
function codeWorkSection(repos: string[]): string[] {
  if (!repos.length) {
    return ["## 코드 작업",
      "이 프로젝트엔 연결된 레포가 없다. 코드가 필요하면 `lively_local_repo_list` 로 이 머신에서 뜰 수 있는 레포 후보를 확인하고, "
      + "`lively_local_repo_worktree {repo}` 로 워크트리를 떠서 그 위에서 작업한다(공유 base 직접작업 금지). 어느 레포인지 애매하면 사용자에게 확인한다.",
      "그 레포가 이 프로젝트의 코드가 맞으면 **`project_set_repos_v6 {id, repos}` 로 연결해 둔다** — 다음 세션이 후보를 다시 고르지 않고 "
      + "여기서 이름을 바로 본다(연결은 전체 교체이므로 기존 목록에 더해서 넘긴다).", ""];
  }
  return ["## 관련 레포 (코드 작업)", ...repos.map((r) => `- ${r}`), "",
    "코드를 만져야 하면 `lively_local_repo_worktree {repo}` 로 **워크트리를 떠서 그 위에서** 작업한다 — cwd 에 격리 브랜치로 몇 초 만에 생긴다.",
    "이 세션이 코드 없는 폴더에서 떠 있는 건 정상이다(워크트리는 세션 생성이 아니라 그 툴이 만든다). 이미 뜬 워크트리가 있으면 툴이 그대로 재사용한다.",
    "공유 base 레포(여러 워크트리의 pristine 부모 — 남의 작업이 체크아웃돼 있을 수 있다)에서 직접 작업·커밋·빌드 금지.", ""];
}

function buildProjectDigest(p: any): string {
  const L: string[] = [];
  L.push(`# ${p.name}   (프로젝트 #${p.id})`, "");
  L.push("> 이 파일은 lively 가 자동 생성합니다(아래 '규칙'만 사람이 편집). 상세·최신은 lively MCP 로 조회하세요.", "");
  L.push("## 메타데이터");
  L.push(`- 상태: ${p.status}${p.due_date ? ` · 기한: ${p.due_date}` : ""}`);
  if (Array.isArray(p.members) && p.members.length) L.push(`- 멤버: ${p.members.map((m: any) => m.display_name || m.member_id).join(", ")}`);
  if (Array.isArray(p.categories) && p.categories.length) L.push(`- 카테고리(도메인): ${p.categories.map((c: any) => c.name || c.key).join(", ")}`);
  L.push(`- 전체/최신 조회: \`project_get_v6(${p.id})\` (lively MCP)`, "");
  L.push(...codeWorkSection(Array.isArray(p.repos) ? p.repos : []));
  if (p.description) L.push("## 개요", String(p.description), "");
  // 필요지식(required) — 이 프로젝트를 진행하기 전에 알아야 할 배경. AI 가 처음부터 무엇을 알아야 하는지 보고 시작한다(전문 X·드리프트 최소 → knowledge_get 포인터). 산출(produced)은 결과물이라 넣지 않는다.
  const reqK = ((p.knowledge && p.knowledge.required) || []) as any[];
  if (reqK.length) {
    L.push("## 필요지식 (이 프로젝트를 진행하기 전에 알아야 할 것 — 전문은 knowledge_get)");
    for (const k of reqK) L.push(`- ${k.title || k.name} \`knowledge_get('${k.name}')\``);
    L.push("");
  }
  if (Array.isArray(p.tasks) && p.tasks.length) {
    L.push("## 태스크 인덱스");
    for (const t of p.tasks) {
      L.push(`- [#${t.id}] ${t.name}${t.status ? ` (${t.status})` : ""}`);
      for (const s of (t.subtasks || [])) L.push(`  - [#${s.id}] ${s.name}${s.status ? ` (${s.status})` : ""}`);
    }
    L.push("- 각 항목 상세: `project_get_v6` 의 tasks 로 id 조회.", "");
  }
  L.push(CLOSEOUT_SECTION, "");
  return L.join("\n").trim();
}

/**
 * 규칙(사람 편집 영역)과 그 출처 — 판정은 agents-md-rules.pickRules 한 자리.
 *  저장소를 옮기는 중이면(멤버 저장소에 AGENTS.md 가 아직 없다) 게이트웨이 쪽 원본도 재료로 준다 — 이관이 그 파일에
 *  닿기 전이면 사람 규칙은 거기 있다. 원본은 옮겨지는 순간 그 자리에서 빠지므로 지운 규칙이 되살아나지는 않는다.
 */
async function readRules(store: ProjectStorage): Promise<{ rules: string; from: RulesSource }> {
  const agents = await store.readText(path.join(store.base, "AGENTS.md"));
  const original = agents == null && store.localBase !== store.base
    ? await fsp.readFile(path.join(store.localBase, "AGENTS.md"), "utf8").catch(() => null)
    : null;
  const claude = await store.readText(path.join(store.base, "CLAUDE.md"));
  return pickRules({ agents, original, claude });
}

// 규칙(사람 편집 영역)만 읽는다 — 세부설정 규칙 블록 로드용.
export async function readProjectAgentsMd(store: ProjectStorage): Promise<{ rules: string }> {
  return { rules: (await readRules(store)).rules };
}

// ── .lively/project.json 마커 — 호스트 로컬(공유 매니페스트가 '.' 시작 전부 제외 → 동기화 안 됨, 각 호스트가 직접 생성). ──
//  로컬 PC 는 work.mjs 가 같은 마커를 ~/lively/projects/<id> 에 쓴다 — 박스는 프로젝트 폴더(workspace/project/<id>)에 여기서 쓴다.
//  박스는 비개발 경작업 전용이라 레포 워크트리를 provision 하지 않음(=로컬 러너 영역) → repos 는 이름만 기록. project_id 가 핵심.
//  멱등·비파괴: project_id/repos 가 바뀔 때만 다시 쓰고, work.mjs 등이 채운 다른 키(last_pull 등)는 보존(머지).
//  sync(#905 P1-②) — pull 훅의 '쓰기 자격' 게이트. 박스 프로젝트 폴더(workspace/project/<id>)는 공유폴더
//   그 자체(라이블리 소유)라 pull 이 기본. 기존 값이 있으면 보존한다(사람이 끈 걸 되살리지 않는다).
//   ⚠ 사용자 자기 폴더에 마커를 심는 `lively init`(C2a)의 기본값은 반대로 "none" — 혼동 금지(#905 §2).
async function writeProjectMarker(base: string, p: any): Promise<void> {
  const dir = path.join(base, ".lively");
  const file = path.join(dir, "project.json");
  let prev: Record<string, unknown> = {};
  let prevRaw = "";
  try { prevRaw = await fsp.readFile(file, "utf8"); prev = JSON.parse(prevRaw); } catch { /* 신규 또는 파손 → 새로 씀 */ }
  const repos = Array.isArray(p.repos) ? p.repos : [];
  const next = { ...prev, project_id: p.id, sync: prev.sync ?? "pull", repos };
  const serialized = JSON.stringify(next, null, 2) + "\n";
  if (serialized === prevRaw) return; // write-if-changed
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(file, serialized);
  // 격리 세션(box_)이 마커를 갱신(last_pull)·.lively 에 원장(sync-ledger)을 만들 수 있게 그룹 rw(#1246).
  await grantSharedGroupWrite(file, base, "file");
}

// 프로젝트 folder(없으면 물리 폴더 생성)를 해결. 생성 직후엔 folder 가 비어 있으므로 여기서 만든다.
async function resolveProjectFolder(p: any): Promise<string> {
  let folder = p.folder;
  if (!folder) {
    folder = await createProjectFolder(p.id);
    // 채널은 감사 제약(mcp/web/connector/cli/migration/unknown)을 따른다 — index.ts 의 ensureFolder 와 동일하게 web.
    await setProjectFolder(p.id, folder, { source: "web" });
  }
  return folder;
}

/** 요청 밖 호출(캐퍼빌리티의 재생성)이 쓰는 저장소 — 만든 사람 권한. 만든 사람이 없으면 저장소가 신원을 요구할 수 있다 */
export async function agentsMdStorage(p: { id: number; folder?: string | null; created_by?: string | null }): Promise<ProjectStorage> {
  const folder = await resolveProjectFolder(p);
  return projectStorage(folder, p.created_by ? { memberId: String(p.created_by) } : null);
}

// AGENTS.md(+ CLAUDE.md @import) 를 현재 프로젝트 상태로 재생성(write-if-changed). 비치명적으로 호출(.catch).
//  store 를 주면 그대로(엔드포인트는 요청자 권한으로 이미 연 저장소 보유), 안 주면 만든 사람 권한으로 연다(캐퍼빌리티 호출용).
export async function ensureAgentsMd(projectId: number, store?: ProjectStorage, manualOverride?: string): Promise<void> {
  const p = await getProjectV6(projectId).catch(() => null);
  if (!p) return;
  const st = store ?? (await agentsMdStorage(p));
  const found = manualOverride !== undefined ? { rules: manualOverride, from: "none" as RulesSource } : await readRules(st);
  const content = `${buildProjectDigest(p)}\n\n${RULES_MARK}\n## 규칙\n${(found.rules && found.rules.trim()) || RULES_PLACEHOLDER}\n`;
  await st.mkdirp(st.base);
  const file = path.join(st.base, "AGENTS.md");
  const prev = (await st.readText(file)) ?? "";
  if (content !== prev) await st.writeText(file, content);
  // 게이트웨이가 만든 파일(644)은 box_ 격리 세션이 못 고친다 — 그룹 rw 로(매 호출 재적용 = 구 파일도 지나가며 치유, #1246).
  await st.grantGroup(file, "file");
  // Claude Code 는 CLAUDE.md 를 로드하므로 한 줄 import 로 AGENTS.md 를 끌어온다(Codex 는 AGENTS.md 네이티브).
  //  ★ 사람이 쓴 CLAUDE.md 는 덮지 않는다 — import 줄만 맨 위에 보탠다. import 한 줄로 정리하는 건 ①없을 때
  //   ②규칙을 방금 CLAUDE.md 에서 옮겨 왔을 때(내용은 이제 AGENTS.md 규칙에 있다) ③구 자동블록 형식일 때뿐이다.
  const claude = path.join(st.base, "CLAUDE.md");
  const nextC = nextClaudeMd(await st.readText(claude), found.from);
  if (nextC != null) await st.writeText(claude, nextC);
  await st.grantGroup(claude, "file");
  // .lively/project.json 마커도 같이 보장 — **게이트웨이 쪽 자리**에 둔다(호스트 로컬 마커). 멤버 저장소에 심으면
  //  그 폴더에서 도는 중앙 세션의 동기화 훅이 마커를 보고 자기 폴더를 자기에게 pull 한다(#4064).
  await writeProjectMarker(st.localBase, p);
  // 폴더 바인딩 등록(#905 P1-①) — "이 프로젝트가 어느 환경 어디에 사는가" 인벤토리에 박스 폴더를 올린다.
  //  (project.folder 는 경로해석용 정본 컬럼으로 그대로 두고, 이 테이블은 멤버 노트북·워커노드까지 아우르는
  //   N:M 인벤토리다 — 설계가 세는 폴더 3개 중 하나가 이 박스 폴더다.) 실패해도 비치명(호출부가 .catch).
  await upsertProjectFolderBinding({
    projectId: p.id, memberId: SHARED_BINDING_MEMBER, nodeId: CENTRAL_NODE,
    absPath: st.localBase, sync: "pull",
  }).catch(() => { /* 인벤토리 실패가 AGENTS.md 생성을 막지 않는다 */ });
}
