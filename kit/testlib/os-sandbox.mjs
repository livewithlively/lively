// 테스트용 크로스플랫폼 샌드박스 헬퍼 (#1510) — 배포 번들에 안 들어간다(테스트 전용).
//
// 왜 이 파일이 생겼나 — 2026-08-04 windows-latest CI 첫 실행에서 kit 테스트 33건 중 18건이 깨졌고,
//  그중 상당수가 **테스트가 격리를 만드는 방식**에 POSIX 를 가정한 것이었다. 두 가지가 반복됐다:
//
//   ① `env: { HOME, TMPDIR }` 로 홈·임시폴더를 돌린다 → 윈도우에선 **아무 효과가 없다.**
//      node 의 os.homedir() 는 윈도우에서 USERPROFILE 을, os.tmpdir() 는 TEMP/TMP 를 본다.
//      결과가 '테스트 실패'로만 보였지만 실제로는 더 나쁘다 — 훅이 **실행하는 사람의 진짜 홈과
//      진짜 임시폴더**에 파일을 쓴다(샌드박스 탈출). 게다가 케이스들이 같은 실디렉터리를 공유하게 되어
//      앞 케이스가 남긴 상태가 뒤 케이스의 판정을 바꾼다(work-flag-lifecycle 스로틀 오판이 그 경우).
//
//   ② PATH 앞에 `#!/bin/sh` 스텁을 두어 외부 명령(claude·git…)을 가로챈다 → 윈도우에선 그 파일이
//      **실행 가능하지 않다.** 가로채기가 조용히 실패하고 진짜 명령이 불리거나(실기기 오염) 아무것도
//      안 불려 테스트가 "스텁 호출 0건"만 본다. PATH 구분자도 `:` 가 아니라 `;` 다.
//
//  두 관례를 여기 한 곳에 못박아, 다음 테스트가 같은 함정을 다시 열지 않게 한다.
import { writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join, delimiter } from "node:path";

export const WIN = process.platform === "win32";

// 자식 프로세스의 os.homedir()/os.tmpdir() 를 **실제로** 샌드박스로 돌리는 env 조각.
//  플랫폼별 변수를 모두 세운다 — 분기해서 하나만 세우면 "이 테스트는 어느 쪽이더라"를 매번 다시 틀린다.
//  ⚠ 인프로세스(process.env 직접 대입)로 쓸 때도 이걸 통해야 한다 — 같은 이유로 HOME 만 대입하면 윈도우에서 샌다.
export function sandboxEnv({ home, tmp } = {}) {
  const e = {};
  if (home) { e.HOME = home; e.USERPROFILE = home; }        // POSIX / 윈도우
  if (tmp) { e.TMPDIR = tmp; e.TEMP = tmp; e.TMP = tmp; }   // POSIX / 윈도우(TEMP 우선, TMP 폴백)
  return e;
}

// process.env 에 직접 샌드박스를 건다(인프로세스 테스트용). 되돌리는 함수를 돌려준다.
export function applySandboxEnv({ home, tmp } = {}) {
  const patch = sandboxEnv({ home, tmp });
  const prev = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
  Object.assign(process.env, patch);
  return () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

// PATH 앞에 dir 을 붙인다(구분자 플랫폼별). base 를 빈 문자열로 주면 '닫힌 PATH'.
export function pathWith(dir, base = process.env.PATH) {
  return base ? `${dir}${delimiter}${base}` : String(dir);
}

// '닫힌 PATH' — 실제 하네스(claude·codex)가 **절대** 안 잡히도록 최소 시스템 경로만 남긴다.
//  ⚠ 윈도우에서 시스템 경로까지 지우면 안 된다: has() 가 쓰는 `where.exe` 와 shell:true 의 cmd.exe 가 거기 있다.
//   (사용자가 깐 하네스는 %USERPROFILE%·Program Files 쪽이라 아래 목록엔 안 들어온다.)
export function closedPath(dir) {
  if (!WIN) return [dir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
  const root = process.env.SystemRoot || "C:\\Windows";
  return [dir, join(root, "System32"), root, join(root, "System32", "Wbem")].join(delimiter);
}

// 실 브라우저를 못 열게 하는 env 조각 — **lively CLI 를 프로세스로 띄우는 테스트는 반드시 얹는다.**
//  왜 PATH 로 안 되나: device-code 로그인은 승인 URL 을 `open`(darwin)·`cmd /c start`(win)·`xdg-open`(linux)
//   으로 띄우는데, 위 closedPath() 는 /usr/bin·System32 를 **일부러 남긴다**(where.exe·cmd.exe 가 거기 있다).
//   그래서 스텁을 심지 않는 한 진짜 `open` 이 잡히고, 테스트가 **실행하는 사람의 브라우저에** 픽스처 URL
//   탭을 띄운다(#1717 실측: `npm test` 한 번에 5개 — http://127.0.0.1/device?c=WXYZ-8899 등).
//   홈·임시폴더와 같은 종류의 샌드박스 탈출이라 같은 자리에 관례로 못박는다.
//  ⚠ 이건 '테스트 편의'가 아니라 격리다 — URL·코드는 CLI 가 화면에 먼저 찍으므로 안 열려도 로그인은 완주한다.
export const noBrowserEnv = () => ({ LIVELY_NO_BROWSER: "1" });

// 실행 가능한 스텁 명령을 만든다 — **로직은 JS 한 벌**로 쓰고 런처만 플랫폼별로 낸다.
//  종전처럼 스텁 본문을 sh 스크립트로 쓰면 윈도우 분량을 배치로 한 벌 더 써야 하고, 그 두 벌은 반드시 어긋난다.
//  jsBody 는 node 로 실행되는 ESM 소스이며 인자는 process.argv.slice(2) 로 받는다.
//  반환: **실행할 경로(런처)** — POSIX 는 `<dir>/<name>`, 윈도우는 `<dir>/<name>.cmd`.
//   PATH 에 얹어 이름으로 부를 거면 무시해도 되지만, 경로로 직접 넘길 땐(예: --harness <경로>) 이 값을 써야 한다.
export function writeStubBin(dir, name, jsBody) {
  mkdirSync(dir, { recursive: true });
  const impl = join(dir, `${name}.stub.mjs`);
  writeFileSync(impl, jsBody.endsWith("\n") ? jsBody : jsBody + "\n");
  if (WIN) {
    // cmd.exe 는 CRLF 를 기대한다(LF 만이면 라벨·괄호 블록이 어긋난다). 이건 생성물이라 .gitattributes 와 무관.
    const launcher = join(dir, `${name}.cmd`);
    writeFileSync(launcher, [
      "@echo off",
      `"${process.execPath}" "${impl}" %*`,
      "exit /b %errorlevel%",
      "",
    ].join("\r\n"));
    return launcher;
  }
  const launcher = join(dir, name);
  writeFileSync(launcher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(impl)} "$@"\n`);
  chmodSync(launcher, 0o755);
  return launcher;
}

// 아무 일도 안 하고 성공하는 스텁(하네스를 PATH 에서 '가리기'만 할 때).
export const writeNoopBin = (dir, name) => writeStubBin(dir, name, "process.exit(0);");
