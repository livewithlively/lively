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
};

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
    async stat(file) {
      try { const s = await memberStat(osUser, file); return s && s.file ? s.size : null; } catch { return null; }
    },
    read(file, size, fn) {
      return fn(prefetchReader((s, e) => memberReadRange(osUser, file, s, e), size));
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
  };
}

/** 이 세션의 대화 파일을 읽을 파사드 — 중계 배포 + 소유자 osUser 가 있으면 멤버, 아니면 로컬(종전과 동일). */
export function transcriptFsFor(osUser: string | null | undefined): TranscriptFs {
  return osUser && memberExecConfigured() ? memberTranscriptFs(osUser) : localTranscriptFs;
}
