// 대화 파일 접근 파사드 — 게이트웨이 로컬 fs 와 **멤버 실행환경 중계**(LIVELY_MEMBER_EXEC) 두 구현 (#1437 ②).
//
//  ── 왜 ──
//  chat-routes 는 대화 파일을 fsp.open/stat 로 **직독**했다. 파일과 게이트웨이가 한 호스트에 있다는 전제인데, 매니지드
//  (중앙 게이트웨이 1개·파일시스템 마운트 0)에서는 파일이 실행 노드의 멤버 홈에 있다 → locateTranscript 가 매번 null → 404
//  (도그푸드 실측 2026-08-18). 파일 API(terminal-files)는 이미 memberSpawn seam 으로 그 노드에서 op 를 돌리므로, 대화 파일도
//  **같은 관문**을 탄다: 존재/크기(memberStat) · 구간 읽기(memberReadRange = tail|head) · 압축 전 파일 탐색(node 한 줄).
//  로컬 구현은 종전 코드 그대로 — 중계가 설정되지 않은 배포는 한 바이트도 안 바뀐다(seam 교리).
//
//  ── 어느 쪽인가 ──
//  transcriptFsFor(osUser): 중계 설정(memberExecConfigured) + 세션 소유자의 osUser 가 있으면 멤버 구현, 아니면 로컬.
//  ⚠ 로컬 격리(box-spawn) 박스에서는 **로컬 구현을 유지**한다 — 거기서 대화 파일은 게이트웨이가 읽을 수 있는 자리(프로필
//   CLAUDE_CONFIG_DIR·공유 홈)에 있고, 그 경로를 멤버 uid 로 바꾸면 되레 못 읽는 자리(게이트웨이 소유 프로필)가 생긴다.
//   중계 배포만 파일이 '다른 호스트'다 — 갈아끼울 이유가 있는 곳만 갈아끼운다.
import fsp from "node:fs/promises";
import path from "node:path";
import { memberExecConfigured } from "../terminal-isolation.js";
import { memberStat, memberReadRange, memberNodeJson, memberLs } from "../terminal-member-fs.js";
import { findPrevTranscript } from "../terminal-transcript.js";
import { fileReader, prefetchReader, type ByteReader } from "./window.js";
import { HttpError } from "../../http-error.js";   // 무의존 leaf — 저수준이 상태코드를 직접 던지라고 만든 자리(#1313 R9)

export interface TranscriptFs {
  /** 일반 파일이면 크기, 아니면(없음·디렉터리·권한) null. */
  stat(file: string): Promise<number | null>;
  /** 파일을 열어 ByteReader 로 fn 을 실행하고 닫는다. size = stat 이 준 워터마크. */
  read<T>(file: string, size: number, fn: (r: ByteReader) => Promise<T>): Promise<T>;
  /** 이 파일이 맥락 압축(compact_boundary)으로 시작하면 압축 전 대화 uuid — claude 규약(terminal-transcript.findPrevTranscript). */
  prevTranscript(file: string): Promise<string | null>;
  /** 이 폴더의 **일반 파일** 이름+mtime(ms). 못 읽으면 빈 배열 — '없다'와 '못 본다'를 구별하지 않는다(호출부가 폴백을 쓴다).
   *  왜 필요한가: 매핑(대화 id)이 아직 없는 갓 뜬 세션은 규약 경로를 만들 수 없어 **그 폴더에서 방금 자란 파일**을
   *  찾아야 한다(session-outbox 의 에코 확인). 중계 배포에선 그 폴더가 노드의 멤버 홈이라 로컬 readdir 이 빈손이다. */
  listDir(dir: string): Promise<Array<{ name: string; mtimeMs: number }>>;
  /**
   * promptId 턴의 **첫 줄**(출처가 있는 사용자 줄)을 `before` 바이트 앞쪽으로 거슬러 찾아 그 출처를 준다 — origin.kind, 없으면 turnOrigin 의
   *  `_` 를 `-` 로 맞춘 것(«auto-continuation» · «human» …). 최대 maxBytes 만 거슬러 읽는다. 못 찾음 · 없는 파일 · 이상한 promptId = null.
   *  그 밖의 읽기 실패(중계·입출력)는 던진다. (#4821 — 한도 대기 판정이 끝 창보다 긴 «이어 간 턴» 의 출처를 알아야 한다: session-quota-wait.ts)
   *  ⚠ 중계 배포에선 노드 쪽 node 한 줄로 **한 번에** 찾는다 — 덩어리마다 중계를 왕복하면 수십 MB 에 수십 번이다(prevTranscript 와 같은 이유).
   */
  turnOrigin(file: string, promptId: string, before: number, maxBytes: number): Promise<string | null>;
}

