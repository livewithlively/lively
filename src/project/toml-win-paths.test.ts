// writable_roots 의 윈도우 경로 이스케이프 — 사양테스트.
//  실행: npm run build && node dist/project/toml-win-paths.test.js
//
//  계기(2026-08-04, 윈도우 실기기): `writable_roots = ["C:\Users\amorite\context-ontology"]` 를 우리가 썼고,
//  TOML basic string 은 백슬래시를 이스케이프로 읽으므로 `\U` 에서 `too few unicode value digits` 로
//  **config.toml 전체가 로드 실패** → codex 가 아예 안 떴다. 사용자는 손으로 고치기 전엔 못 쓴다.
//  이 결함 클래스는 **mac/linux 개발 박스에선 절대 재현되지 않는다**(경로 구분자가 슬래시라서).
//  그래서 단언은 "우리가 쓰는 값"과 "이미 깨진 값의 복구" 양쪽을 본다.
import { repairTomlWinPaths } from "./project-provision.js";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };
const bad = (n: string, why: string) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n: string, cond: boolean, why = "") => (cond ? ok(n) : bad(n, why));

// 우리가 값을 만들 때 쓰는 인코딩(생성부와 같은 규칙) — 이게 TOML basic string 으로 유효해야 한다.
const enc = (p: string) => JSON.stringify(p);

// W1 — 윈도우 경로를 값으로 만들면 백슬래시가 이스케이프된다(= codex 가 읽을 수 있다).
check("W1 윈도우 경로 인코딩", enc("C:\\Users\\amorite\\context-ontology") === '"C:\\\\Users\\\\amorite\\\\context-ontology"',
  enc("C:\\Users\\amorite\\context-ontology"));

// W2 — POSIX 경로는 그대로(회귀 없음).
check("W2 POSIX 경로 인코딩 무변화", enc("/Users/lively/workspace/repo") === '"/Users/lively/workspace/repo"', enc("/Users/lively/workspace/repo"));

// W3 — 옛 버전이 남긴 깨진 줄을 복구한다.
{
  const broken = '[sandbox_workspace_write]\n# lively: 프로젝트 59 레포\nwritable_roots = ["C:\\Users\\amorite\\context-ontology"]\n';
  const fixed = repairTomlWinPaths(broken);
  check("W3 깨진 윈도우 줄 복구", fixed.includes('"C:\\\\Users\\\\amorite\\\\context-ontology"'), fixed.split("\n")[2]);
}

// W4 — **이미 올바른 줄은 건드리지 않는다**(재실행마다 백슬래시가 늘어나면 그것도 고장이다).
{
  const good = 'writable_roots = ["C:\\\\Users\\\\a\\\\repo"]\n';
  check("W4 올바른 줄 멱등", repairTomlWinPaths(good) === good, repairTomlWinPaths(good));
  check("W4b 2회 적용 멱등", repairTomlWinPaths(repairTomlWinPaths(good)) === good, "이중 이스케이프");
}

// W5 — 유효 이스케이프는 보존한다(경로에 든 \n 을 개행으로 바꿔버리면 안 된다).
{
  const src = 'writable_roots = ["a\\tb", "c\\u00e9d", "e\\\\f"]\n';
  check("W5 유효 이스케이프 보존", repairTomlWinPaths(src) === src, repairTomlWinPaths(src));
}

// W6 — 우리 줄 **밖**은 불가침(사용자 설정을 건드리지 않는다).
{
  const other = 'model = "gpt-5.5"\nsome_other = ["C:\\Users\\x"]\nwritable_roots = ["C:\\Users\\y"]\n';
  const out = repairTomlWinPaths(other);
  check("W6 다른 키 불가침", out.includes('some_other = ["C:\\Users\\x"]'), "사용자 줄이 바뀌었다");
  check("W6b 우리 줄만 복구", out.includes('"C:\\\\Users\\\\y"'), "우리 줄이 안 고쳐졌다");
}

// W7 — 복구 후에는 **기록된 표기**로 중복이 잡혀야 한다(날것 경로로 찾으면 윈도우에선 영영 못 찾아 계속 쌓인다).
{
  const target = "C:\\Users\\amorite\\context-ontology";
  const fixed = repairTomlWinPaths(`writable_roots = ["${target}"]\n`);
  check("W7 중복 판정(인코딩 기준)", fixed.includes(enc(target)), "인코딩된 표기로 못 찾는다");
  check("W7b 날것 경로로는 못 찾는 게 정상", !fixed.includes(`"${target}"`), "날것이 남아 있다(복구 실패)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
