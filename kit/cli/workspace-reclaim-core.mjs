// ═══════════════════════════════════════════════════════════════════════════
// 워크스페이스 회수 코어 (#813 T3-2 · kit 이전 #2621) — 프로젝트 워크트리에서 **재생성 가능한 것만** 되돌린다.
//
// 왜 kit 에 있나 (#2621): 이 로직은 `fs` + `git` 만 쓰는 순수 로컬 작업인데, 종전엔 게이트웨이(`src/`)에만
//  있어서 **게이트웨이 호스트의 파일시스템만** 회수할 수 있었다. 개인 PC 노드의 `~/workspace/project/<id>/`
//  는 원리적으로 그 스캔 범위 밖이라, 그 PC 로 프로젝트를 여럿 돌리면 디스크가 조용히 찼다(실측: 맥북
//  `workspace/project` 5.1GB, 200MB+ 프로젝트 15개 — 사람이 손으로 찾아 지워야 했다).
//  → 로직을 kit 으로 옮겨 **한 벌**로 만들고, 게이트웨이(`src/ops/workspace-reclaim.ts`)와 로컬 CLI
//    (`lively reclaim`)가 각자의 컨텍스트로 같은 코드를 부른다. 삭제 규칙이 두 벌로 갈라지지 않는 것이 핵심이다.
//
// 설계 원칙 (haru 결정 2026-07-13): **무인 자동 삭제 프로세스를 만들지 않는다.**
//  되돌릴 수 없는 삭제를 데몬에게 맡기지 않고, **맥락을 아는 주체(프로젝트를 마무리하는 에이전트/사람)가 생애주기
//  경계에서** 회수한다. 이 모듈은 그 주체가 호출하는 **도구**다 — 판단은 호출자가, **삭제 규칙은 코드가 강제**한다
//  (LLM 이 rm -rf 를 즉흥적으로 치는 것보다 훨씬 안전하다).
//
// 무엇을 지우나 — **두 조건을 모두** 만족해야 한다:
//  ① git 이 ignored 라고 말한 것(`git clean -Xdn` — 즉 "커밋 안 하는 것" = 재생성 가능 후보)
//  ② 우리가 아는 파생물 이름(allow-list)일 것
//  둘 다 필요하다. ①만으로는 위험하다 — gitignored 라고 삭제해도 되는 게 아니다(`.env` 시크릿, `data/` 로컬 데이터가
//  전부 gitignored 다. dev 박스 dry-run 에서 실제로 `Would remove data/` 가 나왔다). ②만으로도 위험하다 — 이름이
//  `build` 여도 그게 소스면 gitignore 에 없다(그러면 ①에서 걸러진다).
//  allow-list 에 없는 gitignored 항목은 **지우지 않고 '미분류'로 보고**한다 — 관리자가 보고 판단한다.
//
// 워크트리 자체(#675 세션 워크트리와 달리 프로젝트 워크트리는 영속)는 **커밋이 전부 원격에 있음 + 더티 없음**일 때만
//  제거한다. 그 조건이면 `git worktree add` 로 언제든 복구된다 = 진짜 '복구 가능한 것'. 하나라도 어긋나면
//  **거부하고 이유를 말한다.** (지식: workspace-storage-model-asset-vs-derived-cache)
//
// zero-dep: node 내장만 쓴다(kit 규율). **외부 프로세스(git·du)는 직접 쥐지 않고 주입받는다** —
//  `repo-worktree-core.mjs` 와 같은 형태다(R5: kit 제품 코드는 호스트 효과 프리미티브를 직접 import 하지
//  않는다. 그래야 테스트가 실행기를 가짜로 갈아끼워 판정만 검증할 수 있고, 실 호스트로 새지 않는다).
//  호출자가 `createReclaim({ exec, logger })` 로 자기 실행기를 준다 — 게이트웨이는 promisify(execFile),
//  CLI 는 자기 hostEffects 배선. **삭제 규칙은 여기 한 벌이고, 실행 수단만 주입된다.**
// ═══════════════════════════════════════════════════════════════════════════
import path from "node:path";
import fsp from "node:fs/promises";

