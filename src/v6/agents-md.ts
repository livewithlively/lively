// ── AGENTS.md 생성 — 프로젝트 digest(자동) + 규칙(사람). 공유 폴더에 쓰며 동기화로 각 PC 에 전달. ──
//  ⚠ 레포 '경로'는 절대 넣지 않는다(머신마다 달라 — 로컬 경로는 .lively/project.json). 여기엔 이름·메타·태스크 인덱스·조회 key 만.
//  호출처: (1) project-routes 의 매니페스트/규칙 엔드포인트, (2) projects-v6 캐퍼빌리티(생성·상태·팀원·레포·카테고리 변경 직후).
//  base 를 주면 그대로 쓰고, 안 주면 프로젝트 folder 를 해결(없으면 물리 폴더 생성)해서 쓴다 — 생성 직후에도 동작.
import fsp from "node:fs/promises";
import path from "node:path";
import { getProject as getProjectV6, setProjectFolder } from "./project-store.js";
import { projectAbsPath, createProjectFolder } from "../project-fs.js";

const RULES_MARK = "<!-- LIVELY:RULES — 아래는 사람이 작성·편집 (digest 는 자동 갱신, 규칙은 보존) -->";
// 규칙이 비었을 때 '## 규칙' 본문 자리표시 — HTML 주석이라 사람이 파일을 열면 힌트로 보이되 AI 에겐 지시문으로
//  읽히지 않는다(과거엔 안내 문장을 그대로 써넣어 AI 컨텍스트를 오염시켰다 — #246). 규칙을 저장하면 사라진다.
const RULES_PLACEHOLDER = "<!-- (아직 작성된 규칙이 없습니다) 이 프로젝트에서 AI가 지켰으면 하는 규칙을 적으세요 — 웹: 프로젝트 ▸ 세부 설정 ▸ 규칙 -->";
// 구(舊) 기본 템플릿 문장 — 디스크의 기존 AGENTS.md 에 본문으로 박혀 있을 수 있어, 읽을 때 '빈 규칙'으로 이관 처리한다.
const LEGACY_DEFAULT_RULES = "여기에 이 프로젝트에서 AI가 지켰으면 하는 걸 적으세요. (예: 새로 만들기 전에 비슷한 게 있는지 먼저 찾는다 / 큰 변경·삭제는 먼저 물어본다)";

// 프로젝트 마무리(close-out) 루틴 — 모든 프로젝트 공통이라 digest(자동 섹션)에 박는다. 프로젝트 폴더에서만 노출돼
//  '플젝 세션일 때만' 보이고(플젝 밖 0비용), 전역 always 주입의 과주입·미작동(라이브 템플릿 ${rules} 부재)을 피한다.
//  간결판(5단계)만 인라인하고 상세·근거는 WIKI 권위문서로 둔다(knowledge_get 포인터) — 드리프트 최소.
const CLOSEOUT_SECTION = [
  "## 마무리 (이 프로젝트를 끝낼 때 — done 처리 전후)",
  "1. 본문 보강: `project_update_v6` 로 결과·근본원인·해법·반영(커밋/머지) 요약을 개요에 덧붙인다(원문 유지·append).",
  "2. 산출지식: 아직 안 쓴 산출물을 `knowledge_save`(전문) 후 `project_link_knowledge_v6(produced)` 로 연결, 배경지식은 `required`.",
  "3. 태스크 상태: 끝난 task/subtask 를 `task_set_status_v6(done)`.",
  "4. 프로젝트 상태: `project_set_status_v6(done)`.",
  "5. 후속 과업: 이번 범위 밖 후속은 **사용자에게 물어** 과업화 → 새 `project_create_v6`(이 프로젝트 하위태스크 아님).",
  "상세·근거: `knowledge_get('project-closeout-routine')`.",
].join("\n");

