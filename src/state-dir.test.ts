// #618 가드레일(강화) — 게이트웨이 런타임 쓰기 경로가 서비스유저↔디렉 소유 불일치로 EACCES 나는 클래스를 CI 에서 차단.
//  근본 규약: 런타임 쓰기는 반드시 state-dir.ts 의 stateDir()/stateRoot() 로만(그 한 곳만 process.cwd() 사용). 그러면
//  새 기능은 mkdir(stateDir("x"),{recursive}) 한 줄로 '권한처리 없이' 안전하다(stateRoot 은 배포·부팅이 쓰기가능 보장).
//  denylist(특정 나쁜 리터럴)로는 새 형태를 놓치므로(예전 버전의 한계), allowlist 로 뒤집는다:
//   R1) process.cwd() 는 허용목록(런타임 루트를 정의/사용하는 곳) 밖에서 전면 금지 — cwd-상대 경로의 간접(변수)우회까지 차단.
//   R2) fs 변이 호출의 첫 인자가 '경로 문자열 리터럴'이면 금지 — 하드코딩(/home·/srv·상대) 직접 쓰기 차단. 정상 사이트는 변수/헬퍼를 쓴다.
//  ※ 소스(src/*.ts)를 스캔한다(저장소 루트에서 npm test 실행).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// process.cwd() 사용이 정당한 곳만: 런타임 루트 정의(state-dir) + 자식 spawn 의 cwd 전달(run-tracker, 쓰기경로 아님).
const CWD_ALLOW = new Set(["src/state-dir.ts", "src/connectors/run-tracker.ts"]);
// 경로-리터럴 fs 쓰기가 정당한 곳(현재 없음 — 새로 생기면 리뷰 후 여기 추가).
const LITERAL_ALLOW = new Set<string>([]);
// 스캔 제외 — 게이트웨이 런타임 코드가 아닌 '생성된 데이터' 파일. default-content.ts 는 캡처된 멤버측 훅·스킬
//  본문(멤버 머신에서 도는 훅은 정당하게 process.cwd()/파일쓰기 사용)을 문자열로 담을 뿐이라 이 가드레일 범위 밖.
const SCAN_SKIP = new Set(["src/org/default-content.ts"]);

// R2: fs 변이 호출의 첫 인자가 문자열 리터럴이거나 resolve()/join() 로 감싼 리터럴(=하드코딩 경로). 정상은 변수/헬퍼.
const FS_WRITE = /\.\s*(mkdir|mkdirSync|writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rename|renameSync|cp|copyFile|copyFileSync|symlink|symlinkSync)\s*\(\s*((path\.)?(resolve|join)\s*\(\s*)?(["'`])/;
// R3: env 기본값이 '상대 경로 리터럴'(슬래시 포함, 절대/URL 아님) — 예 `?? "var/repos"`. cwd-상대 루트가 변수로 새는 경로.
//  단, 같은 줄에 경로 컨텍스트 토큰이 있을 때만(MIME "application/octet-stream"·브랜치 "project/${id}" 같은 '/'-포함 비경로 오탐 방지).
const REL_DEFAULT = /(\?\?|\|\|)\s*(["'`])(?!\/)([^"'`]*\/[^"'`]*)\2/;
const PATH_CTX = /resolve\s*\(|path\.(resolve|join)|_DIR\b|_ROOT\b|reposDir|assetDir|stateDir|mkdir/;

// 한 줄의 위반 사유(없으면 null).
function violation(line: string, cwdAllowed: boolean, literalAllowed: boolean): string | null {
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("*")) return null; // 주석 제외
  if (!cwdAllowed && /process\.cwd\(\)/.test(line))
    return "process.cwd() 런타임 경로 금지 — stateDir()/stateRoot() 사용(간접 우회도 금지)";
  if (!literalAllowed && FS_WRITE.test(line))
    return "fs 변이 호출에 경로 리터럴 금지 — 변수/헬퍼(stateDir·projectAbsPath 등) 사용";
  const m = REL_DEFAULT.exec(line);
  if (!literalAllowed && m && !m[3].includes("://") && PATH_CTX.test(line))
    return "상대경로 리터럴 기본값 금지(예 ?? \"var/repos\") — stateDir(...) 사용";
  return null;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "node_modules") out.push(...walk(p)); }
    else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const SRC = path.resolve(process.cwd(), "src");
const violations: string[] = [];
for (const f of walk(SRC)) {
  const rel = path.relative(process.cwd(), f).split(path.sep).join("/");
  if (SCAN_SKIP.has(rel)) continue;
  const cwdAllowed = CWD_ALLOW.has(rel);
  const literalAllowed = LITERAL_ALLOW.has(rel);
  readFileSync(f, "utf8").split("\n").forEach((ln, i) => {
    const why = violation(ln, cwdAllowed, literalAllowed);
    if (why) violations.push(`${rel}:${i + 1} — ${why}\n    ${ln.trim().slice(0, 120)}`);
  });
}
assert.equal(violations.length, 0, "런타임 쓰기 경로 가드레일 위반:\n" + violations.join("\n"));

// 자기검증 — 가드레일이 '무력화'되지 않았음을 known-bad 샘플로 증명(예전엔 이 6종이 다 통과했었다).
const BAD_SAMPLES = [
  'const p = path.join(process.cwd(), "cache");',
  'await fsp.writeFile("var/out/x.json", d)',
  'fs.mkdirSync(resolve("tmp/scan"))',
  'await fsp.mkdir("/data/repos2")',
  'return resolve(process.env.DOMAINMAP_REPOS_DIR ?? "var/repos");',
  'const assetDir = path.resolve(process.cwd(), "data", "notion-assets");',
];
for (const s of BAD_SAMPLES) assert.ok(violation(s, false, false), `가드레일이 못 잡음(퇴화): ${s}`);
// 정상 샘플은 통과해야(오탐 방지)
const OK_SAMPLES = [
  'await fsp.mkdir(stateDir("repos"), { recursive: true })',
  'await fsp.mkdir(repoPath, { recursive: true })',
  'const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "x-"))',
  'return MIME[ext] || "application/octet-stream";',          // '/'-포함 비경로(MIME) 오탐 아님
  'const branch = spec.branch || `project/${projectId}`;',    // '/'-포함 비경로(브랜치) 오탐 아님
];
for (const s of OK_SAMPLES) assert.equal(violation(s, false, false), null, `정상인데 오탐: ${s}`);

console.log("ok  #618 state-dir 가드레일(강화) — cwd-상대·경로리터럴 런타임쓰기 차단 + 자기검증(6 known-bad 잡음)");
