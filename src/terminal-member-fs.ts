// 중앙 박스 구성원 격리(#524) — 격리 홈(멤버 700)의 파일 op 를 그 멤버 OS 계정으로 수행.
//  게이트웨이(비-root lively)는 멤버 700 홈에 직접 접근 못 하므로, 파일 API(ls/stat/read/write/mkdir)를
//  sudo → box-spawn 로 **멤버 uid** 에서 실행한다(wrapAsMember). 구조적 op(ls/stat)는 node one-liner 로
//  JSON emit(ls 출력 파싱 대신 안전), 스트리밍(read/write)은 cat / sh-redirect. 생성 파일 소유자=멤버(정합).
//  ⚠ 경로 봉쇄(세션 dir 내부)는 호출부(terminal-files resolveInSession)가 이미 건다 — 여기선 uid 만 내린다.
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { wrapAsMember } from "./terminal-isolation.js";

// node one-liner(멤버 PATH 의 node 로 실행). argv[1]=대상 절대경로. 셸 미경유(argv) — 인젝션 없음.
const LS_JS =
  "const fs=require('fs'),p=process.argv[1],o=[];" +
  "for(const e of fs.readdirSync(p,{withFileTypes:true})){const d=e.isDirectory();let s=0;" +
  "if(!d){try{s=fs.statSync(p+'/'+e.name).size}catch{}}o.push({name:e.name,type:d?'dir':'file',size:s})}" +
  "process.stdout.write(JSON.stringify(o))";
const STAT_JS =
  "const fs=require('fs');try{const s=fs.statSync(process.argv[1]);" +
  "process.stdout.write(JSON.stringify({size:s.size,file:s.isFile(),dir:s.isDirectory()}))}" +
  "catch{process.stdout.write('null')}";

// box-spawn 경유로 멤버 uid 에서 프로세스 스폰. wrapAsMember = ["sudo","-n","-u",osUser,"--",BOX_SPAWN,...argv].
function memberSpawn(osUser: string, argv: string[], stdio: Array<"ignore" | "pipe">): ChildProcess {
  const full = wrapAsMember(osUser, argv);
  return spawn(full[0], full.slice(1), { stdio });
}
// 자식 stderr 를 문자열로 수집(진단). 스트림 null 이면 no-op.
function collectErr(c: ChildProcess): { get: () => string } {
  let err = "";
  c.stderr?.on("data", (d) => (err += d));
  return { get: () => err.trim() };
}

export interface LsEntry { name: string; type: "dir" | "file"; size: number; }

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
export function memberWriteFrom(osUser: string, absPath: string, src: Readable, maxBytes: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = memberSpawn(osUser, ["sh", "-c", 'cat > "$0"', absPath], ["pipe", "ignore", "pipe"]);
    const err = collectErr(c);
    c.on("error", reject);
    const stdin = c.stdin;
    if (!stdin) return reject(new Error("member write: no stdin"));
    let size = 0, aborted = false;
    const abort = (e: Error): void => {
      if (aborted) return;
      aborted = true;
      try { c.kill("SIGKILL"); } catch { /* 이미 죽었으면 무시 */ }
      reject(e);
    };
    src.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // 초과분은 더 읽지 않되 소켓은 죽이지 않는다 — 죽이면 413 응답을 보낼 상대가 사라진다.
      if (size > maxBytes && !aborted) { src.pause(); abort(new Error("too large")); return; }
      stdin.write(chunk);
    });
    src.on("end", () => { try { stdin.end(); } catch { /* */ } });
    src.on("error", abort); // 클라이언트가 업로드를 끊음(취소) — cat 도 같이 죽여 stdin 열린 채 남지 않게
    c.on("close", (code) => { if (aborted) return; code === 0 ? resolve() : reject(new Error(err.get() || `member write exit ${code}`)); });
  });
}
