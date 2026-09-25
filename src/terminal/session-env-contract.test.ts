// 세션 env 허용목록 «단일 출처» 계약 시험 (#2599 T1) — 사양 기반.
//
// 막으려는 사고:
//  구성원 OS 격리가 켜진 리눅스 박스에서 세션 pane 은 곧 `sudo -n -u box_<멤버> -- …/box-spawn` 이다
//  (메모리 캡이 걸린 세션은 box-cgspawn 을 한 번 더 경유한다). sudo 는 기본 env_reset 이라 sudoers 가
//  **명시 보존(env_keep)하지 않은 변수는 오류도 로그도 없이 그 자리에서 사라진다.** 세션은 멀쩡히 뜨고
//  기능만 조용히 빠진다 — 하네스가 디스크 자격으로 폴백해 «엉뚱한 계정의 크레딧» 이 쓰인 실측 사고가
//  바로 이 계열이다. 종전엔 「게이트웨이가 싣는 목록」과 「sudoers 가 통과시키는 목록」이 서로 다른
//  두 벌이었고 대조를 강제하는 장치가 없었다. 이 시험이 그 대조 장치다.
//
// ⚠ 이 시험의 제1 규율 — **사람이 옮겨 적은 두 번째 목록과 비교하지 않는다.**
//  "코어가 싣는 이름"은 순수 함수를 **호출**하거나 주입 코드를 **훑어서** 실제 코드에서 얻는다.
//  그래서 각 수집 축마다 «정말 뭔가 잡았나» 를 먼저 확인하는 배선 단언을 둔다: 정규식 한 글자가 틀려
//  0건 매치가 되면 뒤의 단언이 전부 공허해지고, 그게 이 레포가 가장 싫어하는
//  «통과하는데 아무것도 안 보는 시험» 이다.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import {
  SESSION_ENV_GROUPS, KEEP_CMNDS, sudoersEnvKeep, envKeepPolicy, declaredEnvNames,
  renderSudoersEnvKeepBlock, spliceSudoers, SUDOERS_BEGIN, SUDOERS_END,
} from "./session-env-contract.js";
import { HARNESSES, modeEnvArgs, themeEnvArgs, harnessThemeEnvArgs } from "./catalog.js";
import { safeCacheEnv, homeRelocateEnv } from "../ops/build-cache.js";
import { SESSION_KIND_ENV } from "../sessions/session-kind.js";

// 실패 메시지에 항상 붙일 «다음 행동». 선언만 고치고 생성물을 안 돌리면 sudoers 가 그대로라 사고가 남는다.
const REGEN = "→ src/terminal/session-env-contract.ts 에 선언한 뒤 `npm run gen:sudoers` 로 sudoers 를 재생성하라";
const fmt = (xs: Iterable<string>): string => {
  const a = [...xs];
  return a.length ? a.join(", ") : "(없음)";
};

// 빌드 후 dist/terminal/ 에서 돌므로 레포 루트는 ../../ 다.
const readRepo = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

const SESSIONS_TS = "src/terminal/sessions.ts";   // 대화·앱·상시 세션을 여는 코어 진입
const TASKS_TS = "src/node/tasks.ts";             // 위탁 배치 — createSession 을 안 타는 두 번째 문
const BROKER_TS = "src/broker/route.ts";          // 브로커도 같은 wrapper 로 뜬다
const SCHEDULER_TS = "src/node/task-scheduler.ts"; // 하네스 자격 리스 표
const SUDOERS = "deploy/linux/sudoers-lively";
const BOX_SPAWN = "deploy/linux/box-spawn";
const BOX_CGSPAWN = "deploy/linux/box-cgspawn";

const sources = new Map<string, string>();
for (const rel of [SESSIONS_TS, TASKS_TS, BROKER_TS, SCHEDULER_TS, SUDOERS, BOX_SPAWN, BOX_CGSPAWN]) {
  sources.set(rel, readRepo(rel));
}
// ★ 배선 0 — 파일을 정말 읽었나. 경로가 틀리면 readFileSync 가 던지지만, 빈 파일/자리표시자면 조용히
//  통과해 모든 스캔이 0건이 된다. 그 상태의 «green» 이 가장 위험하다.
for (const [rel, src] of sources) {
  assert.ok(src.length > 200, `${rel} 이 비었거나 잘렸다 — 이 파일을 훑는 단언이 전부 공허해진다`);
}
const src = (rel: string): string => sources.get(rel)!;

