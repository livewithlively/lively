// Windows 노드 상시화의 **정적 계약**(#1541) — 순수함수라 어느 플랫폼에서든 돈다.
//
// ⚠ 이 파일이 존재하는 이유: `lively node` 의 Windows 분기는 mac/linux CI 에서 **한 번도 실행되지 않는다**.
//  #1510 이 같은 자리에서 얻은 교훈 그대로다 — 실행 커버리지가 0인 표면은 계약을 코드로 못박지 않으면
//  조용히 썩는다. 그래서 경로 목록·작업 스케줄러 XML 생성을 순수함수로 빼고 여기서 직접 검증한다.
//  (실기기 e2e 는 별도 — Windows VM 에서 등록·기동까지 확인한다.)
// 실행: node kit/cli/node-win-contract.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { muxCandidates, winTaskXml, winRunnerCmd, resolveWinUserId, winInstallArgv, nodeDaemonArtifact, nodeProcProbe, parseProcCount, winStartupDir, winStartupVbs, tailLines, lastConnectedAt, logTailHint, nodeConnectedFrom, parseResidualProbe, winResidualAgentProcs, stopResidualNote, decodeConsoleText } from "./cmd-node.mjs";

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

// ── N. 노드 상태 축(#1541 T4) — 데스크톱 앱이 폴링하는 그 값 ────────────────
// 앱은 이 값으로 '시작/정지' 버튼을 가른다. 틀리면 사용자는 도는 노드에 '시작' 을 눌러 중복 기동하거나,
//  죽은 노드를 '실행 중' 으로 본다. Windows 분기는 CI 에서 안 도니 여기서 못박는다(#1510 §5).
t('N1 플랫폼별 데몬 아티팩트 — mac=plist · linux=systemd unit · win=작업 이름', () => {
  // ⚠ 경로는 **인자 platform 의 구분자**로 나와야 한다 — 호스트 OS 와 무관하게. 전문 비교로 못박는다
  //  (endsWith 로는 앞부분이 `\Users\yoon` 처럼 뒤집혀도 못 잡는다). 윈도우 CI 가 실제로 이걸 잡았다:
  //  구현이 호스트 기본 join 을 써서 Windows 러너에서 darwin 경로가 `\Users\yoon\Library\…` 로 나왔다.
  const mac = nodeDaemonArtifact('darwin', '/Users/yoon');
  assert.equal(mac.kind, 'file');
  assert.equal(mac.path, '/Users/yoon/Library/LaunchAgents/io.lvly.node-agent.plist');
  const lin = nodeDaemonArtifact('linux', '/home/yoon');
  assert.equal(lin.path, '/home/yoon/.config/systemd/user/lively-node-agent.service');
  for (const p of [mac.path, lin.path]) assert.ok(!p.includes('\\'), `POSIX 경로에 역슬래시: ${p}`);
  // Windows 는 **두 자리**를 다 준다 — 스케줄러가 거부된 계정은 시작프로그램으로 앉기 때문(#1541 실측).
  //  한쪽만 보면 폴백으로 설치된 PC 전부가 "자동시작 꺼짐" 으로 보인다.
  assert.deepEqual(nodeDaemonArtifact('win32', 'C:\\Users\\yoon', {}), {
    kind: 'task', name: 'Lively Node Agent',
    fallbackPath: 'C:\\Users\\yoon\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\lively-node-agent.vbs',
  });
  // 모르는 플랫폼에서 파일 경로를 지어내지 않는다.
  assert.equal(nodeDaemonArtifact('aix', '/h').kind, 'none');
});

t('N2 ★ 프로세스 프로브가 남의 Node 를 세지 않는다(커맨드라인으로 우리 것만)', () => {
  const win = nodeProcProbe('win32');
  assert.equal(win.cmd, 'powershell');
  const script = win.args.join(' ');
  assert.ok(script.includes('node-agent*agent.mjs'), script);
  assert.ok(!/tasklist/i.test(script), 'tasklist /IM node.exe 는 사용자의 다른 Node 까지 센다');
  assert.deepEqual(nodeProcProbe('linux'), { cmd: 'pgrep', args: ['-f', 'node-agent/agent.mjs'] });
});

