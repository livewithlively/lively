// 헤드리스 자격 발급 러너 — **대화형 로그인과 같은 자리**에서 띄우고, 잡은 자격을 따로 된 파일로 넘긴다 (#4051).
//
//  ── 왜 같은 자리인가 (실측 조사 2026-09-17) ──
//  매니지드에서 대화형 로그인은 세션 노드의 로그인 자리(세션 컨테이너, 테넌트 uid, 멤버 HOME)에서 돈다(ai-login-run
//  spawnAt). 그 이미지에는 claude·codex·tmux·node 가 다 있고 게이트웨이 재기동과도 무관하다. CP 게이트웨이에서 직접
//  돌리면 ① 배포·슬롯 교대 때 같이 죽고(KillMode 기본값) ② 모든 테넌트가 같은 uid·HOME 을 쓰며 ③ 같은 uid 프로세스는
//  /proc 로 게이트웨이 env(전 테넌트 DB 주소·비밀)를 읽는다. 샌드박스 판(task-op)은 붙여넣기 통로가 없다.
//  그래서 **띄우기는 그 자리, 읽기·붙여넣기·정리는 멤버 경계**(파일) — ai-login-run 의 규약을 그대로 쓴다.
//
//  ── 왜 tmux 인가 (claude) ──
//  `claude setup-token` 은 TTY 가 아니면 아무것도 안 찍는다. PTY 를 줄 도구 중 tmux 만 **모든 자리에 반드시** 있다
//  (세션 이미지 base · 셀프호스트 리눅스·맥 — 세션이 tmux 위에서 돈다). util-linux `script` 는 맥(BSD)에서 파이프 stdin 을
//  거절하고(실측 `tcgetattr/ioctl: Operation not supported on socket`), python3 은 맥 기본 설치가 없을 수 있다.
//  tmux 는 덤으로 **그려진 화면**을 준다(capture-pane) — Ink 가 단어 사이를 커서 이동으로 채워(`ESC[<n>G`) 원시 출력을
//  읽으면 «Pastecodehere…» 가 되고 주소는 80칸마다 OSC-8 로 잘려 나온다(실측). 창을 500칸으로 두면 주소·토큰이 한 줄이다.
//  전용 소켓을 **임시 HOME 안**(`-S <임시>/.tmux.sock`)에 둔다 — 그 자리의 세션 tmux 서버와 섞이지 않고, 끝나면 임시
//  폴더와 함께 사라진다(`-L` 이름 소켓은 맥에서 kill-server 뒤에도 /tmp/tmux-<uid>/ 에 파일이 남았다 — 실측).
//
//  ── 토큰 다루기 ──
//  · 러너가 화면에서 토큰을 찾으면 **0600 파일(.tok)** 에 쓰고, 로그에는 표식만 남긴다(TOKEN_CAPTURED_MARK).
//  · 서버가 다음 조회에서 .tok 을 읽어 멤버 비밀로 저장하고, 곧바로 지운 뒤 «저장했다» 표식(.stored)을 남긴다.
//  · 아무도 안 거두면 러너가 상한(20분)에 .tok 을 지우고 끝난다 — 발급만 되고 저장 안 된 자격을 홈에 남기지 않는다.
//  · CLI 는 **임시 HOME** 에서 돈다 — 멤버의 ~/.claude.json · ~/.codex 를 건드리지 않는다(평소 로그인과 섞이지 않게).
import { createHash, randomBytes } from "node:crypto";
import { EXIT_MARK } from "./ai-login-flow.js";
import {
  HEADLESS_SECRET_KIND, SETUP_TOKEN_PATTERN_SOURCE, TOKEN_CAPTURED_MARK, CAPTURED_LINE,
  headlessLoginArgv, headlessNeedsPty, type HeadlessLoginHarness,
} from "./headless-login-flow.js";
import { runAtLoginSeatSh, loginHomeOf, loginShQuote as q, spawnAtLoginSeat } from "./ai-login-run.js";
import type { LivelyUser } from "../context.js";

/** 헤드리스 발급의 자리 키 — 대화형 로그인 자리(하네스 이름 그대로)와 **갈라 둔다**(spawnAt 머리말). */
export const HEADLESS_SEAT_PREFIX = "hl-";
export const headlessSeatKey = (h: HeadlessLoginHarness): string => `${HEADLESS_SEAT_PREFIX}${h}`;

