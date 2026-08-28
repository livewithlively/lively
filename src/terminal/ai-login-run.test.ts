// 로그인 러너의 **셸 계약** (#2055 후속) — 생성되는 한 줄을 문자열로 검사한다(프로세스 없음).
//
//  이 셸이 틀리면 증상이 조용하다: 화면은 «시작 중…» 에 머물고 로그는 영영 비어 있다. 실제로 두 번 밟았다 —
//   ① `node -e <script> a b c` 는 a 가 argv[1] 이라 인자가 하나씩 밀렸다(로그 경로 자리에 슬롯 이름이 들어갔다).
//   ② 갓 만든 멤버 홈엔 `~/.codex` 가 없어 codex 가 «CODEX_HOME points to … does not exist» 로 즉사했다.
//  둘 다 «띄웠다» 는 신호는 정상이었다. 그래서 그 두 자리를 계약으로 못박는다.
import assert from "node:assert/strict";
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
  assert.match(SH, /const log=process\.argv\[2\],inp=process\.argv\[3\],argv=process\.argv\.slice\(4\)/);
  // 이름표 → 로그 → 입력 → 명령 순으로 넘긴다(그 순서가 위 인덱스의 근거다).
  assert.match(SH, /node -e '.*' 'lvly-login-codex-abc123' '\/home\/box_x\/\.cache\/lvly-login-codex-abc123\.log'/);
});

t("★ D2 하네스 홈을 먼저 보장한다 — 없으면 codex 가 설정을 못 읽고 즉사한다", () => {
  assert.match(SH, /mkdir -p '\/home\/box_x\/\.cache' '\/home\/box_x\/\.codex' '\/home\/box_x\/\.claude'/);
});

t("★ D3 이미 돌고 있으면 다시 안 띄운다 — 둘이 같은 자격 파일을 노리면 서로를 덮는다", () => {
  assert.match(SH, /pgrep -f 'lvly-login-codex-abc123'[^\n]*echo running/);
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

t("★ D8 claude 는 stdin 을 되받는다 — 입력 파일을 폴링해 자식에게 넘긴다", () => {
  const sh = loginStartSh({ home: "/h", slotName: "s", argv: aiLoginArgv("claude") });
  assert.match(sh, /claude' 'auth' 'login'/);
  assert.match(sh, /readFileSync\(inp,"utf8"\);fs\.unlinkSync\(inp\);c\.stdin\.write/);
});

console.log(`\n${pass} passed`);