t('N3 프로브 출력 해석 — pgrep 은 pid 줄, PowerShell 은 개수', () => {
  assert.equal(parseProcCount('linux', '1234\n5678\n', 0), 2);
  assert.equal(parseProcCount('linux', '', 1), 0, 'pgrep 미검출(exit 1)은 0 이다');
  assert.equal(parseProcCount('win32', '\r\n2\r\n', 0), 2);
  assert.equal(parseProcCount('win32', '0', 0), 0);
  // 쓰레기 출력을 '있다' 로 읽지 않는다.
  assert.equal(parseProcCount('win32', '무슨 오류', 0), 0);
  assert.equal(parseProcCount('linux', '무슨 오류', 0), 0);
});

// ── E. 폴백 상시화(시작프로그램) — 작업 스케줄러를 못 쓰는 계정 (#1541 실측) ──────────────
// 왜 필요했나: 일반 사용자 PC(비관리자 + 그룹정책)에서 `schtasks /Create` 가 **가장 단순한 ONLOGON 작업조차**
//  "액세스가 거부되었습니다" 로 거절했다. 트리거 종류나 S4U 문제가 아니라 등록 권한 자체가 없는 계정이 있다.
//  그 PC 들이 이 기능의 주 대상(개인 노트북)이라, 폴백이 없으면 기능이 통째로 없는 것과 같다.
t('E1 ★ 시작프로그램 경로 — %APPDATA% 를 존중하고, 없으면 표준 경로로 파생', () => {
  assert.equal(winStartupDir({ APPDATA: 'C:\\Users\\yoon\\AppData\\Roaming' }, 'C:\\Users\\yoon'),
    'C:\\Users\\yoon\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup');
  // 로밍 프로필·리디렉션된 홈이면 APPDATA 가 홈 밖을 가리킨다 — 그걸 무시하고 홈으로 지어내면 안 된다.
  assert.equal(winStartupDir({ APPDATA: 'D:\\Roaming' }, 'C:\\Users\\yoon'),
    'D:\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup');
  assert.ok(winStartupDir({}, 'C:\\Users\\yoon').startsWith('C:\\Users\\yoon\\AppData\\Roaming\\'));
  // Windows 경로에 posix 구분자가 섞이면 안 된다(mac CI 에서 만들어도 나가는 건 Windows 경로다).
  assert.ok(!winStartupDir({}, 'C:\\Users\\yoon').includes('/'), winStartupDir({}, 'C:\\Users\\yoon'));
});

t('E2 ★ 시작프로그램 런처(.vbs) — 콘솔 창 없이(0), 기다리지 않고(False) 런처를 띄운다', () => {
  const vbs = winStartupVbs({ runnerCmd: 'C:\\Users\\yoon\\.lively\\node-agent-run.cmd' });
  // 창모드 0 = 숨김. 여기가 1 이면 로그인마다 검은 창이 뜨고, 사용자가 닫으면 노드가 죽는다.
  assert.ok(/\.Run\s+""".+""",\s*0,\s*False/.test(vbs), vbs);
  assert.ok(vbs.includes('node-agent-run.cmd'), vbs);
  // 런처를 직접 부르지 말 것 — 재시작 루프가 .cmd 안에 있다(node.exe 를 바로 부르면 죽으면 끝이다).
  assert.ok(!/node\.exe/i.test(vbs), '에이전트를 직접 부르면 재시작 루프를 건너뛴다');
  // .cmd 와 달리 .vbs 는 CRLF + ASCII 본문(경로만 유니코드) — wscript 가 읽는 형식.
  assert.ok(vbs.endsWith('\r\n'), 'CRLF 로 끝나야 한다');
  assert.ok(/^[\x00-\x7F]*$/.test(vbs), '본문에 비ASCII 가 섞였다 — 경로 외엔 ASCII 로 둔다');
});

