// Windows 노드 상시화의 **정적 계약**(#1541) — 순수함수라 어느 플랫폼에서든 돈다.
//
// ⚠ 이 파일이 존재하는 이유: `lively node` 의 Windows 분기는 mac/linux CI 에서 **한 번도 실행되지 않는다**.
//  #1510 이 같은 자리에서 얻은 교훈 그대로다 — 실행 커버리지가 0인 표면은 계약을 코드로 못박지 않으면
//  조용히 썩는다. 그래서 경로 목록·작업 스케줄러 XML 생성을 순수함수로 빼고 여기서 직접 검증한다.
//  (실기기 e2e 는 별도 — Windows VM 에서 등록·기동까지 확인한다.)
// 실행: node kit/cli/node-win-contract.test.mjs
import assert from "node:assert/strict";
import { muxCandidates, winTaskXml, winRunnerCmd, resolveWinUserId, winInstallArgv } from "./cmd-node.mjs";

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };

const WIN_ENV = {
  LOCALAPPDATA: "C:\\Users\\yoon\\AppData\\Local",
  USERPROFILE: "C:\\Users\\yoon",
  ProgramFiles: "C:\\Program Files",
};

// ── A. muxCandidates ──────────────────────────────────────────────────────
t("W1 win32 — psmux 후보. 우리가 깐 자리가 1순위", () => {
  const c = muxCandidates("win32", WIN_ENV);
  assert.ok(c.length >= 3, `후보가 너무 적다: ${c.length}`);
  assert.ok(c.every((p) => /psmux\.exe$/i.test(p)), `psmux.exe 아닌 항목: ${c}`);
  assert.equal(c[0], "C:\\Users\\yoon\\.lively\\bin\\psmux\\psmux.exe");
});

t("W2 win32 — 경로가 Windows 구분자(POSIX 에서 만들어도 / 가 안 섞인다)", () => {
  for (const p of muxCandidates("win32", WIN_ENV)) {
    assert.ok(!p.includes("/"), `POSIX 구분자가 섞임: ${p}`);
    assert.ok(/^[A-Za-z]:\\/.test(p), `드라이브 절대경로가 아님: ${p}`);
  }
});

t("W3 win32 — LIVELY_HOME 을 홈으로 존중(샌드박스 계약)", () => {
  const c = muxCandidates("win32", { ...WIN_ENV, LIVELY_HOME: "D:\\sandbox" });
  assert.equal(c[0], "D:\\sandbox\\.lively\\bin\\psmux\\psmux.exe");
});

t("W4 win32 — env 가 비어도 throw 하지 않고 목록을 낸다", () => {
  const c = muxCandidates("win32", {});
  assert.ok(Array.isArray(c) && c.length >= 1, "빈 env 에서 목록이 비었다");
  assert.ok(c.every((p) => typeof p === "string" && p.length > 0), "빈 항목이 섞였다");
});

