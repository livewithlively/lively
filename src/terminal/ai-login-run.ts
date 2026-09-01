// AI 로그인 프로세스를 **멤버 자리에서** 띄우고 그 출력을 읽는다 (#2055 후속). 순수 파싱은 ai-login-flow.ts.
//
//  ── 왜 이렇게 (파일 두 개로 주고받나) ──
//  이 프로세스는 **장수**다(사람이 브라우저에서 끝낼 때까지 기다린다). 그래서 요청-응답 exec 으로는 못 잡고,
//  게이트웨이의 자식으로 두면 재기동 때 같이 죽는다(#2055 에서 app-server 로 이미 겪었다).
//  그래서 detached 로 띄우고 **로그 파일**로 출력을 남긴다 — 화면은 그 파일을 폴링해 읽는다.
//
//  claude 는 한 겹 더 필요하다: 주소를 찍은 뒤 `Paste code here` 로 **stdin 을 기다린다**. 소켓을 놓을 수도
//  있지만(app-server 감독자가 그렇다) 여기서는 **입력 파일**이면 충분하다 — 한 번에 한 줄, 그것도 사람이
//  누를 때만 온다. 파일이면 어느 실행 통로(멤버 중계·drop-priv·로컬)로도 `cat > file` 한 줄로 넘길 수 있어
//  배포마다 갈리지 않는다. 소켓은 SUN_LEN·권한·수명까지 따라오는데 그 값을 여기서 쓸 이유가 없다.
//
//  ⚠ HOME 을 **명시한다**. 중계 exec 환경엔 그 유저의 passwd 항목이 없어 $HOME 이 다르고(profiles.ts
//   runAtMemberSeat 머리말과 같은 함정), 로그인 자격은 HOME 아래(`~/.codex/auth.json`)에 떨어진다.
//   여기서 틀리면 «로그인은 됐다는데 세션은 여전히 미로그인» 이 된다.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { memberShOut } from "./terminal-member-fs.js";
import { MEMBER_HOME_BASE } from "./terminal-transcript.js";
import { aiLoginArgv, EXIT_MARK, type AiLoginHarness } from "./ai-login-flow.js";
import { sessionExecConfigured, sessionSpawnArgv } from "./session-exec.js";
import type { LivelyUser } from "../context.js";

/** 한 사람 · 한 하네스의 로그인 자리. 이름이 짧아야 경로가 길어지지 않는다. */
function slot(osUser: string | null, h: AiLoginHarness): string {
  return `lvly-login-${h}-${createHash("sha256").update(String(osUser ?? "solo")).digest("hex").slice(0, 8)}`;
}
const logOf = (home: string, s: string): string => `${home}/.cache/${s}.log`;
const inOf = (home: string, s: string): string => `${home}/.cache/${s}.in`;
/**
 * 러너의 PID 파일.
 *
 *  ⚠ 왜 pgrep 이 아니라 파일인가 — **실측 2026-08-28, 매니지드 프로덕션에서 이 통로를 통째로 죽인 결함이다.**
 *  종전 판은 `pgrep -f <슬롯>` 으로 «이미 돌고 있나» 를 봤다. 그런데 이 스크립트는 멤버 중계가
 *  `sh -c "<스크립트 전문>"` 으로 돌리고, 스크립트 본문에 그 슬롯 이름이 들어 있다. 그래서 pgrep 은
 *  **자기를 실행 중인 셸을 잡는다** — 늘 «돌고 있다» 가 되어 로그인이 **한 번도 안 떴다**(화면은 조용히
 *  «시작하는 중» 에서 멈춘다). 같은 이유로 cancel 의 `pkill -f <슬롯>` 은 **자기 셸을 죽여** 뒤의 rm 까지
 *  가지도 못했다 — 만료된 옛 로그가 남아 다음 사람에게 옛 오류를 보여 줬다.
 *  PID 파일은 그 자기참조가 원리적으로 없다: 우리가 쓴 것만 본다.
 */
const pidOf = (home: string, s: string): string => `${home}/.cache/${s}.pid`;

