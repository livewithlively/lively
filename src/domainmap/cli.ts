#!/usr/bin/env node
// domainmap 호스트 CLI — 구 domain-map/store.mjs 1:1 대체(docker exec 불필요).
// 실행: cd context-ontology && node --env-file-if-exists=.env dist/domainmap/cli.js <cmd>
// 서브커맨드(v6: 스캔 엔진 중심 — domain 조회/편집은 웹·MCP category 로 이전):
//   init | ingest (<stdin json) | refresh <repo> (<stdin json) | scan <repo> <rootPath> (사실추출→stdout) | refresh-scan <repo> <rootPath> … |
//   eval-domain-debt <repo> | history [--limit=N 기본15, 글로벌·oldest-first] | restore <change_id> --actor=<id>
// actor 규칙 verbatim: --actor=<id> → {type:'human',id}; 아니면 --actor-type=/--actor-id=(기본 human/human).
// 에러는 'ERROR: msg' + exit 1. 종료 시 반드시 endPool()(CLI 프로세스 전용 — 게이트웨이와 분리).
import { argv } from "node:process";
import { readFileSync } from "node:fs";
import { endPool } from "./db.js";
import type { Actor } from "./core/types.js";
import { saneLimit } from "./core/types.js";
import { init } from "./core/schema.js";
import { ingest } from "./core/reconcile.js";
import { refresh } from "./core/refresh.js";
import { restore, historyGlobal } from "./core/changelog.js";
import { refreshFromFilesystem, type RenamePrefix } from "./core/refresh-fs.js";
import { evaluateDomainStructureDebt } from "./core/domain-debt.js";
import { collectFacts } from "./core/scan-fs.js";

// v6 드랍(2026-06-24): show/list-domains/domain-set 커맨드 제거 — 구 domain 테이블(드랍됨)을 읽던 dev 커맨드.
//  도메인=category 조회는 웹(#/categories)·MCP(category_list/category_get)로. ingest/refresh/eval-domain-debt 는 유지(스캔 엔진).

async function historyCmd(flags: Record<string, string | true>): Promise<void> {
  // 글로벌(전 repo)·기본 15·oldest-first 출력 — HTTP history(repo 스코프·기본 50)와 다른 기존 거동 유지.
  const rows = await historyGlobal(saneLimit(flags.limit ?? 15, 15));
  for (const c of rows.reverse())
    console.log(`#${c.id} ${c.at?.toISOString?.() ?? c.at} ${c.op.toUpperCase().padEnd(8)} ${c.entity_type}/${c.entity_id} by ${c.actor_type}:${c.actor_id}` +
      (c.note ? `  — ${c.note}` : "") + (c.before ? `\n      before: ${JSON.stringify(c.before)}` : "") + (c.after ? `\n      after:  ${JSON.stringify(c.after)}` : ""));
}

const cmd = argv[2];
const rest = argv.slice(3);
const pos = rest.filter((a) => !a.startsWith("--"));
const flags: Record<string, string | true> = Object.fromEntries(
  rest.filter((a) => a.startsWith("--")).map((a) => { const [k, ...v] = a.slice(2).split("="); return [k, v.length ? v.join("=") : true]; }));
const actor: Actor = {
  type: (flags.actor ? "human" : (flags["actor-type"] ?? "human")) as Actor["type"],
  id: typeof flags.actor === "string" ? flags.actor : ((typeof flags["actor-id"] === "string" ? flags["actor-id"] : undefined) ?? "human"),
};

