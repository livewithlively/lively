// 중앙 박스 구성원 격리(#524) — 격리 홈(멤버 700)의 파일 op 를 그 멤버 OS 계정으로 수행.
//  게이트웨이(비-root lively)는 멤버 700 홈에 직접 접근 못 하므로, 파일 API(ls/stat/read/write/mkdir)를
//  sudo → box-spawn 로 **멤버 uid** 에서 실행한다(wrapAsMember). 구조적 op(ls/stat)는 node one-liner 로
//  JSON emit(ls 출력 파싱 대신 안전), 스트리밍(read/write)은 cat / sh-redirect. 생성 파일 소유자=멤버(정합).
//  ⚠ 경로 봉쇄(세션 dir 내부)는 호출부(terminal-files resolveInSession)가 이미 건다 — 여기선 uid 만 내린다.
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { memberExecConfigured, wrapAsMember } from "./terminal-isolation.js";
import { tenantSlug } from "./catalog.js";

// node one-liner(멤버 PATH 의 node 로 실행). argv[1]=대상 절대경로. 셸 미경유(argv) — 인젝션 없음.
// 심링크(#1744): dirent 의 isDirectory() 는 링크에 대해 **항상 false** 라, 폴더를 가리키는 링크가 '파일'로 나왔다
//  (세션 폴더의 ./project 가 그 대표 — 눌러도 미리보기가 열려 못 들어갔다). statSync 는 링크를 따라가므로 그 값으로
//  실효 종류를 정하고, link/linkTarget 으로 '링크였다'는 사실도 함께 싣는다(끊어진 링크는 stat 이 던져 file 로 남는다).
export const LS_JS =
  "const fs=require('fs'),p=process.argv[1],o=[];" +
  "for(const e of fs.readdirSync(p,{withFileTypes:true})){const l=e.isSymbolicLink();let d=e.isDirectory(),s=0,m=0,t='';" +
  "try{const st=fs.statSync(p+'/'+e.name);m=Math.floor(st.mtimeMs);if(l)d=st.isDirectory();if(!d)s=st.size}catch{}" +
  "if(l){try{t=fs.readlinkSync(p+'/'+e.name)}catch{}}" +
  "o.push({name:e.name,type:d?'dir':'file',size:s,mtime:m,link:l,linkTarget:t})}" +
  "process.stdout.write(JSON.stringify(o))";
const STAT_JS =
  "const fs=require('fs');try{const s=fs.statSync(process.argv[1]);" +
  "process.stdout.write(JSON.stringify({size:s.size,file:s.isFile(),dir:s.isDirectory()}))}" +
  "catch{process.stdout.write('null')}";

/**
 * 멤버 파일 op 실행 seam — 기본은 **로컬 uid 강하**(설정 없으면 종전과 완전히 동일하다).
 *
 * 왜 필요한가: 이 파일의 모든 op 는 "게이트웨이와 파일이 같은 호스트에 있다"는 가정으로
 *  sudo→box-spawn 을 부른다. 그 가정이 깨지는 배포(파일은 실행 노드, 게이트웨이는 중앙 컨테이너)
 *  에서는 여기 하나만 갈아끼우면 상위(terminal-files·upload·session-project)는 한 줄도 안 바뀐다 —
 *  tmuxExecArgv 와 같은 자리·같은 교리다.
 *
 * 계약: 지정한 프로그램을 `<중계> <osUser> -- <argv...>` 로 실행한다. 중계는 argv 를 **그 멤버의
 *  실행 환경**(우리 배포에선 그 테넌트의 컨테이너)에서 돌리고, stdio 를 바이트 그대로 잇고,
 *  argv 의 종료코드로 끝난다 — 로컬 실행과 같은 규약이라 상위 파서·에러 처리가 그대로 동작한다.
 *
 * ★★ `{slug}` 템플릿인데 테넌트 컨텍스트가 없으면 **던진다.** 로컬로 폴백하면 그 op 가 게이트웨이
 *  컨테이너의 (존재하지 않거나 남의) 경로를 만진다 — tmuxExecArgv 의 판단과 같은 교리다.
 */