// 알려진 파생물 — 이 이름이면서 **gitignored 일 때만** 회수한다(둘 다 필요).
//  이름만으로는 절대 지우지 않으므로, 여기 있는 이름이 소스 디렉터리인 레포라도 안전하다(그러면 gitignored 가 아니다).
export const DERIVED_NAMES = [
  "node_modules", ".pnpm-store", ".yarn",                       // node
  "build", "target", "dist", "out",                             // 범용 빌드 산출물
  ".gradle", ".cxx",                                            // gradle/android
  "Pods", "DerivedData", ".build",                              // ios/swift
  ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".tox", ".ruff_cache", // python
  ".next", ".nuxt", ".svelte-kit", ".astro", ".turbo", ".parcel-cache", ".vite", // 웹 프레임워크
  "obj",                                                        // dotnet
  ".terraform",                                                 // iac
  "coverage", ".nyc_output",                                    // 커버리지
];

// 절대 안 지운다 — gitignored 이고 위 allow-list 에 걸리더라도 여기 걸리면 제외(마지막 안전망).
//  gitignore 는 "커밋하지 마라"이지 "지워도 좋다"가 아니다: 시크릿·로컬 데이터·개인 설정이 전부 여기 산다.
export const PROTECTED_NAMES = [
  ".env", ".git", "data", "secrets", "credentials",
  ".claude", ".codex", ".lively", ".vscode", ".idea", ".ssh",
];

/** @typedef {"derived"|"unclassified"|"protected"} EntryKind */

export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** @param {string} rel @returns {EntryKind} */
function classify(rel) {
  const parts = rel.split("/").filter(Boolean);
  // 경로의 **어느 구간이라도** 보호목록이면 제외 — `some/.env`·`x/data/y` 도 지키기 위해.
  if (parts.some((p) => PROTECTED_NAMES.includes(p) || p.startsWith(".env"))) return "protected";
  const base = parts[parts.length - 1] ?? "";
  return DERIVED_NAMES.includes(base) ? "derived" : "unclassified";
}

/** 디렉터리 크기(Node 워크). 시간 예산 초과 시 partial.
 *  ⚠ **루트가 심링크면 따라가지 않는다.** readdir 은 심링크를 따라가므로, 예컨대 node_modules 가 다른 곳을 가리키는
 *   심링크면 **그 대상의 크기**를 이 디렉터리의 크기인 양 보고하게 된다(실측 확인). 회수 도구가 "224MB 회수 가능"
 *   이라고 거짓 보고하는 원인이었다 — 정작 이 워크트리가 쓰는 공간은 0인데. 아래 항목 루프도 심링크를 건너뛴다. */
export async function dirSize(root, budgetMs = 2000) {
  const deadline = Date.now() + budgetMs;
  let bytes = 0;
  let partial = false;
  try {
    if ((await fsp.lstat(root)).isSymbolicLink()) return { bytes: 0, partial: false };
  } catch {
    return { bytes: 0, partial: false }; // 없는 경로 — 0
  }
  const stack = [root];
  while (stack.length) {
    // >= 로 본다: 예산 0 = '잴 시간이 없다' → 즉시 partial. (> 로 두면 같은 밀리초 안에 끝나버려 예산이 무의미해진다.)
    if (Date.now() >= deadline) { partial = true; break; }
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 없거나 권한 없음 — 건너뛴다
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile()) continue;
      try {
        bytes += (await fsp.stat(p)).size;
      } catch { /* 스캔 중 사라졌을 수 있다 */ }
    }
  }
  return { bytes, partial };
}

