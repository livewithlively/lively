// #2172 ④ — 깔아 준 claude 가 **새 터미널에서도** 잡히게. 사양·엣지 표는 스크래치패드 spec4.md(9행).
//
//  ── 무엇이 잘못됐었나 ──
//  `lively install` 은 하네스가 하나도 없으면 claude 를 깔아 준다(`curl claude.ai/install.sh | bash`, POSIX만).
//  그런데 PATH 영속화를 안 했다 — 코드 주석이 그렇게 적고 있었다:
//    "claude 설치기는 ~/.local/bin 에 넣고 PATH 영속화는 사용자 몫으로 남긴다 — 이 프로세스에서만 보이게 해 둔다."
//  그러면 우리가 깔아 준 claude 가 **그 창에서만** 보이고 새 터미널에선 `command not found` 다. claude 설치기
//  자신도 그 일을 사용자에게 떠넘기므로(경고만 출력) 아무도 안 하는 일이 된다. #355 의 setup-mac.sh 는 이걸
//  했는데 CLI(#864)로 오면서 빠졌고, uninstall 쪽엔 "local-bin 블록은 claude 소유라 보존한다"는 주석만
//  **유물로** 남아 있었다 — 쓰는 쪽이 없어 그 보존 규칙이 죽은 문장이었다.
//
//  🔴 두 방향의 값이 다르다:
//   · 안 심으면 → 깔아 준 의미가 없다(오늘의 결함).
//   · 잘못 심으면 → 남의 rc 를 망가뜨린다. **되돌릴 수 없다.** 그래서 비파괴·멱등·백업을 아래가 지킨다.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const HERE = join(fileURLToPath(import.meta.url), "..");
const { localBinRcBlock, LOCAL_BIN_BEGIN, LOCAL_BIN_END } =
  await import(pathToFileURL(join(HERE, "lively.mjs")));

// 1) 이 수정의 목적 — 빈손이면 블록을 만든다.
test("1 블록이 없으면 심을 내용을 돌려준다", () => {
  const b = localBinRcBlock("export FOO=1\n");
  assert.ok(b && b.includes(LOCAL_BIN_BEGIN) && b.includes(LOCAL_BIN_END));
});

// 2) 멱등 — 이미 있으면 **null**(= 건드리지 않는다). 두 번 심으면 PATH 가 자라고, 그게 #2172 본편의 사고다.
test("2 이미 블록이 있으면 null — 두 번 심지 않는다", () => {
  const rc = `x\n${LOCAL_BIN_BEGIN}\nold\n${LOCAL_BIN_END}\n`;
  assert.equal(localBinRcBlock(rc), null);
});

// 3) 비파괴 — 돌려주는 것은 **이어붙일 조각**이다. 기존 내용을 다시 쓰지 않는다(호출부가 cur + block 한다).
test("3 기존 rc 내용을 포함하지 않는다(append-only 조각)", () => {
  const b = localBinRcBlock("export SECRET=keep-me\n");
  assert.ok(!b.includes("SECRET"), "기존 내용을 되뱉으면 호출부가 중복 기록한다");
});

// 8) source 를 두 번 해도 PATH 가 안 자라야 한다 — 블록 안에 중복 방지 case 문이 있어야 한다.
test("8 블록이 PATH 중복 추가를 스스로 막는다", () => {
  const b = localBinRcBlock("");
  assert.ok(/case ":\$PATH:" in/.test(b), "중복 방지 case 문이 없다");
  assert.ok(b.includes('$HOME/.local/bin'), "대상 디렉터리가 없다");
});

// 경계 — 빈 rc 와 개행 없이 끝나는 rc. 앞줄이 붙어버리면 rc 가 깨진다(`fi# >>> …`).
test("경계 빈 rc 면 앞에 빈 줄을 안 만든다", () => {
  assert.ok(localBinRcBlock("").startsWith(LOCAL_BIN_BEGIN));
});
test("경계 개행 없이 끝나는 rc 앞에는 개행을 넣는다", () => {
  const b = localBinRcBlock("fi");
  assert.ok(b.startsWith("\n"), "앞줄에 이어붙으면 rc 가 깨진다");
});

// ── 배선 — 순수 조각이 맞아도 **호출되지 않으면** 아무 일도 안 일어난다. ──
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CLI = code(readFileSync(join(HERE, "lively.mjs"), "utf8"));

// 9) claude 를 **우리가 깔았을 때만** 심는다 — 안 깔았으면 남의 PATH 를 안 건드린다.
test("9 claude 설치 직후에만 PATH 를 심는다", () => {
  const i = CLI.indexOf("claude.ai/install.sh");
  assert.ok(i > 0, "설치 호출을 못 찾았다");
  const after = CLI.slice(i, i + 600);
  assert.ok(/wireLocalBinPath\(\)/.test(after), "설치 직후에 안 부른다");
  //  정의(`function wireLocalBinPath()`)는 빼고 **호출**만 센다 — 호출이 여러 곳이면 우리가 안 깐 경우에도 심게 된다.
  const calls = (CLI.match(/(?<!function )wireLocalBinPath\(\)/g) || []).length;
  assert.equal(calls, 1, `호출은 설치 직후 한 곳뿐이어야 한다(지금 ${calls}곳)`);
});

// 7) Windows 는 대상이 아니다 — 거기선 우리가 claude 를 안 깐다(안내만 한다).
test("7 Windows 에서는 아무것도 하지 않는다", () => {
  assert.ok(/function wireLocalBinPath\(\) \{\s*if \(WIN\) return;/.test(CLI), "win32 조기 반환이 없다");
});

// 4) pristine 백업은 **한 번만** — 두 번째 실행이 백업을 덮으면 복구가 죽는다.
test("4 백업은 없을 때만 쓴다(덮지 않는다)", () => {
  assert.ok(/if \(!existsSync\(bak\)\) writeFileSync\(bak, cur\)/.test(CLI));
});

// 5·6) rc 가 없으면 만들고, 여러 개면 전부에 심는다(사용자가 어느 셸을 쓸지 모른다).
test("5·6 rc 후보 넷을 보고, 하나도 없으면 .zshrc 를 만든다", () => {
  assert.ok(/\[".zshrc", ".bashrc", ".bash_profile", ".profile"\]/.test(CLI));
  assert.ok(/rcs\.push\(z\)/.test(CLI), "rc 가 없을 때 만드는 경로가 없다");
});

// 센티넬은 user-uninstall 과 **공유하는 약속**이다 — 리터럴이 갈리면 제거·보존 규칙이 조용히 죽는다.
test("센티넬 리터럴이 uninstall 쪽 약속과 같다", () => {
  const un = readFileSync(join(HERE, "..", "setup", "user-uninstall.mjs"), "utf8");
  assert.ok(un.includes(LOCAL_BIN_BEGIN), "uninstall 이 아는 리터럴과 다르다");
});