export function memberExecArgv(): string[] {
  const raw = (process.env.LIVELY_MEMBER_EXEC || "").trim();
  if (!raw) return [];
  if (!raw.includes("{slug}")) return raw.split(/\s+/);
  const slug = tenantSlug();
  if (!slug) throw new Error("멤버 파일 op 중계에 테넌트 컨텍스트가 필요합니다 — 컨텍스트 밖에서 호출됐습니다");
  return raw.replace("{slug}", slug).split(/\s+/);
}

// box-spawn 경유로 멤버 uid 에서 프로세스 스폰. wrapAsMember = ["sudo","-n","-u",osUser,"--",BOX_SPAWN,...argv].
//  중계 배포(memberExecConfigured)면 `<중계> <osUser> -- <argv...>` — memberExecArgv 머리말 참조.
/**
 * (순수 — 테스트 seam) 멤버 경계에서 argv 를 돌릴 **전체 명령**을 조립한다.
 *  · 중계 배포(LIVELY_MEMBER_EXEC): `<중계> <osUser> -- <argv…>` — 그 멤버의 실행 환경(테넌트 컨테이너)에서 돈다.
 *  · 로컬 격리:                      `sudo -n -u <osUser> -- box-spawn <argv…>`(wrapAsMember).
 * 파일 op 말고도 **멤버 uid 로 떠야 하는 장수 프로세스**(#2055 codex app-server)가 같은 자리를 쓴다 —
 * 경계 계산이 두 벌이 되면 한쪽만 고쳐져 조용히 게이트웨이 권한으로 도는 프로세스가 생긴다.
 */
export function memberSpawnArgv(osUser: string, argv: string[]): string[] {
  const relay = memberExecConfigured() ? memberExecArgv() : [];
  return relay.length ? [...relay, osUser, "--", ...argv] : wrapAsMember(osUser, argv);
}

function memberSpawn(osUser: string, argv: string[], stdio: Array<"ignore" | "pipe">): ChildProcess {
  const full = memberSpawnArgv(osUser, argv);
  return spawn(full[0], full.slice(1), { stdio });
}
// 자식 stderr 를 문자열로 수집(진단). 스트림 null 이면 no-op.
function collectErr(c: ChildProcess): { get: () => string } {
  let err = "";
  c.stderr?.on("data", (d) => (err += d));
  return { get: () => err.trim() };
}

export interface LsEntry { name: string; type: "dir" | "file"; size: number; mtime: number; link?: boolean; linkTarget?: string; }

// 업로드 정지(#1272) — 본문이 **한 바이트도 오지 않는데 요청이 닫히지도 않는** 상태의 상한.
//  실측(고객사 A 실박스): 중간에서(사내 PC 문서보안(DLP)·프록시) 브라우저에만 403 을 돌려주고 본문 중계를 멈추면,
//  요청은 data·end·error·close 를 **하나도** 못 받고 영구히 열려 있다(33분 경과 요청 + `cat` 자식 + 0바이트 임시파일 생존).
//  Node 의 server.requestTimeout(기본 300s)도 이 경로를 구제하지 못했으므로 여기서 직접 idle 상한을 건다.
//  진행 중인 업로드는 청크마다 상한이 다시 시작되므로 느린 회선을 끊지 않는다.
export const UPLOAD_STALLED = "upload stalled";
export const UPLOAD_STALL_MS = 120_000;

export function memberLs(osUser: string, absPath: string): Promise<LsEntry[]> {
  return new Promise((resolve, reject) => {
    const c = memberSpawn(osUser, ["node", "-e", LS_JS, absPath], ["ignore", "pipe", "pipe"]);
    const err = collectErr(c);
    let out = "";
    c.stdout?.on("data", (d) => (out += d));
    c.on("error", reject);
    c.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.get() || `member ls exit ${code}`));
      try { resolve(JSON.parse(out || "[]") as LsEntry[]); } catch (e) { reject(e as Error); }
    });
  });
}

