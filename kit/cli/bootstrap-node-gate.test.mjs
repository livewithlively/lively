#!/usr/bin/env node
// 설치 부트스트랩의 **Node 런타임 선택 게이트** 회귀테스트 (#1068).
//  실측 사고: 고객 박스의 시스템 Node 가 v16.20.2 였는데 설치기가 "Node 가 있다"는 이유만으로 그걸 채택했다.
//  CLI·훅은 Node 20+ 전제(구버전에 없는 런타임 API 사용)라 설치는 한참 뒤 키트 내려받기에서 `fetch is not defined`
//  로 죽었고, 화면 어디에도 Node 얘기가 없어 사용자는 원인을 알 수 없었다.
//  → 판정 기준은 **존재가 아니라 버전(major ≥ 20)** 이어야 한다. 이 테스트가 막는 회귀는 넷이다:
//    ① 구버전 시스템 Node 채택  ② 전용 런타임이 이미 있는데 또 내려받기  ③ 멀쩡한 박스(20+)에 불필요한 다운로드
//    ④ 조용한 우회(사람이 읽는 출력에 아무 설명 없음) — 그리고 그 와중에 시스템 Node 를 건드리는 것.
//
//  ⚠ 오프라인·비파괴: node·curl/wget·패키지매니저(sudo/brew/apt…)를 전부 PATH 스텁으로 가로채고 HOME 은
//    mkdtemp 샌드박스를 준다 → 실제 30MB 런타임 다운로드·실제 ~/.lively·실제 시스템 Node 무접촉.
//    게이트웨이는 닫힌 포트(127.0.0.1:9) — Node 선택 이후 단계는 어차피 실패한다. 관심사는 그 앞의 선택뿐이다.
//  ⚠ 검증은 **구현의 출력 문구가 아니라** 테스트가 심은 값(v16.20.2 · 최소 20)과 관찰 가능한 부작용
//    (어떤 실행파일이 실제로 불렸나 · 어떤 주소로 나갔나 · 어떤 디렉터리/파일이 생기거나 바뀌었나)으로만 한다.
//  실행: node kit/cli/bootstrap-node-gate.test.mjs

import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, readlinkSync,
  existsSync, statSync, chmodSync, symlinkSync, rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  console.log("skip — Windows 는 별개 진입점(bootstrap.ps1)이라 이 테스트의 대상이 아니다(사양 비목표).");
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };
const bad = (name, why) => { fail++; console.error(`FAIL ${name} — ${why}`); };
const check = (name, cond, why) => (cond ? ok(name) : bad(name, why || "조건 불만족"));

const HERE = join(fileURLToPath(import.meta.url), "..");
const ROOT = join(HERE, "..", "..");
const BOOTSTRAP = join(HERE, "bootstrap.sh");

// ── 사양이 정한 값(검증의 유일한 기준) ────────────────────────────────────────
const MIN_MAJOR = 20;                        // 사양: 최소 major
const OLD = { ver: "v16.20.2", major: 16 };  // 고객 박스에서 채택돼 버렸던 구버전
const NEW = { ver: "v22.11.0", major: 22 };  // 최소 이상
const EXACT = { ver: "v20.0.0", major: 20 }; // 정확히 최소 — `>` vs `>=` 오프바이원 방지
const GATEWAY = "http://127.0.0.1:9";        // 닫힌 포트(discard) — 여기로 나가는 건 우리 서버 호출

// ── 스텁 유틸 ────────────────────────────────────────────────────────────────
const q = (s) => JSON.stringify(s); // 임시경로엔 $·백틱이 없으므로 sh 에서도 안전한 인용
const stub = (path, body) => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); };
const lines = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : []);
const fingerprint = (p) => (existsSync(p)
  ? `${createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 12)}/${(statSync(p).mode & 0o777).toString(8)}`
  : "(없음)");

// 스텁 node — 실제 런타임이 아니라 "버전을 보고하는 실행파일". 모든 호출 인자를 로그에 남긴다.
//  `node -v` → v16.20.2 같은 버전 문자열 / `node -p|-e <식>` → major 숫자.
function nodeStub(path, { ver, major }, log) {
  stub(path, [
    `printf '%s\\n' "$*" >> ${q(log)}`,
    `for a in "$@"; do case "$a" in -v|--version) printf '%s\\n' ${q(ver)}; exit 0 ;; esac; done`,
    `for a in "$@"; do case "$a" in -p|--print|-e|--eval) printf '%s\\n' ${q(String(major))}; exit 0 ;; esac; done`,
    `exit 0`,
  ].join("\n"));
}