/** 셸 리터럴 — 우리가 만든 값만 넣지만(하네스 키·해시) 그래도 감싼다. */
const q = (s: string): string => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * (순수) 로그인 프로세스를 detached 로 띄우는 셸 한 줄.
 *  · 이미 돌고 있으면 **다시 띄우지 않는다**(두 개가 같은 자격 파일을 노리면 서로를 덮는다).
 *  · 로그는 매번 새로 시작한다 — 지난 시도의 주소·코드가 남아 있으면 화면이 **만료된 코드**를 보여 준다.
 *  · 입력 파일이 나타나면 자식 stdin 으로 넘기고 지운다(claude 의 코드 되넣기).
 *  · 끝나면 종료코드를 로그에 남긴다 — 화면이 «끝났다» 를 알 유일한 단서다.
 */
export function loginStartSh(o: { home: string; slotName: string; argv: string[] }): string {
  const log = logOf(o.home, o.slotName);
  const inp = inOf(o.home, o.slotName);
  const pid = pidOf(o.home, o.slotName);
  const bin = o.argv[0];
  const runner = [
    `const cp=require("child_process"),fs=require("fs");`,
    // ⚠ `node -e <script> a b c` 는 a 가 **argv[1]** 이다. 첫 인자는 사람이 프로세스 목록에서 알아볼
    //  «슬롯 이름표» 라 실제 인자는 하나씩 밀린다 — 실측으로 밟았다(로그가 영영 빈 채였다).
    `const log=process.argv[2],inp=process.argv[3],pidf=process.argv[4],argv=process.argv.slice(5);`,
    // 생존 판정의 근거 — pgrep 과 달리 **우리가 쓴 것만** 본다(pidOf 머리말).
    `try{fs.writeFileSync(pidf,String(process.pid))}catch(_){}`,
    `const out=fs.openSync(log,"a");`,
    `const c=cp.spawn(argv[0],argv.slice(1),{stdio:["pipe",out,out]});`,
    `const done=()=>{try{fs.unlinkSync(pidf)}catch(_){}};`,
    `c.on("error",e=>{try{fs.appendFileSync(log,"\\nError: "+e.message+"\\n${EXIT_MARK} 127\\n")}catch(_){};done();process.exit(0)});`,
    // 사람이 코드를 넣을 때만 파일이 생긴다 — 0.5초 폴링이면 체감이 즉시다.
    `const t=setInterval(()=>{try{const v=fs.readFileSync(inp,"utf8");fs.unlinkSync(inp);c.stdin.write(v.trim()+"\\n")}catch(_){}} ,500);`,
    // 취소는 이 프로세스에 SIGTERM 을 보낸다 — 자식(하네스 CLI)까지 같이 내려야 자격 파일을 반쯤 쓴 채로 남지 않는다.
    `process.on("SIGTERM",()=>{clearInterval(t);try{c.kill()}catch(_){};done();process.exit(0)});`,
    `c.on("exit",code=>{clearInterval(t);try{fs.appendFileSync(log,"\\n${EXIT_MARK} "+(code==null?-1:code)+"\\n")}catch(_){};done();process.exit(0)});`,
  ].join("");
  return [
    `command -v ${q(bin)} >/dev/null 2>&1 || { echo "${bin} 없음" >&2; exit 127; }`,
    // ⚠ 하네스 홈을 **먼저 보장한다**. codex 는 CODEX_HOME 이 없으면 설정을 못 읽고 즉사한다(실측:
    //  `Error loading configuration: CODEX_HOME points to … but that path does not exist`).
    //  갓 만든 멤버 홈에는 그 폴더가 아직 없다 — app-server 기동에서 밟은 것과 같은 함정이다.
    `mkdir -p ${q(`${o.home}/.cache`)} ${q(`${o.home}/.codex`)} ${q(`${o.home}/.claude`)} ${q(`${o.home}/.grok`)} 2>/dev/null || true`,
    // 이미 도는 중이면 그대로 둔다(로그도 지우지 않는다 — 그 화면이 이미 사람에게 주소를 보여 주고 있다).
    //  ⚠ pgrep 을 쓰지 않는다 — 이 스크립트를 도는 셸의 명령줄에 슬롯 이름이 있어 **자기를 잡는다**(pidOf 머리말).
    `if [ -f ${q(pid)} ] && kill -0 "$(cat ${q(pid)} 2>/dev/null)" 2>/dev/null; then echo running; exit 0; fi`,
    // 죽은 자리는 흔적째 치운다 — 안 그러면 지난 시도의 **만료된 코드·옛 오류**를 다음 사람이 본다(실측).
    `rm -f ${q(log)} ${q(inp)} ${q(pid)} 2>/dev/null || true`,
    `nohup node -e ${q(runner)} ${q(o.slotName)} ${q(log)} ${q(inp)} ${q(pid)} ${o.argv.map(q).join(" ")} >/dev/null 2>&1 &`,
    `echo started`,
  ].join("\n");
}