/** 발급을 기다리는 상한 — codex 장치 코드가 15분이다. 넘으면 러너가 스스로 치운다. */
export const HEADLESS_RUN_LIMIT_MS = 20 * 60_000;
/**
 * «살아 있다» 로 보는 심박 나이(초). 러너는 0.5초마다 pid 파일의 시각을 갱신한다.
 *
 *  ⚠ 왜 `kill -0 <pid>` 가 아닌가 — 매니지드에서 러너는 **세션 컨테이너**에서 돌고, 정리·조회는 멤버 경계(**tmux
 *   컨테이너**)에서 돈다. 둘은 pid 네임스페이스가 다르다(각자 gVisor 샌드박스). 거기서 pid 로 묻거나 죽이면 **엉뚱한
 *   프로세스**를 겨눈다. 파일 시각은 두 컨테이너가 같은 홈 볼륨으로 보므로 어디서 재도 같은 답이다.
 *   그래서 멈춤도 신호가 아니라 **pid 파일 삭제**로 전한다 — 러너가 매 박동마다 «이 파일이 아직 내 것인가» 를 본다.
 */
export const HEADLESS_ALIVE_SEC = 5;

/** 러너의 tmux 호출 하나의 상한(ms). 조회의 «끝났다» 여유(HEADLESS_DEAD_SEC)가 이 값에 기대므로 한 곳에서 정한다. */
export const HEADLESS_TMUX_CALL_TIMEOUT_MS = 10_000;

/**
 * 조회가 «러너가 끝났다» 고 말하는 심박 나이(초) — **이보다 오래됐을 때만**(같으면 아직 산 것이다).
 *  시작 판정(HEADLESS_ALIVE_SEC)보다 훨씬 너그럽다. 러너는 tmux 호출마다 직전에 심박을 찍지만, 호출 하나가 상한
 *  (HEADLESS_TMUX_CALL_TIMEOUT_MS)까지 막힐 수 있고 자리 CPU 가 몰리면 전체가 밀린다. 산 러너를 «끝났다» 고 말하면
 *  사람은 멀쩡한 시도를 버린다 — 반대쪽(죽은 러너를 조금 늦게 알아채기)이 훨씬 싸다.
 *  이 판정이 잡는 것은 **정리 없이 사라진 러너**다(자리 회수 · 강제 종료 · 기동 실패). 취소·상한·저장은 pid 파일을
 *  지우므로 바로 잡힌다.
 */
export const HEADLESS_DEAD_SEC = 45;

/**
 * 러너 기록(.log)의 첫 줄 머리 — `LVLY_RUN <실행 id>`. 조회는 이 id 가 pid 파일의 주인과 다르면 그 기록을 버린다.
 *  ⚠ 왜 필요한가(실측 2026-09-17, 매니지드): 취소 뒤 조회 3회 중 2회가 **옛 주소 화면**을 되살렸다. 러너 박동은
 *   «주인 확인 → 화면 캡처(느림) → 기록 쓰기» 라, 캡처 도중 지운 기록을 다시 쓴다. 새 시도와 겹치면 사람은
 *   **죽은 시도의 주소**로 승인하고 그 코드를 새 러너에 넣는다 — CLI 는 state 가 달라 거절한다.
 */
export const HEADLESS_RUN_MARK = "LVLY_RUN";
const RUN_ID_RE = /^[0-9a-f]{8,64}$/;

/** 한 사람 · 한 하네스의 발급 자리. 대화형 로그인(lvly-login-*)과 파일이 겹치지 않는다. */
export function headlessSlot(osUser: string | null, h: HeadlessLoginHarness): string {
  return `lvly-hl-${h}-${createHash("sha256").update(String(osUser ?? "solo")).digest("hex").slice(0, 8)}`;
}

/** 발급 파일이 사는 폴더 — 0700. 자격 파일(.tok)이 잠깐이라도 여기 앉는다. */
export const headlessDirOf = (home: string): string => `${home}/.cache/lvly-hl`;
export interface HeadlessPaths { dir: string; log: string; inp: string; pid: string; tok: string; stored: string }
export function headlessPaths(home: string, slotName: string): HeadlessPaths {
  const dir = headlessDirOf(home);
  const f = (ext: string): string => `${dir}/${slotName}.${ext}`;
  return { dir, log: f("log"), inp: f("in"), pid: f("pid"), tok: f("tok"), stored: f("stored") };
}