/** 프로젝트 폴더 안의 git 레포(워크트리) 경로들 — **한 프로젝트에 여러 레포가 붙을 수 있다.**
 *
 *  ⚠ 목록·분석·회수가 **모두 이 함수를 써야 한다.** 각자 따로 판정하면 "목록엔 [분석] 버튼이 있는데 누르면
 *   '레포가 없습니다' 에러" 같은 어긋남이 생긴다(실제로 그랬다 — #845). 판정은 한 곳에서.
 *
 *  `.git` 은 **워크트리면 파일**(gitdir 포인터), 일반 클론이면 디렉터리다 — stat 은 둘 다 잡는다.
 *  레포를 provision 하지 않은 프로젝트 폴더는 여기서 **빈 배열**이 나온다(정상이다 — 회수할 파생물이 없을 뿐,
 *  에러가 아니다). dev 박스 실측 307개 중 184개가 그런 폴더였다. */
export async function reposIn(dir) {
  const repos = [];
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    const p = path.join(dir, name);
    if (await fsp.stat(path.join(p, ".git")).then(() => true).catch(() => false)) repos.push(p);
  }
  return repos.sort();
}

/** 회수 도구 한 벌을 만든다 — **외부 프로세스 실행기를 주입**받는다.
 *
 *  @param {{
 *    exec: (file:string, args:string[], opts?:object) => Promise<{stdout:string}>,
 *    logger?: {warn:(o:unknown,m:string)=>void, info:(o:unknown,m:string)=>void},
 *  }} deps
 *  `exec` 계약은 `promisify(child_process.execFile)` 과 같다 — 성공하면 `{stdout}`, 실패하면 throw.
 *  게이트웨이는 그걸 그대로 주고, CLI 는 자기 hostEffects 배선을 감싸 준다. 테스트는 가짜를 꽂아
 *  **실 호스트를 건드리지 않고** 판정만 검증한다.
 */
export function createReclaim({ exec, logger = { warn() {}, info() {} } } = {}) {
  if (typeof exec !== "function") throw new TypeError("createReclaim: exec 실행기가 필요합니다");

  async function git(args, cwd) {

  try {
    const { stdout } = await exec("git", args, {
      cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, out: stdout };
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) };
  }
}

/** 디렉터리 크기 — 관리탭이 프로젝트 수십 개를 한 번에 재야 해서 OS `du` 를 쓴다(수십만 파일에서 Node 워크보다 훨씬 빠르다).
 *  실패하면(du 없음·권한) Node 폴백(dirSize). 둘 다 안 되면 null = '못 쟀음'(UI 는 '—' 로 표시). */
async function dirSizeFast(p, timeoutMs = 8000) {
  try {
    const { stdout } = await exec("du", ["-sk", p], { timeout: timeoutMs, maxBuffer: 64 * 1024 });
    const kb = Number(stdout.trim().split(/\s+/)[0]);
    if (Number.isFinite(kb)) return kb * 1024;
  } catch { /* du 없음/실패 → 폴백 */ }
  const r = await dirSize(p, Math.min(timeoutMs, 3000));
  return r.partial && r.bytes === 0 ? null : r.bytes;
}

/** 여러 디렉터리 크기를 **한 번의 du 호출**로. 프로세스를 경로 수만큼 띄우면 관리탭이 몇 초씩 멈춘다
 *  (실측: 300개 순차 호출 5.2초 → 한 번에 묶으면 1초 미만). 못 잰 경로는 null. */
async function dirSizesFast(paths, timeoutMs = 20_000) {
  const out = new Map(paths.map((p) => [p, null]));
  if (!paths.length) return out;
  try {
    const { stdout } = await exec("du", ["-sk", ...paths], {
      timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
    });
    for (const line of stdout.split("\n")) {
      // "12345\t/path/with spaces" — 첫 탭/공백 뒤가 전부 경로다(경로에 공백이 있을 수 있으므로 split 한 번만).
      const m = /^(\d+)\s+(.+)$/.exec(line);
      if (!m || !m[1] || !m[2]) continue;
      if (out.has(m[2])) out.set(m[2], Number(m[1]) * 1024);
    }
  } catch (err) {
    // ⚠ 여기서 경로 수만큼 개별 폴백을 돌리면 안 된다 — 300개 × 2초 = 10분 동안 관리탭이 멈춘다.
    //  전체 예산 안에서만 최대한 재고, 못 잰 건 null(UI 는 '—')로 둔다. 크기를 못 재는 건 불편할 뿐 치명적이지 않다.
    logger.warn({ err, count: paths.length }, "du 일괄 측정 실패 — 예산 내 개별 폴백");
    const deadline = Date.now() + Math.min(timeoutMs, 10_000);
    for (const p of paths) {
      if (Date.now() >= deadline) break;
      out.set(p, await dirSizeFast(p, 1500));
    }
  }
  return out;
}

