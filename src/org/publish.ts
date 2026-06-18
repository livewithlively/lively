// 발행 인터페이스 — DB(진실원천) → materialize → 기존 generator 를 subprocess 로 호출 → 발행 아티팩트/설치 번들.
// generator 를 in-process import 하지 않는 이유: build-context.mjs 가 잘못된 입력에 process.exit(1) 을 부른다
//  → import 호출이면 게이트웨이 프로세스를 죽인다. subprocess 는 프로세스 격리 + 출력 캡처 + 무위험.
//  이것이 우리가 합의한 'delivery 인터페이스'의 구현(웹은 이 인터페이스에만 의존, 내부 기제는 교체 가능).
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { materializeOrgContent } from "./materialize.js";
import { getSection } from "./store.js";
import { redactString } from "./redact.js";
import { logger } from "../log.js";

// generator(build-context.mjs) 경로 — env 오버라이드 또는 sibling 레이아웃 기본값.
function generatorPath(): string {
  if (process.env.WORKFLOW_STD_DIR) return join(process.env.WORKFLOW_STD_DIR, "generator", "build-context.mjs");
  return fileURLToPath(new URL("../../../workflow-std/generator/build-context.mjs", import.meta.url));
}

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
    : new URL("../../../workflow-std/generator/build-context.mjs", import.meta.url).href;
  const mod = await import(genUrl);
  if (typeof mod.buildStaticContext !== "function") {
    throw new Error("generator 에 buildStaticContext export 가 없습니다 (workflow-std 버전 불일치)");
  }
  return mod.buildStaticContext;
}

interface RunResult { code: number; stdout: string; stderr: string }

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

export interface PublishResult {
  ok: boolean;
  artifactBytes: number;
  log: string;
  warning?: string;
}

// DB → materialize → generator publish → <outDir> 에 context-setup 아티팩트 조립.
export async function runPublish(outDir: string, harness = "claude"): Promise<PublishResult> {
  // org-content 는 items DB 가 진실원천 — 미설정이면 발행 자체가 불가(명확한 서버 설정 에러 → 500).
  if (!process.env.ITEMS_DATABASE_URL) throw new Error("ITEMS_DATABASE_URL 미설정 — 조직 컨텍스트 발행 불가");
  const mat = await materializeOrgContent();
  try {
    const gen = generatorPath();
    // '없음' 토큰은 wrap() 이 404 로 매핑하므로 회피(이건 서버 설정/경로 오류 → 500).
    if (!existsSync(gen)) throw new Error(`generator 실행 파일을 찾지 못함: ${gen} (WORKFLOW_STD_DIR 로 경로 지정)`);
    const r = await run(process.execPath, [
      gen, "--org", mat.dir, "--publish", outDir, "--harness", harness, "--org-name", mat.orgName,
    ]);
    if (r.code !== 0) {
      logger.error({ stderr: r.stderr }, "generator publish 실패");
      throw new Error(`발행 실패(generator exit ${r.code}): ${r.stderr.trim().split("\n").slice(-3).join(" ")}`);
    }
    let artifactBytes = 0;
    try { artifactBytes = (await readFile(join(outDir, "AGENTS.md"))).byteLength; } catch { /* 무시 */ }
    const warning = artifactBytes > 32 * 1024 ? "AGENTS.md 가 32KiB 를 초과 — Codex 한도 주의" : undefined;
    // P-V3-5 Part A: 오프라인 폴백 context.md 도 발행물에 함께 굳힌다 — DB-materialize 한 같은 트리에서
    //  buildStaticContext 로 구워, AGENTS.md(=generator 발행)와 동일 DB Knowledge Index 를 갖는 단일소스.
    //  설치기(user-install.mjs)가 발행물 context.md 를 ~/.lively/context.md 로 복사(AGENTS.md 파생 대신).
    //  멱등: 같은 DB 상태 → byte-identical(buildKnowledgeIndex 결정적). 재발행이 인덱스 중복 누적 안 함.
    try {
      const buildStaticContext = await loadBuildStaticContext();
      const { context } = buildStaticContext(mat.dir, mat.orgName);
      await writeFile(join(outDir, "context.md"), context);
    } catch (err) {
      // fail-soft: context.md 굽기 실패해도 발행 자체는 성공(설치기가 AGENTS.md 파생으로 폴백).
      logger.warn({ err }, "정적 context.md 발행 실패 — 설치기가 AGENTS.md 파생으로 폴백");
    }
    return { ok: true, artifactBytes, log: r.stdout.trim(), warning };
  } finally {
    await mat.cleanup().catch((err) => logger.warn({ err }, "materialize 임시디렉토리 정리 실패"));
  }
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
    JSON.stringify({ hooks: cfg.hooks, writeback_notice: cfg.writeback_notice || undefined }, null, 2) + "\n");
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

export async function previewMemberContext(orgName: string): Promise<string> {
  const header = `# ${orgName} 컨텍스트`;
  const policy = await getSection("managed-policy");
  const defaults = await getSection("org-defaults");
  const { listKnowledge } = await import("./knowledge.js");
  // 실제 발행물(MEMORY.md)과 **동일** 인덱스여야 WYSIWYG 가 안 깨진다 — materialize 의 buildKnowledgeIndex 를 그대로
  //  재사용(v4: R 전문 + area 지도 + 쓰기 가이드 단일 소스). 따로 만들면 미리보기↔발행물 불일치.
  const { buildKnowledgeIndex, areaMapForIndex } = await import("./materialize.js");
  const knowledge = await listKnowledge({ lifecycle: "active" });
  // area 지도는 라이브 조회(domainmap+items 조인, non-stale) — materialize 와 동일 소스라 미리보기↔발행물 일치 유지.
  const areaMap = await areaMapForIndex();
  const memIndex = (knowledge.length || areaMap.length) ? buildKnowledgeIndex(knowledge, areaMap).trim() : "";
  const sections = [
    header,
    policy?.body_md?.trim() ? strip(policy.body_md) : "",
    defaults?.body_md?.trim() ? strip(defaults.body_md) : "",
    memIndex,
  ];
  // H1-b 시크릿 출력게이트(v3 P-V3-1): 이 미리보기는 구성원 AI 가 매 세션 실제로 읽는 항상-주입 컨텍스트(=훅 fetchOrgContext
  //  의 live 소스)다. memIndex 는 buildKnowledgeIndex 가 이미 마스킹하나, policy/defaults 는 06-16 write-gate 이전
  //  레거시 본문이 평문 시크릿을 품을 수 있으므로 조립 후 한 번 더 redactString 으로 마스킹한다(서빙 경로 = throw 금지,
  //  fail-open 보존 — 마스킹만). 쓰기경로 hard-block(assertNoHardSecrets)과 이중 안전망.
  return redactString(sections.filter(Boolean).join("\n\n")) + "\n";
}