/**
 * 창 안의 **자기 소멸 시계**(초). 러너보다 늦게(상한 + 5분) 울린다.
 *  ⚠ 왜 필요한가(실측 2026-09-17): 러너가 정리 전에 죽으면(강제 종료·OOM) tmux 서버는 데몬이라 **혼자 남는다** —
 *   코드를 기다리는 CLI 는 영영 안 끝나므로 서버도 안 끝난다. 변이 시험에서 실제로 고아 서버가 남았다.
 *   창이 스스로 자기 프로세스 그룹을 내리면(`kill -TERM 0`) 마지막 창이 닫혀 서버도 따라 내려간다.
 */
export const HEADLESS_PANE_WATCHDOG_SEC = Math.ceil(HEADLESS_RUN_LIMIT_MS / 1000) + 300;

/**
 * (순수) tmux 창 안에서 도는 명령.
 *  · HOME 은 러너가 만든 **임시 폴더**다(`$LVLY_HL_HOME` — tmux 서버 env 로 넘긴다).
 *  · 부모 세션 표지·다른 자격 env 를 걷는다 — 세션 안에서 띄운 CLI 가 부모 흔적을 물려받으면 엉뚱하게 돈다
 *    (headless-subscription-billing 실측: env 상속으로 훅이 부모 세션을 오염시켰다).
 *  · 자동 업데이트를 끈다 — 임시 HOME 이라 켜 두면 발급 한 번에 바이너리를 통째로 내려받는다.
 *  · 종료코드는 **명령 바로 뒤에** 잡는다(`echo` 뒤의 `$?` 는 echo 의 것이다).
 *  · 끝나도 창을 남긴다(sleep) — 러너가 마지막 화면(토큰 줄)을 읽기 전에 창이 닫히면 안 된다.
 *  · 맨 앞의 시계가 상한 뒤 창을 스스로 내린다(HEADLESS_PANE_WATCHDOG_SEC 머리말).
 */
export function headlessPaneCmd(argv: string[], watchdogSec: number = HEADLESS_PANE_WATCHDOG_SEC): string {
  const sec = Math.max(1, Math.floor(watchdogSec));
  //  ⚠ `&` 뒤에 `;` 를 붙이면 sh 문법 오류다 — 시계는 `&` 로 끝내고 본 명령을 바로 잇는다.
  return `(sleep ${sec}; kill -TERM 0) >/dev/null 2>&1 & ` + [
    `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u TMUX -u TMUX_PANE`
      + ` HOME="$LVLY_HL_HOME" DISABLE_AUTOUPDATER=1 ${argv.map(q).join(" ")}`,
    `rc=$?`,
    `echo`,
    `echo "${EXIT_MARK} $rc"`,
    `exec sleep ${sec}`,
  ].join("; ");
}

/**
 * 러너 본문(node -e). **자기완결**이어야 한다 — 로그인 자리에는 코어 코드가 없다(세션 이미지엔 /app 이 없다).
 *  수명 규약: 시작 스크립트가 pid 파일에 **이번 실행 id** 를 먼저 써 두고, 러너는 그 id 를 제 것으로 삼아 0.5초마다
 *  시각을 갱신한다. 파일이 사라지거나 남의 값으로 바뀌면(취소 · 저장 완료 · 새 시도) 스스로 끝낸다 — 남의 pid 파일은
 *  지우지 않는다(HEADLESS_ALIVE_SEC 머리말). 뜨기도 전에 자리를 잃었으면 아무것도 안 하고 끝낸다.
 *  쓰기는 전부 **직전에** 주인을 다시 본다 — 캡처가 느린 사이 취소가 들어오면 지운 기록을 되살린다(HEADLESS_RUN_MARK).
 *   · 기록은 실행마다 이름이 다른 임시 파일(`<log>.<id>.w`)에 쓰고 rename 으로 바꿔 끼운다 — 남의 임시 파일을 건드리지
 *     않고, 경로를 새로 «만드는» 쓰기(append)가 없다. 파이프 모드는 그렇게 만든 파일의 fd 에만 덧붙인다.
 *   · 자격 파일은 쓴 **뒤에도** 주인을 본다 — 그 사이 자리를 잃었으면 지운다(headlessCleanSh 의 pid→tok 순서와 한 짝).
 *   · tmux 호출마다 **직전에** 심박을 찍는다 — 호출 하나가 막혀도 조회가 산 러너를 «끝났다» 고 읽지 않게.
 *  인자: [이름표, log, in, pid, tok, 실행 id, mode('tmux'|'pipe'), tmux 경로('-' = 안 씀), ...명령]
 *   ⚠ `node -e <script> a b` 는 a 가 argv[1] 이다(ai-login-run D1 과 같은 함정) — 첫 인자는 사람이 알아볼 이름표다.
 */