// ─────────────────────────────────────────────────────────────────────────────
// D. 계약 자체의 규율
//    (먼저 잰다 — A·B·C·E 가 전부 이 계약을 딛고 서므로, 계약이 비어 있으면 그 뒤가 다 공허하다.)
// ─────────────────────────────────────────────────────────────────────────────
{
  // ★ 배선 — 선언이 하나도 없으면 «모든 이름이 선언돼 있다» 는 A 의 단언이 자동으로 참이 된다.
  assert.ok(SESSION_ENV_GROUPS.length > 0, "SESSION_ENV_GROUPS 가 비었다 — 계약이 아무것도 소유하지 않는다");
  assert.ok(declaredEnvNames().length > 0, "declaredEnvNames() 가 빈 배열이다 — 선언 수집이 헛돈다");
  assert.ok(sudoersEnvKeep().length > 0, "sudoersEnvKeep() 이 빈 배열이다 — sudo 경계를 넘는 이름이 하나도 없다는 뜻");

  // D-1. 같은 이름이 두 번 선언되면 안 된다. 중복이면 envKeepPolicy 의 답이 «어느 쪽을 먼저 만나느냐» 라는
  //      우연에 달리고, 한쪽이 never·한쪽이 keep 이면 그 우연이 곧 보안 경계가 된다.
  const seen = new Map<string, string[]>();
  for (const g of SESSION_ENV_GROUPS) {
    for (const n of g.names) seen.set(n, [...(seen.get(n) ?? []), g.title]);
  }
  const dup = [...seen].filter(([, titles]) => titles.length > 1);
  assert.deepEqual(dup.map(([n]) => n), [],
    `같은 이름이 두 번 선언됐다: ${dup.map(([n, t]) => `${n}(${t.join(" / ")})`).join(", ")}`
    + " — 정책 조회가 선언 순서라는 우연에 달리게 된다. 한 곳만 남겨라");

  // D-1b. declaredEnvNames() 는 선언들의 합집합이어야 한다(수집 함수가 그룹 하나를 통째로 흘리면
  //       A 의 완전성 검사가 그 그룹만큼 눈이 먼다).
  assert.deepEqual([...declaredEnvNames()].sort(), [...seen.keys()].sort(),
    "declaredEnvNames() 가 SESSION_ENV_GROUPS 의 이름 합집합과 다르다 — 수집 함수가 선언을 흘린다");
  assert.equal(new Set(declaredEnvNames()).size, declaredEnvNames().length,
    `declaredEnvNames() 에 중복이 있다: ${fmt(declaredEnvNames().filter((n, i, a) => a.indexOf(n) !== i))}`);

  // D-1c. 이름 모양 — 공백·따옴표가 섞이면 생성된 sudoers 한 줄이 통째로 깨져 그 줄의 **모든** 변수가
  //       조용히 사라진다(사고의 폭발 반경이 크다).
  const badShape = declaredEnvNames().filter((n) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
  assert.deepEqual(badShape, [],
    `env 이름으로 쓸 수 없는 선언: ${fmt(badShape)} — sudoers env_keep 줄이 깨져 그 줄 전체가 무효가 된다`);

  // D-2. 모든 선언에 근거 문장(why)이 있어야 한다. 그 문장이 그대로 생성물의 주석이 되므로,
  //      비면 sudoers 를 읽는 다음 사람이 «왜 이게 여기 있나» 를 영영 못 알아낸다.
  const noWhy = SESSION_ENV_GROUPS.filter((g) => !String(g.why ?? "").trim()).map((g) => g.title);
  assert.deepEqual(noWhy, [], `근거(why)가 빈 선언: ${fmt(noWhy)} — 생성물 주석이 비어 다음 사람이 판단할 근거가 없다`);

  // D-3. keep + 비밀 값이면 «왜 보존해도 되는지» 근거가 따로 있어야 한다.
  //      비밀을 sudo 경계 너머로 넘기는 건 기본이 아니라 예외다 — 예외엔 문장이 붙어야 한다.
  const secretNoWhy = SESSION_ENV_GROUPS
    .filter((g) => g.secret && g.keep === "keep" && !String(g.secretWhy ?? "").trim())
    .map((g) => `${g.title}[${g.names.join(",")}]`);
  assert.deepEqual(secretNoWhy, [],
    `비밀인데 keep 이면서 secretWhy 가 없는 선언: ${fmt(secretNoWhy)} — 근거 없는 비밀 보존은 금지다`);

  // D-4. envKeepPolicy 는 선언과 같은 답을 줘야 한다(조회 경로가 선언을 배신하면 B·E 가 전부 헛것을 잰다).
  const mismatched: string[] = [];
  for (const g of SESSION_ENV_GROUPS) {
    for (const n of g.names) if (envKeepPolicy(n) !== g.keep) mismatched.push(`${n}(선언=${g.keep} 조회=${envKeepPolicy(n)})`);
  }
  assert.deepEqual(mismatched, [], `envKeepPolicy 가 선언과 다르게 답한다: ${fmt(mismatched)}`);
  assert.equal(envKeepPolicy("LIVELY_존재하지_않는_변수_2599"), undefined,
    "선언 안 된 이름에 undefined 가 아닌 답을 준다 — A 의 «선언되지 않은 주입» 검출이 통째로 무력해진다");

  // D-5. sudoersEnvKeep() 은 keep 만, 선언 순서로. sudo-default/never 가 섞여 들어가면
  //      «보존하면 안 된다» 고 적어둔 이름이 그대로 보존 목록에 실린다.
  const expectedKeep = SESSION_ENV_GROUPS.filter((g) => g.keep === "keep").flatMap((g) => [...g.names]);
  assert.deepEqual(sudoersEnvKeep(), expectedKeep,
    `sudoersEnvKeep() 이 keep 선언(선언 순서)과 다르다. 차이: ${
      fmt([...new Set([...sudoersEnvKeep(), ...expectedKeep])].filter((n) => sudoersEnvKeep().includes(n) !== expectedKeep.includes(n)))}`);
  assert.equal(new Set(sudoersEnvKeep()).size, sudoersEnvKeep().length, "sudoersEnvKeep() 에 중복이 있다");
}

// ─────────────────────────────────────────────────────────────────────────────
// A. 선언 완전성 — 코어가 세션 pane 에 싣는 «모든» 이름이 계약에 선언돼 있는가.
//    이름은 세 부류로 얻는다: ①순수 함수 호출 ②소스의 리터럴 스캔 ③런타임 결정(반복문) → 값의 출처에서 교차검증.
// ─────────────────────────────────────────────────────────────────────────────

/** `["-e","K=V", …]` 꼴 tmux 인자에서 이름만 뽑는다. */
const namesFromDashE = (argv: readonly string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "-e") continue;
    const kv = argv[i + 1] ?? "";
    const eq = kv.indexOf("=");
    if (eq > 0) out.push(kv.slice(0, eq));
  }
  return out;
};

