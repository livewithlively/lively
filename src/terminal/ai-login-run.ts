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

/** 한 사람 · 한 하네스의 로그인 자리. 이름이 짧아야 경로가 길어지지 않는다. */
function slot(osUser: string | null, h: AiLoginHarness): string {
  return `lvly-login-${h}-${createHash("sha256").update(String(osUser ?? "solo")).digest("hex").slice(0, 8)}`;
}
const logOf = (home: string, s: string): string => `${home}/.cache/${s}.log`;
const inOf = (home: string, s: string): string => `${home}/.cache/${s}.in`;

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
  const bin = o.argv[0];
  const runner = [
    `const cp=require("child_process"),fs=require("fs");`,
    // ⚠ `node -e <script> a b c` 는 a 가 **argv[1]** 이다. 첫 인자는 pgrep 이 이 프로세스를 찾을
    //  «슬롯 이름표» 라 실제 인자는 하나씩 밀린다 — 실측으로 밟았다(로그가 영영 빈 채였다).
    `const log=process.argv[2],inp=process.argv[3],argv=process.argv.slice(4);`,
    `const out=fs.openSync(log,"a");`,
    `const c=cp.spawn(argv[0],argv.slice(1),{stdio:["pipe",out,out]});`,
    `c.on("error",e=>{try{fs.appendFileSync(log,"\\nError: "+e.message+"\\n${EXIT_MARK} 127\\n")}catch(_){};process.exit(0)});`,
    // 사람이 코드를 넣을 때만 파일이 생긴다 — 0.5초 폴링이면 체감이 즉시다.
    `const t=setInterval(()=>{try{const v=fs.readFileSync(inp,"utf8");fs.unlinkSync(inp);c.stdin.write(v.trim()+"\\n")}catch(_){}} ,500);`,
    `c.on("exit",code=>{clearInterval(t);try{fs.appendFileSync(log,"\\n${EXIT_MARK} "+(code==null?-1:code)+"\\n")}catch(_){};process.exit(0)});`,
  ].join("");
  return [
    `command -v ${q(bin)} >/dev/null 2>&1 || { echo "${bin} 없음" >&2; exit 127; }`,
    // ⚠ 하네스 홈을 **먼저 보장한다**. codex 는 CODEX_HOME 이 없으면 설정을 못 읽고 즉사한다(실측:
    //  `Error loading configuration: CODEX_HOME points to … but that path does not exist`).
    //  갓 만든 멤버 홈에는 그 폴더가 아직 없다 — app-server 기동에서 밟은 것과 같은 함정이다.
    `mkdir -p ${q(`${o.home}/.cache`)} ${q(`${o.home}/.codex`)} ${q(`${o.home}/.claude`)} 2>/dev/null || true`,
    // 이미 도는 중이면 그대로 둔다(로그도 지우지 않는다 — 그 화면이 이미 사람에게 주소를 보여 주고 있다).
    `if pgrep -f ${q(o.slotName)} >/dev/null 2>&1; then echo running; exit 0; fi`,
    `rm -f ${q(log)} ${q(inp)} 2>/dev/null || true`,
    `nohup node -e ${q(runner)} ${q(o.slotName)} ${q(log)} ${q(inp)} ${o.argv.map(q).join(" ")} >/dev/null 2>&1 &`,
    `echo started`,
  ].join("\n");
}

/** 그 사람의 홈(격리면 멤버 홈, 아니면 게이트웨이 홈). */
function homeOf(osUser: string | null): string {
  return osUser ? `${MEMBER_HOME_BASE}/${osUser}` : (process.env.HOME || "/tmp");
}

async function sh(osUser: string | null, script: string): Promise<string> {
  if (osUser) return memberShOut(osUser, `HOME=${q(homeOf(osUser))} ${script}`);
  return new Promise((resolve, reject) => {
    const p = spawn("sh", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    p.stdout?.on("data", (c: Buffer) => { out += c.toString("utf8"); });
    p.stderr?.on("data", (c: Buffer) => { err = (err + c.toString("utf8")).slice(-400); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `sh exit ${code}`))));
  });
}

/** 로그인을 시작한다(멱등 — 이미 돌고 있으면 그대로). */
export async function startAiLogin(osUser: string | null, h: AiLoginHarness): Promise<void> {
  const home = homeOf(osUser);
  const out = await sh(osUser, loginStartSh({ home, slotName: slot(osUser, h), argv: aiLoginArgv(h) }));
  if (!/started|running/.test(out)) throw new Error(`로그인 명령을 띄우지 못했습니다 — ${out.slice(0, 160)}`);
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
  await sh(osUser, `pkill -f ${q(s)} 2>/dev/null || true; rm -f ${q(logOf(home, s))} ${q(inOf(home, s))} 2>/dev/null || true; echo ok`)
    .catch(() => "");
}