export function headlessRunnerJs(): string {
  return `"use strict";
const cp=require("child_process"),fs=require("fs"),os=require("os"),path=require("path");
const A=process.argv;
const log=A[2],inp=A[3],pidf=A[4],tokf=A[5],me=A[6],mode=A[7],tmuxBin=A[8],argv=A.slice(9);
const EXIT=${JSON.stringify(EXIT_MARK)},CAP=${JSON.stringify(CAPTURED_LINE)},MARK=${JSON.stringify(TOKEN_CAPTURED_MARK)};
const SRC=${JSON.stringify(SETUP_TOKEN_PATTERN_SOURCE)};
const LIMIT=${HEADLESS_RUN_LIMIT_MS},TMO=${HEADLESS_TMUX_CALL_TIMEOUT_MS},t0=Date.now();
const HDR=${JSON.stringify(HEADLESS_RUN_MARK + " ")}+me+"\\n";
const W=log+"."+me+".w";
const mine=()=>{try{return fs.readFileSync(pidf,"utf8")===me}catch(_){return false}};
if(!me||!mine())process.exit(0);
const home=fs.mkdtempSync(path.join(os.tmpdir(),"lvly-hl-"));
let got=false,ended=false,child=null,tick=()=>{},onEnd=()=>{},add=(s)=>{};
const touch=()=>{try{const t=new Date();fs.utimesSync(pidf,t,t)}catch(_){}};
const beat=()=>{try{const t=new Date();fs.utimesSync(pidf,t,t);return mine()}catch(_){return false}};
const put=(s)=>{if(!mine())return false;
  try{fs.writeFileSync(W,HDR+s,{mode:0o600})}catch(_){return true}
  if(!mine()){try{fs.unlinkSync(W)}catch(_){}return false}
  try{fs.renameSync(W,log)}catch(_){}
  return true};
const keep=(v)=>{if(got||!mine())return;
  try{fs.writeFileSync(tokf,v,{mode:0o600});got=true}catch(_){}
  if(!mine()){try{fs.unlinkSync(tokf)}catch(_){}}};
const end=()=>{if(ended)return;ended=true;
  try{onEnd()}catch(_){}
  if(child){try{child.kill()}catch(_){}}
  try{fs.rmSync(home,{recursive:true,force:true})}catch(_){}
  if(mine()){try{fs.unlinkSync(pidf)}catch(_){}}
  process.exit(0)};
if(mode==="tmux"){
  const tenv=Object.assign({},process.env,{SHELL:"/bin/sh",LVLY_HL_HOME:home});
  delete tenv.TMUX;delete tenv.TMUX_PANE;
  const sock=path.join(home,".tmux.sock");
  const T=(a)=>{if(mine())touch();return cp.spawnSync(tmuxBin,["-u","-S",sock].concat(a),{encoding:"utf8",env:tenv,timeout:TMO})};
  let last="";
  onEnd=()=>{T(["kill-server"])};
  add=(s)=>{put(last+s)};
  if(!put(""))end();
  const r=T(["-f","/dev/null","new-session","-d","-s","hl","-x","500","-y","50",argv[0]]);
  if(r.status!==0){add("Error: 터미널을 띄우지 못했어요 — "+String(r.stderr||(r.error&&r.error.message)||"").trim().slice(0,200)+"\\n"+EXIT+" 127\\n");end()}
  tick=()=>{
    try{const v=fs.readFileSync(inp,"utf8");fs.unlinkSync(inp);const c=v.trim();if(c){T(["send-keys","-t","hl","-l",c]);T(["send-keys","-t","hl","Enter"])}}catch(_){}
    const c=T(["capture-pane","-p","-J","-t","hl","-S","-300"]);
    if(c.status!==0){add("\\n"+EXIT+" -1\\n");end();return}
    let s=String(c.stdout||"");
    const m=s.match(new RegExp(SRC));
    if(m)keep(m[0]);
    s=s.replace(new RegExp(SRC,"g"),MARK).split("\\n").map((l)=>l.replace(/\\s+$/,"")).join("\\n").replace(/\\n{3,}/g,"\\n\\n");
    if(!put(s)){end();return}
    last=s;
    if(s.includes(EXIT)&&(!got||!fs.existsSync(tokf)))end();
  };
}else{
  let out=-1;
  try{out=fs.openSync(W,"a",0o600);fs.writeSync(out,HDR)}catch(_){end()}
  if(!mine()){try{fs.unlinkSync(W)}catch(_){}end()}
  try{fs.renameSync(W,log)}catch(_){end()}
  add=(s)=>{if(!mine())return;try{fs.writeSync(out,s)}catch(_){}};
  const env=Object.assign({},process.env,{CODEX_HOME:home});
  child=cp.spawn(argv[0],argv.slice(1),{stdio:["pipe",out,out],env});
  child.on("error",(e)=>{child=null;add("\\nError: "+e.message+"\\n"+EXIT+" 127\\n");end()});
  child.on("exit",(code)=>{child=null;
    if(code===0){try{const v=fs.readFileSync(path.join(home,"auth.json"),"utf8");if(v.trim()){keep(v);add("\\n"+CAP+"\\n")}}catch(_){}}
    add("\\n"+EXIT+" "+(code==null?-1:code)+"\\n");
    try{fs.rmSync(home,{recursive:true,force:true})}catch(_){}});
  tick=()=>{
    try{const v=fs.readFileSync(inp,"utf8");fs.unlinkSync(inp);if(child&&child.stdin)child.stdin.write(v.trim()+"\\n")}catch(_){}
    if(!child&&(!got||!fs.existsSync(tokf)))end();
  };
}
setInterval(()=>{if(!beat()){end();return}tick();if(Date.now()-t0>LIMIT){try{fs.unlinkSync(tokf)}catch(_){}end()}},500);
process.on("SIGTERM",()=>end());
`;
}