// ── 축 ①-a: 실행 모드 / 화면 테마 (순수 함수를 실제로 호출해 얻는다) ──────────────
const pureNames = new Set<string>();
for (const argv of [
  modeEnvArgs({}), modeEnvArgs({ readOnly: true }), modeEnvArgs({ incognito: true }),
  modeEnvArgs({ readOnly: true, incognito: true }),
  themeEnvArgs("dark"), themeEnvArgs("light"), themeEnvArgs(undefined),
]) for (const n of namesFromDashE(argv)) pureNames.add(n);
// ★ 배선 — 두 함수 모두 «분기를 태운» 인자로 불러야 이름이 나온다. 0건이면 아래 완전성 검사가 공허하다.
assert.ok(namesFromDashE(modeEnvArgs({ incognito: true })).length > 0,
  "modeEnvArgs(incognito) 가 -e 인자를 안 낸다 — 모드 축이 헛돈다(이 시험이 모드 변수를 하나도 안 보고 있다)");
assert.ok(namesFromDashE(modeEnvArgs({ readOnly: true })).length > 0, "modeEnvArgs(readOnly) 가 -e 인자를 안 낸다");
assert.ok(namesFromDashE(themeEnvArgs("dark")).length > 0, "themeEnvArgs('dark') 가 -e 인자를 안 낸다 — 테마 축이 헛돈다");

// ── 축 ①-b: 하네스별 테마 env (하네스 표를 순회해 얻는다 — 손으로 옮겨 적지 않는다) ──
const harnessNames = new Set<string>();
assert.ok(HARNESSES.length > 0, "HARNESSES 가 비었다 — 하네스 테마 축을 훑을 대상이 없다");
for (const h of HARNESSES) {
  for (const t of ["dark", "light"]) for (const n of namesFromDashE(harnessThemeEnvArgs(h.key, t))) harnessNames.add(n);
}
// ★ 배선 — env 로 테마를 받는 하네스가 최소 하나는 있어야 이 축이 뭔가를 본다.
assert.ok(harnessNames.size > 0,
  `어느 하네스도 테마 env 를 내지 않는다(훑은 하네스: ${fmt(HARNESSES.map((h) => h.key))}) — 하네스 테마 축이 헛돈다`);

// ── 축 ①-c: 공유 빌드 캐시 (Record 의 키가 곧 env 이름) ────────────────────────
const cacheNames = new Set<string>([...Object.keys(safeCacheEnv("/tmp/x")), ...Object.keys(homeRelocateEnv("/tmp/x"))]);
assert.ok(Object.keys(safeCacheEnv("/tmp/x")).length > 0, "safeCacheEnv 가 빈 객체다 — 캐시 축이 헛돈다");
assert.ok(Object.keys(homeRelocateEnv("/tmp/x")).length > 0, "homeRelocateEnv 가 빈 객체다 — 홈 이전 축이 헛돈다");