t('E3 ★ .vbs 문자열 이스케이프 — 인용부호가 섞인 경로로 임의 실행이 되면 안 된다', () => {
  // VBS 문자열 리터럴의 " 는 "" 로 이스케이프한다. 안 하면 리터럴이 조기 종료돼 뒤가 코드가 된다.
  const vbs = winStartupVbs({ runnerCmd: 'C:\\a"b\\run.cmd' });
  assert.ok(vbs.includes('"""C:\\a""b\\run.cmd"""'), vbs);
  // 한글 사용자명 경로도 그대로 실린다(파일은 UTF-16LE+BOM 으로 써서 wscript 가 제대로 읽는다).
  assert.ok(winStartupVbs({ runnerCmd: 'C:\\Users\\상민\\.lively\\node-agent-run.cmd' }).includes('상민'));
});

// ── F. 기동 확인 — '등록했다' 를 '돌고 있다' 로 말하지 않는다 (#1541 실측) ────────────────────
// 왜 필요했나: 시작프로그램 폴백이 등록에 성공해 `✅ 상시화` 를 찍었는데 에이전트는 한 번도 붙지 않았다.
//  사용자는 초록 체크를 보고 끝났다고 믿었고 노드는 관리탭에서 오프라인이었다.
t('F1 ★ 연결 판정은 프로세스가 아니라 로그의 "게이트웨이 연결됨" 시각으로 한다', () => {
  const log = [
    '{"level":30,"time":1786344258025,"msg":"노드 에이전트 시작"}',
    '{"level":30,"time":1786344258376,"url":"wss://x/node/ws","msg":"게이트웨이 연결됨"}',
  ].join("\n");
  assert.equal(lastConnectedAt(log), 1786344258376);
  // 재연결이 여러 번이면 **마지막**이 답이다(로그는 append 라 뒤가 최신).
  assert.equal(lastConnectedAt(log + '\n{"level":30,"time":1786344999999,"msg":"게이트웨이 연결됨"}'), 1786344999999);
  // 붙은 적 없음 = null. 0 이나 false 로 눕히면 '옛날에 붙었다' 와 구분이 사라진다.
  assert.equal(lastConnectedAt('{"level":30,"time":1786344258025,"msg":"노드 에이전트 시작"}'), null);
  assert.equal(lastConnectedAt(""), null);
  assert.equal(lastConnectedAt(null), null);
  // 🔴 크래시 루프 방어의 핵심 — 기동 **전** 연결 기록을 이번 기동의 성공으로 세면 안 된다.
  const since = 1786344258500;
  assert.ok(!(lastConnectedAt(log) >= since), '🔴 옛 연결 기록을 이번 기동 성공으로 읽었다');
});

t('F2 로그 꼬리 — 빈 줄을 빼고 마지막 n줄만(실패를 그 자리에서 보여준다)', () => {
  assert.deepEqual(tailLines("a\n\nb\r\nc\n", 2), ["b", "c"]);
  assert.deepEqual(tailLines("", 5), [], "로그가 비어도 throw 하지 않는다");
  assert.equal(tailLines("x\n".repeat(50), 12).length, 12);
});

// ── G. 로그 확인 안내 문구 — 한글이 안 깨지는 명령이어야 한다 (#1541) ────────────
// 계기(실측): Windows 안내가 `type <로그>` 였다. 로그는 UTF-8 인데 한국어 콘솔은 chcp 949 로 시작해
//  `type` 이 그 바이트를 cp949 로 읽는다 → 한글 전부 깨짐. 파일도 우리 출력도 정상이고 **안내가 틀렸다**.
t("G1 Windows — type 이 아니라 UTF-8 을 명시 디코드하는 명령을 안내한다", () => {
  const h = logTailHint("C:\\Users\\yoon\\.lively\\logs\\node-agent.log", "win32");
  assert.ok(!/^type\b/.test(h), `🔴 여전히 type 을 안내한다(cp949 로 깨진다): ${h}`);
  assert.match(h, /-Encoding\s+utf8/, `UTF-8 디코드를 명시하지 않는다: ${h}`);
  assert.match(h, /Get-Content/, h);
  assert.ok(h.includes("node-agent.log"), h);
});