/**
 * (순수) 발급 러너를 detached 로 띄우는 셸.
 *  ai-login-run.loginStartSh 와 같은 규약이다 — pid 파일로만 생존 판정(자기참조 금지) · 죽은 자리는 흔적째 치움 ·
 *  바이너리가 없으면 127. 더한 것: 0700 폴더 · umask 077 · tmux 경로 해소(게이트웨이 PATH 에 brew 가 없을 수 있다) ·
 *  생존은 pid 가 아니라 **심박 나이**로 잰다(HEADLESS_ALIVE_SEC — 컨테이너가 바뀌어도 같은 답).
 *  pid 파일에는 **러너를 띄우기 전에** 이번 실행 id 를 쓴다 — 러너가 뜨는 동안(노드 기동 · tmux 준비)에도 자리의 주인이
 *  정해져 있어야 조회가 «아직 시작 중» 과 «끝났다» 를 가른다. 러너는 이 id 를 인자로 받아 제 것으로 삼는다.
 */
export function headlessStartSh(o: { home: string; slotName: string; harness: HeadlessLoginHarness; runId: string }): string {
  //  id 는 셸 한 줄에 그대로 실린다 — 모양을 못박는다(비었거나 이상하면 러너가 누구의 자리인지 모른다).
  if (!RUN_ID_RE.test(String(o.runId ?? ""))) throw new Error("발급 실행 id 가 올바르지 않습니다.");
  const p = headlessPaths(o.home, o.slotName);
  const argv = headlessLoginArgv(o.harness);
  const pty = headlessNeedsPty(o.harness);
  const lines = [`command -v ${q(argv[0])} >/dev/null 2>&1 || { echo "${argv[0]} 없음" >&2; exit 127; }`];
  if (pty) {
    lines.push(
      `LVLY_TMUX=""`,
      `for c in "$(command -v tmux 2>/dev/null)" /opt/homebrew/bin/tmux /usr/local/bin/tmux /usr/bin/tmux; do if [ -n "$c" ] && [ -x "$c" ]; then LVLY_TMUX="$c"; break; fi; done`,
      `[ -n "$LVLY_TMUX" ] || { echo "tmux 없음" >&2; exit 127; }`,
    );
  }
  lines.push(
    //  폴더는 만들 때부터 0700(`-m`) — 이미 있던 폴더는 chmod 로 좁힌다(리뷰 #4051: mkdir 과 chmod 사이 창).
    `mkdir -p -m 700 ${q(p.dir)} 2>/dev/null; chmod 700 ${q(p.dir)} 2>/dev/null || true`,
    `lvly_age() { n=$(date +%s); m=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0); echo $((n - m)); }`,
    `if [ -f ${q(p.pid)} ] && [ "$(lvly_age ${q(p.pid)})" -lt ${HEADLESS_ALIVE_SEC} ]; then echo running; exit 0; fi`,
    headlessCleanSh(p),
    `umask 077`,
    `printf '%s' ${q(o.runId)} > ${q(p.pid)}`,
    pty
      ? `nohup node -e ${q(headlessRunnerJs())} ${q(o.slotName)} ${q(p.log)} ${q(p.inp)} ${q(p.pid)} ${q(p.tok)} ${q(o.runId)} tmux "$LVLY_TMUX" ${q(headlessPaneCmd(argv))} >/dev/null 2>&1 &`
      : `nohup node -e ${q(headlessRunnerJs())} ${q(o.slotName)} ${q(p.log)} ${q(p.inp)} ${q(p.pid)} ${q(p.tok)} ${q(o.runId)} pipe - ${argv.map(q).join(" ")} >/dev/null 2>&1 &`,
    `echo started`,
  );
  return lines.join("\n");
}