/** 그 사람의 홈(격리면 멤버 홈, 아니면 게이트웨이 홈). */
function homeOf(osUser: string | null): string {
  return osUser ? `${MEMBER_HOME_BASE}/${osUser}` : (process.env.HOME || "/tmp");
}

async function sh(osUser: string | null, script: string): Promise<string> {
  //  ⚠ `HOME=x <script>` 로 붙이면 그 값은 **첫 줄에만** 걸린다(셸의 명령 앞 변수 대입 규칙). 스크립트가
  //   여러 줄이라 둘째 줄부터는 중계가 준 기본 HOME 으로 돈다 — 지금 배포는 그 둘이 우연히 같아서 안 터졌을
  //   뿐이고, 다르면 «로그인은 됐다는데 세션은 미로그인» 이 된다. 그래서 export 로 스크립트 전체에 건다.
  if (osUser) return memberShOut(osUser, `export HOME=${q(homeOf(osUser))}\n${script}`);
  return new Promise((resolve, reject) => {
    const p = spawn("sh", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    p.stdout?.on("data", (c: Buffer) => { out += c.toString("utf8"); });
    p.stderr?.on("data", (c: Buffer) => { err = (err + c.toString("utf8")).slice(-400); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `sh exit ${code}`))));
  });
}

/**
 * 로그인 프로세스를 **띄울 자리**를 정한다.
 *
 *  ⚠ 이게 이 파일에서 가장 조용히 틀렸던 자리다(실측 2026-09-01, 매니지드 프로덕션).
 *   종전엔 무조건 멤버 중계(`memberShOut`)로 띄웠는데, 매니지드에서 그 중계는 **tmux 컨테이너**로 들어간다
 *   (`member-exec-relay.cjs` → `/containers/lvly-s-<slug>-tmux/exec`). 그런데 #2454(이미지 역할 분할)가
 *   **그 컨테이너에서 하네스 4종(1,033MB)을 걷어냈다** — 보안·용량 면에서 옳은 결정이었지만, 이 통로가
 *   거기서 `grok login` 을 부른다는 걸 아무도 안 봤다. 결과: 화면이 «grok 없음» 만 뱉었다.
 *   하네스는 **세션 컨테이너**(`session` 타깃)에만 있다.
 *
 *  그래서 «띄우는 것» 만 세션 경계로 보낸다. 읽기·붙여넣기·정리는 그대로 멤버 경계다 —
 *  그 셋은 **파일만** 만지고, 멤버 홈은 두 컨테이너가 같은 볼륨으로 본다(profiles.ts 머리말과 같은 사실).
 *  즉 «세션 컨테이너가 쓰고, tmux 컨테이너가 읽는다» 가 성립한다.
 *
 *  ⚠ 세션 경계 중계가 없는 배포(셀프호스트)는 종전 그대로다 — 거기선 한 자리에 다 있다.
 */
async function spawnAt(user: LivelyUser | null, osUser: string | null, h: AiLoginHarness, script: string): Promise<string> {
  if (!user || !sessionExecConfigured()) return sh(osUser, script);
  const sid = await ensureLoginSession(user, h);
  const argv = sessionSpawnArgv(sid, ["sh", "-c", script]);
  if (!argv.length) return sh(osUser, script);   // 중계가 갑자기 빠졌다 — 종전 자리로 접는다
  return new Promise((resolve, reject) => {
    const p = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    p.stdout?.on("data", (c: Buffer) => { out += c.toString("utf8"); });
    p.stderr?.on("data", (c: Buffer) => { err = (err + c.toString("utf8")).slice(-400); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `session sh exit ${code}`))));
  });
}

/** 이 사람·이 하네스의 로그인 자리(세션 컨테이너). 한 번 만들고 재사용한다. */
const loginSessions = new Map<string, string>();