// 멤버 uid 로 `sh -c <script>` 를 돌리고 **stdout 을 받는다**.
//  ⚠ memberSh 와 다르다: 그쪽은 stdout 을 **버리고** `Promise<void>` 를 돌려준다(성공/실패만 본다).
//   출력이 필요한 자리에서 memberSh 를 쓰면 `await` 값이 undefined 라 **조용히 빈 문자열**이 된다 —
//   실측(2026-08-27, #2055): rolloutPath 가 그렇게 써서 격리·매니지드 배포에서 대화 파일 경로를 **항상 ""**
//   로 돌려줬고, 그 결과 화면이 답이 쓰인 파일을 못 찾아 «답이 안 온다» 가 됐다. 타입이 void 라
//   컴파일러도 안 잡는 자리다(String(undefined ?? "") 는 합법). 그래서 통로를 따로 둔다.
//  스크립트는 우리 코드의 **고정 리터럴**만(사용자 입력 X → 인젝션 없음) — memberSh 와 같은 계약이다.
export function memberShOut(osUser: string, script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = memberSpawn(osUser, ["sh", "-c", script], ["ignore", "pipe", "pipe"]);
    const err = collectErr(c);
    let out = "";
    c.stdout?.on("data", (d) => (out += d));
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.get() || `member sh exit ${code}`))));
  });
}

// 멤버 uid 로 node 한 줄(고정 리터럴)을 돌리고 stdin JSON → stdout JSON 을 받는다(#1719 session-project — 세션 폴더 안
//  마커·링크·셔틀을 격리 홈(700)에 쓰려면 이 통로뿐이다). 스크립트는 우리 코드의 **고정 리터럴**, 값은 전부 stdin JSON.
export function memberNodeJson<T>(osUser: string, js: string, input: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const c = memberSpawn(osUser, ["node", "-e", js], ["pipe", "pipe", "pipe"]);
    const err = collectErr(c);
    let out = "";
    c.stdout?.on("data", (d) => (out += d));
    c.on("error", reject);
    if (!c.stdin) return reject(new Error("member node: no stdin"));
    c.stdin.on("error", reject);
    c.stdin.end(JSON.stringify(input));
    c.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.get() || `member node exit ${code}`));
      try { resolve(JSON.parse(out || "null") as T); } catch (e) { reject(e as Error); }
    });
  });
}

export function memberStat(osUser: string, absPath: string): Promise<{ size: number; file: boolean; dir: boolean } | null> {
  return new Promise((resolve, reject) => {
    const c = memberSpawn(osUser, ["node", "-e", STAT_JS, absPath], ["ignore", "pipe", "pipe"]);
    const err = collectErr(c);
    let out = "";
    c.stdout?.on("data", (d) => (out += d));
    c.on("error", reject);
    c.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.get() || `member stat exit ${code}`));
      try { resolve(JSON.parse(out || "null")); } catch (e) { reject(e as Error); }
    });
  });
}

export function memberMkdir(osUser: string, absPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = memberSpawn(osUser, ["mkdir", "-p", "--", absPath], ["ignore", "ignore", "pipe"]);
    const err = collectErr(c);
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.get() || `member mkdir exit ${code}`))));
  });
}

// 멤버 uid 로 이름변경/이동(mv). 덮어쓰기 방지(대상 존재 확인)는 호출부에서 memberStat 로.
export function memberMv(osUser: string, fromAbs: string, toAbs: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = memberSpawn(osUser, ["mv", "--", fromAbs, toAbs], ["ignore", "ignore", "pipe"]);
    const err = collectErr(c);
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.get() || `member mv exit ${code}`))));
  });
}