// 텍스트 파일 트리에서 needle 이 박힌 파일(심링크 타깃 포함)을 찾는다 — "무엇이 설치물에 기록됐나" 관찰용.
function grepTree(root, needle) {
  const hits = [];
  const walk = (d) => {
    let ents = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (hits.length >= 20) return;
      const p = join(d, e.name);
      if (e.isSymbolicLink()) { try { if (readlinkSync(p).includes(needle)) hits.push(p); } catch { /* */ } continue; }
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      let st; try { st = statSync(p); } catch { continue; }
      if (st.size > 1_000_000) continue;
      let txt = ""; try { txt = readFileSync(p, "utf8"); } catch { continue; }
      if (txt.includes(needle)) hits.push(p);
    }
  };
  walk(root);
  return hits;
}

// ── 시나리오 실행기 ──────────────────────────────────────────────────────────
// systemNode: OLD|NEW|null (PATH 에 놓을 시스템 node) / runtime: NEW|null (이미 설치된 전용 런타임)
function runScenario(label, { systemNode = null, runtime = null }) {
  const box = mkdtempSync(join(tmpdir(), `bootstrap-gate-${label}-`));
  const home = join(box, "home");
  const bin = join(box, "stub-bin");
  const work = join(box, "work"); // cwd — 스크립트가 흘린 파일이 있으면 여기 갇힌다
  const tmp = join(box, "tmp");
  for (const d of [home, bin, work, tmp]) mkdirSync(d, { recursive: true });

  const netLog = join(box, "net.log");     // 시도한 URL
  const pkgLog = join(box, "pkg.log");     // 시스템 변경 도구 호출
  const sysLog = join(box, "sys-node.log");// 시스템 node 호출 인자
  const ownLog = join(box, "own-node.log");// 전용 런타임 node 호출 인자

  // 네트워크 스텁 — URL 만 적고 실패(7=couldn't connect). 실제 다운로드는 절대 일어나지 않는다.
  for (const t of ["curl", "wget"]) {
    stub(join(bin, t), `for a in "$@"; do case "$a" in http://*|https://*) printf '%s\\n' "$a" >> ${q(netLog)} ;; esac; done\nexit 7`);
  }
  // 시스템 변경 도구 스텁 — 불리면 로그만 남기고 실패. (R3: 시스템 Node 를 깔거나 올리려 들면 여기 찍힌다)
  for (const t of ["sudo", "brew", "apt-get", "apt", "yum", "dnf", "pacman", "port", "nvm", "n", "volta", "fnm", "asdf"]) {
    stub(join(bin, t), `printf '%s %s\\n' ${q(t)} "$*" >> ${q(pkgLog)}\nexit 1`);
  }
  if (systemNode) nodeStub(join(bin, "node"), systemNode, sysLog);

  // 이미 설치된 전용 런타임(설치물 계약 경로: $HOME/.lively/runtime/current/bin/node, current 는 심링크)
  const rtDir = join(home, ".lively", "runtime");
  const ownNode = join(rtDir, "current", "bin", "node");
  if (runtime) {
    mkdirSync(join(rtDir, runtime.ver, "bin"), { recursive: true });
    nodeStub(join(rtDir, runtime.ver, "bin", "node"), runtime, ownLog);
    for (const t of ["npm", "npx"]) stub(join(rtDir, runtime.ver, "bin", t), `printf '%s %s\\n' ${q(t)} "$*" >> ${q(ownLog)}\nexit 0`);
    symlinkSync(runtime.ver, join(rtDir, "current"));
  }

  const before = {
    sysNode: fingerprint(join(bin, "node")),
    ownNode: fingerprint(ownNode),
    rt: existsSync(rtDir) ? readdirSync(rtDir).sort().join(",") : "(없음)",
  };

  const r = spawnSync("/bin/sh", [BOOTSTRAP], {
    cwd: work,
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      LIVELY_GATEWAY: GATEWAY,
      TMPDIR: tmp,
      SHELL: "/bin/zsh",
      USER: process.env.USER || "tester",
      LOGNAME: process.env.LOGNAME || "tester",
      NO_COLOR: "1",
    },
    input: "",            // stdin 즉시 EOF — 프롬프트가 있어도 매달리지 않는다
    encoding: "utf8",
    timeout: 90_000,
    killSignal: "SIGKILL",
  });

  const after = {
    sysNode: fingerprint(join(bin, "node")),
    ownNode: fingerprint(ownNode),
    rt: existsSync(rtDir) ? readdirSync(rtDir).sort().join(",") : "(없음)",
  };

  const urls = lines(netLog);
  return {
    label, box, home, bin, rtDir, r,
    err: r.stderr || "", out: r.stdout || "",
    urls,
    origins: [...new Set(urls.map((u) => (u.match(/^[a-z]+:\/\/[^/]+/i) || [u])[0]))],
    // "전용 런타임을 받으러 나갔나" — 게이트웨이(우리 서버) 밖 주소이거나, node 배포 아카이브처럼 생긴 URL.
    runtimeFetch: urls.filter((u) => (!u.startsWith(`${GATEWAY}/`) && u !== GATEWAY) || /node-v?\d/i.test(u)),
    pkgCalls: lines(pkgLog),
    sysCalls: lines(sysLog),
    ownCalls: lines(ownLog),
    // 시스템 node 로 "스크립트를 돌린" 호출(= 런타임으로 채택했다는 증거). 버전 질의(-v/-p)는 채택이 아니다.
    sysRuns: lines(sysLog).filter((l) => /\.(m|c)?js(\s|$)/.test(l)),
    before, after,
    systemNodePath: systemNode ? join(bin, "node") : null,
  };
}