/** 워크트리의 **베이스 레포**(공유 부모 클론) 경로. `git worktree remove` 는 워크트리 자신이 아니라 부모에서 돌려야 한다.
 *  `--git-common-dir` 이 부모의 `.git` 을 가리키므로 그 상위가 베이스 레포 루트. 못 찾으면 undefined(제거 안 함). */
async function baseRepoOf(wt) {
  const r = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], wt);
  if (!r.ok) return undefined;
  const common = r.out.trim();
  if (!common) return undefined;
  return path.dirname(common); // <base>/.git → <base>
}

/** 워크트리 제거가 안전한가 — **커밋이 전부 원격에 있음 + 더티 없음**일 때만. 하나라도 어긋나면 이유를 말하고 거부한다. */
async function checkWorktree(wt) {
  const st = await git(["status", "--porcelain"], wt);
  if (!st.ok) return { removable: false, reason: "git 상태를 읽지 못했습니다(레포가 아니거나 손상)", dirty: false, unpushed: -1, branch: null };
  const dirty = st.out.trim().length > 0;

  const br = await git(["branch", "--show-current"], wt);
  const branch = br.ok ? br.out.trim() || null : null;

  // **커밋이 원격에 있나**를 직접 센다. 예전엔 upstream **설정**(`branch.*.merge`)이 있나를 물었는데, 그건 프록시일
  //  뿐이고 우리 환경에선 대개 어긋난다 — 그래서 **안전한 워크트리를 거부**했다(#904 실측 → #922):
  //   ① 우리 워크트리는 애초에 upstream 없이 만들어진다 — provisionProjectRepos 는 시작점 없이 `worktree add -b <branch>`
  //      로 자르므로 추적이 안 붙는다(terminal-sessions.ts·kit/setup/work.mjs 도 동형).
  //   ② 다른 이름으로 push 하는 게 정상이다 — `git push origin project/904:main` 이면 브랜치명이 달라 추적이 없다.
  //  그 상태로 커밋이 origin/main 에 멀쩡히 올라가 있어도 "upstream 없음 = 전부 미푸시"로 단정해 거부했다.
  //  `HEAD --not --remotes` = "HEAD 에서 닿지만 **어떤** remote-tracking ref 에서도 안 닿는 커밋" = 설정과 무관한 실제
  //  안전 속성. 원격이 아예 없으면 히스토리 전체가 잡혀 거부된다(맞는 답 — 어디에도 안 올라갔다).
  //  ⚠ 판정 전 fetch 로 stale 을 걷어내지 말 것 — 일괄 회수는 한 요청에 폴더 40개(delivery.ts)를 도므로 네트워크가
  //   요청당 40+회가 되고, du 만으로도 이미 504 를 겪었다(#600). stale 노출은 `@{upstream}` 때도 같았다(그 자신이
  //   remote-tracking ref) → 무회귀.
  let unpushed = -1; // -1 = 세지 못함(레포 손상·커밋 0개) → 아래에서 거부
  const rl = await git(["rev-list", "--count", "HEAD", "--not", "--remotes"], wt);
  if (rl.ok) {
    const n = Number(rl.out.trim());
    // 파싱 실패(NaN)를 0 으로 흘리면 '전부 원격에 있음' = 제거 허용이 된다 — 못 셌으면 -1 로 남겨 거부한다.
    if (Number.isInteger(n) && n >= 0) unpushed = n;
  }

  if (dirty) return { removable: false, reason: "커밋하지 않은 변경이 있습니다 — 잃어버릴 수 있어 제거하지 않습니다", dirty, unpushed, branch };
  if (unpushed < 0) return { removable: false, reason: "커밋이 원격에 있는지 확인하지 못했습니다(git rev-list 실패) — 확인 전에는 제거하지 않습니다", dirty, unpushed, branch };
  if (unpushed > 0) return { removable: false, reason: `원격 어디에도 없는 커밋이 ${unpushed}개 있습니다 — 박스를 재구축하면 사라집니다`, dirty, unpushed, branch };
  return { removable: true, reason: null, dirty, unpushed, branch };
}

