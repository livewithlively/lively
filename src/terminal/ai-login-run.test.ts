// 로그인 러너의 **셸 계약** (#2055 후속) — 생성되는 한 줄을 문자열로 검사한다(프로세스 없음).
//
//  이 셸이 틀리면 증상이 조용하다: 화면은 «시작 중…» 에 머물고 로그는 영영 비어 있다. 실제로 두 번 밟았다 —
//   ① `node -e <script> a b c` 는 a 가 argv[1] 이라 인자가 하나씩 밀렸다(로그 경로 자리에 슬롯 이름이 들어갔다).
//   ② 갓 만든 멤버 홈엔 `~/.codex` 가 없어 codex 가 «CODEX_HOME points to … does not exist» 로 즉사했다.
//  둘 다 «띄웠다» 는 신호는 정상이었다. 그래서 그 두 자리를 계약으로 못박는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loginStartSh } from "./ai-login-run.js";
import { aiLoginArgv, EXIT_MARK } from "./ai-login-flow.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const SH = loginStartSh({ home: "/home/box_x", slotName: "lvly-login-codex-abc123", argv: aiLoginArgv("codex") });

t("배선 · 셸을 실제로 만들었다(vacuous 방지)", () => {
  assert.ok(SH.length > 300);
  assert.match(SH, /codex' 'login' '--device-auth'/);
});

t("★ D1 `node -e` 의 인자 밀림을 지킨다 — 슬롯 이름표가 첫 인자다", () => {
  assert.match(SH, /const log=process\.argv\[2\],inp=process\.argv\[3\],pidf=process\.argv\[4\],argv=process\.argv\.slice\(5\)/);
  // 이름표 → 로그 → 입력 → 명령 순으로 넘긴다(그 순서가 위 인덱스의 근거다).
  assert.match(SH, /node -e '.*' 'lvly-login-codex-abc123' '\/home\/box_x\/\.cache\/lvly-login-codex-abc123\.log'/);
});

t("★ D2 하네스 홈을 먼저 보장한다 — 없으면 codex 가 설정을 못 읽고 즉사한다", () => {
  //  ⚠ 하네스가 늘 때 **여기에 한 줄 더하는 것을 잊으면 그 하네스에서만 조용히 깨진다.** 그래서 순서를 고정한
  //   한 줄이 아니라 «이 통로가 다루는 하네스의 홈이 전부 있나» 로 본다 — 목록이 늘면 이 단언이 먼저 깨진다.
  const m = SH.match(/mkdir -p ([^\n]*)/);
  assert.ok(m, "홈 보장 줄이 있다");
  for (const d of [".cache", ".codex", ".claude", ".grok"]) {
    assert.ok(m![1].includes(`'/home/box_x/${d}'`), `${d} 홈을 보장한다`);
  }
});

t("★ D3 이미 돌고 있으면 다시 안 띄운다 — 둘이 같은 자격 파일을 노리면 서로를 덮는다", () => {
  //  ⚠ 이 단언의 첫 판은 `pgrep -f <슬롯>` 을 **요구**했다 — 즉 결함을 계약으로 고정하고 있었다.
  //   중계가 이 스크립트를 `sh -c "<본문>"` 으로 돌리므로 그 pgrep 은 자기 셸을 잡아 늘 «돌고 있다» 가 됐고,
  //   로그인이 한 번도 안 떴다(실측 2026-08-28 프로덕션). 생존 판정은 **우리가 쓴 pid 파일**로만 한다.
  assert.match(SH, /kill -0 "\$\(cat '[^']*lvly-login-codex-abc123\.pid'[^\n]*echo running/);
});

t("★ D4 새로 띄울 때는 지난 로그를 지운다 — 안 지우면 **만료된 코드**를 보여준다", () => {
  const i = SH.indexOf("rm -f "), j = SH.indexOf("nohup node");
  assert.ok(i > 0 && i < j, "띄우기 직전에 지운다");
  assert.match(SH.slice(i, j), /\.log' '[^']*\.in'/);
});

t("★ D5 끝나면 종료코드를 로그에 남긴다 — 화면이 «끝났다»를 알 유일한 단서다", () => {
  assert.ok(SH.includes(EXIT_MARK), "종료 표식을 남긴다");
});

t("D6 바이너리가 없으면 그렇게 말한다(127)", () => {
  assert.match(SH, /command -v 'codex'[^\n]*exit 127/);
});

t("D7 detached 로 띄운다 — 게이트웨이가 재기동돼도 로그인이 이어진다", () => {
  assert.match(SH, /nohup node -e .* >\/dev\/null 2>&1 &/);
});

// ── 어느 자리에서 띄우나 (실측 2026-09-01, 매니지드 프로덕션) ─────────────────────────────────
//  종전엔 무조건 멤버 중계로 띄웠다. 매니지드에서 그건 **tmux 컨테이너**인데, #2454(이미지 역할 분할)가
//  거기서 하네스 4종을 걷어냈다 — 화면이 «grok 없음» 만 뱉었고, 그게 인라인 카드 통로 전체를 죽였다
//  (grok 만이 아니라 codex·claude 도). 하네스는 **세션 컨테이너**에만 있다.
//  그래서 «띄우는 것» 만 세션 경계로 보내고, 읽기·붙여넣기·정리는 멤버 경계로 남긴다(홈 볼륨 공유).
t("★ D10 띄우는 자리와 읽는 자리를 가른다 — 하네스는 세션 컨테이너에만 있다", () => {
  const src = readFileSync(new URL("./ai-login-run.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
  const code = src.split("\n").filter((l: string) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  //  띄우기는 세션 경계를 **탄다**.
  assert.match(code, /sessionSpawnArgv\(sid, \["sh", "-c", script\]\)/, "띄우기는 세션 컨테이너에서 돈다");
  assert.match(code, /kind: "login"/, "사람 세션으로 새지 않는다(#2162 종류 축)");
  assert.match(code, /harness: "shell"/, "하네스 TUI 를 띄우지 않는다 — 필요한 건 바이너리가 있는 자리뿐이다");
  //  읽기·붙여넣기는 **멤버 경계 그대로**여야 한다(파일만 만지고, 홈은 두 컨테이너가 같은 볼륨으로 본다).
  const read = code.slice(code.indexOf("export async function readAiLogin"), code.indexOf("export async function pasteAiLogin"));
  assert.ok(!/sessionSpawnArgv/.test(read), "읽기는 세션 컨테이너를 만들지 않는다(파일만 본다)");
  //  중계가 없는 배포(셀프호스트)는 종전 자리로 접힌다 — fail-open.
  assert.match(code, /if \(!user \|\| !sessionExecConfigured\(\)\) return sh\(osUser, script\)/, "세션 경계가 없으면 종전 자리");
});

t("★ D9 grok 도 이 러너로 띄운다 — device-auth 한 줄(재실측 2026-09-01, grok 1.0.13)", () => {
  const sh = loginStartSh({ home: "/h", slotName: "s", argv: aiLoginArgv("grok") });
  assert.match(sh, /grok' 'login' '--device-auth'/);
  assert.match(sh, /command -v 'grok'[^\n]*exit 127/, "바이너리가 없으면 그렇게 말한다");
});

t("★ D8 claude 는 stdin 을 되받는다 — 입력 파일을 폴링해 자식에게 넘긴다", () => {
  const sh = loginStartSh({ home: "/h", slotName: "s", argv: aiLoginArgv("claude") });
  assert.match(sh, /claude' 'auth' 'login'/);
  assert.match(sh, /readFileSync\(inp,"utf8"\);fs\.unlinkSync\(inp\);c\.stdin\.write/);
});

// ── 자기참조 금지 (실측 2026-08-28, 매니지드 프로덕션) ────────────────────────────────────────────
//  이 스크립트는 멤버 중계가 `sh -c "<스크립트 전문>"` 으로 돌린다. 그래서 스크립트가 **자기 본문에 있는
//  문자열로 프로세스를 찾으면 자기를 찾는다.** 종전 판은 `pgrep -f <슬롯>` 이라 늘 «이미 돌고 있다» 가 되어
//  로그인이 한 번도 안 떴고(화면은 «시작하는 중» 에서 조용히 멈춘다), cancel 의 `pkill -f <슬롯>` 은
//  자기 셸을 죽여 뒤의 rm 까지 가지 못했다(만료된 옛 로그가 다음 사람에게 보였다).
//  주석으로 적어 두는 것으로는 안 막힌다 — 여기서 단언한다.
t("★ 프로세스를 슬롯 이름으로 찾지 않는다 — 자기 자신을 잡는다", () => {
  const sh = loginStartSh({ home: "/home/box_x", slotName: "lvly-login-codex-abc123", argv: ["codex", "login", "--device-auth"] });
  const code = sh.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/\bpgrep\b/.test(code), "pgrep 은 자기 셸을 잡는다");
  assert.ok(!/\bpkill\b/.test(code), "pkill 은 자기 셸을 죽인다");
  // 생존 판정은 우리가 쓴 pid 파일로 한다.
  assert.match(code, /kill -0 "\$\(cat '[^']*\.pid'/, "pid 파일로 생존을 판정한다");
});
t("★ 죽은 자리는 흔적째 치운다 — 만료된 코드가 남으면 다음 사람이 그걸 본다", () => {
  const sh = loginStartSh({ home: "/home/box_x", slotName: "s1", argv: ["codex", "login"] });
  const rm = sh.split("\n").find((l) => l.startsWith("rm -f")) || "";
  for (const ext of [".log", ".in", ".pid"]) assert.ok(rm.includes(ext), `rm 에 ${ext} 가 없다`);
});
t("★ 러너가 pid 를 남기고, 끝나면 지운다 — 남으면 영영 «돌고 있다» 가 된다", () => {
  const sh = loginStartSh({ home: "/home/box_x", slotName: "s1", argv: ["codex", "login"] });
  assert.match(sh, /fs\.writeFileSync\(pidf,String\(process\.pid\)\)/);
  assert.match(sh, /const done=\(\)=>\{try\{fs\.unlinkSync\(pidf\)\}/);
  // 종료·오류·취소(SIGTERM) 세 갈래 모두에서 지운다.
  // 갈래는 셋 — 오류(error) · 취소(SIGTERM) · 정상종료(exit). 정의부(`const done=()=>`)는 세지 않는다.
  assert.ok((sh.match(/done\(\);/g) || []).length >= 3, "세 갈래 모두에서 pid 를 지운다");
  assert.match(sh, /process\.on\("SIGTERM"/, "취소가 자식까지 내린다");
});

console.log(`\n${pass} passed`);