function buildProjectDigest(p: any): string {
  const L: string[] = [];
  L.push(`# ${p.name}   (프로젝트 #${p.id})`, "");
  L.push("> 이 파일은 lively 가 자동 생성합니다(아래 '규칙'만 사람이 편집). 상세·최신은 lively MCP 로 조회하세요.", "");
  L.push("## 메타데이터");
  L.push(`- 상태: ${p.status}${p.due_date ? ` · 기한: ${p.due_date}` : ""}`);
  if (Array.isArray(p.members) && p.members.length) L.push(`- 멤버: ${p.members.map((m: any) => m.display_name || m.member_id).join(", ")}`);
  if (Array.isArray(p.categories) && p.categories.length) L.push(`- 카테고리(도메인): ${p.categories.map((c: any) => c.name || c.key).join(", ")}`);
  L.push(`- 전체/최신 조회: \`project_get_v6(${p.id})\` (lively MCP)`, "");
  if (Array.isArray(p.repos) && p.repos.length) {
    L.push("## 관련 레포", ...p.repos.map((r: string) => `- ${r}`), "- 이 머신의 로컬 경로(클론/워크트리)는 `.lively/project.json` 참조.", "");
  }
  if (p.description) L.push("## 개요", String(p.description), "");
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

function extractRules(content: string): string | null {
  const i = content.indexOf(RULES_MARK);
  if (i < 0) return null;
  const body = content.slice(i + RULES_MARK.length)
    .replace(/^\s*##\s*규칙\s*\n?/, "")
    .replace(/<!--[\s\S]*?-->/g, "")  // 자리표시 주석 제거 → 주석만 있으면 빈 규칙
    .trim();
  return body === LEGACY_DEFAULT_RULES ? "" : body;  // 구 기본 템플릿 문장도 빈 규칙으로 이관
}
// 구 CLAUDE.md 의 사람 규칙(LIVELY:REFS 자동블록 제외) — AGENTS.md 최초 생성 시 1회 이관.
function stripClaudeManaged(content: string): string {
  const s = content.indexOf("<!-- LIVELY:REFS");
  return (s >= 0 ? content.slice(0, s) : content).trim();
}

// 규칙(사람 편집 영역)만 읽는다 — 세부설정 규칙 블록 로드용. AGENTS.md 없으면 구 CLAUDE.md 에서 1회 이관.
export async function readProjectAgentsMd(base: string): Promise<{ rules: string }> {
  let existing = ""; try { existing = await fsp.readFile(path.join(base, "AGENTS.md"), "utf8"); } catch { /* 없음 */ }
  let rules = extractRules(existing);
  if (rules == null) { try { rules = stripClaudeManaged(await fsp.readFile(path.join(base, "CLAUDE.md"), "utf8")); } catch { rules = ""; } }
  return { rules: rules || "" };
}

// ── .lively/project.json 마커 — 호스트 로컬(공유 매니페스트가 '.' 시작 전부 제외 → 동기화 안 됨, 각 호스트가 직접 생성). ──
//  로컬 PC 는 work.mjs 가 같은 마커를 ~/lively/projects/<id> 에 쓴다 — 박스는 프로젝트 폴더(workspace/project/<id>)에 여기서 쓴다.
//  박스는 비개발 경작업 전용이라 레포 워크트리를 provision 하지 않음(=로컬 러너 영역) → repos 는 이름만 기록. project_id 가 핵심.
//  멱등·비파괴: project_id/repos 가 바뀔 때만 다시 쓰고, work.mjs 등이 채운 다른 키(last_pull 등)는 보존(머지).
async function writeProjectMarker(base: string, p: any): Promise<void> {
  const dir = path.join(base, ".lively");
  const file = path.join(dir, "project.json");
  let prev: Record<string, unknown> = {};
  let prevRaw = "";
  try { prevRaw = await fsp.readFile(file, "utf8"); prev = JSON.parse(prevRaw); } catch { /* 신규 또는 파손 → 새로 씀 */ }
  const repos = Array.isArray(p.repos) ? p.repos : [];
  const next = { ...prev, project_id: p.id, repos };
  const serialized = JSON.stringify(next, null, 2) + "\n";
  if (serialized === prevRaw) return; // write-if-changed
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(file, serialized);
}

// 프로젝트 folder(없으면 물리 폴더 생성)를 절대경로로 해결. 생성 직후엔 folder 가 비어 있으므로 여기서 만든다.
async function resolveProjectBase(p: any): Promise<string> {
  let folder = p.folder;
  if (!folder) {
    folder = await createProjectFolder(p.id);
    // 채널은 감사 제약(mcp/web/connector/cli/migration/unknown)을 따른다 — index.ts 의 ensureFolder 와 동일하게 web.
    await setProjectFolder(p.id, folder, { source: "web" });
  }
  return projectAbsPath(folder);
}

// AGENTS.md(+ CLAUDE.md @import) 를 현재 프로젝트 상태로 재생성(write-if-changed). 비치명적으로 호출(.catch).
//  base 를 주면 그대로(엔드포인트는 이미 검증된 base 보유), 안 주면 folder 해결(캐퍼빌리티 호출용).
export async function ensureAgentsMd(projectId: number, base?: string, manualOverride?: string): Promise<void> {
  const p = await getProjectV6(projectId).catch(() => null);
  if (!p) return;
  const resolvedBase = base ?? (await resolveProjectBase(p));
  const manual = manualOverride !== undefined ? manualOverride : (await readProjectAgentsMd(resolvedBase)).rules;
  const content = `${buildProjectDigest(p)}\n\n${RULES_MARK}\n## 규칙\n${(manual && manual.trim()) || RULES_PLACEHOLDER}\n`;
  await fsp.mkdir(resolvedBase, { recursive: true });
  const file = path.join(resolvedBase, "AGENTS.md");
  let prev = ""; try { prev = await fsp.readFile(file, "utf8"); } catch { /* */ }
  if (content !== prev) await fsp.writeFile(file, content);
  // Claude Code 는 CLAUDE.md 를 로드하므로 한 줄 import 로 AGENTS.md 를 끌어온다(Codex 는 AGENTS.md 네이티브).
  const claude = path.join(resolvedBase, "CLAUDE.md");
  let prevC = ""; try { prevC = await fsp.readFile(claude, "utf8"); } catch { /* */ }
  if (prevC.trim() !== "@AGENTS.md") await fsp.writeFile(claude, "@AGENTS.md\n");
  // .lively/project.json 마커도 같이 보장 — 박스 프로젝트 폴더가 로컬 PC(work.mjs)와 동일하게 마커를 갖도록.
  await writeProjectMarker(resolvedBase, p);
}