/** 회수 계획 — **아무것도 지우지 않는다.** 무엇을 지울지/못 지울지와 그 이유만 돌려준다.
 *  activeSessionDirs: 지금 살아있는 세션들의 작업 디렉터리(호출자가 수집). 이 워크트리 안에 있으면
 *  회수를 통째로 막는다 — 빌드 중인 워크트리의 node_modules 를 지우면 그 세션이 깨진다. */
async function planReclaim(wt, opts = {}) {
  const sizeBudgetMs = opts.sizeBudgetMs ?? 4000;
  const active = (opts.activeSessionDirs ?? []).some((d) => isInside(d, wt));
  const entries = [];
  // git 에게 '삭제'를 시키지 않는다 — **후보 나열만**(-n) 시키고, 무엇을 지울지는 우리가 필터링해서 정한다.
  const clean = await git(["clean", "-Xdn"], wt);
  if (clean.ok) {
    const deadline = Date.now() + sizeBudgetMs;
    for (const line of clean.out.split("\n")) {
      const m = /^Would remove (.+?)\/?$/.exec(line.trim());
      if (!m || !m[1]) continue;
      const rel = m[1];
      const abs = path.join(wt, rel);

      // ── §심링크 — **회수하지 않는다.** ──
      //  ① 크기가 우리 것이 아니다: 심링크는 다른 곳을 가리키므로 이 워크트리가 쓰는 공간은 0 이다.
      //     (예전엔 dirSize 가 링크를 따라가 대상의 크기를 "회수 가능"으로 **거짓 보고**했다 — 실제 사고.)
      //  ② 지워도 공간이 안 생긴다: fs.rm 은 심링크를 lstat 으로 판별해 **링크만 unlink** 한다(대상은 무사).
      //     즉 지워봐야 0바이트 회수하고 남의 의도적 배치만 깨뜨린다.
      //  → 이름이 node_modules 여도 **심링크면 손대지 않고 '미분류'로 보고**한다(사람이 보고 판단).
      let symlink = false;
      try { symlink = (await fsp.lstat(abs)).isSymbolicLink(); } catch { /* 사라졌으면 아래에서 0 */ }
      if (symlink) {
        entries.push({ rel, kind: "unclassified", bytes: 0, partial: false, symlink: true });
        continue;
      }

      const kind = classify(rel);
      const budget = Math.max(0, Math.min(1500, deadline - Date.now()));
      const { bytes, partial } = await dirSize(abs, budget);
      entries.push({ rel, kind, bytes, partial });
    }
  } else {
    logger.warn({ wt, err: clean.out }, "회수 후보 조회 실패(git clean -Xdn)");
  }
  entries.sort((a, b) => b.bytes - a.bytes);
  const reclaimableBytes = entries.filter((e) => e.kind === "derived").reduce((s, e) => s + e.bytes, 0);
  const check = await checkWorktree(wt);
  // 활성 세션이 붙어 있으면 워크트리 제거도 당연히 불가 — 이유를 그 문장으로 덮어쓴다(사용자가 바로 이해하게).
  const worktree_check = active
    ? { ...check, removable: false, reason: "이 워크트리에서 작업 중인 세션이 있습니다" }
    : check;
  return { worktree: wt, entries, reclaimableBytes, worktree_check, active_session: active };
}

