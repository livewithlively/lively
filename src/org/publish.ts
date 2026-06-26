// 발행 인터페이스 — DB(위키) → kit generator 의 buildKitBundle 을 **in-process** 호출 → 설치 번들(부트스트랩만, org-콘텐츠 0).
// 2026-06-24 컷오버: materialize(DB→파일트리)·subprocess generator·콘텐츠 strip 를 전부 제거했다 —
//  콘텐츠는 설치-시 라이브 fetch + 세션 훅 write-back 캐시로 전달(번들 베이킹 폐지). 따라서 발행물엔 굽지 않으므로
//  generator 의 **순수 buildKitBundle**(process.exit 안 함)을 import 해 부트스트랩만 조립한다. buildStaticContext 는 라이브 폴백용으로만 잔존.
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { materializeOrgContent } from "./materialize.js";
import { getSection } from "./store.js";
import { DEFAULT_WRITEBACK_NOTICE } from "./hook-defaults.js";
import { redactString } from "./redact.js";
import { logger } from "../log.js";

// generator 의 buildStaticContext 를 in-process import — DB 진실원천을 stale 파일기반 lively-org 대신
//  materialize 한 DB-org 트리에 적용한다(P-V3-5 Part A: 정적 폴백 context.md 도 DB 단일소스).
//  buildStaticContext 는 순수 함수(process.exit 안 함 — generate 의 필수파일 가드는 materialize 가 항상 채움)라
//  in-process import 가 안전하다(runPublish 의 subprocess 격리 이유는 잘못된 입력 시 process.exit(1) 인데,
//  materialize 산출물은 항상 org/org-defaults.md 를 보장하므로 그 경로를 타지 않는다).
async function loadBuildStaticContext(): Promise<
  (orgRoot: string, orgName?: string) => { context: string; orgName: string }
> {
  const genUrl = process.env.WORKFLOW_STD_DIR
    ? pathToFileURL(join(process.env.WORKFLOW_STD_DIR, "generator", "build-context.mjs")).href
    : new URL("../../kit/generator/build-context.mjs", import.meta.url).href;
  const mod = await import(genUrl);
  if (typeof mod.buildStaticContext !== "function") {
    throw new Error("generator 에 buildStaticContext export 가 없습니다 (workflow-std 버전 불일치)");
  }
  return mod.buildStaticContext;
}

// generator 의 buildKitBundle(콘텐츠 없는 키트 조립) in-process import — buildStaticContext 와 동일 패턴(순수 함수).
async function loadBuildKitBundle(): Promise<
  (target: string, opts: { orgName?: string; orgLabel?: string; harness?: string }) => { copied: string[] }
> {
  const genUrl = process.env.WORKFLOW_STD_DIR
    ? pathToFileURL(join(process.env.WORKFLOW_STD_DIR, "generator", "build-context.mjs")).href
    : new URL("../../kit/generator/build-context.mjs", import.meta.url).href;
  const mod = await import(genUrl);
  if (typeof mod.buildKitBundle !== "function") {
    throw new Error("generator 에 buildKitBundle export 가 없습니다 (kit 버전 불일치)");
  }
  return mod.buildKitBundle;
}

export interface PublishResult {
  ok: boolean;
  artifactBytes: number;
  log: string;
  warning?: string;
}

// DB(위키) → kit generator 의 buildKitBundle in-process → <outDir> 에 부트스트랩 번들 조립(org-콘텐츠 0).
//  materialize·subprocess·strip 불요(콘텐츠를 애초에 안 만듦). org 표시명만 프로필에서 읽어 넘긴다.
export async function runPublish(outDir: string, harness = "claude"): Promise<PublishResult> {
  if (!process.env.ITEMS_DATABASE_URL) throw new Error("ITEMS_DATABASE_URL 미설정 — 조직 컨텍스트 발행 불가");
  const { getOrgProfile } = await import("./store.js");
  const p = await getOrgProfile();
  const orgName = p.display_name?.trim() || p.name?.trim() || "조직";
  const orgLabel = (p.name && p.name.trim()) || "org";
  const buildKitBundle = await loadBuildKitBundle();
  const { copied } = buildKitBundle(outDir, { orgName, orgLabel, harness });
  return { ok: true, artifactBytes: 0, log: `kit-bundle in-process (${copied.length} files)`, warning: undefined };
}

// 오프라인 폴백 정적 context.md(DB 진실원천) — materialize(DB) → buildStaticContext.
//  진실원천 이원화 해소: 정적(이 함수)·라이브(previewMemberContext)·웹·발행 모두 DB buildKnowledgeIndex 단일소스.
//  어댑터/설치기가 게이트웨이 가용 시 이걸 받아 ~/.lively/context.md 에 박고(DB-인덱스), 다운 시 파일기반 폴백.
//  멱등: 같은 DB 상태 → 같은 출력(buildKnowledgeIndex 결정적). 재발행 시 인덱스 중복 0.
export async function materializeStaticContext(): Promise<{ context: string; orgName: string }> {
  if (!process.env.ITEMS_DATABASE_URL) throw new Error("ITEMS_DATABASE_URL 미설정 — 정적 컨텍스트 발행 불가");
  const mat = await materializeOrgContent();
  try {
    const buildStaticContext = await loadBuildStaticContext();
    const { context, orgName } = buildStaticContext(mat.dir, mat.orgName);
    return { context, orgName };
  } finally {
    await mat.cleanup().catch((err) => logger.warn({ err }, "materialize 임시디렉토리 정리 실패"));
  }
}