// ── 축 ②: 주입 코드 리터럴 스캔 ──────────────────────────────────────────────
//  두 코어 진입 파일 모두 `args.push("-e", `이름=값`)` 꼴로 싣는다. 리터럴 이름은 여기서 그대로 얻는다.
const LITERAL_RE = /"-e"\s*,\s*[`"]([A-Za-z_][A-Za-z0-9_]*)=/g;
const DYNAMIC_RE = /"-e"\s*,\s*[`"]\$\{([^}]*)\}=/g;
/** `${IDENT}=…` 로 주입되는 자리 — 이름이 상수에 있으므로 그 상수를 import 해 풀어 준다. */
const KNOWN_CONST_ENV: Record<string, string> = { SESSION_KIND_ENV };
/** 반복문 주입(`${k}=${v}`) 자리의 **개수**를 고정한다. 늘면 «덮이지 않은 새 동적 주입» 이다. */
const EXPECTED_LOOP_SITES: Record<string, number> = { [SESSIONS_TS]: 1, [TASKS_TS]: 1 };
/** 리터럴 이름 수의 하한 — 정규식이 깨져 0~1건이 되는 «거짓 green» 을 잡는 배선 바닥값(정확한 수가 아니다). */
const LITERAL_FLOOR: Record<string, number> = { [SESSIONS_TS]: 8, [TASKS_TS]: 5 };

const scannedNames = new Set<string>();
for (const rel of [SESSIONS_TS, TASKS_TS]) {
  const text = src(rel);
  const literal = new Set([...text.matchAll(LITERAL_RE)].map((m) => m[1]));
  const dynamic = [...text.matchAll(DYNAMIC_RE)].map((m) => m[1].trim());
  const totalDashE = (text.match(/"-e"/g) ?? []).length;
  const literalHits = [...text.matchAll(LITERAL_RE)].length;

  // ★ 배선 1 — 정규식이 정말 잡았나.
  assert.ok(literal.size >= LITERAL_FLOOR[rel]!,
    `${rel} 에서 리터럴 env 주입을 ${literal.size}건밖에 못 찾았다(최소 ${LITERAL_FLOOR[rel]} 기대). `
    + `찾은 것: ${fmt(literal)} — 주입 표기가 바뀌어 스캐너가 헛도는 것이다. LITERAL_RE 를 고쳐라`);
  // ★ 배선 2 — 스캐너가 **모든** `-e` 자리를 설명하는가. 설명 못 한 자리가 하나라도 있으면
  //   그 자리의 변수는 이 시험이 통째로 못 본다(= 조용히 사라져도 green).
  assert.equal(literalHits + dynamic.length, totalDashE,
    `${rel} 의 "-e" 주입 ${totalDashE}건 중 ${literalHits + dynamic.length}건만 해석했다 — `
    + "스캐너가 모르는 주입 표기가 생겼다. 그 자리를 LITERAL_RE/DYNAMIC_RE 가 읽게 고치거나, "
    + "정적으로 못 읽는 자리면 값의 출처에서 교차검증하는 단언을 추가하라");

  for (const n of literal) scannedNames.add(n);

  // ── 축 ③: 이름이 런타임에 정해지는 자리 ──
  let loops = 0;
  for (const capture of dynamic) {
    const resolved = KNOWN_CONST_ENV[capture];
    if (resolved) { scannedNames.add(resolved); continue; }
    if (/^[A-Z][A-Z0-9_]*$/.test(capture)) {
      // 상수 참조인데 이 시험이 모르는 상수다 — 이름을 정적으로 못 얻으므로 그냥 넘기면 눈이 먼다.
      assert.fail(`${rel} 이 모르는 상수 ${capture} 로 env 를 싣는다 — 이 시험에 그 상수를 import 해 `
        + "KNOWN_CONST_ENV 에 넣고 이름을 얻어라(안 그러면 그 변수는 아무도 안 본다)");
    }
    loops++;   // `${k}=${v}` 꼴 — 이름이 값의 출처에서만 온다.
  }
  assert.equal(loops, EXPECTED_LOOP_SITES[rel]!,
    `${rel} 의 반복문 env 주입 자리가 ${loops}개다(고정값 ${EXPECTED_LOOP_SITES[rel]}). `
    + "새로 생긴 자리라면 그 값의 **출처**(예: 리스 표·캐시 env 생성기)에서 이름을 교차검증하는 단언을 "
    + "추가한 뒤 이 개수를 갱신하라 — 개수만 올리면 그 자리는 영영 안 보인다");
}
// SESSION_KIND_ENV 는 상수 참조로 풀렸어야 한다(위 루프의 결과를 다시 확인 — 상수 해석이 죽으면 조용히 빠진다).
assert.ok(scannedNames.has(SESSION_KIND_ENV),
  `${SESSION_KIND_ENV}(세션 종류)가 스캔 결과에 없다 — 상수 참조 해석이 죽었다`);

// ── A 완전성 단언 ────────────────────────────────────────────────────────────
const injected = new Map<string, string>();   // 이름 → 어느 축에서 왔나(실패 메시지용)
const addAxis = (axis: string, names: Iterable<string>): void => {
  for (const n of names) if (!injected.has(n)) injected.set(n, axis);
};
addAxis("실행모드/테마(순수함수)", pureNames);
addAxis("하네스 테마(순수함수)", harnessNames);
addAxis("공유 빌드 캐시(값의 출처)", cacheNames);
addAxis("주입 코드 스캔", scannedNames);
addAxis("세션 종류 상수", [SESSION_KIND_ENV]);

// ★ 배선 — 축을 다 합쳤는데도 수확이 초라하면 어딘가 헛돌고 있다.
assert.ok(injected.size >= 15,
  `코어가 싣는 이름을 ${injected.size}개밖에 못 모았다 — 수집 축 중 하나가 헛돈다. 모은 것: ${fmt(injected.keys())}`);

const undeclared = [...injected].filter(([n]) => envKeepPolicy(n) === undefined);
assert.deepEqual(undeclared.map(([n]) => n), [],
  `계약에 선언되지 않은 채 세션 pane 에 실리는 변수가 있다: ${
    undeclared.map(([n, axis]) => `${n}(${axis})`).join(", ")}\n`
  + "  이 이름들은 격리 세션에서 sudo 가 오류 없이 지운다 — 기능이 조용히 빠진다.\n"
  + `  keep / sudo-default / never 중 하나로 선언하라. ${REGEN}`);

// ─────────────────────────────────────────────────────────────────────────────
// B. 허용목록 일치 — 계약과 체크인된 sudoers 의 보존 줄이 서로 맞는가.
// ─────────────────────────────────────────────────────────────────────────────
const sudoersText = src(SUDOERS);

// sudoers 의 논리 줄(줄이음 `\` 를 접는다) + 원문 시작 오프셋. 오프셋은 «생성 구역 안인가» 판정에 쓴다.
const logicalLines: { text: string; start: number }[] = [];
{
  let buf = "", start = 0, offset = 0;
  for (const line of sudoersText.split("\n")) {
    if (buf === "") start = offset;
    const cont = /\\$/.test(line);
    buf += cont ? line.slice(0, -1) : line;
    offset += line.length + 1;
    if (!cont) { logicalLines.push({ text: buf, start }); buf = ""; }
  }
  if (buf !== "") logicalLines.push({ text: buf, start });
}

const KEEP_LINE_RE = /^\s*Defaults!(\S+)\s+env_keep\s*\+?=\s*"([^"]*)"/;
const parsedKeep = logicalLines
  .map(({ text, start }) => ({ m: KEEP_LINE_RE.exec(text), start }))
  .filter((x): x is { m: RegExpExecArray; start: number } => x.m !== null)
  .map(({ m, start }) => ({ cmnd: m[1]!, names: m[2]!.trim().split(/\s+/).filter(Boolean), start }));

