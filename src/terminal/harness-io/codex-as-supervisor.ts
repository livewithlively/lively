// 격리 리눅스 박스(#524)의 codex app-server 자리 — **TCP 를 쓰지 않는다**. (#2055)
//
//  ── 왜 포트가 아니라 소켓인가 ──
//  `codex app-server --listen ws://127.0.0.1:<포트>` 에는 **인증이 없다**. 배포마다 경계를 서 주는 것이 다르다:
//   · 매니지드      세션 컨테이너가 선다 — loopback 이 그 세션 안이라 밖에서 못 닿는다.
//   · 비격리(맥·dev) 단일 사용자 박스라 지킬 경계가 없다.
//   · **격리 리눅스**  여러 멤버가 **한 호스트**를 나눠 쓴다. loopback 포트는 uid 를 안 가리므로
//     같은 박스의 다른 멤버가 그 포트에 붙어 **남의 대화를 조종**할 수 있다 — 이 배포의 존재 이유인
//     그 경계가 거기서만 비어 있었다.
//  포트를 없애면 그 구멍도 없어진다. 감독자를 **그 멤버 uid 로** 띄우고 유닉스 소켓을 **0600** 으로 두면,
//  경계는 파일 권한이 선다(다른 멤버의 uid 로는 open 자체가 안 된다). 그래서 «켤 때 동의를 받는 노브» 가
//  필요 없다 — 격리가 실제로 지켜지므로 대화 UI 를 그냥 기본으로 둘 수 있다.
//
//  ── 왜 감독자를 따로 두나(그냥 app-server 를 stdio 로 띄우면 안 되나) ──
//  그러면 서버가 그 exec 의 **자식**이라 게이트웨이가 재기동되면 같이 죽는다 — 돌던 턴이 통째로 유실되는
//  그 회귀다(#2055 실측 2026-08-26 dev: 18:23 프롬프트 → 18:24 재기동 → 답 영영 없음). 감독자가 서버를
//  붙들고 있으면 **다리만 끊기고 서버는 남아** 턴을 마치고 rollout 에 답을 쓴다. 화면의 읽기 경로가 그
//  파일이므로 답은 도착한다 — 포트판이 주던 이득을 소켓판도 그대로 준다.
//
//  ── 왜 codex 의 daemon/proxy 를 안 쓰나(실측 2026-08-27) ──
//  `codex app-server daemon start` 는 **standalone 설치본**(`$CODEX_HOME/packages/standalone/current/codex`)을
//  요구한다 — 우리 이미지는 npm 전역 설치라 없다("managed standalone Codex install not found").
//  `codex app-server proxy --sock` 는 그 daemon 의 control 소켓 전용이고, `--listen unix://<경로>` 가 만든
//  소켓(0600 으로 생기는 것까지 확인)에 붙여 initialize 를 보내면 **응답이 없다**. 그래서 우리 감독자를 둔다.
import { createHash } from "node:crypto";

/** 유닉스 소켓 경로는 **짧아야 한다** — SUN_LEN(리눅스 108·맥 104)을 넘으면 bind 가 실패한다(실측). */
export function sessionSockName(sessionId: string): string {
  return `lvly-as-${createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 10)}.sock`;
}

/**
 * 감독자 스크립트 원문(멤버 홈에 심어 멤버 uid 로 돈다).
 *  · `serve <sock> <log>` — app-server 를 stdio 로 붙들고, 0600 유닉스 소켓으로 중계한다. 기동을 확인해 말한다.
 *  · `connect <sock>`     — 그 소켓에 붙어 stdin/stdout 으로 잇는다(게이트웨이가 이걸 자식으로 띄운다).
 *
 *  ⚠ 클라이언트는 **한 번에 하나**다. codex 는 스레드당 writer 를 하나만 허용하므로 둘이 붙을 이유가 없고,
 *   새 연결이 오면 이전 것을 끊는다(게이트웨이 재기동 뒤 재접속이 정상 경로다).
 *  ⚠ 붙은 클라이언트가 없을 때의 출력은 버린다 — 답의 정본은 rollout 파일이지 이 스트림이 아니다.
 */
export const SUPERVISOR_JS = `
const net=require("net"),fs=require("fs"),cp=require("child_process");
const mode=process.argv[2],sock=process.argv[3];
if(mode==="connect"){
  const c=net.connect(sock);
  c.on("error",e=>{process.stderr.write("connect: "+e.message+"\\n");process.exit(1)});
  process.stdin.pipe(c);c.pipe(process.stdout);
  c.on("close",()=>process.exit(0));
}else{
  const log=process.argv[4];
  try{fs.unlinkSync(sock)}catch(e){}
  const out=fs.openSync(log,"a");
  const srv=cp.spawn("codex",["app-server"],{stdio:["pipe","pipe",out]});
  srv.on("error",e=>{process.stderr.write("spawn: "+e.message+"\\n");process.exit(1)});
  srv.on("exit",()=>process.exit(0));
  let client=null;
  srv.stdout.on("data",d=>{if(client)client.write(d)});
  const s=net.createServer(c=>{
    if(client)client.destroy();
    client=c;
    c.on("data",d=>{try{srv.stdin.write(d)}catch(e){}});
    c.on("close",()=>{if(client===c)client=null});
    c.on("error",()=>{});
  });
  s.on("error",e=>{process.stderr.write("listen: "+e.message+"\\n");process.exit(1)});
  s.listen(sock,()=>{try{fs.chmodSync(sock,0o600)}catch(e){}process.stdout.write("started\\n")});
}
`.trim();

/**
 * (순수) 감독자를 **떼어내어** 띄우는 셸 한 줄.
 *  이미 소켓이 살아 있으면 두 번 띄우지 않는다(서버 둘이 같은 스레드를 노리면 writer 충돌이 난다).
 *  기동은 **확인해서** 말한다 — `&` 는 즉시 0 을 돌려주므로 그것만으로는 아무것도 안 본 것과 같다.
 */
export function supervisorStartSh(o: { script: string; sock: string; log: string; env?: Record<string, string> }): string {
  const env = Object.entries(o.env ?? {}).map(([k, v]) => `${k}='${String(v).replace(/'/g, "")}'`).join(" ");
  return [
    `if command -v codex >/dev/null 2>&1; then :; else echo "codex 없음" >&2; exit 127; fi`,
    `if node -e 'require("net").connect(process.argv[1]).on("connect",function(){process.exit(0)}).on("error",function(){process.exit(1)})' "${o.sock}" 2>/dev/null; then echo already; exit 0; fi`,
    `mkdir -p "$(dirname "${o.log}")" 2>/dev/null || true`,
    `${env ? env + " " : ""}nohup node "${o.script}" serve "${o.sock}" "${o.log}" >/dev/null 2>&1 &`,
    // 소켓이 실제로 열렸는지 최대 ~10초 기다린다. 안 열리면 로그 꼬리를 stderr 로 올려 진단이 남게 한다.
    `i=0; while [ $i -lt 20 ]; do if node -e 'require("net").connect(process.argv[1]).on("connect",function(){process.exit(0)}).on("error",function(){process.exit(1)})' "${o.sock}" 2>/dev/null; then echo started; exit 0; fi; i=$((i+1)); sleep 0.5; done`,
    `echo "app-server 감독자가 소켓을 열지 않았다" >&2; tail -n 5 "${o.log}" >&2 2>/dev/null; exit 1`,
  ].join("\n");
}