// 설치 번들 — 발행 아티팩트를 tar.gz 로 묶어 바이트를 반환(/install 엔드포인트가 스트림). 임시물은 정리.
export async function buildInstallBundle(harness = "claude"): Promise<{ buffer: Buffer; orgName: string }> {
  const stage = await mkdtemp(join(tmpdir(), "lively-pub-"));
  try {
    const res = await runPublish(stage, harness);
    if (!res.ok) throw new Error("발행 아티팩트 생성 실패");
    // 런타임 설정/ MCP 목록을 번들 .lively/ 에 주입(DB → 설치기가 ~/.lively 로 복사).
    await writeRuntimeBundle(stage);
    // buildKitBundle 가 org-콘텐츠를 애초에 안 만든다(부트스트랩만) — strip 불요. .lively/ 만 DB 에서 주입(위 writeRuntimeBundle).
    // tar -czf - -C <stage> .  → stdout 로 받기.
    const buf = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn("tar", ["-czf", "-", "-C", stage, "."]);
      const chunks: Buffer[] = [];
      let err = "";
      child.stdout.on("data", (d) => chunks.push(d as Buffer));
      child.stderr.on("data", (d) => { err += d.toString(); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar 실패: ${err}`)));
    });
    // orgName 재도출(materialize 가 내부 정리됨) — 프로필에서 직접.
    const { getOrgProfile } = await import("./store.js");
    const p = await getOrgProfile();
    return { buffer: buf, orgName: p.display_name?.trim() || p.name?.trim() || "조직" };
  } finally {
    await rm(stage, { recursive: true, force: true }).catch((err) => logger.warn({ err }, "발행 stage 정리 실패"));
  }
}

// 런타임 번들 주입 — DB(org_runtime_config·org_mcp_server)를 발행 묶음 .lively/ 에 굳힌다.
//  설치기(user-install.mjs)가 이걸 ~/.lively/ 로 복사하고, 훅·register-clients 가 런타임에 읽는다.
async function writeRuntimeBundle(stageDir: string): Promise<void> {
  const { getRuntimeConfig, listMcpServers, listAutoApproveTools } = await import("./store.js");
  const dir = join(stageDir, ".lively");
  await mkdir(dir, { recursive: true });
  const cfg = await getRuntimeConfig();
  await writeFile(join(dir, "hooks-config.json"),
    JSON.stringify({ hooks: cfg.hooks, writeback_notice: cfg.writeback_notice || DEFAULT_WRITEBACK_NOTICE,
      write_tools: cfg.write_tools?.length ? cfg.write_tools : undefined }, null, 2) + "\n");
  const wrHeader = "# lively work-root 레지스트리 — 줄당 절대경로 prefix. 이 아래에서 켠 세션은 writeback 게이트가 작동.\n# 어드민 런타임 설정에서 중앙 관리. env LIVELY_WORK_ROOTS 로도 augment.";
  await writeFile(join(dir, "work-roots"), [wrHeader, ...cfg.work_roots].join("\n") + "\n");
  const mcps = (await listMcpServers())
    .filter((s) => s.enabled && (s.transport === "stdio" ? !!s.command : !!s.url)) // 불완전 서버(http인데 url없음 등) 제외
    .map((s) => ({ name: s.name, transport: s.transport, url: s.url, command: s.command, auth_env: s.auth_env }));
  await writeFile(join(dir, "mcp-servers.json"), JSON.stringify({ servers: mcps }, null, 2) + "\n");
  // auto-approve — 멤버 설치기가 settings.json 의 무확인 실행 허용목록(permissions.allow)에 머지.
  //  MCP 툴 이름은 하네스에서 'mcp__lively__<tool>' 로 노출되므로 그 형태로 굳힌다(lively=등록 라벨).
  const autoApprove = (await listAutoApproveTools()).map((t) => `mcp__lively__${t.name}`);
  await writeFile(join(dir, "auto-approve.json"), JSON.stringify({ allow: autoApprove }, null, 2) + "\n");
}

// 멤버 컨텍스트 미리보기 — 구성원의 AI 가 매 세션 실제로 읽는 정적 컨텍스트(WYSIWYG).
// generate() 의 섹션 조립(build-context.mjs:110-118)을 그대로 미러: managed-policy → org-defaults → memory index.
// subprocess 없이 가볍게(읽기 미리보기) — frontmatter/HTML 주석은 제거(generate 의 strip 과 동일).
const strip = (md: string): string =>
  md.replace(/^<!--[\s\S]*?-->\s*/, "").replace(/^---[\s\S]*?---\s*/, "").trim();

// 팀 층(team-scoped) — 보는 멤버의 소속 팀 + 소유/이해관계 카테고리를 요약하는 '우리 팀' 프리앰블 + mine id 집합.
//  ★오너십 ≠ 접근권한: 우선순위 신호일 뿐 — 다른 팀 맥락도 아래 인덱스에서 전원 열람·검색('분절 없는 집중').
//  memberId 없거나(정적/멤버무관) 팀 미소속이면 block="" → 출력 불변(정적↔라이브 일치 불변식 유지). fail-open(조회 실패=빈 블록).
async function buildTeamBlock(memberId: string): Promise<{ block: string; mineIds: Set<number> }> {
  try {
    const { memberTeams, memberCategories } = await import("../v6/team-store.js");
    const [teams, cats] = await Promise.all([memberTeams(memberId), memberCategories(memberId)]);
    const mineIds = new Set(cats.map((c) => Number(c.category_id)));
    if (!teams.length) return { block: "", mineIds };
    const fmt = (c: { name: string | null; key: string }): string => (c.name?.trim() || c.key);
    const owned = cats.filter((c) => c.owner);
    const stake = cats.filter((c) => !c.owner);
    const lines = ["## 우리 팀", `- **팀:** ${teams.map((t) => t.name?.trim() || t.key).join(", ")}`];
    if (owned.length) lines.push(`- **소유 카테고리:** ${owned.map(fmt).join(" · ")}`);
    if (stake.length) lines.push(`- **이해관계 카테고리:** ${stake.map(fmt).join(" · ")}`);
    lines.push("> 위 카테고리(★)의 지식·프로젝트·도메인맵을 먼저 본다 — 오너십은 우선순위일 뿐 접근제한이 아니다. 아래 인덱스의 다른 팀 맥락도 전원 열람·검색 가능('분절 없는 집중').");
    return { block: lines.join("\n"), mineIds };
  } catch {
    return { block: "", mineIds: new Set() };
  }
}

export async function previewMemberContext(orgName: string, memberId?: string): Promise<string> {
  const header = `# ${orgName} 컨텍스트`;
  const policy = await getSection("managed-policy");
  const defaults = await getSection("org-defaults");
  // 팀 층 — memberId(=org_member.id, bearer 토큰 principal) 있을 때만. 훅이 멤버 토큰으로 fetch 하므로 게이트웨이가 신원을 안다.
  const team = memberId ? await buildTeamBlock(memberId) : { block: "", mineIds: new Set<number>() };
  const { listKnowledge } = await import("../v6/knowledge-store.js");
  // 실제 발행물(MEMORY.md)과 **동일** 인덱스여야 WYSIWYG 가 안 깨진다 — materialize 의 buildKnowledgeIndex 를 그대로
  //  재사용(v6: injection=always 전문 + 카테고리 지도 + 쓰기 가이드 단일 소스). 따로 만들면 미리보기↔발행물 불일치.
  const { buildKnowledgeIndex, categoryMapForIndex, loadGuideTemplate, wikiCategoryMap } = await import("./materialize.js");
  const knowledge = await listKnowledge({ lifecycle: "active", limit: 500 });
  // 카테고리 지도는 라이브 조회(domainmap+items 조인, non-stale) — materialize 와 동일 소스라 미리보기↔발행물 일치 유지.
  //  team.mineIds 주면 우리 팀 카테고리를 공간 내 상단 정렬+★(없으면 출력 불변).
  const categoryMap = await categoryMapForIndex(team.mineIds.size ? team.mineIds : undefined);
  // 컨텍스트 온톨로지 가이드 템플릿도 DB 섹션에서 로드 — materialize(발행물)와 동일 소스(편집값 우선·비면 기본값).
  const guide = await loadGuideTemplate();
  const memIndex = (knowledge.length || categoryMap.length) ? buildKnowledgeIndex(knowledge, categoryMap, guide, await wikiCategoryMap()).trim() : "";
  const sections = [
    header,
    policy?.body_md?.trim() ? strip(policy.body_md) : "",
    defaults?.body_md?.trim() ? strip(defaults.body_md) : "",
    team.block,
    memIndex,
  ];
  // H1-b 시크릿 출력게이트(v3 P-V3-1): 이 미리보기는 구성원 AI 가 매 세션 실제로 읽는 항상-주입 컨텍스트(=훅 fetchOrgContext
  //  의 live 소스)다. memIndex 는 buildKnowledgeIndex 가 이미 마스킹하나, policy/defaults 는 06-16 write-gate 이전
  //  레거시 본문이 평문 시크릿을 품을 수 있으므로 조립 후 한 번 더 redactString 으로 마스킹한다(서빙 경로 = throw 금지,
  //  fail-open 보존 — 마스킹만). 쓰기경로 hard-block(assertNoHardSecrets)과 이중 안전망.
  return redactString(sections.filter(Boolean).join("\n\n")) + "\n";
}