// 멤버 uid 로 삭제(rm -rf, 파일/폴더). ⚠ 경로 봉쇄(루트 내부)는 호출부(resolveRootPath)가 이미 건다 — 여긴 uid 만 내린다.
export function memberRm(osUser: string, absPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = memberSpawn(osUser, ["rm", "-rf", "--", absPath], ["ignore", "ignore", "pipe"]);
    const err = collectErr(c);
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.get() || `member rm exit ${code}`))));
  });
}

// 멤버 파일 → dest(res). cat 으로 스트리밍, dest 로 pipe(백프레셔 존중).
export function memberReadTo(osUser: string, absPath: string, dest: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = memberSpawn(osUser, ["cat", "--", absPath], ["ignore", "pipe", "pipe"]);
    const err = collectErr(c);
    c.on("error", reject);
    if (!c.stdout) return reject(new Error("member read: no stdout"));
    c.stdout.on("error", reject);
    c.stdout.pipe(dest);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.get() || `member read exit ${code}`))));
  });
}

// 멤버 파일의 바이트 구간 [start,end) — 대화 파일 창 읽기(harness-io/transcript-fs)가 쓴다.
//  `tail -c +K | head -c N`(K=start+1, 1-based). 스크립트는 고정 리터럴, 값(오프셋·길이·경로)은 전부 argv(인젝션 없음).
//  head 가 N 바이트를 받으면 파이프를 닫아 tail 이 스스로 끝난다 — 우리 쪽에서 EOF 를 신호할 일이 없다(중계 채널은
//  half-close 를 전체 종료로 전파하므로 stdin 없는 op 여야 한다). 파일이 짧으면 짧게 돌아온다(=EOF, ByteReader 계약).
export function memberReadRange(osUser: string, absPath: string, start: number, end: number): Promise<Buffer> {
  const s = Math.max(0, Math.floor(start));
  const n = Math.floor(end) - s;
  if (n <= 0) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    const c = memberSpawn(osUser, ["sh", "-c", 'tail -c +"$1" -- "$3" | head -c "$2"', "lively-range", String(s + 1), String(n), absPath], ["ignore", "pipe", "pipe"]);
    const err = collectErr(c);
    const chunks: Buffer[] = [];
    c.stdout?.on("data", (d: Buffer) => chunks.push(d));
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err.get() || `member range exit ${code}`))));
  });
}

// 멤버 uid 로 `sh -c <script>` 실행(선택 stdin) — 스크립트는 **우리 코드의 고정 리터럴**만(사용자입력 X → 인젝션 없음).
//  시크릿(git 개인키·토큰 등)은 argv 아닌 **stdin** 으로만 전달한다(ps/argv 노출 회피). git 자격 materialize(#540)에 쓰인다.
export function memberSh(osUser: string, script: string, stdin?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = memberSpawn(osUser, ["sh", "-c", script], [stdin != null ? "pipe" : "ignore", "ignore", "pipe"]);
    const err = collectErr(c);
    c.on("error", reject);
    if (stdin != null) {
      if (!c.stdin) return reject(new Error("member sh: no stdin"));
      c.stdin.on("error", reject);
      c.stdin.end(stdin);
    }
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.get() || `member sh exit ${code}`))));
  });
}