// ★ 배선 1 — 계약이 보존 대상 Cmnd 를 알고 있나. 비면 아래가 전부 «0개를 0개와 비교» 가 된다.
assert.ok(KEEP_CMNDS.length >= 2,
  `KEEP_CMNDS 가 ${KEEP_CMNDS.length}개다 — 세션 spawn 경로는 둘(직행·cgroup 경유)이라 둘 다 있어야 한다`);
// ★ 배선 2 — sudoers 파싱이 헛돌지 않았나.
assert.ok(parsedKeep.length > 0,
  `${SUDOERS} 에서 env_keep 줄을 한 줄도 못 찾았다(파싱 실패 — 이 시험이 sudoers 를 아예 안 보고 있다)`);

// KEEP_CMNDS 의 각 경로에 대응하는 보존 줄을 찾는다(전체 경로 우선, 없으면 파일명으로).
const base = (p: string): string => p.split("/").pop() ?? p;
const keepLines = new Map<string, { names: string[]; start: number }>();
for (const cmnd of KEEP_CMNDS) {
  const hit = parsedKeep.find((p) => p.cmnd === cmnd) ?? parsedKeep.find((p) => base(p.cmnd) === base(cmnd));
  // ★ 배선 3 — 계약이 «여기에 건다» 고 말한 자리에 실제로 줄이 있어야 한다. 없으면 그 spawn 경로는
  //   env_reset 그대로라 그 종류의 세션만 통째로 기능이 빠진다.
  assert.ok(hit, `sudoers 에 ${cmnd} 용 env_keep 줄이 없다(찾은 Cmnd: ${fmt(parsedKeep.map((p) => p.cmnd))}). ${REGEN}`);
  assert.ok(hit.names.length > 0, `${cmnd} 의 env_keep 줄이 비었다 — 그 경로의 세션은 env 를 하나도 못 받는다`);
  keepLines.set(cmnd, { names: hit.names, start: hit.start });
}

