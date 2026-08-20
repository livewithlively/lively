#!/usr/bin/env node
// work-flag 훅 유닛테스트 — 플래그 판정(worked/writeback/lively)의 결정표를 고정한다.
//  오프라인·fs-only: 샌드박스 HOME/TMPDIR 에서 훅을 실제 프로세스로 띄운다(실제 ~/.lively·/tmp 무접촉).
//  실행: node kit/hooks/work-flag.test.mjs  (npm test 체인에 포함)
//
//  왜 이 테스트가 있나(#906): "노션만 읽고 끝낸 세션"은 .worked 가 안 서서 종료 게이트를 조용히 통과했다.
//  그런데 프록시(ext__*)는 무엇을 읽었는지 아무것도 안 남기므로(순수 passthrough) 그 맥락은 그대로 증발한다.
//  그래서 pull_tools prefix 에 걸리면 .worked 를 세워 게이트 결정표(worked && !writeback)에 태운다.
//  ⚠ 여기서 고정하는 핵심 불변식 = **pull_tools 가 비면 기능이 꺼진다**(write_tools 의 '비면 기본값'과 반대).
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../testlib/os-sandbox.mjs";   // HOME/TMPDIR 만으론 윈도우 격리가 안 된다(#1510)

const HOOK = join(fileURLToPath(import.meta.url), "..", "work-flag.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "wf-test-"));
const HOME = join(SANDBOX, "home");
const TMP = join(SANDBOX, "tmp");
mkdirSync(join(HOME, ".lively"), { recursive: true });
mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };
const bad = (name, why) => { fail++; console.error(`FAIL ${name} — ${why}`); };

const cfg = (o) => writeFileSync(join(HOME, ".lively", "hooks-config.json"), JSON.stringify(o));
let sid = 0;
// 훅을 실제 프로세스로 실행하고 그 세션이 남긴 플래그 집합을 돌려준다.
function flagsFor(tool) {
  const id = `s${++sid}`;
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: id, tool_name: tool }),
    env: { ...process.env, ...sandboxEnv({ home: HOME, tmp: TMP }), LIVELY_OFF: "", LIVELY_HOOKS_OFF: "" },
  });
  return ["worked", "writeback", "lively"].filter((f) => existsSync(join(TMP, "lively-hooks", `${id}.${f}`)));
}
const eq = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

// ⓪ 격리 회귀 가드(2026-08-18) — 이 테스트는 훅을 **실제 프로세스로** 띄운다. env 에 진짜 신원이 남아 있으면
//  가짜 session_id("s1"…)가 실 게이트웨이로 POST 돼 **살아 있는 세션의 대화 매핑을 덮는다**(실측: 세션 3개가 "s7"이 됐다).
//  HOME 샌드박스로는 못 막는다 — 훅이 토큰을 env 우선으로 읽기 때문이다. 그래서 sandboxEnv 가 값을 비운다.
{
  const e = sandboxEnv({ home: HOME, tmp: TMP });
  (e.LIVELY_TOKEN === "" && e.LIVELY_SESSION_ID === "" && e.LIVELY_GATEWAY_URL === "")
    ? ok("\u24ea 샌드박스 env 가 라이블리 신원·게이트웨이를 지운다(실 게이트웨이 유출 차단)")
    : bad("\u24ea 실 게이트웨이 유출 차단", JSON.stringify(e));
}

// ── pull_tools 켜짐(기본값과 동일) ──
cfg({ pull_tools: ["mcp__lively__ext__"] });

// ① 프록시 pull → worked(게이트 대상) + lively(자가게이팅). 이게 #906 의 본체.
{
  const f = flagsFor("mcp__lively__ext__notion__notion-fetch");
  eq(f, ["worked", "lively"]) ? ok("① ext 프록시 호출 → worked+lively") : bad("① ext pull", `flags=${f}`);
}
// ② lively 일반 읽기 툴은 pull 이 아니다 — worked 가 서면 안 된다(전 세션 오넛지).
{
  const f = flagsFor("mcp__lively__knowledge_get");
  eq(f, ["lively"]) ? ok("② lively 읽기 툴 → lively 만(worked 없음)") : bad("② 오넛지 방지", `flags=${f}`);
}
// ③ source_save = 외부 원본 회수의 착지점 → writeback 인정(WRITE_TOOLS_DEFAULT). 없으면 모범 세션이 너지를 맞는다.
{
  const f = flagsFor("mcp__lively__source_save");
  eq(f, ["writeback", "lively"]) ? ok("③ source_save → writeback 인정") : bad("③ source_save 인정", `flags=${f}`);
}
// ④ 판정 자체는 서버 라벨 무관 — 자체설치 MCP prefix 를 넣으면 그대로 잡힌다. lively 플래그는 안 선다.
//   ⚠ 현재 settings matcher 가 mcp__lively__.* 라 **프로덕션에선 이 호출이 훅에 안 온다**. 이 테스트는 훅 쪽 준비가
//   돼 있음을 고정하는 것 — 자체설치 커버는 matcher 를 pull_tools 에서 파생시키는 후속 작업에서 열린다.
{
  cfg({ pull_tools: ["mcp__notion__"] });
  const f = flagsFor("mcp__notion__notion-fetch");
  eq(f, ["worked"]) ? ok("④ 판정은 서버 라벨 무관(matcher 만 넓히면 커버 — 후속)") : bad("④ 서버 무관 판정", `flags=${f}`);
}

// ⑤ writeback 은 **우리 스토어**로 스코프된다 — 남의 MCP 의 동명 툴(...__knowledge_save)이 게이트를 끄면 안 된다.
//   matcher 가 mcp__lively__.* 였을 땐 이 코드에 도달할 일이 없어 안 드러났고, #906 이 mcp__.* 로 넓히며 실재화된 경로다.
//   실패가 '유실' 방향(맥락 안 남았는데 조용히 종료)이라 치명적이다.
{
  cfg({ pull_tools: ["mcp__lively__ext__"] });
  const f = flagsFor("mcp__evil__knowledge_save");
  eq(f, []) ? ok("⑤ 남의 MCP 의 동명 writeback 툴 → 인정 안 함") : bad("⑤ writeback 스코프", `flags=${f} (게이트가 조용해짐)`);
}

// ── pull_tools 꺼짐 — 어드민이 웹에서 비운 상태 ──
// ⑥ 비면 기능 꺼짐. 내장 폴백이 있으면 어드민의 '끄기'가 무시된다(write_tools 와 반대 시맨틱의 핵심).
{
  cfg({});
  const f = flagsFor("mcp__lively__ext__notion__notion-fetch");
  eq(f, ["lively"]) ? ok("⑥ pull_tools 비움 → 기능 꺼짐(worked 없음)") : bad("⑥ 끄기", `flags=${f}`);
}
// ⑦ 설정 파일 자체가 없어도(게이트웨이 영영 불가) 죽지 않고 조용히 꺼진다 — 넛지는 못 하는 쪽이 안전.
{
  rmSync(join(HOME, ".lively", "hooks-config.json"));
  const f = flagsFor("mcp__lively__ext__notion__notion-fetch");
  eq(f, ["lively"]) ? ok("⑦ 설정 부재 → fail-safe 로 꺼짐") : bad("⑦ 설정 부재", `flags=${f}`);
}

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`work-flag tests: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exit(1);