// src(req) → 멤버 파일. `sh -c 'cat > "$0"' <abs>` 로 멤버 소유 파일 생성. maxBytes 초과 시 중단('too large').
//  ⚠ 호출부는 **임시 경로**를 주고 완료 후 memberMv 로 목적지에 옮긴다(upload-file.ts) — cat 은 목적지를 즉시 truncate 하므로
//  업로드가 끊기면(취소) 여기에 목적지를 바로 주면 원본이 잘려나간다(#797).
export function memberWriteFrom(
  osUser: string, absPath: string, src: Readable, maxBytes: number, stallMs = UPLOAD_STALL_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = memberSpawn(osUser, ["sh", "-c", 'cat > "$0"', absPath], ["pipe", "ignore", "pipe"]);
    const err = collectErr(c);
    c.on("error", reject);
    const stdin = c.stdin;
    if (!stdin) return reject(new Error("member write: no stdin"));
    let size = 0, aborted = false;
    let idle: NodeJS.Timeout | undefined;
    const clearIdle = (): void => { if (idle) { clearTimeout(idle); idle = undefined; } };
    // 진행이 있으면 상한을 다시 센다(느린 회선 보호) — 아무것도 안 오면 stallMs 뒤 정지로 판정(#1272).
    const armIdle = (): void => {
      clearIdle();
      if (stallMs > 0) idle = setTimeout(() => abort(new Error(UPLOAD_STALLED)), stallMs);
    };
    const abort = (e: Error): void => {
      if (aborted) return;
      aborted = true;
      clearIdle();
      // ⚠ 자식 사슬은 **stdin 을 닫아서** 끝낸다 — kill 은 직접 자식인 `sudo` 하나만 종료시키고,
      //  그 아래 `box-spawn → sh → cat` 은 고아로 살아남아 임시파일을 계속 붙잡는다(사슬 종료가 파이프 닫힘에
      //  간접적으로 의존하게 된다). stdin 을 닫으면 cat 이 EOF 를 보고 사슬 전체가 정상 종료(exit 0)된다.
      //  kill 은 그래도 best-effort 로 함께 시도한다(실측: sudo 의 real uid = 게이트웨이 uid → 시그널은 허용된다).
      try { stdin.destroy(); } catch { /* 이미 닫혔으면 무시 */ }
      try { c.kill("SIGKILL"); } catch { /* 이미 죽었으면 무시 */ }
      reject(e);
    };
    armIdle();
    src.on("data", (chunk: Buffer) => {
      size += chunk.length;
      armIdle();
      // 초과분은 더 읽지 않되 소켓은 죽이지 않는다 — 죽이면 413 응답을 보낼 상대가 사라진다.
      if (size > maxBytes && !aborted) { src.pause(); abort(new Error("too large")); return; }
      stdin.write(chunk);
    });
    src.on("end", () => { clearIdle(); try { stdin.end(); } catch { /* */ } });
    src.on("error", abort); // 클라이언트가 업로드를 끊음(취소) — cat 도 같이 끝내 stdin 열린 채 남지 않게
    // error 없이 끊긴 경우(런타임·프록시에 따라 close 만 오기도) — 응답할 상대가 없으니 취소로 본다(uploadError→null).
    src.on("close", () => { if (!src.readableEnded) abort(new Error("aborted")); });
    c.on("close", (code) => {
      clearIdle();
      if (aborted) return;
      code === 0 ? resolve() : reject(new Error(err.get() || `member write exit ${code}`));
    });
  });
}

// 문자열 → 멤버 소유 파일(작은 파일 전용, #1780 앱 세션 물질화). `cat > "$0" && chmod "$1" "$0"` 로 멤버 uid 에서
//  파일을 만들고 모드를 굳힌다 — 경로·모드는 **argv**($0·$1)로만 넘겨 스크립트 본문에 문자열을 안 섞는다(인젝션 없음,
//  memberWriteFrom 의 `cat > "$0"` 규약과 동일). data 는 우리 코드가 만든 내용(앱 토큰·조립된 자산)이라 stdin 으로 준다.
//  ⚠ 스트리밍 업로드(memberWriteFrom)와 달리 상한/스톨 가드가 없다 — 서버가 만든 유한한 작은 문자열에만 쓴다.
export function memberWriteFile(osUser: string, absPath: string, data: string, mode = 0o600): Promise<void> {
  const octal = (mode & 0o777).toString(8).padStart(3, "0");
  return new Promise((resolve, reject) => {
    const c = memberSpawn(osUser, ["sh", "-c", 'cat > "$0" && chmod "$1" "$0"', absPath, octal], ["pipe", "ignore", "pipe"]);
    const err = collectErr(c);
    c.on("error", reject);
    const stdin = c.stdin;
    if (!stdin) return reject(new Error("member write: no stdin"));
    stdin.on("error", reject);
    stdin.end(data);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.get() || `member write exit ${code}`))));
  });
}