{
  const keepDeclared = sudoersEnvKeep();

  // B-1. keep 으로 선언된 이름은 **두 줄 모두** 에 있어야 한다.
  //      한쪽에만 있으면 메모리 캡이 걸린 세션과 아닌 세션의 환경이 갈린다(재현이 안 되는 버그의 온상).
  for (const [cmnd, line] of keepLines) {
    const have = new Set(line.names);
    const missing = keepDeclared.filter((n) => !have.has(n));
    assert.deepEqual(missing, [],
      `${cmnd} 의 env_keep 에 keep 선언이 빠졌다: ${fmt(missing)}\n`
      + `  → 이 경로로 뜨는 세션에서만 위 변수들이 조용히 사라진다. ${REGEN}`);
  }

  // B-1b. 두 줄이 서로 완전히 같은가(집합 일치). 순서는 상관없다.
  const [first, ...rest] = [...keepLines];
  for (const [cmnd, line] of rest) {
    const a = [...first![1].names].sort(), b = [...line.names].sort();
    assert.deepEqual(b, a,
      `${first![0]} 와 ${cmnd} 의 보존 목록이 다르다 — 두 종류 세션의 환경이 갈린다. 차이: ${
        fmt([...new Set([...a, ...b])].filter((v) => a.includes(v) !== b.includes(v)))}`);
  }

  // B-2. 보존 줄에 계약이 모르는 이름이 있으면 실패 — 손으로 끼워 넣은 항목이다.
  //      (생성기를 거치지 않은 항목은 다음 재생성 때 말없이 사라져, 그때 원인 모를 회귀가 된다.)
  for (const [cmnd, line] of keepLines) {
    const unknown = line.names.filter((n) => envKeepPolicy(n) === undefined);
    assert.deepEqual(unknown, [],
      `${cmnd} 의 env_keep 에 계약이 모르는 이름이 있다: ${fmt(unknown)}\n`
      + `  → 손으로 끼워 넣은 항목이다. 계약에 선언해 생성물이 소유하게 하라. ${REGEN}`);
    const notKeep = line.names.filter((n) => envKeepPolicy(n) !== "keep");
    assert.deepEqual(notKeep, [],
      `${cmnd} 의 env_keep 에 keep 이 아닌 정책의 이름이 있다: ${
        notKeep.map((n) => `${n}(${envKeepPolicy(n)})`).join(", ")} — 선언과 생성물이 어긋났다`);
  }

  // B-3. never 로 선언된 이름은 보존 줄 어디에도 없어야 한다(있으면 그게 곧 사고다 — 아래 E-4 참고).
  const neverNames = SESSION_ENV_GROUPS.filter((g) => g.keep === "never").flatMap((g) => [...g.names]);
  for (const [cmnd, line] of keepLines) {
    const leaked = neverNames.filter((n) => line.names.includes(n));
    assert.deepEqual(leaked, [], `${cmnd} 의 env_keep 에 never 선언이 들어 있다: ${fmt(leaked)} — 보존하면 안 되는 이름이다`);
  }

  // B-4. 보존 줄은 생성 구역 **안** 에 있어야 한다. 밖에 손으로 적은 줄은 생성물이 소유하지 않으므로
  //      계약을 고쳐도 갱신되지 않고, 두 줄이 조용히 갈라지는 원래 문제로 되돌아간다.
  const beginAt = sudoersText.indexOf(SUDOERS_BEGIN);
  const endAt = sudoersText.indexOf(SUDOERS_END);
  const outside = [...keepLines].filter(([, l]) => !(beginAt >= 0 && endAt > beginAt && l.start > beginAt && l.start < endAt));
  assert.deepEqual(outside.map(([c]) => c), [],
    `생성 구역 밖에 있는 보존 줄: ${fmt(outside.map(([c]) => c))} — 계약이 소유하지 못한다. ${REGEN}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// C. 생성물 동일성 — 체크인된 sudoers 의 생성 구역이 «지금 렌더한 결과» 와 한 글자도 다르지 않은가.
// ─────────────────────────────────────────────────────────────────────────────
{
  // ★ 배선 — 마커가 없거나 짝이 안 맞으면 «구역» 이라는 개념 자체가 없다. 조용히 통과시키면 안 된다.
  const beginHits = sudoersText.split(SUDOERS_BEGIN).length - 1;
  const endHits = sudoersText.split(SUDOERS_END).length - 1;
  assert.equal(beginHits, 1, `${SUDOERS} 의 생성 구역 시작 마커가 ${beginHits}개다(1개여야 한다): ${SUDOERS_BEGIN}`);
  assert.equal(endHits, 1, `${SUDOERS} 의 생성 구역 끝 마커가 ${endHits}개다(1개여야 한다): ${SUDOERS_END}`);
  assert.ok(sudoersText.indexOf(SUDOERS_BEGIN) < sudoersText.indexOf(SUDOERS_END), "생성 구역 마커의 순서가 뒤집혔다");

  // C-1. 렌더는 결정적이어야 한다. 두 번 부른 결과가 다르면(집합 순회 순서·시각 등) 생성물이 매번
  //      바뀌어 아래 동일성 단언이 «가끔 실패» 로 변한다.
  assert.equal(renderSudoersEnvKeepBlock(), renderSudoersEnvKeepBlock(), "renderSudoersEnvKeepBlock() 이 비결정적이다");
  assert.ok(renderSudoersEnvKeepBlock().length > 0, "renderSudoersEnvKeepBlock() 이 빈 문자열이다 — 렌더가 헛돈다");

  // C-2. 체크인된 파일 = 지금 렌더한 결과. splice 를 태워 «한 글자도 다르지 않음» 을 잰다.
  assert.equal(spliceSudoers(sudoersText), sudoersText,
    `${SUDOERS} 의 생성 구역이 계약을 지금 렌더한 결과와 다르다 — 선언을 고치고 재생성을 안 했거나, `
    + `구역을 손으로 고쳤다. ${REGEN}`);
  assert.ok(sudoersText.includes(renderSudoersEnvKeepBlock()),
    `렌더 결과가 ${SUDOERS} 안에 그대로 들어 있지 않다 — 생성물과 체크인본이 갈렸다. ${REGEN}`);

  // C-3. 사람이 생성 구역을 손으로 고치면 잡히는가. 잡히지 않으면 위 C-2 는 «아무것도 안 보는 시험» 이다.
  const tampered = sudoersText.replace(SUDOERS_BEGIN, () => `${SUDOERS_BEGIN}\n# 사람이 손으로 끼워 넣은 줄`);
  assert.notEqual(tampered, sudoersText, "손댄 텍스트를 만들지 못했다 — 마커 문자열이 파일에 없다(배선 실패)");
  assert.notEqual(spliceSudoers(tampered), tampered,
    "생성 구역에 줄을 끼워 넣었는데 재렌더 결과와 같다고 나온다 — 손댄 것을 못 잡는다");
  assert.equal(spliceSudoers(tampered), spliceSudoers(sudoersText),
    "손댄 생성 구역을 splice 가 원래 렌더로 되돌리지 못한다 — 구역 경계 판정이 틀렸다");

  // C-4. 생성 구역 **밖** 은 건드리지 않는가(사람이 관리하는 나머지 sudoers 를 생성기가 먹으면 안 된다).
  const withComment = `${sudoersText}\n# 사람이 관리하는 꼬리 주석\n`;
  assert.ok(spliceSudoers(withComment).endsWith("# 사람이 관리하는 꼬리 주석\n"),
    "생성 구역 밖의 손글씨가 splice 로 날아간다 — 생성기가 사람 영역을 먹는다");
  const head = withComment.slice(0, withComment.indexOf(SUDOERS_BEGIN));
  assert.ok(spliceSudoers(withComment).startsWith(head), "생성 구역 앞부분이 splice 로 바뀐다 — 사람 영역 침범");

  // C-5. 마커가 없으면 조용히 통과하지 말고 던져야 한다. 조용히 «그냥 붙이기» 를 하면
  //      구역 없는 sudoers 가 만들어져 다음 재생성이 목록을 중복으로 쌓는다.
  assert.throws(() => spliceSudoers("# 마커가 전혀 없는 sudoers\nDefaults env_reset\n"),
    "마커가 없는 텍스트에도 splice 가 조용히 성공한다 — 구역 소실을 못 잡는다");
  assert.throws(() => spliceSudoers(`${SUDOERS_BEGIN}\n# 끝 마커가 지워졌다\n`),
    "끝 마커가 없는데 splice 가 성공한다 — 구역의 끝을 모르는 채로 잘라 붙인다");
  assert.throws(() => spliceSudoers(`# 시작 마커가 지워졌다\n${SUDOERS_END}\n`),
    "시작 마커가 없는데 splice 가 성공한다");

  // C-5b. 구역이 **둘** 이어도 조용히 통과하면 안 된다(잘못된 병합). splice 는 첫 짝만 갈아끼우므로
  //  뒤에 남은 옛 블록이 그대로 살아 있고, sudoers 는 **나중 줄이 이긴다** — «재생성했는데 옛 허용목록이
  //  실효» 라는 최악의 조합이 된다. 위 C-1~C-3 이 체크인 파일만 보는 것과 달리 이건 splice 를 부르는
  //  **모든 호출자**(생성기 포함)가 받아야 하는 보호라 함수 자신이 던져야 한다.
  assert.throws(() => spliceSudoers(`${sudoersText}\n${sudoersText}`),
    "생성 구역이 둘인 텍스트에도 splice 가 조용히 성공한다 — 첫 블록만 갱신되고 뒤의 옛 목록이 실효로 남는다");

  // C-6. splice 는 멱등이어야 한다(재생성을 두 번 돌려도 파일이 흔들리지 않는다).
  assert.equal(spliceSudoers(spliceSudoers(sudoersText)), spliceSudoers(sudoersText), "spliceSudoers 가 멱등이 아니다");
}

// ─────────────────────────────────────────────────────────────────────────────
// E. 알려진 도메인 규칙 (엣지)
// ─────────────────────────────────────────────────────────────────────────────
const notKeepOf = (names: Iterable<string>): string[] =>
  [...names].filter((n) => envKeepPolicy(n) !== "keep").map((n) => `${n}(${envKeepPolicy(n) ?? "선언없음"})`);

// E-1. 브로커도 같은 wrapper 로 뜬다 → 브로커가 싣는 이름은 전부 keep.
//      이름은 브로커 spawn 코드에서 직접 훑는다(대문자 키 = env 이름).
{
  const brokerSrc = src(BROKER_TS);
  const names = new Set<string>();
  for (const m of brokerSrc.matchAll(/^[ \t]*([A-Z][A-Z0-9_]*)\s*:/gm)) names.add(m[1]!);
  for (const m of brokerSrc.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\s*=(?!=)/g)) names.add(m[1]!);
  // ★ 배선 — 브로커 env 를 한 개도 못 찾으면 이 규칙은 아무것도 안 본다.
  assert.ok(names.size >= 4,
    `${BROKER_TS} 에서 브로커 env 를 ${names.size}개밖에 못 찾았다 — 스캐너가 헛돈다(찾은 것: ${fmt(names)})`);
  const bad = notKeepOf(names);
  assert.deepEqual(bad, [],
    `브로커가 싣는데 keep 이 아닌 이름: ${fmt(bad)}\n`
    + `  → 브로커도 sudo wrapper 로 뜬다. 보존 안 되면 브로커가 설정을 못 받아 조용히 죽는다. ${REGEN}`);
}

