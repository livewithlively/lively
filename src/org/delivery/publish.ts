// 발행 인터페이스 — DB(위키) → kit generator 의 buildKitBundle 을 **in-process** 호출 → 설치 번들(부트스트랩만, org-콘텐츠 0).
// 2026-06-24 컷오버: materialize(DB→파일트리)·subprocess generator·콘텐츠 strip 를 전부 제거했다 —
//  콘텐츠는 설치-시 라이브 fetch + 세션 훅 write-back 캐시로 전달(번들 베이킹 폐지). 따라서 발행물엔 굽지 않으므로
//  generator 의 **순수 buildKitBundle**(process.exit 안 함)을 import 해 부트스트랩만 조립한다. buildStaticContext 는 라이브 폴백용으로만 잔존.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { materializeOrgContent } from "./knowledge-index.js";
import { toClientBundleServers } from "./mcp-client-bundle.js";
// (#335) getSection 직접호출 폐기 — 섹션은 listSections 로 동적 조립(buildSectionBlocks).
import { DEFAULT_WRITEBACK_NOTICE } from "./hook-defaults.js";
import { redactString } from "../ingest/redact.js";
import { installBundleTarArgs } from "./bundle-tar.js";
// (#1313 R18) 구 동적 import("../store.js") 5건을 정적으로 환원 — store 는 publish/materialize 를 import 하지
//  않아 순환이 없다(scripts/check-imports.mjs 게이트로 확인). 동적 유지 대상은 진짜 지연이 필요한 것들만
//  (generator .mjs 경로 해석·v6 등).
import { getOrgProfile, getRuntimeConfig, listMcpServers, listAutoApproveTools, listSections, getMember, getLivProfile } from "../store.js";
import { logger } from "../../log.js";

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
    : new URL("../../../kit/generator/build-context.mjs", import.meta.url).href;
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
    : new URL("../../../kit/generator/build-context.mjs", import.meta.url).href;
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

// ════════ 키트 버전(#858) — 멤버 자동 업데이트의 비교 키 ════════
//
// 멤버 키트의 네 축 중 콘텐츠·런타임설정·하네스자산은 이미 매 세션 라이브 동기화된다. 남은 한 축
//  — **키트 코드(훅 .mjs)와 배선(settings.json·config.toml)** — 만 재설치가 필요했고, 그게 멤버가 손으로
//  업데이트 한 줄을 돌려야 했던 이유다. 그 축에 버전을 붙여 멤버 훅이 스스로 갱신하게 한다.
//
// 버전 = **설치 번들의 지문**(경로+내용 sha256, 12 hex). "설치가 실제로 반영하는 바이트"가 곧 버전이라
//  릴리스마다 사람이 숫자를 올릴 필요가 없다(빠뜨릴 수도 없다).
// 제외 두 파일:
//  · .lively/kit-version       — 지문 자신을 담는 파일(자기참조)
//  · .lively/hooks-config.json — session-preload 가 매 세션 라이브 동기화 → 훅 on/off 토글마다 전원
//                                재설치를 유발하는 건 낭비(설치가 반영할 게 없다).
// 나머지 .lively/*(mcp-servers·auto-approve·work-roots)는 **설치 시점에만** 반영되므로 포함한다 —
//  덕분에 그 셋의 관리자 변경도 이제 자동 전파된다(종전엔 수동 재설치가 유일한 경로였다).
const VERSION_EXCLUDE = new Set([".lively/kit-version", ".lively/hooks-config.json"]);
const KIT_VERSION_TTL_MS = 60_000; // 멤버 세션마다 조회되는 값 — 60초 캐시(번들 조립은 파일복사+소량 쿼리라 저렴하나 공짜는 아님)
let kitVersionCache: { v: string; at: number } | null = null;
let kitVersionInFlight: Promise<string | null> | null = null; // 게이트웨이 재기동 직후(캐시 콜드) 전 멤버가 동시에 붙어도 조립은 1회

// 스테이지 트리의 상대경로 전량(정렬 전).
async function walkRel(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkRel(abs, base));
    else if (e.isFile()) out.push(relative(base, abs).split(sep).join("/"));
  }
  return out;
}