/**
 * (순수) 자리의 흔적을 지우는 한 줄 — 시작과 취소가 같이 쓴다.
 *  ⚠ **pid 가 자격 파일(.tok)보다 앞이어야 한다.** 러너의 keep 은 «주인 확인 → 자격 쓰기 → 주인 재확인(아니면 지움)»
 *   이다. rm 이 .tok 을 먼저 지우고 pid 를 나중에 지우면, 그 사이에 쓴 자격을 러너도 rm 도 안 지운다(비밀이 남는다).
 *  기록 임시 파일은 실행마다 이름이 달라(`<log>.<id>.w`) 글롭으로 지운다 — 이전 판의 `<log>.w` 도 함께.
 */
export function headlessCleanSh(p: HeadlessPaths): string {
  return `rm -f ${q(p.pid)} ${q(p.log)} ${q(p.log)}.*.w ${q(p.log + ".w")} ${q(p.inp)} ${q(p.tok)} ${q(p.stored)} 2>/dev/null || true`;
}

/** 조회 한 번에 넷(로그 · 저장 표식 · 잡은 자격 · 자리 주인)을 읽는 구분자 — CLI 출력에 나올 수 없는 글자로 둔다. */
const SEP_STORED = "<<LVLY-HL-STORED>>";
const SEP_TOK = "<<LVLY-HL-TOK>>";
const SEP_PID = "<<LVLY-HL-PID>>";
/** 끝 표식 — 이것까지 와야 조회가 온전하다. 없으면 pid 칸이 잘린 것과 «pid 파일 없음» 을 가를 수 없다(리뷰 #4051). */
const SEP_END = "<<LVLY-HL-END>>";

/**
 * (순수) 조회 스크립트. 파일이 없으면 빈 칸이다.
 *  pid 칸은 `<심박 나이 초> <주인 id>`, 파일이 없으면 빈 줄이다. 나이를 못 재면(`stat` 이 없는 자리 · 이상한 출력) `?` 를
 *  쓴다 — ⚠ 산술에 숫자가 아닌 값(빈 값 · `12:34`)이나 앞자리 0(`0899` — 8진수로 읽힌다)이 들어가면 dash·bash 는
 *  스크립트째 죽고, 그러면 조회 전체가 빈 값이 된다. 그래서 두 값을 **따로** 검사한다.
 */