/** turnOrigin 이 한 번에 읽는 덩어리 — 중계 구현(TURN_ORIGIN_JS)과 같은 값. */
const TURN_SCAN_CHUNK = 1024 * 1024;
/** turnOrigin 이 받는 promptId 모양(본체는 uuid) — 아니면 찾지 않는다(찾을 문자열을 만드는 값이다). */
const PROMPT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const NL = 0x0a;

/** 그 줄이 promptId 턴의 첫 줄이면 출처, 아니면 null — TURN_ORIGIN_JS 의 kindOf 와 같은 규칙. */
function turnOpenerKind(line: Buffer, needle: Buffer, promptId: string): string | null {
  if (line.indexOf(needle) < 0) return null;
  let o: unknown;
  try { o = JSON.parse(line.toString("utf8")); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const l = o as Record<string, unknown>;
  if (l.type !== "user" || l.isSidechain === true || l.promptId !== promptId) return null;
  const k = l.origin && typeof l.origin === "object" ? (l.origin as { kind?: unknown }).kind : undefined;
  if (typeof k === "string" && k) return k;
  return typeof l.turnOrigin === "string" && l.turnOrigin ? l.turnOrigin.replace(/_/g, "-") : null;
}

export const localTranscriptFs: TranscriptFs = {
  async stat(file) {
    try { const st = await fsp.stat(file); return st.isFile() ? st.size : null; } catch { return null; }
  },
  async read(file, _size, fn) {
    const fh = await fsp.open(file, "r");
    try { return await fn(fileReader(fh)); } finally { await fh.close(); }
  },
  prevTranscript: findPrevTranscript,
  async listDir(dir) {
    let names: string[] = [];
    try { names = await fsp.readdir(dir); } catch { return []; }
    const out: Array<{ name: string; mtimeMs: number }> = [];
    for (const name of names) {
      try { const s = await fsp.stat(path.join(dir, name)); if (s.isFile()) out.push({ name, mtimeMs: s.mtimeMs }); }
      catch { /* 그새 사라짐 — 다음 */ }
    }
    return out;
  },
  async turnOrigin(file, promptId, before, maxBytes) {
    if (!PROMPT_ID_RE.test(promptId)) return null;
    let fh: Awaited<ReturnType<typeof fsp.open>>;
    try { fh = await fsp.open(file, "r"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    try {
      const needle = Buffer.from(`"promptId":"${promptId}"`);
      const end = Math.min(Math.max(0, before), (await fh.stat()).size);
      const lo = Math.max(0, end - Math.max(0, maxBytes));
      let pos = end;
      let carry = Buffer.alloc(0);          // 덩어리 첫 개행 앞 조각 — 더 앞 덩어리의 끝과 이어 붙여 한 줄이 된다
      while (pos > lo) {
        const s = Math.max(lo, pos - TURN_SCAN_CHUNK);
        const got = Buffer.alloc(pos - s);
        const { bytesRead } = await fh.read(got, 0, got.length, s);
        const data = carry.length ? Buffer.concat([got.subarray(0, bytesRead), carry]) : got.subarray(0, bytesRead);
        let e = data.length;                // 아직 안 본 줄의 끝 — 뒤에서부터(첫 줄은 그 턴의 가장 앞이라 거슬러 가며 처음 만나는 출처가 곧 첫 줄)
        while (e > 0) {
          const nl = data.lastIndexOf(NL, e - 1);
          if (nl < 0) break;
          const k = turnOpenerKind(data.subarray(nl + 1, e), needle, promptId);
          if (k) return k;
          e = nl;
        }
        carry = data.subarray(0, e);
        pos = s;
      }
      //  남은 조각은 파일 맨 앞이거나 상한 바로 앞이 개행이면 온전한 줄이다(상한이 줄 시작에 꼭 맞았다). 아니면 상한에 잘린 반 줄 — 보지 않는다.
      if (!carry.length) return null;
      let whole = lo === 0;
      if (!whole) { const b = Buffer.alloc(1); whole = (await fh.read(b, 0, 1, lo - 1)).bytesRead === 1 && b[0] === NL; }
      return whole ? turnOpenerKind(carry, needle, promptId) : null;
    } finally { await fh.close(); }
  },
};

// localTranscriptFs.turnOrigin 과 같은 규칙을 **멤버 실행환경에서** 돌리는 node 한 줄(고정 리터럴 · 값은 stdin JSON). 없는 파일 = null,
//  그 밖의 입출력 실패는 종료코드 1 → memberNodeJson 이 던진다(«못 찾음» 으로 기억하지 않게 — session-quota-wait 가 못 찾음을 기억한다).
const TURN_ORIGIN_JS =
  "const fs=require('fs');let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{let out=null;try{" +
  "const {file,promptId,before,max}=JSON.parse(d);let fd;try{fd=fs.openSync(file,'r')}catch(e){if(e&&e.code==='ENOENT'){process.stdout.write('null');return}throw e}" +
  "try{const needle=Buffer.from('\"promptId\":\"'+promptId+'\"');const C=1048576;" +
  "const kindOf=(b)=>{if(b.indexOf(needle)<0)return null;let o;try{o=JSON.parse(b.toString('utf8'))}catch{return null}" +
  "if(!o||typeof o!=='object'||o.type!=='user'||o.isSidechain===true||o.promptId!==promptId)return null;" +
  "const k=o.origin&&typeof o.origin==='object'?o.origin.kind:undefined;if(typeof k==='string'&&k)return k;" +
  "return typeof o.turnOrigin==='string'&&o.turnOrigin?o.turnOrigin.replace(/_/g,'-'):null};" +
  "const end=Math.min(Math.max(0,before),fs.fstatSync(fd).size);const lo=Math.max(0,end-Math.max(0,max));" +
  "let pos=end,carry=Buffer.alloc(0);outer:while(pos>lo){const s=Math.max(lo,pos-C);const got=Buffer.alloc(pos-s);" +
  "const n=fs.readSync(fd,got,0,got.length,s);const data=carry.length?Buffer.concat([got.subarray(0,n),carry]):got.subarray(0,n);" +
  "let e=data.length;while(e>0){const nl=data.lastIndexOf(10,e-1);if(nl<0)break;const k=kindOf(data.subarray(nl+1,e));if(k){out=k;break outer}e=nl}" +
  "carry=data.subarray(0,e);pos=s}" +
  "if(out===null&&carry.length){let whole=lo===0;if(!whole){const b=Buffer.alloc(1);whole=fs.readSync(fd,b,0,1,lo-1)===1&&b[0]===10}if(whole)out=kindOf(carry)}" +
  "}finally{fs.closeSync(fd)}" +
  "}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(1)}process.stdout.write(JSON.stringify(out))});";

/**
 * 중계가 답하지 않을 때의 문장 — «파일이 없다»가 아니라 «지금 못 읽는다» (#2257 후속).
 *  화면(web/session-chat)은 404 를 «아직 기록 없음»으로 읽으므로, 중계 실패를 404 로 내보내면 사람에게 **거짓말**이 된다.
 */
export const RELAY_UNAVAILABLE =
  "대화 기록을 지금 읽지 못했습니다 — 세션이 도는 컴퓨터와의 중계가 응답하지 않습니다. 잠시 뒤 다시 시도해 주세요.";

/**
 * 중계 실패를 **삼키지도, internal_error 로 흘리지도 않는다.** 503 으로 올려 wrap 이 원인(cause)까지 로그에 남기게 한다(#1278 과 같은 규약).
 *
 * ★ 왜 이 파사드가 상태코드를 아는가: `http-error.ts` 는 그러라고 있는 무의존 leaf 다(#1313 R9 — "저수준 인프라가
 *  express 헬퍼 없이 상태코드 오류를 던질 수 있다"). 중계 실패의 뜻을 아는 곳은 여기뿐이고, 이걸 호출부마다
 *  다시 판정하게 하면 자리가 늘어난 만큼 또 갈린다(지금 stat 과 read 가 갈려 있던 것이 정확히 그 모양이다).
 */
function relayFailed(cause: unknown): never {
  throw new HttpError(503, RELAY_UNAVAILABLE, { cause });
}

// findPrevTranscript 와 같은 규칙을 **멤버 실행환경에서** 돌리는 node 한 줄(고정 리터럴 · 값은 stdin JSON).
//  게이트웨이에서 readdir+readFile 을 왕복으로 흉내내면 파일 수만큼 exec 이 든다 — 판정 자체를 그쪽에서 끝낸다.
const PREV_JS =
  "const fs=require('fs'),p=require('path');let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{let prev=null;try{" +
  "const {file}=JSON.parse(d);const fd=fs.openSync(file,'r');const b=Buffer.alloc(8192);const n=fs.readSync(fd,b,0,8192,0);fs.closeSync(fd);" +
  "const first=b.subarray(0,n).toString('utf8').split('\\n')[0]||'';let o=null;try{o=JSON.parse(first)}catch{}" +
  "const lp=o&&o.type==='system'&&o.subtype==='compact_boundary'?String(o.logicalParentUuid||''):'';" +
  "if(lp&&/^[A-Za-z0-9-]{8,64}$/.test(lp)){const dir=p.dirname(file);" +
  "const names=fs.readdirSync(dir).filter(n=>n.endsWith('.jsonl')&&p.join(dir,n)!==file);" +
  "const st=names.map(n=>{let m=0;try{m=fs.statSync(p.join(dir,n)).mtimeMs}catch{}return{n,m}}).sort((a,b)=>b.m-a.m);" +
  "const needle='\"uuid\":\"'+lp+'\"';for(const {n} of st.slice(0,12)){let t='';try{t=fs.readFileSync(p.join(dir,n),'utf8')}catch{}" +
  "if(t.includes(needle)){prev=n.replace(/\\.jsonl$/,'');break}}}}catch{}process.stdout.write(JSON.stringify(prev))});";
// 압축 전 uuid 는 파일당 불변(첫 줄) — 로컬 구현(prevCache)과 같은 이유로 캐시한다. 원격은 그 왕복이 더 비싸다.
const prevCache = new Map<string, string | null>();

export function memberTranscriptFs(osUser: string): TranscriptFs {
  return {
    // ★ 중계 실패를 `null`(=없음) 로 뭉개지 않는다 (#2257 후속). STAT_JS 는 **없는 파일도 exit 0 + 'null'** 로
    //  답하므로, reject 는 «파일이 없다»가 아니라 «중계가 못 갔다» 뿐이다. 종전엔 둘을 같은 null 로 만들어
    //  locateTranscript 가 null 을 내고 chat-routes 가 404 «대화 기록 파일을 찾지 못했습니다» 를 냈다 —
    //  파일은 멀쩡한데 없다고 말한 것이다(실측 2026-08-28 나이틀리 e2e: `증분 폴링(from=워터마크) got '404'`).
    async stat(file) {
      let s: Awaited<ReturnType<typeof memberStat>>;
      try { s = await memberStat(osUser, file); } catch (e) { relayFailed(e); }
      return s && s.file ? s.size : null;
    },
    // ⚠ 종전엔 catch 가 **아예 없어** 중계 throw 가 그대로 올라가 wrap 이 500 `internal_error` 로 냈다
    //  (실측 2026-08-30 나이틀리 e2e: 허브 20초 상한(member-exec-relay `timeout: 20_000`)에 걸려
    //   `transcript HTTP 500`). 같은 원인이 stat 에선 404, read 에선 500 이던 것을 여기서 한 답으로 모은다.
    read(file, size, fn) {
      return fn(prefetchReader(async (s, e) => {
        try { return await memberReadRange(osUser, file, s, e); } catch (err) { relayFailed(err); }
      }, size));
    },
    async prevTranscript(file) {
      const key = `${osUser}|${file}`;
      if (prevCache.has(key)) return prevCache.get(key) ?? null;
      let prev: string | null = null;
      try {
        const r = await memberNodeJson<unknown>(osUser, PREV_JS, { file });
        prev = typeof r === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(r) ? r : null;
      } catch { prev = null; }
      prevCache.set(key, prev);
      return prev;
    },
    async listDir(dir) {
      // memberLs 가 이미 그 멤버 uid 로 도는 한 줄(LS_JS)로 name·type·mtime 을 준다 — 여기서 왕복을 새로 만들지 않는다.
      try { return (await memberLs(osUser, dir)).filter((e) => e.type === "file").map((e) => ({ name: e.name, mtimeMs: e.mtime })); }
      catch { return []; }
    },
    async turnOrigin(file, promptId, before, maxBytes) {
      if (!PROMPT_ID_RE.test(promptId)) return null;
      let r: unknown;
      try { r = await memberNodeJson<unknown>(osUser, TURN_ORIGIN_JS, { file, promptId, before, max: maxBytes }); } catch (e) { relayFailed(e); }
      return typeof r === "string" && /^[\w-]{1,64}$/.test(r) ? r : null;   // 우리 한 줄의 답 모양 — 로컬 구현이 주는 값과 같은 범위
    },
  };
}

/** 이 세션의 대화 파일을 읽을 파사드 — 중계 배포 + 소유자 osUser 가 있으면 멤버, 아니면 로컬(종전과 동일). */
export function transcriptFsFor(osUser: string | null | undefined): TranscriptFs {
  return osUser && memberExecConfigured() ? memberTranscriptFs(osUser) : localTranscriptFs;
}