t("G2 Windows — 따라가기(-Wait)로 tail -f 와 같은 역할", () => {
  assert.match(logTailHint("C:\\x.log", "win32"), /-Wait/);
});

t("G3 경로에 공백이 있어도 한 인자로 유지된다(따옴표)", () => {
  const h = logTailHint("C:\\Users\\First Last\\.lively\\logs\\node-agent.log", "win32");
  assert.match(h, /'C:\\Users\\First Last\\[^']*'/, `공백 경로가 안 감싸졌다: ${h}`);
});

t("G4 POSIX 는 종전 그대로 tail -f (무회귀)", () => {
  assert.equal(logTailHint("/home/y/.lively/logs/node-agent.log", "darwin"), "tail -f /home/y/.lively/logs/node-agent.log");
  assert.equal(logTailHint("/x.log", "linux"), "tail -f /x.log");
});

// ── H. '붙어 있는가' 축 — 프로세스 실측(running)과 다른 축 (#1541) ────────────────────────
// 실측(2026-08-18): 노드 프로세스는 살았는데 게이트웨이엔 3시간째 오프라인(절전 뒤 좀비). running 만 보는 화면은
//  "노드 실행 중" 이라고 거짓말했다. 게이트웨이 /api/ui/nodes 의 online 이 정본이다.
t("H1 붙어 있음/오프라인/모름 — 목록에서 id 로 찾고, 못 찾거나 이상하면 null(모름 — false 로 눕히지 않는다)", () => {
  const list = { nodes: [{ id: "hammurabi", online: false }, { id: "macmini", online: true }] };
  assert.equal(nodeConnectedFrom(list, "macmini"), true);
  assert.equal(nodeConnectedFrom(list, "hammurabi"), false);
  assert.equal(nodeConnectedFrom(list, "nope"), null, "목록에 없으면 모름");
  assert.equal(nodeConnectedFrom(list.nodes, "macmini"), true, "배열 그대로도 받는다");
  assert.equal(nodeConnectedFrom({ nodes: [{ id: "x" }] }, "x"), null, "online 이 boolean 이 아니면 모름");
  // 새 헬퍼의 빈 입력 — 크래시 없이 모름
  assert.equal(nodeConnectedFrom(undefined, "x"), null); assert.equal(nodeConnectedFrom({}, "x"), null);
  assert.equal(nodeConnectedFrom(list, ""), null); assert.equal(nodeConnectedFrom(null, null), null);
  // id 는 문자열 비교(숫자 id 가 와도)
  assert.equal(nodeConnectedFrom({ nodes: [{ id: 7, online: true }] }, "7"), true);
});