t("W5 POSIX — 종전 tmux 목록 그대로(무회귀)", () => {
  for (const plat of ["darwin", "linux"]) {
    const c = muxCandidates(plat, {});
    assert.deepEqual(c, ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/opt/local/bin/tmux", "/usr/bin/tmux"]);
  }
});

// ── A1-2. winget 패키지 id — 추측할 수 없고, 틀려도 조용히 실패한다 ────────
// 계기(#1541 실측): 코드가 `psmux.psmux` 로 깔려 있었는데 **그 id 는 존재하지 않는다**. winget 공식 소스
//  인덱스(source.msix 안의 index.db)를 직접 조회해 확정한 값이 `marlocarlo.psmux` 다(publisher 가 psmux 가
//  아니다 — psmux 퍼블리셔엔 psmux.TerminalMap 뿐). `-e` 덕에 엉뚱한 패키지가 깔리진 않지만, 틀리면 그냥
//  실패해 zip 폴백으로 떨어져 **아무 오류도 안 보이고 느려질 뿐**이라 아무도 눈치채지 못한다.
//  Windows 분기는 CI 에서 한 번도 실행되지 않으므로(#1510 §5) 문자열 자체를 여기서 못박는다.
t("W6 winget 설치 명령 — id 는 marlocarlo.psmux(존재하지 않는 psmux.psmux 아님)", () => {
  const argv = winInstallArgv();
  assert.equal(argv[argv.indexOf("--id") + 1], "marlocarlo.psmux");
  assert.ok(!argv.includes("psmux.psmux"), "존재하지 않는 id 로 되돌아갔다");
  // -e(exact) 가 빠지면 이름 검색으로 떨어져 **다른 패키지**가 깔릴 수 있다(psmux.TerminalMap 등 동명 후보 존재).
  assert.ok(argv.includes("-e"), "exact 매칭이 빠지면 엉뚱한 패키지를 깔 수 있다");
  // 무인 설치 — 프롬프트가 뜨면 데몬·설치 스크립트가 그대로 멈춘다.
  for (const f of ["--silent", "--accept-package-agreements", "--accept-source-agreements"]) {
    assert.ok(argv.includes(f), `무인 설치 플래그 누락: ${f}`);
  }
});

// ── A2. resolveWinUserId — 실기기에서 등록을 통째로 막았던 자리 ────────────
// 계기(#1541 실측): OpenSSH 로그온 세션에서 USERDOMAIN 이 `WORKGROUP` 으로 들어왔고, 그걸 그대로 쓰면
//  schtasks 가 "No mapping between account names and security IDs was done" 으로 **등록을 거부**한다.
//  워크그룹 머신에서 로컬 계정의 도메인은 컴퓨터명이다.
t("U1 whoami 가 machine\\user 를 주면 그걸 쓴다(1순위)", () => {
  assert.equal(resolveWinUserId({
    whoami: "ec2amaz-dnpmtv9\\administrator\n",
    computerName: "EC2AMAZ-DNPMTV9", userName: "Administrator", userDomain: "WORKGROUP",
  }), "ec2amaz-dnpmtv9\\administrator");
});

t("U2 ★ USERDOMAIN=WORKGROUP 은 절대 쓰지 않는다(등록 거부의 원인)", () => {
  const id = resolveWinUserId({ whoami: "", computerName: "MYPC", userName: "yoon", userDomain: "WORKGROUP" });
  assert.equal(id, "MYPC\\yoon");
  assert.ok(!/WORKGROUP/i.test(id), `WORKGROUP 이 샜다: ${id}`);
  // 컴퓨터명조차 없으면 사용자명만 — 그래도 WORKGROUP 을 붙이지는 않는다.
  const bare = resolveWinUserId({ whoami: "", computerName: "", userName: "yoon", userDomain: "WORKGROUP" });
  assert.ok(!/WORKGROUP/i.test(bare), `WORKGROUP 이 샜다: ${bare}`);
});

t("U3 진짜 도메인 가입 머신은 도메인을 존중한다", () => {
  assert.equal(resolveWinUserId({ whoami: "", computerName: "PC1", userName: "yoon", userDomain: "CORP" }), "PC1\\yoon");
  assert.equal(resolveWinUserId({ whoami: "CORP\\yoon", computerName: "PC1", userName: "yoon", userDomain: "CORP" }), "CORP\\yoon");
});

t("U4 입력이 전부 비어도 throw 하지 않는다", () => {
  assert.equal(resolveWinUserId({}), "");
  assert.equal(resolveWinUserId(), "");
});

// ── B. winTaskXml / winRunnerCmd ──────────────────────────────────────────
const ARGS = {
  nodeBin: "C:\\Users\\yoon\\.lively\\runtime\\node.exe",
  agentJs: "C:\\Users\\yoon\\.lively\\node-agent\\agent.mjs",
  envFile: "C:\\Users\\yoon\\.lively\\node-agent.env",
  logFile: "C:\\Users\\yoon\\.lively\\logs\\node-agent.log",
  userId: "EC2AMAZ-DNPMTV9\\Administrator",
};
const RUNNER = "C:\\Users\\yoon\\.lively\\node-agent-run.cmd";
const XML = winTaskXml({ runnerCmd: RUNNER, userId: ARGS.userId });
const CMD = winRunnerCmd(ARGS);

t("X1 부팅·로그인 트리거 — PC 재시작 시 자동 시작", () => {
  assert.match(XML, /<BootTrigger>[\s\S]*?<Enabled>true<\/Enabled>[\s\S]*?<\/BootTrigger>/);
  assert.match(XML, /<LogonTrigger>[\s\S]*?<Enabled>true<\/Enabled>[\s\S]*?<\/LogonTrigger>/);
  assert.ok(XML.includes(ARGS.userId), "트리거에 사용자가 없다");
});

t("X2 죽으면 재기동 — RestartOnFailure(KeepAlive 대응물)", () => {
  const m = XML.match(/<RestartOnFailure>\s*<Interval>(PT\w+)<\/Interval>\s*<Count>(\d+)<\/Count>/);
  assert.ok(m, "RestartOnFailure 가 없다 — 죽으면 그대로 죽는다");
  assert.equal(m[1], "PT1M");
  assert.ok(Number(m[2]) >= 1, "재시도 횟수가 0");
});

t("X3 실행시간 무제한 — 기본 3일 종료를 해제", () => {
  assert.match(XML, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
});

t("X4 사용자 신원으로 실행 — SYSTEM 아님 · 권한상승 없음 · 로그온 세션 불요", () => {
  // S4U = 그 사용자 컨텍스트를 유지하되 대화형 로그온을 요구하지 않는다.
  //  ⚠ InteractiveToken 으로 되돌리면 로그인 안 한 PC 에서 영영 안 돈다(실측: Last Result 267011).
  assert.match(XML, /<LogonType>S4U<\/LogonType>/);
  assert.ok(!/InteractiveToken/.test(XML), "InteractiveToken 은 로그온 세션이 없으면 실행되지 않는다");
  assert.match(XML, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.ok(!XML.includes("S-1-5-18"), "SYSTEM SID 가 들어 있다");
  assert.ok(!/HighestAvailable/.test(XML), "관리자 권한 상승을 요구한다");
});

t("X5 XML 은 런처 한 줄만 실행한다(인용 지옥 회피)", () => {
  const args = XML.match(/<Arguments>([\s\S]*?)<\/Arguments>/)[1];
  assert.ok(args.includes(RUNNER), "런처 경로가 없다");
  assert.match(XML, /<Command>cmd\.exe<\/Command>/);
});

// ── R. winRunnerCmd — 상시성의 실체가 여기 있다 ───────────────────────────
t("R1 ★ 죽으면 되살리는 루프가 있다(KeepAlive 대응물)", () => {
  // 실측(#1541 e2e): 스케줄러의 RestartOnFailure 만으로는 강제 종료된 프로세스가 3분 동안 안 살아났다.
  //  런처가 직접 되살려야 launchd KeepAlive · systemd Restart=always 와 같은 보장이 된다.
  assert.match(CMD, /^:loop$/m, ":loop 라벨이 없다");
  assert.match(CMD, /^goto loop$/m, "goto loop 가 없다 — 한 번 죽으면 그대로 끝난다");
  assert.match(CMD, /timeout \/t \d+/, "재시작 백오프가 없다(즉시 재시작 폭주)");
});

t("R2 ★ 토큰이 명령줄에 실리지 않는다(--env-file 경유)", () => {
  assert.ok(CMD.includes("--env-file"), "--env-file 을 안 쓴다");
  assert.ok(CMD.includes(ARGS.envFile), "env 파일 경로가 없다");
  for (const secretish of ["LIVELY_NODE_TOKEN=", "lvk_", "Bearer "]) {
    assert.ok(!CMD.includes(secretish) && !XML.includes(secretish), `비밀이 실렸다: ${secretish}`);
  }
});

t("R3 로그를 파일로 append(진단 가능성)", () => {
  assert.ok(CMD.includes(">>"), "append 리다이렉트가 없다");
  assert.ok(CMD.includes("2>&1"), "stderr 를 안 모은다");
  assert.ok(CMD.includes(ARGS.logFile), "로그 경로가 없다");
});

t("R4 .cmd 는 ASCII 전용 + CRLF (코드페이지·파서 안전)", () => {
  // 한글 주석을 넣으면 cp949 콘솔에서 깨진다. BOM 도 넣으면 안 된다(.ps1 과 규칙이 반대다).
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[^\x00-\x7F]/.test(CMD), "비-ASCII 문자가 있다");
  assert.ok(!CMD.startsWith("﻿"), "BOM 이 붙었다(.cmd 는 첫 줄이 깨진다)");
  assert.ok(CMD.includes("\r\n"), "CRLF 가 아니다");
  assert.match(CMD, /^@echo off/, "@echo off 로 시작하지 않는다");
});

t("R5 결정적 — 같은 입력이면 같은 런처", () => {
  assert.equal(winRunnerCmd(ARGS), winRunnerCmd(ARGS));
});

t("X7 XML 이스케이프 — 경로·사용자명의 & < > 가 원문으로 새지 않는다", () => {
  const xml = winTaskXml({
    runnerCmd: "C:\\x&y\\a<b>\\run.cmd",
    userId: "DOM&AIN\\a<b>c",
  });
  // 원문 그대로 들어가면 XML 파싱이 깨진다 → 엔티티로 나가야 한다.
  assert.ok(xml.includes("DOM&amp;AIN"), "& 가 이스케이프 안 됨");
  assert.ok(xml.includes("a&lt;b&gt;c"), "< > 가 이스케이프 안 됨");
  // 태그 밖 텍스트에 날 `<` 가 남으면 안 된다: 태그를 전부 지운 뒤 확인.
  const textOnly = xml.replace(/<[^>]*>/g, "");
  assert.ok(!/[<>]/.test(textOnly), `텍스트에 날 꺾쇠가 남음: ${textOnly.slice(0, 120)}`);
});

t("X8 결정적 — 같은 입력이면 같은 XML(재등록 안전)", () => {
  assert.equal(winTaskXml(ARGS), winTaskXml(ARGS));
  assert.ok(!/\d{13}|Math\.random/.test(XML), "타임스탬프/랜덤이 섞였다");
});

t("X9 구조 유효성 — 필수 노드 존재 + 태그 균형", () => {
  for (const tag of ["Task", "RegistrationInfo", "Triggers", "Principals", "Settings", "Actions", "Exec"]) {
    assert.ok(XML.includes(`<${tag}`), `<${tag}> 없음`);
    assert.ok(XML.includes(`</${tag}>`), `</${tag}> 없음`);
  }
  assert.match(XML, /^<\?xml version="1\.0" encoding="UTF-16"\?>/);
  // 열림/닫힘 개수 균형(자기닫힘 태그는 이 XML 에 없다).
  //  ⚠ `[^/>]*` 로 쓰면 안 된다 — xmlns 값의 `http://…` 때문에 여는 <Task …> 를 통째로 놓친다(실제로 밟았다).
  const opens = (XML.match(/<[A-Za-z][^>]*>/g) || []).length;
  const closes = (XML.match(/<\/[A-Za-z][^>]*>/g) || []).length;
  assert.equal(opens, closes, `태그 불균형: 열림 ${opens} / 닫힘 ${closes}`);
});

console.log(`\n${pass} passed`);