// E-2. 하네스 자격 리스 표의 env 이름은 전부 keep.
//      빠지면 하네스가 디스크 자격으로 조용히 폴백해 «엉뚱한 계정의 크레딧» 이 쓰인다(실측 사고).
//      표는 스케줄러 소스에서 훑는다(스케줄러 모듈은 import 부작용이 커서 텍스트로 읽는다).
{
  const schedSrc = src(SCHEDULER_TS);
  const block = /export const LEASE_SECRET[^=]*=\s*\{([\s\S]*?)\n\};/.exec(schedSrc);
  // ★ 배선 — 표의 모양이 바뀌면 0건이 되어 이 규칙이 통째로 눈이 먼다.
  assert.ok(block, `${SCHEDULER_TS} 에서 LEASE_SECRET 표를 못 찾았다 — 표 모양이 바뀌었다. 이 시험의 추출식을 고쳐라`);
  const leaseEnv = [...block[1]!.matchAll(/\benv:\s*"([A-Za-z_][A-Za-z0-9_]*)"/g)].map((m) => m[1]!);
  assert.ok(leaseEnv.length > 0, `LEASE_SECRET 표에서 env 이름을 한 개도 못 뽑았다 — 추출식이 헛돈다`);
  const bad = notKeepOf(leaseEnv);
  assert.deepEqual(bad, [],
    `자격 리스 표에 있는데 keep 이 아닌 이름: ${fmt(bad)}\n`
    + `  → 격리 세션에서 sudo 가 지우면 하네스가 디스크 자격으로 조용히 폴백한다(엉뚱한 계정의 크레딧). ${REGEN}`);
}