// 발행물 트리 → 결정적 지문. 경로를 정렬해 넣으므로 같은 입력이면 어느 머신에서든 같은 값.
async function hashStage(stage: string): Promise<string> {
  const rels = (await walkRel(stage, stage)).filter((r) => !VERSION_EXCLUDE.has(r)).sort();
  const h = createHash("sha256");
  for (const rel of rels) {
    h.update(rel); h.update("\0");
    h.update(await readFile(join(stage, rel))); h.update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

// 현재 게이트웨이가 서빙하는 키트 버전. runtime-config 응답에 실려 매 세션 멤버 훅이 로컬 스탬프와 비교한다.
//  실패 시 직전 성공값(없으면 null) — null 이면 멤버 훅이 업데이트를 시도하지 않는다(fail-safe: 모르면 안 건드림).
export async function kitVersion(): Promise<string | null> {
  if (kitVersionCache && Date.now() - kitVersionCache.at < KIT_VERSION_TTL_MS) return kitVersionCache.v;
  if (kitVersionInFlight) return kitVersionInFlight; // 이미 조립 중 — 같이 기다린다(thundering herd 방지)
  kitVersionInFlight = (async () => {
    const stage = await mkdtemp(join(tmpdir(), "lively-kitver-"));
    try {
      await runPublish(stage, "claude");
      await writeRuntimeBundle(stage);
      const v = await hashStage(stage);
      kitVersionCache = { v, at: Date.now() };
      return v;
    } catch (err) {
      logger.warn({ err }, "kit 버전 계산 실패 — 멤버 자동 업데이트는 이번 조회에서 건너뜀");
      return kitVersionCache?.v ?? null; // 직전 성공값(없으면 null → 멤버는 아무것도 안 한다)
    } finally {
      await rm(stage, { recursive: true, force: true }).catch((err) => logger.warn({ err }, "kit 버전 stage 정리 실패"));
      kitVersionInFlight = null;
    }
  })();
  return kitVersionInFlight;
}

// 설치 번들 — 발행 아티팩트를 tar.gz 로 묶어 바이트를 반환(/install 엔드포인트가 스트림). 임시물은 정리.
export async function buildInstallBundle(harness = "claude"): Promise<{ buffer: Buffer; orgName: string }> {
  const stage = await mkdtemp(join(tmpdir(), "lively-pub-"));
  try {
    const res = await runPublish(stage, harness);
    if (!res.ok) throw new Error("발행 아티팩트 생성 실패");
    // 런타임 설정/ MCP 목록을 번들 .lively/ 에 주입(DB → 설치기가 ~/.lively 로 복사).
    await writeRuntimeBundle(stage);
    // 버전 스탬프 — **지금 내보내는 바이트**에서 직접 계산해 번들에 박는다(캐시값이 아니라).
    //  설치기가 이걸 ~/.lively/kit-version 으로 복사 → 멤버 스탬프는 항상 '받은 것'과 일치한다.
    //  (수동 설치·업데이트로도 스탬프가 찍히므로, 손으로 업데이트한 멤버가 곧바로 자동 업데이트를 또 돌지 않는다.)
    const version = await hashStage(stage);
    await writeFile(join(stage, ".lively", "kit-version"), version + "\n");
    kitVersionCache = { v: version, at: Date.now() }; // 방금 조립한 게 곧 최신 — 캐시 갱신
    // buildKitBundle 가 org-콘텐츠를 애초에 안 만든다(부트스트랩만) — strip 불요. .lively/ 만 DB 에서 주입(위 writeRuntimeBundle).
    // tar -czf - -C <stage> .  → stdout 로 받기.
    // ⚠ COPYFILE_DISABLE=1 필수(#858 회귀) — macOS 게이트웨이(우리 dev)에선 stage 파일에 com.apple.provenance
    //  xattr 이 붙고, bsdtar 가 그걸 AppleDouble `._<name>` 파일로 아카이브에 굽는다. 리눅스 멤버가 풀면
    //  `.claude/hooks/._run-custom.mjs` 같은 쓰레기가 생겨 self-update 의 `node --check` 검증이 전체를 막았다.
    //  이 env 가 macOS tar 의 AppleDouble 생성을 끈다(리눅스 GNU tar 는 무시 — 무해, 크로스플랫폼 안전).
    const buf = await new Promise<Buffer>((resolve, reject) => {
      //  ⚠ 인자는 bundle-tar.ts 가 소유한다 — **pax 포맷 강제**(비-ASCII 경로가 윈도우에서 깨지던 #1087).
      const child = spawn("tar", installBundleTarArgs(stage), { env: { ...process.env, COPYFILE_DISABLE: "1" } });
      const chunks: Buffer[] = [];
      let err = "";
      child.stdout.on("data", (d) => chunks.push(d as Buffer));
      child.stderr.on("data", (d) => { err += d.toString(); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar 실패: ${err}`)));
    });
    // orgName 재도출(materialize 가 내부 정리됨) — 프로필에서 직접.
    const p = await getOrgProfile();
    return { buffer: buf, orgName: p.display_name?.trim() || p.name?.trim() || "조직" };
  } finally {
    await rm(stage, { recursive: true, force: true }).catch((err) => logger.warn({ err }, "발행 stage 정리 실패"));
  }
}

// 런타임 번들 주입 — DB(org_runtime_config·org_mcp_server)를 발행 묶음 .lively/ 에 굳힌다.
//  설치기(user-install.mjs)가 이걸 ~/.lively/ 로 복사하고, 훅·register-clients 가 런타임에 읽는다.
async function writeRuntimeBundle(stageDir: string): Promise<void> {
  const dir = join(stageDir, ".lively");
  await mkdir(dir, { recursive: true });
  const cfg = await getRuntimeConfig();
  await writeFile(join(dir, "hooks-config.json"),
    JSON.stringify({ hooks: cfg.hooks, writeback_notice: cfg.writeback_notice || DEFAULT_WRITEBACK_NOTICE,
      write_tools: cfg.write_tools?.length ? cfg.write_tools : undefined,
      // pull_tools(#906): 비면 생략 = 기능 꺼짐(write_tools 의 '비면 기본값'과 반대 — 여기선 생략이 곧 off 다).
      pull_tools: cfg.pull_tools?.length ? cfg.pull_tools : undefined }, null, 2) + "\n");
  // work-roots 헤더 — 단일 출처는 kit/setup/work-roots-header.mjs(WORK_ROOTS_HEADER). 서버는 배포물 경계상 그 .mjs 를
  //  빌드타임 import 하지 않으므로 동일 텍스트를 유지한다(이 사본은 번들 .lively/work-roots 용 — 멤버 최종본은 user-install seed).
  const wrHeader = "# lively work-root 레지스트리 — 줄당 절대경로 prefix. 이 아래에서 켠 세션은 writeback 게이트가 작동.\n# 추가/제거 자유. env LIVELY_WORK_ROOTS 로도 augment 가능.";
  await writeFile(join(dir, "work-roots"), [wrHeader, ...cfg.work_roots].join("\n") + "\n");
  // 클라 직접등록(레인 C) 번들 — mode='proxy' 는 게이트웨이 대리·통제 대상이라 제외(불변식 #894, mcp-client-bundle.ts).
  const mcps = toClientBundleServers(await listMcpServers());
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
    const { memberTeams, memberCategories } = await import("../../v6/team-store.js");
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

// 항상-주입 섹션(injection='always' 행)을 sort 순으로 전부 조립한다(#335 — 섹션이 곧 항상-주입의 전부, 죽은 ${rules}/지식-always 경로 폐기).
//  각 본문에 ${team}/${categories}/${wiki} 치환. 본문 비면 코드 기본값(가이드) 폴백. 어떤 섹션도 ${team} 를 안 쓰면 팀블록을 말미에 폴백 부착.
//  managed-policy(데이터 없음·구 'AI 필수 규칙')는 listSections 에 안 나오므로 자연히 빠진다 — 별도 특수처리 불요.
async function buildSectionBlocks(opts: { team: string; categoryMap: any[]; wikiUnits: any[]; wikiCats: Map<string, string> }): Promise<string> {
  const { substituteBlocks, effectiveSectionTemplate, GUIDE_SECTION_DEFAULTS } = await import("./knowledge-index.js");
  const sections = await listSections(); // ORDER BY sort, name
  // (#1245) 잠금(제품 소유) 섹션 = GUIDE_SECTION_DEFAULTS 키: DB 행 본문을 무시하고 항상 코드 기본값을 렌더한다
  //  (릴리스 = 갱신 — #537/#1242 행 동결 드리프트 차단). org 는 주입 여부(inject_ontology_guide)만 정한다.
  //  조회 실패는 켜짐(fail-open — 가이드는 시스템 사용법의 골격이라 빠지는 쪽이 더 큰 사고).
  let guideOn = true;
  try { guideOn = (await getRuntimeConfig()).inject_ontology_guide; } catch { /* fail-open */ }
  const consumedTeam = { v: false };
  const out: string[] = [];
  for (const s of sections) {
    const tpl = effectiveSectionTemplate(s.section, s.body_md, guideOn);
    const raw = tpl === null ? "" : strip(tpl);
    if (!raw.trim()) continue;
    const filled = substituteBlocks(raw, { team: opts.team, categoryMap: opts.categoryMap, wikiUnits: opts.wikiUnits, wikiCats: opts.wikiCats, consumedTeam });
    if (filled.trim()) out.push(filled);
  }
  // context-ontology-guide(시스템 사용법 골격)는 행이 없어도 렌더(토글 on 일 때) — 신규 조직의 ${categories}/${wiki}/가이드 보존.
  //  org_overview 도 같은 DEFAULT 로 에디터에 패딩하므로 화면=주입 일치. 행 삭제는 이제 무영향(본문은 어차피 코드 소유).
  const GUIDE_KEY = "context-ontology-guide";
  if (guideOn && !sections.some((s) => s.section === GUIDE_KEY)) {
    const def = GUIDE_SECTION_DEFAULTS[GUIDE_KEY];
    if (def) {
      const filled = substituteBlocks(strip(def), { team: opts.team, categoryMap: opts.categoryMap, wikiUnits: opts.wikiUnits, wikiCats: opts.wikiCats, consumedTeam });
      if (filled.trim()) out.push(filled);
    }
  }
  if (opts.team.trim() && !consumedTeam.v) out.push(opts.team.trim()); // ${team} 미사용 시 폴백(마이그레이션으로 org-defaults 에 ${team} 시드 시 in-position)
  return out.join("\n\n");
}

// 개인 층(#846) — 그 멤버만의 규칙(org_member.body_md). me_profile_update 로 저장은 됐지만 **어떤 주입 경로도 읽지
//  않아 죽은 칸**이었다(delivery.ts 주석은 "합성 컨텍스트에 실리는 자유텍스트"라 적어 둔 채 합성 지점이 없었음).
//  그래서 개인 규칙을 올릴 데가 없어 injection='always' 지식(=전원 공유)밖에 선택지가 없었다 — 남의 세션까지 오염.
//  memberId 는 bearer 토큰 principal 이므로 본인 세션에만 실린다(남의 개인 규칙이 새지 않음). 조직·팀 층 **뒤**에 놓아
//  개인 규칙이 조직 규칙을 덮어쓰는 것처럼 읽히지 않게 한다. fail-open — 개인 층 조회가 실패해도 조직 맥락은 나가야 한다.
//  나 층(#1072)도 같은 getMember 한 번으로 함께 만든다 — 이 세션의 **사람 식별자**(2줄). 주입 맥락엔 호칭·개인 규칙만 있고
//  member_id 가 없어서, AI 가 "내가 맡은 프로젝트" 같은 요청에 쓸 조인 키를 몰라 추측하거나 되물어야 했다(#1072 의 계기).
//  짧게 유지한다 — 상세 신원(외부계정·권한·팀·이 세션의 하네스/모드)은 whoami 툴이 SoT 이고 여기선 그 입구만 가리킨다.
// 나 층 렌더(#1072) — 순수 포맷. 멤버 레코드가 없거나(정적 토큰) 이름/이메일이 비어도 **member_id 는 반드시** 나간다:
//  주입의 목적이 "이 세션의 사람이 어느 키로 조인되는가"라서, 이름은 없어도 되지만 키가 없으면 블록이 무의미하다.
export function renderMeBlock(
  memberId: string,
  member: { display_name?: string | null; nickname?: string | null; use_nickname?: boolean | null; email?: string | null } | null,
): string {
  if (!memberId) return ""; // 멤버 무관(정적) 경로 — 출력 불변
  const bits = [`member_id \`${memberId}\``];
  const email = member?.email?.trim();
  if (email) bits.push(email);
  //  ⚠ 이름은 화면과 **같은 규칙**으로 부른다(#1813) — 「이 닉네임을 내 이름으로 사용」을 켠 사람은 닉네임으로.
  //   여기만 display_name 을 쓰면 화면은 «원준», AI 는 «장원준» 으로 부르는 어긋남이 생긴다.
  //   (규칙 원본은 web/lib/person-name.ts — 여기 한 줄은 그 판정의 서버 쪽 적용이다.)
  const shownName = (member?.use_nickname && member?.nickname?.trim()) || member?.display_name?.trim() || memberId;
  return `## 나 (현재 로그인)\n- **${shownName}** · ${bits.join(" · ")}`
    + " — 내가 맡은 프로젝트는 `project_list_v6 {mine:true}`, 상세 신원(외부계정·팀·권한)은 `whoami`.";
}

// 온보딩에서 알게 된 것(#1843) — **리브가 물어서 알아낸 것이 내 AI 에게 그대로 간다.**
//
//  왜 이게 주입 경로에 있어야 하나: 종전엔 리브가 온보딩 대화로 "무슨 일을 어떻게 하는가"를 알아내
//   liv_profile 에 남겼는데, **주입되는 개인 층은 body_md 하나뿐**이라 그 앎이 정작 그 사람의 AI 세션엔
//   한 줄도 가지 않았다. 물어본 보람이 화면 안에서 끝나던 것이다.
//   화면에 [내 규칙에 반영] 버튼을 두는 방식도 검토했지만 폐기했다(원준 2026-08-21: "사람이 굳이 직접
//   저장을 누르지 않고 자연스럽게 그냥 반영되게") — 사람이 한 번 더 눌러야 반영되는 설계는 ⓐ 안 누른
//   사람에겐 여전히 안 가고 ⓑ 누른 순간 body_md 에 **사본**이 생겨, 나중에 리브가 알아낸 것이 갱신돼도
//   그 사본은 낡은 채로 남는다(진실이 둘). 그래서 옮겨 담지 않고 **주입 시점에 합친다**.
//
//  ⚠ body_md 를 **덮지 않는다.** 사람이 직접 적은 것이 먼저 오고, 이건 그 뒤에 붙는 별도 소절이다 —
//   둘이 어긋나면 사람이 적은 쪽이 위에 있어 먼저 읽힌다.
//  ⚠ 고른 값은 선택지 id 로 저장된다(라벨은 답한 순간 사라진다). 있는 그대로 싣는다 — 지어내지 않는다.
const LIV_INJECT_MAX = 12;   // 매 세션 첫머리에 실리는 줄이다 — 질문이 늘어도 컨텍스트가 불어나지 않게 자른다.
export function renderLivOnboarding(liv: { work?: { asis?: string; tobe?: string } | null;
  answers?: Array<{ key?: string; question?: string; choices?: string[]; other?: string }> } | null): string {
  const lines: string[] = [];
  const asis = strip(liv?.work?.asis || "");
  const tobe = strip(liv?.work?.tobe || "");
  if (asis) lines.push(`- 지금 하는 일: ${asis}`);
  if (tobe) lines.push(`- 이렇게 하고 싶어요: ${tobe}`);
  for (const a of liv?.answers ?? []) {
    if (lines.length >= LIV_INJECT_MAX) break;
    const picked = [...(Array.isArray(a?.choices) ? a.choices : []), ...(a?.other ? [a.other] : [])]
      .map((c) => strip(String(c || ""))).filter(Boolean);
    const label = strip(String(a?.question || a?.key || ""));
    if (!picked.length || !label) continue;
    lines.push(`- ${label}: ${picked.join(" · ")}`);
  }
  return lines.length ? `### 온보딩에서 알려주신 것 (리브와의 대화에서)\n${lines.join("\n")}` : "";
}

async function buildMemberBlocks(memberId: string): Promise<{ me: string; personal: string }> {
  try {
    const m = await getMember(memberId);
    const body = strip(m?.body_md || "");
    // 리브 프로필 조회 실패는 개인 층 전체를 죽이지 않는다(fail-open) — 사람이 적은 규칙은 그대로 나가야 한다.
    const liv = await getLivProfile(memberId).catch(() => null);
    const onboarding = renderLivOnboarding(liv);
    const inner = [body, onboarding].filter(Boolean).join("\n\n");
    return {
      me: renderMeBlock(memberId, m),
      personal: inner ? `## 내 개인 규칙 (나에게만 적용 — 팀 공유 아님)\n\n${inner}` : "",
    };
  } catch { return { me: "", personal: "" }; }
}

export async function previewMemberContext(orgName: string, memberId?: string): Promise<string> {
  const header = `# ${orgName} 컨텍스트`;
  // 팀 층 — memberId(=org_member.id, bearer 토큰 principal) 있을 때만. 훅이 멤버 토큰으로 fetch 하므로 게이트웨이가 신원을 안다.
  const team = memberId ? await buildTeamBlock(memberId) : { block: "", mineIds: new Set<number>() };
  const { listWikiPins, PUBLIC_VIEWER } = await import("../../v6/knowledge-store.js");
  const { categoryMapForIndex, wikiCategoryMap } = await import("./knowledge-index.js");
  // 공개범위(#1291) — **이 함수가 세션 첫머리 주입의 단일 소스**다(훅·웹 미리보기·정적 폴백이 전부 여기를 지난다).
  //  그래서 잠금이 여기서 안 걸리면 다른 모든 표면을 막아도 소용이 없다: 잠긴 지식의 소환키가 매 세션 전원에게 깔린다.
  //  멤버가 특정되면 그 사람 시야로, 아니면(멤버 무관 미리보기·정적 폴백) 공개 맥락만 담는 PUBLIC_VIEWER 로.
  const viewer = memberId || PUBLIC_VIEWER;
  // ${wiki} 블록 소스 = 핀 전량(is_wiki 를 DB 에서 필터). 구 코드는 일반 목록 500건을 넘겨 buildWikiBlock 이
  //  메모리에서 골랐고, 활성 지식 500건 초과 조직에선 창 밖 핀이 매 세션 주입에서 조용히 빠졌다(#1247).
  const wikiPins = await listWikiPins(viewer);
  // 카테고리 지도는 라이브 조회(domainmap+items 조인, non-stale). team.mineIds 주면 우리 팀 카테고리 상단 정렬+★(없으면 출력 불변).
  const categoryMap = await categoryMapForIndex(viewer, team.mineIds.size ? team.mineIds : undefined);
  // 항상-주입 섹션 전부를 sort 순으로 조립(injection='always' 행 = 섹션). 각 본문에 ${team}/${categories}/${wiki} 치환.
  const sectionsText = await buildSectionBlocks({ team: team.block, categoryMap, wikiUnits: wikiPins, wikiCats: await wikiCategoryMap() });
  // (2026-08-12) 온보딩 baseline 블록(#269) **폐지** — 셋업 체크리스트를 매 세션 컨텍스트 맨 앞에 붙이던
  //  자리다. 없앤 이유는 이 파일이 아니라 onboarding.ts 헤더에 적어 뒀다(요약: 체크리스트를 세션에 밀어
  //  넣으면 '영원히 미완 → 매 세션 잔소리'가 되고, 파이프라인처럼 정상 운영 중에도 미완일 수 있는 항목이
  //  들어오면 '완료되면 사라진다'는 방어가 통하지 않는다). 체크리스트의 표면은 웹 화면 하나다.
  //  ⚠ 빈 조직이 맥락 블라인드가 되지는 않는다 — context-ontology-guide 는 코드 소유라 DB 행이 없어도
  //   아래 buildSectionBlocks 가 렌더한다(그게 '라이블리가 뭔지'를 설명하는 실제 출처였다).
  // 나 층·개인 층 — 본인 세션에만(memberId=bearer principal). memberId 없으면 둘 다 "" → 정적(멤버 무관) 출력 불변.
  const { me, personal } = memberId ? await buildMemberBlocks(memberId) : { me: "", personal: "" };
  // '나'는 헤더 직후(누구의 맥락인지 먼저), 개인 규칙은 조직·팀 층 뒤(조직 규칙을 덮어쓰는 것처럼 읽히지 않게).
  const parts = [header, me, sectionsText, personal];
  // H1-b 시크릿 출력게이트(v3 P-V3-1): 이 미리보기는 구성원 AI 가 매 세션 읽는 항상-주입 컨텍스트(=훅 fetchOrgContext live 소스).
  //  substituteBlocks 가 섹션마다 이미 마스킹하나, 레거시 섹션 본문의 평문 시크릿 대비 조립 후 한 번 더 redactString(fail-open).
  return redactString(parts.filter(Boolean).join("\n\n")) + "\n";
}