/**
 * 로그인 러너를 띄울 **세션 컨테이너**를 확보한다.
 *
 *  ⚠ 하네스 TUI 를 띄우지 않는다(`harness: "shell"`) — 우리에게 필요한 건 «바이너리가 있는 자리» 뿐이고,
 *   TUI 를 띄우면 그 pane 이 자격 파일을 같이 노려 서로를 덮는다.
 *  ⚠ `kind: "login"` — 이 종류가 이미 있다(#2162). 사람 세션으로 새면 목록·집계가 오염된다.
 */
async function ensureLoginSession(user: LivelyUser, h: AiLoginHarness): Promise<string> {
  const key = `${ownerKey(user)}:${h}`;
  const had = loginSessions.get(key);
  if (had) return had;
  const { createSession } = await import("./sessions.js");
  const s = await createSession(user, {
    kind: "login", label: `AI 로그인 (${h})`, rootKey: "personal", subpath: "",
    harness: "shell", flags: {}, autoApprove: false, loginProfile: true,
  });
  loginSessions.set(key, s.id);
  return s.id;
}

function ownerKey(user: LivelyUser): string { return String(user.userId || user.email || "solo"); }

/** 로그인을 시작한다(멱등 — 이미 돌고 있으면 그대로). */
export async function startAiLogin(osUser: string | null, h: AiLoginHarness, user?: LivelyUser | null): Promise<void> {
  const home = homeOf(osUser);
  const out = await spawnAt(user ?? null, osUser, h, loginStartSh({ home, slotName: slot(osUser, h), argv: aiLoginArgv(h) }));
  if (!/started|running/.test(out)) throw new Error(`로그인 명령을 띄우지 못했습니다 — ${out.slice(0, 160)}`);
}

/** 그 사람의 로그인 자리를 치운다(세션 컨테이너까지) — cancel 이 함께 부른다. */
export async function dropLoginSession(user: LivelyUser | null, h: AiLoginHarness): Promise<void> {
  if (!user) return;
  const key = `${ownerKey(user)}:${h}`;
  const sid = loginSessions.get(key);
  if (!sid) return;
  loginSessions.delete(key);
  try {
    const { killSession } = await import("./sessions.js");
    await killSession(user, sid, { admin: true });
  } catch (_) { /* 이미 없거나 못 죽였다 — 자리 표만 지우면 다음에 새로 만든다 */ }
}

/** 지금까지의 출력 원문. 아직 없으면 빈 문자열(=시작 중). */
export async function readAiLogin(osUser: string | null, h: AiLoginHarness): Promise<string> {
  const log = logOf(homeOf(osUser), slot(osUser, h));
  return sh(osUser, `cat ${q(log)} 2>/dev/null || true`).catch(() => "");
}

/**
 * 사람이 받아 온 코드를 프로세스에 넣는다(claude).
 *  ⚠ 값 검증은 여기서 한다 — 파일로 넘기지만 그 내용은 결국 CLI 의 stdin 이 된다. 형식 밖 문자는 안 넘긴다.
 */
export async function pasteAiLogin(osUser: string | null, h: AiLoginHarness, code: string): Promise<void> {
  const v = String(code).trim();
  if (!/^[A-Za-z0-9._~+/=#?&:%-]{4,512}$/.test(v)) throw new Error("코드 형식이 올바르지 않습니다.");
  const inp = inOf(homeOf(osUser), slot(osUser, h));
  await sh(osUser, `printf '%s' ${q(v)} > ${q(inp)}`);
}

/** 로그인 자리를 정리한다(사람이 그만두거나 끝난 뒤). 자격 파일은 건드리지 않는다. */
export async function cancelAiLogin(osUser: string | null, h: AiLoginHarness): Promise<void> {
  const s = slot(osUser, h);
  const home = homeOf(osUser);
  const pid = pidOf(home, s);
  //  ⚠ `pkill -f <슬롯>` 이었다 — 이 스크립트를 도는 셸의 명령줄에 슬롯 이름이 있어 **자기를 죽였다.**
  //   그래서 뒤의 rm 까지 가지도 못했고, 만료된 옛 로그가 남아 다음 사람에게 옛 오류를 보여 줬다(실측 2026-08-28).
  await sh(osUser, [
    `if [ -f ${q(pid)} ]; then kill "$(cat ${q(pid)} 2>/dev/null)" 2>/dev/null || true; fi`,
    `rm -f ${q(logOf(home, s))} ${q(inOf(home, s))} ${q(pid)} 2>/dev/null || true`,
    `echo ok`,
  ].join("\n")).catch(() => "");
}
