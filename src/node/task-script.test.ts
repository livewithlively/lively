// 위탁 하네스 기동 스크립트(#1289 회귀 가드) — 프롬프트가 하네스에 **실제로** 도달하는가.
//
// 왜 이 테스트가 있나: 종전 스크립트는 `claude -p "$(cat prompt.txt)"` 로 프롬프트를 argv 에 펼쳤다.
// 리눅스는 인자 하나가 MAX_ARG_STRLEN(32×4096 = 131,072B)을 넘으면 exec 이 E2BIG 으로 죽는다.
// 그 실패는 특히 고약하다 — claude 가 **실행조차 안 되므로** stream.jsonl 이 0줄이고, 위탁은 실패로
// 끝나며, 배치 seen 롤백 때문에 같은 프롬프트가 영원히 재시도된다(진행 0, 원인은 stderr.log 한 줄).
// 프롬프트에 자료 본문을 싣기 시작하면서(#1289) 이건 이론이 아니라 현실적 위험이 됐다.
//
// 문자열을 match 하지 않고 **스텁 하네스로 실제 실행**해 관측한다 — 스크립트가 무엇처럼 생겼나가 아니라
// 프롬프트가 정말 전달됐나·종료코드가 정말 하네스의 것인가를 본다(문구를 바꿔도 안 깨지고, 배선이
// 죽으면 반드시 깨진다).
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { taskScript } from "./tasks.js";

const ARG_MAX_STRLEN = 131_072;   // exec 인자 1개 상한(실측)
let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// 스텁 하네스 — stdin 을 통째로 받아 파일로 남기고, argv 도 남기고, 지정 코드로 끝난다.
function setup(prompt: string, exitCode = 0): { dir: string; run: () => number; got: () => string; argv: () => string } {
  const root = mkdtempSync(path.join(tmpdir(), "taskscript-"));
  const taskDir = path.join(root, "task"); mkdirSync(taskDir);
  const ws = path.join(root, "ws"); mkdirSync(ws);
  const bin = path.join(root, "stub-harness");
  writeFileSync(bin, `#!/bin/sh\ncat > "${root}/got.txt"\nprintf '%s' "$*" > "${root}/argv.txt"\nexit ${exitCode}\n`);
  chmodSync(bin, 0o755);
  writeFileSync(path.join(taskDir, "prompt.txt"), prompt);
  const script = taskScript(bin, ["--model", "opus"], taskDir);
  return {
    dir: taskDir,
    run: () => {
      // SHELL=/bin/true → 스크립트 끝의 `exec "${SHELL:-sh}"` 가 즉시 끝난다(대화형 셸로 매달리지 않게).
      try { execFileSync("/bin/sh", ["-c", script], { env: { ...process.env, LIVELY_TASK_WS: ws, SHELL: "/bin/true" } }); }
      catch { /* 스텁이 비0 으로 끝나는 경우 — exit 파일로 판정한다 */ }
      const f = path.join(taskDir, "exit");
      return existsSync(f) ? Number(readFileSync(f, "utf8").trim()) : -1;
    },
    got: () => (existsSync(path.join(root, "got.txt")) ? readFileSync(path.join(root, "got.txt"), "utf8") : ""),
    argv: () => (existsSync(path.join(root, "argv.txt")) ? readFileSync(path.join(root, "argv.txt"), "utf8") : ""),
  };
}

// S1 — 프롬프트가 하네스에 바이트 그대로 도달한다(배선 확인: 이게 죽으면 아래 단언들이 공허해진다).
{
  const p = "안녕 — 자료 본문 포함 프롬프트\n둘째 줄";
  const s = setup(p);
  assert.equal(s.run(), 0);
  assert.equal(s.got(), p, "프롬프트가 하네스 stdin 에 그대로 도달해야 한다");
  pass++; console.log("ok  S1 프롬프트가 하네스에 바이트 그대로 전달된다");
}

// S2 — 핵심. exec 인자 상한을 넘는 프롬프트에서도 하네스가 **실행되고** 전문을 받는다.
//  argv 방식이면 여기서 E2BIG 으로 하네스가 아예 안 뜬다.
t("S2 128KB 초과 프롬프트에서도 하네스가 실행되고 전문을 받는다(argv 였다면 E2BIG)", () => {
  const big = "가".repeat(60_000);                      // 한글 3바이트 → 180,000B
  assert.ok(Buffer.byteLength(big, "utf8") > ARG_MAX_STRLEN, "표본이 상한을 넘겨야 이 테스트가 의미가 있다");
  const s = setup(big);
  assert.equal(s.run(), 0, "상한 초과 프롬프트에서 하네스가 실행조차 못 되면 배치가 영원히 재시도된다");
  assert.equal(Buffer.byteLength(s.got(), "utf8"), Buffer.byteLength(big, "utf8"), "전문이 잘리지 않고 도달해야 한다");
});

// S3 — 종료코드는 **하네스의 것**이 exit 파일에 남는다(앞 단계에 가려지지 않는다).
t("S3 하네스 종료코드가 그대로 exit 파일에 남는다", () => {
  assert.equal(setup("x", 7).run(), 7, "파이프로 이으면 앞 단계 실패가 $? 를 가린다 — 리다이렉션이어야 한다");
});

// S4 — 프롬프트 파일이 없으면 **실패가 기록된다**(무증상 무한대기 금지).
t("S4 프롬프트 파일 부재 → 비0 이 exit 에 남는다(조용히 매달리지 않는다)", () => {
  const s = setup("x");
  execFileSync("/bin/rm", [path.join(s.dir, "prompt.txt")]);
  const code = s.run();
  assert.notEqual(code, 0, "입력이 없는데 성공으로 끝나면 빈 배치가 성공으로 집계된다");
  assert.notEqual(code, -1, "exit 파일 자체가 없으면 위탁이 타임아웃까지 '실행 중'으로 매달린다");
});

// S5 — 출력 분리 유지(stdout=stream.jsonl / stderr=stderr.log). 섞이면 스트림 파싱이 깨진다.
t("S5 stdout·stderr 가 각각의 파일로 분리된다", () => {
  const s = setup("x");
  s.run();
  assert.ok(existsSync(path.join(s.dir, "stream.jsonl")), "stream.jsonl 이 없으면 진행 미러가 죽는다");
  assert.ok(existsSync(path.join(s.dir, "stderr.log")), "stderr.log 가 없으면 실패 원인이 어디에도 안 남는다");
});

// S6 — 플래그는 계속 argv 로 간다(모델·effort 지정이 사라지면 안 된다).
t("S6 하네스 플래그가 그대로 전달된다", () => {
  const s = setup("x");
  s.run();
  assert.match(s.argv(), /--model opus/, "플래그가 빠지면 증류기별 모델·effort 지정이 무시된다");
  assert.match(s.argv(), /--output-format stream-json/);
});

console.log(`task-script.test: ok (${pass})`);