// E-3. 공유 빌드 캐시 변수는 값이 **경로** 라 sudo 의 기본 처리로는 절대 넘어오지 못한다 → 전부 keep.
//      (sudo-default 로 잘못 분류하면 «선언은 했는데 여전히 사라지는» 최악의 상태가 된다.)
{
  assert.ok(cacheNames.size >= 5, `캐시 env 를 ${cacheNames.size}개밖에 못 모았다 — 캐시 축이 헛돈다`);
  const bad = notKeepOf(cacheNames);
  assert.deepEqual(bad, [],
    `공유 빌드 캐시 변수인데 keep 이 아닌 이름: ${fmt(bad)}\n`
    + `  → 값이 경로라 sudo 기본 처리로는 넘어오지 않는다. 격리 세션만 캐시를 못 써 매번 재다운로드한다. ${REGEN}`);
}

// E-4. 래퍼 자신이 읽는 «실행 대상 경로» 제어 변수는 never 여야 하고 보존 목록에 나타나면 안 된다.
//      보존되면 sudo 경계 너머에서 무엇이 실행되는지를 호출자가 바꿀 수 있다(권한 상승 통로).
//      이름은 래퍼 스크립트에서 직접 뽑는다 — 값 기본치가 경로(`/` 를 포함)인 변수만 고른다.
{
  const wrapper = `${src(BOX_SPAWN)}\n${src(BOX_CGSPAWN)}`;
  const pathVars = new Set<string>();
  for (const m of wrapper.matchAll(/\$\{((?:LIVELY|LVLY)_[A-Z0-9_]+):-[^}]*\/[^}]*\}/g)) pathVars.add(m[1]!);
  // ★ 배선 — 하나도 못 찾으면 이 규칙이 아무것도 안 본다(래퍼가 제어 변수를 안 쓸 리 없다).
  assert.ok(pathVars.size > 0,
    "래퍼 스크립트에서 경로형 제어 변수를 한 개도 못 찾았다 — 추출식이 헛돈다(래퍼 표기가 바뀌었나?)");

  // (a) 보존 목록에 나타나면 안 된다 — 계약 선언과 무관하게 성립해야 하는 안전 불변식이다.
  for (const [cmnd, line] of keepLines) {
    const leaked = [...pathVars].filter((n) => line.names.includes(n));
    assert.deepEqual(leaked, [],
      `${cmnd} 의 env_keep 에 래퍼 제어 변수가 있다: ${fmt(leaked)}\n`
      + "  → 호출자가 sudo 경계 너머의 실행 대상을 바꿀 수 있다. 즉시 빼라");
  }
  // (b) 계약은 이들을 never 로 알고 있어야 한다. 모르면 다음 사람이 «편해 보인다» 며 keep 으로 추가한다.
  const bad = [...pathVars].filter((n) => envKeepPolicy(n) !== "never")
    .map((n) => `${n}(${envKeepPolicy(n) ?? "선언없음"})`);
  assert.deepEqual(bad, [],
    `래퍼가 실행 대상 경로로 읽는데 never 로 선언되지 않은 이름: ${fmt(bad)}\n`
    + `  → never 로 선언해 «보존하면 안 되는 이름» 임을 계약에 남겨라. ${REGEN}`);
}

console.log("session-env-contract.test: ok");