export function headlessReadSh(p: HeadlessPaths): string {
  return [
    `cat ${q(p.log)} 2>/dev/null`,
    `printf '\\n%s\\n' '${SEP_STORED}'`,
    `cat ${q(p.stored)} 2>/dev/null`,
    `printf '\\n%s\\n' '${SEP_TOK}'`,
    `cat ${q(p.tok)} 2>/dev/null`,
    `printf '\\n%s\\n' '${SEP_PID}'`,
    `if [ -f ${q(p.pid)} ]; then`
      + ` n=$(date +%s 2>/dev/null); m=$(stat -c %Y ${q(p.pid)} 2>/dev/null || stat -f %m ${q(p.pid)} 2>/dev/null); a='?';`
      + ` case "$n" in ''|*[!0-9]*|0?*) ;; *) case "$m" in ''|*[!0-9]*|0?*) ;; *) a=$((n - m));; esac;; esac;`
      + ` printf '%s ' "$a"; cat ${q(p.pid)} 2>/dev/null; fi`,
    `printf '\\n%s\\n' '${SEP_END}'`,
  ].join("; ");
}

export interface HeadlessRead {
  /** 러너 기록(머리 줄은 뗐다). 지금 자리 주인의 것이 아니면 빈 값이다. */
  log: string;
  stored: boolean;
  /** ⚠ 비밀 — readHeadlessLogin 머리말. */
  captured: string | null;
  /**
   * 러너가 끝났다 — 시도의 흔적(기록 · 저장 표식)이 있는데 자리 주인이 없거나, 주인의 심박이 멈췄다.
   *  조회가 온전하지 않거나 자리가 비어 있으면 false 다 — 모르면 끝났다고 하지 않는다. 특히 **빈 자리**(시작이 실패했거나
   *  아직 아무것도 없다)를 «끝났다» 고 하면, 화면이 방금 보인 구체적 시작 오류(암호화 키 없음 · tmux 없음 · 중계 실패)를
   *  엉뚱한 사유로 덮는다(리뷰 #4051).
   */
  ended: boolean;
}
const HEADER_RE = new RegExp(`^${HEADLESS_RUN_MARK} ([0-9a-f]{8,64})\\n`);

/**
 * (순수) 조회 결과 → 네 칸 + 러너 수명 판정.
 *  · 기록 첫 줄의 실행 id 가 자리 주인과 다르면 그 기록은 남의 시도의 것이다 — 버린다.
 *  · 머리 없는 기록(이전 판 러너)은 믿는다 — 배포 순간 진행 중이던 연결을 안 깬다.
 *  · 심박 나이는 정수만 믿는다(`?` · 이상한 출력은 «모름» — 나이로는 판정하지 않는다).
 */
export function splitHeadlessRead(out: string): HeadlessRead {
  const s = String(out ?? "");
  const e = s.lastIndexOf(`\n${SEP_END}`);
  const k = e < 0 ? -1 : s.lastIndexOf(`\n${SEP_PID}\n`, e);
  const j = k < 0 ? -1 : s.lastIndexOf(`\n${SEP_TOK}\n`, k);
  const i = j < 0 ? -1 : s.lastIndexOf(`\n${SEP_STORED}\n`, j);
  if (i < 0) return { log: "", stored: false, captured: null, ended: false };
  let log = s.slice(0, i);
  const stored = s.slice(i + SEP_STORED.length + 2, j).trim().length > 0;
  const tok = s.slice(j + SEP_TOK.length + 2, k).trim();
  const pid = s.slice(k + SEP_PID.length + 2, e).trim();

  //  자리 주인: 파일이 없으면 빈 줄. 있으면 «나이 주인» — 주인이 비어 있을 수 있다(시작 스크립트가 쓰는 찰나).
  const sp = pid.indexOf(" ");
  const ageStr = pid ? (sp < 0 ? pid : pid.slice(0, sp)) : "";
  const owner = pid && sp >= 0 ? pid.slice(sp + 1).trim() : "";
  const age = /^-?\d+$/.test(ageStr) ? Math.max(0, Number(ageStr)) : null;
  const trace = log.length > 0 || stored;
  const ended = (!pid && trace) || (age !== null && age > HEADLESS_DEAD_SEC);

  const hm = log.match(HEADER_RE);
  if (hm) {
    log = log.slice(hm[0].length);
    if (owner && hm[1] !== owner) log = "";   // 남의 시도가 남긴 화면 — 옛 주소를 보이면 사람이 죽은 시도로 승인한다
  }
  return { log, stored, captured: tok || null, ended };
}