// stderr 한 줄의 "형태"(숫자·색코드·공백을 지운 골격) — 문구를 하드코딩하지 않고 줄의 등장/부재를 비교하기 위함.
const skeleton = (l) => l.replace(/\[[0-9;]*m/g, "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

// ── 실행 ─────────────────────────────────────────────────────────────────────
if (!existsSync(BOOTSTRAP)) { console.error(`FAIL 부트스트랩 스크립트를 찾을 수 없다: ${BOOTSTRAP}`); process.exit(1); }

const A = runScenario("A", { systemNode: OLD, runtime: null });  // 엣지①: 구버전 · 전용 런타임 없음
const B = runScenario("B", { systemNode: OLD, runtime: NEW });   // 엣지②: 구버전 · 전용 런타임 있음
const C = runScenario("C", { systemNode: NEW, runtime: null });  // 엣지③: 최소 이상 · 전용 런타임 없음
const D = runScenario("D", { systemNode: null, runtime: null }); // 엣지④: Node 없음 · 전용 런타임 없음
const E = runScenario("E", { systemNode: EXACT, runtime: null }); // 엣지③ 경계: 정확히 최소(20)
const ALL = [A, B, C, D, E];

try {
  // ── 배선 자기검증 — 이게 깨지면 아래 통과는 전부 무의미(vacuous)하다 ──────────
  check("배선 스텁 node 가 실제로 호출됐다(부트스트랩이 우리 node 를 봤다)",
    A.sysCalls.length > 0 && C.sysCalls.length > 0,
    `A.sysCalls=${A.sysCalls.length} C.sysCalls=${C.sysCalls.length} — 스텁 node 가 한 번도 안 불렸다면 PATH 가로채기가 실패한 것`);
  // 주의: 이 배선 검증에 D(엣지④)를 넣으면 안 된다 — D 의 URL 유무는 **검증 대상 행위**다.
  check("배선 스텁 curl 이 실제로 URL 을 기록했다(네트워크 관찰이 살아있다)",
    A.urls.length > 0 && B.urls.length + C.urls.length > 0,
    `A=${A.urls.length} B=${B.urls.length} C=${C.urls.length} — 로그가 비었는데 '다운로드 없음' 검증이 통과하면 vacuous`);
  check("배선 모든 시나리오가 행(hang) 없이 종료",
    ALL.every((s) => s.r.signal === null && !s.r.error),
    ALL.map((s) => `${s.label}:signal=${s.r.signal}/err=${s.r.error?.code || "-"}`).join(" "));
  check("배선 시스템 node 없는 시나리오엔 정말 node 가 없다(PATH 누수 없음)",
    D.sysCalls.length === 0 && spawnSync("/bin/sh", ["-c", "command -v node"],
      { env: { PATH: `${D.bin}:/usr/bin:/bin:/usr/sbin:/sbin` } }).status !== 0,
    "샌드박스 PATH 에서 node 가 해석된다 — 엣지④가 무의미해진다");
  check("배선 실제 사용자 HOME 무접촉(샌드박스 HOME 만 사용)",
    ALL.every((s) => s.home.startsWith(tmpdir()) && !s.home.startsWith(join(homedir(), "."))),
    ALL.map((s) => s.home).join(" "));

  // ── 엣지① 구버전(v16) · 전용 런타임 없음 → 시스템 것 채택 금지, 설치 경로로 ──
  check("엣지① R1 — 시스템 v16 을 런타임으로 채택하지 않는다(스크립트 실행에 쓰이지 않음)",
    A.sysRuns.length === 0,
    `시스템 node 가 스크립트를 돌렸다: ${JSON.stringify(A.sysRuns.slice(0, 3))}`);
  check("엣지① R1 — 설치물 어디에도 v16 시스템 node 경로가 박히지 않았다",
    grepTree(A.home, A.systemNodePath).length === 0,
    `참조한 파일: ${JSON.stringify(grepTree(A.home, A.systemNodePath).map((p) => p.replace(A.home, "~")))}`);
  check("엣지① R2 — 전용 런타임을 받으러 나간다(설치 경로 진입)",
    A.runtimeFetch.length > 0,
    `런타임 취득 시도가 없다. 기록된 origin=${JSON.stringify(A.origins)} (총 ${A.urls.length}건)`);
  check("엣지① R5 — 우회 사실이 stderr 에 남는다(거절된 버전 16 이 사람 눈에 보인다)",
    /(^|[^\d.])v?16([^\d]|$)/.test(A.err) || A.err.includes(OLD.ver),
    `stderr(${A.err.length}자)에 16/v16.20.2 언급 없음 — 조용한 우회`);
  check("엣지① R5 — stderr 가 요구 최소 버전(20)도 알려준다",
    new RegExp(`(^|[^\\d.])${MIN_MAJOR}([^\\d]|$)`).test(A.err),
    `stderr 에 최소 버전 ${MIN_MAJOR} 언급 없음 — 사용자가 뭘 해야 할지 모른다`);
  check("엣지① R3 — 시스템 node 파일 무변경(내용·권한 지문 동일)",
    A.before.sysNode === A.after.sysNode && A.before.sysNode !== "(없음)",
    `before=${A.before.sysNode} after=${A.after.sysNode}`);
  check("엣지① R3 — 시스템 node 는 여전히 v16.20.2 를 보고한다(업그레이드·교체 없음)",
    spawnSync(A.systemNodePath, ["-v"], { encoding: "utf8" }).stdout.trim() === OLD.ver,
    `보고 버전=${JSON.stringify(spawnSync(A.systemNodePath, ["-v"], { encoding: "utf8" }).stdout)}`);
  check("엣지① R3 — 시스템 변경 도구(sudo/brew/apt/nvm…) 미호출",
    A.pkgCalls.length === 0, JSON.stringify(A.pkgCalls.slice(0, 5)));

  // ── 엣지② 구버전(v16) · 전용 런타임 있음 → 재사용(재다운로드 없음) ───────────
  check("엣지② R2 — 이미 설치된 전용 런타임이 있으면 다시 내려받지 않는다",
    B.runtimeFetch.length === 0,
    `런타임 취득 시도 발생: origin=${JSON.stringify(B.origins)} (총 ${B.urls.length}건)`);
  check("엣지② R2 — 전용 런타임 node 가 실제로 실행됐다(그게 선택됐다는 부작용 증거)",
    B.ownCalls.length > 0,
    "$HOME/.lively/runtime/current/bin/node 가 한 번도 안 불렸다 — 재사용한 흔적이 없다");
  check("엣지② R2 — 기존 런타임 파일 무변경 + 새 버전 디렉터리 미생성(덮어쓰기 없음)",
    B.before.ownNode === B.after.ownNode && B.before.rt === B.after.rt,
    `node지문 ${B.before.ownNode}→${B.after.ownNode} / runtime/ 목록 ${B.before.rt}→${B.after.rt}`);
  check("엣지② R1 — 전용 런타임이 있어도 시스템 v16 은 채택되지 않는다",
    B.sysRuns.length === 0 && grepTree(B.home, B.systemNodePath).length === 0,
    `sysRuns=${JSON.stringify(B.sysRuns.slice(0, 3))} 참조=${JSON.stringify(grepTree(B.home, B.systemNodePath).map((p) => p.replace(B.home, "~")))}`);
  check("엣지② R5 — 재사용 경로에서도 우회 사실을 stderr 에 남긴다(거절된 16 노출)",
    /(^|[^\d.])v?16([^\d]|$)/.test(B.err) || B.err.includes(OLD.ver),
    `stderr(${B.err.length}자)에 16 언급 없음 — 조용한 우회`);
  check("엣지② R3 — 시스템 node 무변경 + 시스템 변경 도구 미호출",
    B.before.sysNode === B.after.sysNode && B.pkgCalls.length === 0,
    `지문 ${B.before.sysNode}→${B.after.sysNode} pkg=${JSON.stringify(B.pkgCalls.slice(0, 5))}`);

  // ── 엣지③ 최소 이상(v22) · 전용 런타임 없음 → 그대로 사용, 다운로드·경고 없음 ──
  check("엣지③ R4 — 시스템 node(v22)를 실제로 조회해 쓴다",
    C.sysCalls.length > 0, "시스템 node 가 한 번도 안 불렸다 — 20+ 인데도 무시했다는 뜻");
  check("엣지③ R4 — 전용 런타임을 새로 내려받지 않는다(불필요한 다운로드 없음)",
    C.runtimeFetch.length === 0,
    `런타임 취득 시도 발생: origin=${JSON.stringify(C.origins)} (총 ${C.urls.length}건)`);
  check("엣지③ R4 — 전용 런타임 설치 흔적이 없다($HOME/.lively/runtime)",
    !existsSync(join(C.home, ".lively", "runtime", "current")) &&
      (!existsSync(C.rtDir) || readdirSync(C.rtDir).length === 0),
    `runtime/ = ${existsSync(C.rtDir) ? JSON.stringify(readdirSync(C.rtDir)) : "(없음)"}`);
  check("엣지③ R5 — 우회 고지가 나오지 않는다(엣지①의 고지 줄 형태가 여기엔 없다)",
    (() => {
      const noticeSkel = new Set(A.err.split("\n").filter((l) => /(^|[^\d.])v?16([^\d]|$)/.test(l)).map(skeleton));
      const cSkel = new Set(C.err.split("\n").map(skeleton));
      return noticeSkel.size > 0 && [...noticeSkel].every((s) => !cSkel.has(s));
    })(),
    "엣지①에서 우회 고지 줄을 못 찾았거나(=R5 미구현), 멀쩡한 v22 박스에서도 같은 고지가 나온다");
  check("엣지③ R3 — 시스템 변경 도구 미호출",
    C.pkgCalls.length === 0, JSON.stringify(C.pkgCalls.slice(0, 5)));
  // 경계값: "최소 버전 이상"이므로 정확히 20 도 그대로 써야 한다(`>` 로 잘못 쓰면 멀쩡한 20 박스가 다운로드를 탄다).
  check(`엣지③ R4 — 경계값(정확히 ${MIN_MAJOR})도 그대로 쓴다: 다운로드·전용런타임 설치 없음`,
    E.sysCalls.length > 0 && E.runtimeFetch.length === 0 && !existsSync(join(E.rtDir, "current")),
    `sysNode호출=${E.sysCalls.length} 취득시도=${JSON.stringify(E.origins)} runtime/=${existsSync(E.rtDir) ? JSON.stringify(readdirSync(E.rtDir)) : "(없음)"}`);

  // ── 엣지④ Node 없음 → 설치 경로 진입(기존 행위 회귀 방지) ───────────────────
  check("엣지④ R2 — 시스템 Node 자체가 없으면 설치 경로로 간다",
    D.runtimeFetch.length > 0,
    `런타임 취득 시도가 없다(URL ${D.urls.length}건, exit=${D.r.status}, stderr=${D.err.length}B). ` +
    `같은 설치 경로를 타는 엣지①(v16)은 ${A.runtimeFetch.length}건 시도했다 — 두 시나리오의 차이는 '시스템 node 존재' 뿐이므로, ` +
    `Node 가 아예 없는 박스에서만 설치가 중단된다는 뜻이다`);
  check("엣지④ R3 — 시스템에 Node 를 깔려 들지 않는다(sudo/brew/apt/nvm… 미호출)",
    D.pkgCalls.length === 0, JSON.stringify(D.pkgCalls.slice(0, 5)));

  // ── R6 최소 버전 값이 여러 설치 표면에서 일치하는가 ─────────────────────────
  // 구현을 읽지 않고도 검증되도록 관용적인 두 형태만 뽑는다:
  //  (가) 이름에 min/required + node/major/ver 가 든 변수 대입:  MIN_NODE_MAJOR=20 · $MinNodeMajor = 20 · const MIN_NODE = 20
  //  (나) node/major 를 언급한 줄의 비교연산자 뒤 리터럴:  -lt 20 · >= 20
  // 실패 메시지는 파일:줄번호와 숫자만 찍는다(구현 문구를 노출하지 않는다).
  let r6Counts = {};
  {
    const ASSIGN = /([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=|:)\s*['"]?v?(\d{1,3})\b/g;
    const CMP = /(?:>=|<=|-ge|-gt|-lt|-le|>|<)\s*['"]?v?(\d{1,3})\b/g;
    const surfaces = ["kit/cli/bootstrap.sh", "kit/cli/bootstrap.ps1", "kit/cli/lively.mjs", "kit/setup/setup-mac.sh"];
    const found = [];
    const perFile = {};
    for (const rel of surfaces) {
      const p = join(ROOT, rel);
      perFile[rel] = 0;
      if (!existsSync(p)) { found.push({ at: `${rel}:0`, n: NaN }); continue; }
      readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        for (const m of line.matchAll(ASSIGN)) {
          if (/(min|required|require|need)/i.test(m[1]) && /(node|major|ver)/i.test(m[1])) {
            found.push({ at: `${rel}:${i + 1}`, n: Number(m[2]) }); perFile[rel]++;
          }
        }
        if (/(node|major)/i.test(line)) {
          for (const m of line.matchAll(CMP)) { found.push({ at: `${rel}:${i + 1}`, n: Number(m[1]) }); perFile[rel]++; }
        }
      });
    }
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const engines = String(pkg?.engines?.node ?? "");
    const engMajor = Number((engines.match(/(\d{1,3})/) || [])[1]);
    check("R6 — package.json engines.node 가 사양의 최소 버전(20)과 일치",
      engMajor === MIN_MAJOR, `engines.node=${JSON.stringify(engines)} → major=${engMajor}`);
    check("R6 — 네 설치 표면 모두에서 최소 버전 선언을 찾았다(검출기가 헛돌지 않는다)",
      surfaces.every((s) => perFile[s] > 0), `표면별 검출 수: ${JSON.stringify(perFile)}`);
    r6Counts = { ...perFile, "package.json engines": engMajor === MIN_MAJOR ? 1 : 0 };
    const mismatched = found.filter((f) => f.n !== MIN_MAJOR);
    check(`R6 — 모든 표면의 최소 버전 선언이 ${MIN_MAJOR} 으로 일치(engines 포함)`,
      mismatched.length === 0,
      `어긋난 선언: ${JSON.stringify(mismatched)} (기대 ${MIN_MAJOR}, engines=${engMajor})`);
  }

  // ── 관찰 요약 — "무엇을 실제로 봤는지"를 남긴다(vacuous 여부를 사람이 판단할 수 있게) ──
  console.log("\n관찰 요약(시나리오: 시도 URL수/외부호스트 · 시스템node 호출수 · 전용node 호출수 · stderr 바이트):");
  for (const s of ALL) {
    console.log(`  ${s.label}: urls=${s.urls.length}${s.origins.length ? ` ${JSON.stringify(s.origins)}` : ""}` +
      ` · sysNode=${s.sysCalls.length} · ownNode=${s.ownCalls.length} · exit=${s.r.status} · stderr=${s.err.length}B`);
  }
  // R6 검출 수(0 이면 '일치' 검증이 헛돈 것 — 값이 아니라 개수만 찍어 구현 문구를 노출하지 않는다)
  console.log(`  R6 최소버전 선언 검출 수: ${JSON.stringify(r6Counts)}`);
} finally {
  for (const s of ALL) { try { rmSync(s.box, { recursive: true, force: true }); } catch { /* */ } }
}

console.log(`\n${pass} passed${fail ? `, ${fail} failed` : ""}`);
process.exit(fail ? 1 : 0);