// ── K. 정지 뒤 검증 — 못 죽였으면 ✅ 가 아니라 ⚠ (#1541) ─────────────────────────────────
// 실측(2026-08-18, hammurabi): 앱 '노드 정지' → "✅ 노드 데몬 해제" 인데 프로세스는 그대로(관리자 권한 좀비) → 화면 "실행 중".
t("K1 잔여 프로브 파서 — pid<TAB>session<TAB>name 줄, 빈 출력·쓰레기 줄은 버린다", () => {
  assert.deepEqual(parseResidualProbe("1234\t1\tnode.exe\r\n5678\t0\tcmd.exe\r\n"), [{ pid: 1234, session: 1, name: "node.exe" }, { pid: 5678, session: 0, name: "cmd.exe" }]);
  assert.deepEqual(parseResidualProbe(""), []); assert.deepEqual(parseResidualProbe(undefined), []);
  assert.deepEqual(parseResidualProbe("garbage\nnope\t\t\n"), []);
  assert.deepEqual(parseResidualProbe("42\t\tnode.exe"), [{ pid: 42, session: null, name: "node.exe" }], "세션을 못 읽어도 pid 는 살린다");
});
t("K2 ★ 남아 있으면 문구가 '살아 있다·관리자 PowerShell 에서 다시' 를 말하고, 없으면 빈 문자열", () => {
  const r = winResidualAgentProcs(() => "1234\t1\tnode.exe\n");
  assert.deepEqual(r.pids, [1234]); assert.match(r.detail, /PID 1234/);
  const note = stopResidualNote(r);
  assert.match(note, /1개가 아직 살아/); assert.match(note, /관리자 PowerShell/); assert.match(note, /lively node stop/);
  assert.equal(stopResidualNote(winResidualAgentProcs(() => "")), "");
  assert.equal(stopResidualNote(undefined), ""); assert.equal(stopResidualNote({ pids: [] }), "");
  // 배선: nodeStop(WIN) 이 죽인 뒤 다시 세고, 남으면 die(비-0) — 앱이 실패로 받아 문구를 보여준다
  const src = readFileSync(new URL("./cmd-node.mjs", import.meta.url), "utf8");
  const stopFn = src.slice(src.indexOf("function nodeStop()"), src.indexOf("function nodeStop()") + 3000);
  const stopSeg = stopFn.slice(stopFn.indexOf("else if (WIN)"));   // Windows 분기만 — darwin/linux 의 ✅ 는 다른 자리다
  const i = stopSeg.indexOf("winKillAgentProcs();"), j = stopSeg.indexOf("winResidualAgentProcs()"), k = stopSeg.indexOf("die(stopResidualNote");
  assert.ok(i >= 0 && j > i && k > j, "정지 경로: 죽이기 → 다시 세기 → 남으면 die 순서가 아니다");
  assert.ok(stopSeg.indexOf("✅ 노드 데몬 해제") > k, "✅ 가 검증보다 앞에 찍힌다 — 못 죽여도 성공이라 말하게 된다");
});

// ── M. 네이티브 출력 디코드 — cp949 를 utf8 로 읽어 깨진 글자를 사람에게 보여주지 않는다 (#1541) ──────
// 실측: 앱 로그 "(schtasks: ����: �׼����� �źεǾ����ϴ�.)" — 한국어 Windows 의 schtasks stderr(cp949)를 utf8 강제 디코드.
t("M1 decodeConsoleText — utf8 그대로 · cp949 는 euc-kr 로 복원 · 못 읽으면 침묵", () => {
  assert.equal(decodeConsoleText(Buffer.from("오류: 액세스", "utf8")), "오류: 액세스");
  // '오류: 액세스가 거부되었습니다.' 의 실제 cp949 바이트(python cp949 인코딩으로 생성)
  const cp949 = Buffer.from("bfc0b7f93a20bed7bcbcbdbab0a120b0c5baceb5c7befabdc0b4cfb4d92e", "hex");
  assert.equal(decodeConsoleText(cp949), "오류: 액세스가 거부되었습니다.");
  // 어느 쪽으로도 안 읽히는 바이트 → 빈 문자열(깨진 글자를 보여주는 것보다 침묵)
  assert.equal(decodeConsoleText(Buffer.from([0xff, 0xfe, 0x81, 0x00, 0x81])), "");
  assert.equal(decodeConsoleText(null), ""); assert.equal(decodeConsoleText(undefined), "");
  assert.equal(decodeConsoleText("이미 문자열"), "이미 문자열");
  assert.equal(decodeConsoleText("깨진\uFFFD문자열"), "", "이미 깨진 문자열도 침묵");
  // 배선: schtasks /Create 를 encoding 강제 없이(Buffer) 부르고, denied 는 decodeConsoleText 를 거친다
  const src = readFileSync(new URL("./cmd-node.mjs", import.meta.url), "utf8");
  const seg = src.slice(src.indexOf('spawnSync("schtasks", ["/Create"'), src.indexOf('spawnSync("schtasks", ["/Create"') + 1600);
  assert.ok(!/encoding:\s*"utf8"/.test(seg), "schtasks 출력을 utf8 로 강제 디코드한다(cp949 가 깨진다)");
  assert.match(seg, /decodeConsoleText\(r\.stderr\)/, "denied 가 디코더를 안 거친다");
});

console.log(`\n${pass} passed`);