/** 발급을 시작한다(멱등 — 이미 돌고 있으면 그대로). */
export async function startHeadlessLogin(osUser: string | null, h: HeadlessLoginHarness, user?: LivelyUser | null): Promise<void> {
  const script = headlessStartSh({
    home: loginHomeOf(osUser), slotName: headlessSlot(osUser, h), harness: h, runId: randomBytes(9).toString("hex"),
  });
  const out = await spawnAtLoginSeat(user ?? null, osUser, headlessSeatKey(h), script);
  if (!/started|running/.test(out)) throw new Error(`연결 명령을 띄우지 못했습니다 — ${out.slice(0, 160)}`);
}

/**
 * 지금까지의 화면 · 저장 여부 · (있으면) 러너가 잡은 자격.
 *  ⚠ `captured` 는 **비밀**이다 — 호출자는 저장에만 쓰고 응답·로그로 내보내지 않는다.
 */
export async function readHeadlessLogin(osUser: string | null, h: HeadlessLoginHarness): Promise<HeadlessRead> {
  const p = headlessPaths(loginHomeOf(osUser), headlessSlot(osUser, h));
  const out = await runAtLoginSeatSh(osUser, headlessReadSh(p)).catch(() => "");
  return splitHeadlessRead(out);
}

/** 사람이 브라우저에서 받아 온 코드를 넣는다(claude). 값 검증은 대화형 로그인과 같다. */
export async function pasteHeadlessLogin(osUser: string | null, h: HeadlessLoginHarness, code: string): Promise<void> {
  const v = String(code).trim();
  if (!/^[A-Za-z0-9._~+/=#?&:%-]{4,512}$/.test(v)) throw new Error("코드 형식이 올바르지 않습니다.");
  const p = headlessPaths(loginHomeOf(osUser), headlessSlot(osUser, h));
  await runAtLoginSeatSh(osUser, `umask 077; printf '%s' ${q(v)} > ${q(p.inp)}`);
}

/** 저장을 마쳤다 — 자격 파일을 지우고 표식을 남긴다. pid 파일도 지운다 = 러너에게 «끝내라»(다음 박동에 끝난다). */
export async function markHeadlessStored(osUser: string | null, h: HeadlessLoginHarness): Promise<void> {
  const p = headlessPaths(loginHomeOf(osUser), headlessSlot(osUser, h));
  await runAtLoginSeatSh(osUser, [
    //  표식을 **먼저** 쓴다 — 지운 뒤에 쓰면 그 사이의 조회가 «자격도 주인도 없는데 잡았다는 기록» 을 보고
    //   «저장 전에 잃었다» 고 말한다(리뷰 #4051). 러너는 이미 잡았으므로(got) 자격 파일을 다시 쓰지 않는다.
    `date -u +%Y-%m-%dT%H:%M:%SZ > ${q(p.stored)}`,
    `rm -f ${q(p.pid)} ${q(p.tok)}`,
    `echo ok`,
  ].join("\n"));
}

/** 발급 자리를 치운다(그만두거나 다시 시작). 잡았지만 안 거둔 자격도 함께 지운다. */
export async function cancelHeadlessLogin(osUser: string | null, h: HeadlessLoginHarness): Promise<void> {
  const p = headlessPaths(loginHomeOf(osUser), headlessSlot(osUser, h));
  //  ⚠ 프로세스를 슬롯 이름으로도, pid 로도 찾지 않는다. pid 파일을 **지우는 것이 곧 멈춤 신호**다(러너 머리말).
  await runAtLoginSeatSh(osUser, `${headlessCleanSh(p)}; echo ok`).catch(() => "");
}

/** 이 하네스가 저장할 비밀 종류(재수출 — 라우트가 flow 를 따로 import 하지 않게). */
export const headlessSecretKindOf = (h: HeadlessLoginHarness): string => HEADLESS_SECRET_KIND[h];