// 워크트리를 회수했으면 마커(.lively/project.json)의 provisioned 에서 그 항목도 지운다(#918).
//  provisioned 는 코드가 읽지 않는 기록 필드지만, 유일한 소비자인 **에이전트**가 그걸 보고 없는 경로로 간다
//  (실측: 회수됐는데 마커에 남은 죽은 경로 3건). 회수와 기록이 어긋나면 마커가 거짓말을 하는 셈이라 여기서 맞춘다.
//  워크트리는 project/<id>/<repo> 이므로 마커는 그 부모 폴더 — 프로젝트 폴더 밖 워크트리(위탁 등)면 마커가 없어 no-op.
//  read→merge→write: 다른 writer 의 키(project_id·repos·last_pull)는 보존한다(마커는 writer 가 여럿·키가 분리돼 있다).
async function dropProvisionedEntry(worktree) {
  const file = path.join(path.dirname(worktree), ".lively", "project.json");
  try {
    const prev = JSON.parse(await fsp.readFile(file, "utf8"));
    if (!Array.isArray(prev.provisioned)) return;
    const next = prev.provisioned.filter((r) => r?.cwd !== worktree);
    if (next.length === prev.provisioned.length) return;   // 이 워크트리 항목이 애초에 없음 — 무기록
    await fsp.writeFile(file, JSON.stringify({ ...prev, provisioned: next }, null, 2) + "\n");
  } catch { /* 마커 없음·파손·권한 — 회수 자체는 이미 성공했으므로 조용히 넘어간다(best-effort) */ }
}

/**
 * 계획 실행. **derived 로 분류된 것만** 지운다 — unclassified·protected 는 손대지 않는다.
 * removeWorktree=true 여도 checkWorktree 가 거부하면 **워크트리는 남긴다**(호출자가 우겨도 코드가 막는다).
 */
async function applyReclaim(plan, opts = {}) {
  // ⚠ 활성 세션이 붙어 있으면 **아무것도** 하지 않는다. 빌드 중인 워크트리의 node_modules 를 지우면 그 세션이 깨진다.
  //  호출자가 실수로 강행해도 여기서 막힌다(안전은 호출자가 아니라 코드가 보장한다).
  if (plan.active_session) {
    return { removed: [], freedBytes: 0, worktreeRemoved: false, worktreeSkippedReason: "이 워크트리에서 작업 중인 세션이 있습니다" };
  }
  const removed = [];
  let freedBytes = 0;
  for (const e of plan.entries) {
    if (e.kind !== "derived") continue; // ← 여기가 안전선. 미분류·보호는 절대 안 지운다.
    const target = path.join(plan.worktree, e.rel);
    try {
      await fsp.rm(target, { recursive: true, force: true });
      removed.push(e.rel);
      freedBytes += e.bytes;
    } catch (err) {
      logger.warn({ err, target }, "파생물 회수 실패 — 건너뜀");
    }
  }
  logger.info({ wt: plan.worktree, removed: removed.length, freedBytes }, "워크스페이스 파생물 회수");

  let worktreeRemoved = false;
  let worktreeSkippedReason = null;
  if (opts.removeWorktree) {
    // ⚠ 계획 수립 이후 상태가 바뀌었을 수 있다(그 사이 누가 작업했을 수도) → **실행 직전에 다시 확인**한다.
    const recheck = await checkWorktree(plan.worktree);
    if (!recheck.removable) {
      worktreeSkippedReason = recheck.reason;
    } else if (!opts.repoRoot) {
      worktreeSkippedReason = "베이스 레포 경로를 몰라 워크트리를 제거하지 못했습니다";
    } else {
      const r = await git(["worktree", "remove", plan.worktree], opts.repoRoot);
      if (r.ok) {
        worktreeRemoved = true;
        await dropProvisionedEntry(plan.worktree);   // 마커가 죽은 경로를 가리키지 않도록(#918)
        logger.info({ wt: plan.worktree }, "워크트리 회수(푸시 완료·클린 확인)");
      } else {
        worktreeSkippedReason = `git worktree remove 실패: ${r.out}`;
      }
    }
  }
  return { removed, freedBytes, worktreeRemoved, worktreeSkippedReason };
}

  return { git, dirSizeFast, dirSizesFast, baseRepoOf, checkWorktree, planReclaim, applyReclaim };
}