try {
  if (cmd === "init") console.log(await init());
  else if (cmd === "ingest") console.log(JSON.stringify(await ingest(readFileSync(0, "utf8")), null, 2));
  else if (cmd === "refresh") {
    // refresh <repo> reads a git-diff payload {base?,head?,changes[]} from stdin
    // (like ingest) → deterministic incremental structural refresh → prints tally.
    if (!pos[0]) { console.error("usage: refresh <repo>  (payload JSON on stdin)"); process.exitCode = 1; }
    else console.log(JSON.stringify(await refresh(pos[0], readFileSync(0, "utf8"), actor), null, 2));
  }
  else if (cmd === "refresh-scan") {
    // refresh-scan <repo> <rootPath> [--rename=from:to ...] [--head=<sha>] [--stack=<json>]
    //   파일시스템 워크 기반 결정론적 구조 리프레시(git diff 가 닿지 못하는 드리프트 복구용).
    //   저장된 active code_unit path 를 rootPath 기준으로 실재 프로브 → R(rename, 매핑 보존)/
    //   D(soft-remove + orphan flag) change 를 만들어 기존 refresh() 엔진에 먹인다. 비파괴.
    //   --rename 은 구→신 prefix 이전 규칙(반복 가능), --head 는 last_refreshed_sha 체크포인트(freshness 해소),
    //   --stack 은 detected_stack 보정(JSON). 자동화면 --actor-type=agent --actor-id=<id>.
    if (!pos[0] || !pos[1]) { console.error("usage: refresh-scan <repo> <rootPath> [--rename=from:to ...] [--head=<sha>] [--stack=<json>]"); process.exitCode = 1; }
    else {
      const renameVals = rest.filter((a) => a.startsWith("--rename=")).map((a) => a.slice("--rename=".length));
      const renamePrefixes: RenamePrefix[] = renameVals.map((v) => {
        const i = v.indexOf(":");
        if (i < 0) throw new Error(`--rename 형식은 from:to — 받음: ${v}`);
        return { from: v.slice(0, i), to: v.slice(i + 1) };
      });
      const headSha = typeof flags.head === "string" ? flags.head : null;
      const detectedStack = typeof flags.stack === "string" ? JSON.parse(flags.stack) : undefined;
      const evalDomainDebt = flags["eval-domain-debt"] === true;
      const out = await refreshFromFilesystem(pos[0], pos[1], actor, { renamePrefixes, headSha, detectedStack, evalDomainDebt });
      console.log(JSON.stringify(out, null, 2));
    }
  }
  else if (cmd === "scan") {
    // scan <repo> <rootPath> [--fallback-depth=N] — 결정론적 '사실' 추출(파일목록·모듈힌트·스택). DB·판단 무접촉.
    //   최초 is 부트스트랩 런북의 ground-truth: LLM 이 이 JSON 을 grep 해 '유닛 경계 + 도메인 매핑'을 판단하고
    //   domainmap_ingest(REST/MCP)로 payload 를 한 번에 쓴다. 유닛 생성/매핑은 여기서 '안' 한다(그건 판단=LLM).
    //   ↔ 'refresh-scan'(저장 유닛의 rename/delete 재조정)·'ingest'(payload 를 store 에 씀)와 구분.
    if (!pos[0] || !pos[1]) { console.error("usage: scan <repo> <rootPath> [--fallback-depth=N]  (facts JSON → stdout)"); process.exitCode = 1; }
    else {
      const fallbackDepth = typeof flags["fallback-depth"] === "string" ? Number(flags["fallback-depth"]) : undefined;
      const out = await collectFacts(pos[0], pos[1], { fallbackDepth });
      console.log(JSON.stringify(out, null, 2));
    }
  }
  else if (cmd === "eval-domain-debt") {
    // eval-domain-debt <repo> — 결정론적 도메인-레벨 구조 부채(G-diff 슬라이스) 자동 평가·upsert.
    //   vanished(active=0,removed>0)/eroded(active>0,removed>0)를 kind='domain_debt' 로 멱등 생성.
    if (!pos[0]) { console.error("usage: eval-domain-debt <repo>  [--actor-type=agent --actor-id=<id>]"); process.exitCode = 1; }
    else console.log(JSON.stringify(await evaluateDomainStructureDebt(pos[0], actor), null, 2));
  }
  else if (cmd === "history") await historyCmd(flags);
  else if (cmd === "restore") { const r = await restore(Number(pos[0]), actor); console.log("restored change #" + pos[0], JSON.stringify(r)); }
  else console.log("commands: init | ingest (<stdin json) | refresh <repo> (<stdin json) | scan <repo> <rootPath> [--fallback-depth=N] | refresh-scan <repo> <rootPath> [--rename=from:to] [--head=sha] [--stack=json] [--eval-domain-debt] | eval-domain-debt <repo> | history [--limit=N] | restore <change_id> --actor=<id>");
} catch (e) { console.error("ERROR:", (e as Error).message); process.exitCode = 1; }
await endPool();
