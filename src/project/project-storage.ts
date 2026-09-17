// 프로젝트 폴더 저장소 (#4064) — 프로젝트 파일이 **어디에 있고 누가 만지나** 를 한 자리에서 정한다.
//
// ── 왜 한 자리인가 ─────────────────────────────────────────────────────────────
//  같은 `project/<id>` 가 입구마다 다른 저장소로 풀렸다(2026-09-17 매니지드 실측, 프로젝트 #4064):
//   · 세션(격리 멤버)·공유 브라우즈 — resolveRootPath(…, osUser) = 멤버 저장소(`/work/shared/project/<id>`), 멤버 경계로 op
//   · 곁칸 [자료]·AGENTS.md·자료 원본·노드 업로드 정본·첫 지시 첨부 — projectAbsPath() = 게이트웨이 로컬, 게이트웨이 fsp
//  저장소가 분리된 배포(매니지드)에선 둘이 **다른 디렉터리**다. 그래서 세션이 만든 파일은 곁칸에 안 떴고, 곁칸에 올린
//  파일은 세션이 못 읽었다(그 자료 링크는 404). 위탁 작업 폴더(node/tasks.ts)가 같은 부류를 같은 규칙으로 먼저 고쳤다.
//
// ── 규칙 — fileOpsAtMemberBoundary(위탁 폴더와 한 벌) ────────────────────────────
//  그 사람(요청자, 요청 밖이면 호출자가 넘긴 멤버)의 OS 계정이 있고 저장소가 분리된 배포(memberExecConfigured)면
//   자리 = resolveRootPath(그 사람, "shared", folder, osUser) · op = 멤버 경계(memberSpawn 중계)
//  그 밖(자체 호스팅 격리 박스·비격리·개발기)은 종전 그대로 — 자리 = projectAbsPath(folder) · op = 게이트웨이 fsp.
//  ⚠ 멤버 쪽 한 줄(*_JS)은 로컬 구현과 **같은 사양**이다 — project-storage.test 가 같은 트리에 두 구현을 대조한다.
//  ⚠ 멤버 모드에선 권한 비트를 건드리지 않는다. 매니지드 세션·파일 op 는 **테넌트 uid 하나**로 돌고 그 uid 는
//   `lively-shared` 그룹에 없다(2026-09-17 세션 안 `id` 실측) — 로컬의 2770/660 계약을 그대로 걸면 그룹이 엉뚱하게
//   풀리고 other 읽기만 막힌다. 만든 그대로(umask) 두면 같은 워크스페이스의 모든 세션이 고칠 수 있다.
//
// ── 이관 — migrateLocalToMember ───────────────────────────────────────────────
//  멤버 모드로 처음 열 때, 게이트웨이 로컬에만 있던 파일(곁칸 업로드·AGENTS.md·옮겨 둔 첨부)을 멤버 저장소로 옮긴다.
//  덮어쓰지 않는다: 없으면 복사(mtime 보존) · 내용이 같으면 그대로 · 다르면 «이름 (이관 사본).확장자» 로 나란히 둔다.
//  **이 워크스페이스의 것으로 증명된 파일만** 옮긴다(아래 «이관» 머리말 — 게이트웨이 로컬 폴더는 워크스페이스로 안 갈린다).
//  처리한 원본은 게이트웨이 쪽 `.lively/migrated/` 로 옮겨 보관한다 — 데이터는 남기되, 사람이 멤버 저장소에서 지운
//  파일이 다음 이관에서 되살아나지 않게(원본이 걷는 대상에서 빠진다). 실패한 파일은 제자리에 남아 다음에 다시 간다.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable, type Writable } from "node:stream";
import type { LivelyUser } from "../context.js";
import { logger } from "../log.js";
import { projectAbsPath, grantSharedGroupWrite } from "./project-fs.js";
import { manifestFiles, isGitRepoRoot, MANIFEST_FILE_CAP, type Manifest } from "./project-manifest.js";
import { resolveRootPath, userSlug } from "../terminal/profiles.js";
import { resolveMemberOsUser, memberExecConfigured, fileOpsAtMemberBoundary } from "../terminal/terminal-isolation.js";
import {
  memberNodeJson, memberStat, memberReadTo, memberMv, memberRm, memberPathProbe, memberWriteFrom, memberMkdir,
} from "../terminal/terminal-member-fs.js";
import { isConfined, probeLocal } from "../terminal/path-jail.js";
import { receiveUpload } from "../terminal/upload-file.js";
import { tenantSlug } from "../terminal/catalog.js";
import { CLAUDE_IMPORT, sameRules, isAgentsMdOf } from "../v6/agents-md-rules.js";
import { LOCAL_SYSTEM, LOCAL_INSTANCE, localExternalId } from "../ingest/local-file-core.js";

export interface StorageEntry { name: string; type: "dir" | "file"; size: number; mtime: number; repo?: true; empty?: true }
export interface StorageHit { name: string; path: string; type: "dir" | "file"; size: number; mtime: number }
export interface StorageStat { file: boolean; dir: boolean; size: number; mtime: number }

export interface ProjectStorage {
  /** 프로젝트 폴더 — 이 저장소 기준 절대경로 */
  readonly base: string;
  /** op 를 내릴 멤버 OS 계정. null 이면 게이트웨이 로컬 fsp */
  readonly osUser: string | null;
  /** 게이트웨이 로컬 자리 — 호스트 마커·이관 원본이 사는 곳. 로컬 모드면 base 와 같다 */
  readonly localBase: string;
  /** 어느 프로젝트의 저장소인가 — 이관의 소유 확인 재료(모르면 null → 이관하지 않는다) */
  readonly project: StorageProject | null;
  /** 디렉터리 한 칸(숨김 제외). 못 읽으면 null */
  list(abs: string): Promise<StorageEntry[] | null>;
  /** 이름에 q 가 든 파일·폴더(숨김 제외, 깊이·결과 상한) */
  search(q: string, limit?: number): Promise<StorageHit[]>;
  /** 동기화 매니페스트(project-manifest 규칙) */
  manifest(limit?: number): Promise<Manifest>;
  stat(abs: string): Promise<StorageStat | null>;
  readTo(abs: string, dest: Writable): Promise<void>;
  /** 작은 문서(상한 TEXT_MAX) 읽기. 없거나 파일이 아니면 null */
  readText(abs: string): Promise<string | null>;
  /** 작은 문서 쓰기 — 임시파일 뒤 rename(원자적). 부모 폴더는 만든다 */
  writeText(abs: string, data: string): Promise<void>;
  /** 이미 손에 쥔 바이트를 목적지에 — 임시파일 뒤 rename */
  writeBuffer(abs: string, data: Buffer): Promise<void>;
  /** 업로드 스트림 → 목적지(receiveUpload 계약: 취소·초과면 목적지 무손상) */
  receive(src: Readable, abs: string, maxBytes: number): Promise<void>;
  mkdirp(abs: string): Promise<void>;
  move(fromAbs: string, toAbs: string): Promise<void>;
  remove(abs: string): Promise<void>;
  /** 공유 그룹 rw 계약(#1246) — 로컬 모드만 의미가 있다. 멤버 모드는 no-op(머리말) */
  grantGroup(abs: string, kind: "dir" | "file"): Promise<void>;
  /** 심링크를 해소한 뒤에도 base 안인가(#3668 T1) — op 가 도는 자리에서 해소한다 */
  confined(abs: string): Promise<boolean>;
}

/** 저장소가 속한 프로젝트 — 이름은 AGENTS.md 머리 대조에만 쓴다 */
export interface StorageProject { id: number; name?: string | null }

/** 요청 밖에서(생성물 재생성 등) 누구 권한으로 만질지 — 요청이면 그 사용자, 아니면 멤버 id */
export type StorageActor = { user: LivelyUser } | { memberId: string };

const TEXT_MAX = 8 * 1024 * 1024;   // readText 상한 — AGENTS.md(주입 상한 128KB) 같은 작은 문서용
const MIGRATE_WAIT_MS = 15_000;     // 이관을 요청이 기다리는 상한 — 넘으면 뒤에서 마저 간다
const MIGRATE_BATCH = 500;          // 한 번에 옮길 파일 수 — 원본이 빠지므로 남은 것은 다음 열기에서 이어 간다
const MIGRATE_RETRY_MS = 5 * 60_000;
const MIGRATED_DIR = path.join(".lively", "migrated");
export const MIGRATED_COPY_LABEL = "이관 사본";

// ── 로컬 구현(게이트웨이 fsp) ─────────────────────────────────────────────────

/** 폴더가 비었나 — 처음 보이는 것 하나만 확인하고 닫는다(수천 개 든 폴더를 통째로 읽지 않는다, #1819). */
async function dirLooksEmpty(dir: string): Promise<boolean> {
  try {
    const d = await fsp.opendir(dir);
    try {
      for await (const c of d) { if (!c.name.startsWith(".")) return false; }
      return true;
    } finally { await d.close().catch(() => { /* for-await 가 이미 닫았으면 여기서 끝 */ }); }
  } catch { return false; }   // 못 읽으면 '비었다'고 단정하지 않는다
}

export async function localList(abs: string): Promise<StorageEntry[] | null> {
  let entries: fs.Dirent[];
  try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { return null; }
  const items: StorageEntry[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const isDir = e.isDirectory();
    const full = path.join(abs, e.name);
    let size = 0, mtime = 0;
    try { const s = await fsp.stat(full); mtime = Math.floor(s.mtimeMs); if (!isDir) size = s.size; } catch { /* skip */ }
    // repo — provision 된 레포/워크트리(.git 보유)임을 표시한다. 매니페스트가 이미 서브트리째 빼는 것과 같은
    //  대상이다(project-manifest.ts): 코드는 git 이 소유하므로 '자료'가 아니다. 지우지는 않고 **표시만** 한다 —
    //  파일 탐색기(v2/files.ts)는 코드를 보러 들어가는 화면이라 그대로 보여야 하고, 자료 칸만 이 표시로 가린다.
    const repo = isDir && (await isGitRepoRoot(full));
    // empty — 폴더가 비었는지. 화면이 빈 폴더와 든 폴더를 **다른 그림**으로 그린다(맥 파인더 문법, #1819).
    const empty = isDir && !repo && (await dirLooksEmpty(full));
    items.push({ name: e.name, type: isDir ? "dir" : "file", size, mtime, ...(repo ? { repo: true } : {}), ...(empty ? { empty: true } : {}) });
  }
  return items;
}

// 이름에 q 가 든 파일/폴더 재귀 검색(숨김 제외, 깊이·결과 상한). 종전 project-routes.searchFiles 그대로.
export async function localSearch(base: string, q: string, limit = 100): Promise<StorageHit[]> {
  const out: StorageHit[] = [];
  const needle = q.toLowerCase();
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (out.length >= limit || depth > 8) return;
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const childRel = rel ? rel + "/" + e.name : e.name;
      const isDir = e.isDirectory();
      if (e.name.toLowerCase().includes(needle)) {
        let size = 0, mtime = 0;
        try { const s = await fsp.stat(path.join(dir, e.name)); mtime = Math.floor(s.mtimeMs); if (!isDir) size = s.size; } catch { /* skip */ }
        out.push({ name: e.name, path: childRel, type: isDir ? "dir" : "file", size, mtime });
        if (out.length >= limit) return;
      }
      if (isDir) await walk(path.join(dir, e.name), childRel, depth + 1);
    }
  }
  await walk(base, "", 0);
  return out;
}

function localStorage(base: string, project: StorageProject | null): ProjectStorage {
  return {
    base, osUser: null, localBase: base, project,
    list: localList,
    search: (q, limit) => localSearch(base, q, limit),
    manifest: (limit = MANIFEST_FILE_CAP) => manifestFiles(base, limit),
    async stat(abs) {
      try { const s = await fsp.stat(abs); return { file: s.isFile(), dir: s.isDirectory(), size: s.size, mtime: Math.floor(s.mtimeMs) }; }
      catch { return null; }
    },
    readTo: (abs, dest) => new Promise<void>((resolve, reject) => {
      const r = fs.createReadStream(abs);
      r.on("error", reject);
      r.on("end", () => resolve());
      r.pipe(dest);
    }),
    async readText(abs) {
      try {
        const s = await fsp.stat(abs);
        if (!s.isFile() || s.size > TEXT_MAX) return null;
        return await fsp.readFile(abs, "utf8");
      } catch { return null; }
    },
    async writeText(abs, data) {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.write-${crypto.randomBytes(6).toString("hex")}`);
      try { await fsp.writeFile(tmp, data); await fsp.rename(tmp, abs); }
      catch (e) { await fsp.rm(tmp, { force: true }).catch(() => { /* 목적지는 무손상 */ }); throw e; }
      // 게이트웨이가 만든 파일(644)은 box_ 격리 세션이 못 고친다 — 그룹 rw 로(매 호출 재적용 = 구 파일도 지나가며 치유, #1246).
      await grantSharedGroupWrite(abs, base, "file");
    },
    async writeBuffer(abs, data) {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await receiveUpload(Readable.from([data]), abs, data.length, null);
    },
    receive: (src, abs, maxBytes) => receiveUpload(src, abs, maxBytes, null),
    async mkdirp(abs) {
      await fsp.mkdir(abs, { recursive: true });
      // 게이트웨이 소유(lively)·umask(755)로 생긴 폴더는 box_ 격리 세션(lively-shared 그룹)이 못 쓴다(#1246).
      await grantSharedGroupWrite(abs, base, "dir");
    },
    move: (fromAbs, toAbs) => fsp.rename(fromAbs, toAbs),
    remove: (abs) => fsp.rm(abs, { recursive: true, force: true }),
    grantGroup: (abs, kind) => grantSharedGroupWrite(abs, base, kind),
    //  프로젝트 폴더는 그룹 rw 라 게이트웨이가 직접 읽는다(격리 uid 프로브가 필요 없다).
    confined: (abs) => isConfined(base, abs, probeLocal),
  };
}

// ── 멤버 경계 구현 — 한 줄들은 **고정 리터럴**, 값은 전부 stdin JSON(memberNodeJson 계약: 인젝션 표면 없음) ──

const stdinJs = (body: string): string =>
  "const fs=require('fs'),p=require('path'),cr=require('crypto');let d='';process.stdin.setEncoding('utf8');" +
  "process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const q=JSON.parse(d||'null');" + body + "});";
const out = (expr: string): string => `process.stdout.write(JSON.stringify(${expr}));`;

/** localList 와 같은 사양 — 숨김 제외 · 종류는 dirent · 크기·시각은 stat · repo(.git) · empty(첫 항목만) */
export const PROJECT_LIST_JS = stdinJs(
  "let es;try{es=fs.readdirSync(q.dir,{withFileTypes:true})}catch(e){" + out("null") + "return}" +
  "const o=[];for(const e of es){if(e.name.startsWith('.'))continue;const f=p.join(q.dir,e.name);const dir=e.isDirectory();let s=0,m=0;" +
  "try{const st=fs.statSync(f);m=Math.floor(st.mtimeMs);if(!dir)s=st.size}catch(x){}" +
  "let repo=false;if(dir){try{fs.statSync(p.join(f,'.git'));repo=true}catch(x){}}" +
  "let empty=false;if(dir&&!repo){try{const h=fs.opendirSync(f);try{let c;empty=true;while((c=h.readSync())!==null){if(!c.name.startsWith('.')){empty=false;break}}}finally{h.closeSync()}}catch(x){empty=false}}" +
  "const it={name:e.name,type:dir?'dir':'file',size:s,mtime:m};if(repo)it.repo=true;if(empty)it.empty=true;o.push(it)}" +
  out("o"));

/** localSearch 와 같은 사양(결과 상한을 넘는 모양까지 그대로) */
export const PROJECT_SEARCH_JS = stdinJs(
  "const r=[];const n=String(q.q).toLowerCase();" +
  "const walk=(dir,rel,depth)=>{if(r.length>=q.limit||depth>8)return;let es;try{es=fs.readdirSync(dir,{withFileTypes:true})}catch(e){return}" +
  "for(const e of es){if(e.name.startsWith('.'))continue;const cr2=rel?rel+'/'+e.name:e.name;const isDir=e.isDirectory();" +
  "if(e.name.toLowerCase().includes(n)){let s=0,m=0;try{const st=fs.statSync(p.join(dir,e.name));m=Math.floor(st.mtimeMs);if(!isDir)s=st.size}catch(x){}" +
  "r.push({name:e.name,path:cr2,type:isDir?'dir':'file',size:s,mtime:m});if(r.length>=q.limit)return}" +
  "if(isDir)walk(p.join(dir,e.name),cr2,depth+1)}};walk(q.base,'',0);" + out("r"));

/** project-manifest.manifestFiles 와 같은 사양 — 파일만 · 숨김 제외 · git 레포 서브트리 제외 · 상한이면 truncated */
export const PROJECT_MANIFEST_JS = stdinJs(
  "const files=[];let truncated=false;" +
  "const walk=(dir,rel,depth)=>{if(depth>24)return;let es;try{es=fs.readdirSync(dir,{withFileTypes:true})}catch(e){return}" +
  "for(const e of es){if(files.length>=q.limit){truncated=true;return}if(e.name.startsWith('.'))continue;const cr2=rel?rel+'/'+e.name:e.name;" +
  "if(e.isDirectory()){const c=p.join(dir,e.name);let repo=false;try{fs.statSync(p.join(c,'.git'));repo=true}catch(x){}if(repo)continue;walk(c,cr2,depth+1);continue}" +
  "if(!e.isFile())continue;try{const st=fs.statSync(p.join(dir,e.name));files.push({path:cr2,mtime:Math.floor(st.mtimeMs),size:st.size})}catch(x){}}};" +
  "walk(q.base,'',0);" + out("{files,truncated}"));

export const PROJECT_READ_TEXT_JS = stdinJs(
  "try{const st=fs.statSync(q.path);if(!st.isFile()||st.size>q.max){" + out("null") + "return}" +
  out("fs.readFileSync(q.path,'utf8')") + "}catch(e){" + out("null") + "}");

/** 부모를 만들고 임시파일 뒤 rename — 반쯤 쓴 문서를 남기지 않는다 */
export const PROJECT_WRITE_TEXT_JS = stdinJs(
  "const dir=p.dirname(q.path);fs.mkdirSync(dir,{recursive:true});" +
  "const tmp=p.join(dir,'.'+p.basename(q.path)+'.write-'+cr.randomBytes(6).toString('hex'));" +
  "try{fs.writeFileSync(tmp,q.data);fs.renameSync(tmp,q.path)}catch(e){try{fs.unlinkSync(tmp)}catch(x){}throw e}" + out("true"));

/** 이관 — 멤버 쪽 상태(있나·파일인가·크기) */
export const PROJECT_INFO_JS = stdinJs(
  "const o={};for(const it of q.items){try{const st=fs.statSync(it.path);o[it.key]={file:st.isFile(),size:st.size}}catch(e){o[it.key]=null}}" + out("o"));

/** 이관 — 내용 대조용 sha256(1MB 조각으로 스트리밍, 큰 파일을 통째로 올리지 않는다) */
export const PROJECT_HASH_JS = stdinJs(
  "const o={};for(const it of q.items){try{const h=cr.createHash('sha256');const fd=fs.openSync(it.path,'r');" +
  "try{const b=Buffer.alloc(1<<20);let n;while((n=fs.readSync(fd,b,0,b.length,null))>0)h.update(b.subarray(0,n))}finally{fs.closeSync(fd)}" +
  "o[it.key]=h.digest('hex')}catch(e){o[it.key]=null}}" + out("o"));

/** 이관 — 폴더 모양 먼저(빈 폴더도 사람이 만든 것이다) */
export const PROJECT_MKDIRS_JS = stdinJs(
  "for(const dd of q.dirs){fs.mkdirSync(dd,{recursive:true})}" + out("true"));

/**
 * 이관 — 임시파일을 목적지에 **덮어쓰지 않고** 앉힌다. link 는 목적지가 있으면 EEXIST 로 실패한다(원자적 no-clobber).
 *  link 를 못 쓰는 파일시스템이면 존재 확인 뒤 rename 으로 내려간다. 앉혔으면 mtime 을 원본 것으로 되돌린다 —
 *  노드 PC 의 동기화 원장이 «서버가 바꿨다» 로 오판해 같은 내용을 다시 받지 않게.
 */
export const PROJECT_PLACE_JS = stdinJs(
  "let r='ok';try{fs.linkSync(q.tmp,q.dest);fs.unlinkSync(q.tmp)}catch(e){" +
  "if(e.code==='EEXIST'||fs.existsSync(q.dest)){try{fs.unlinkSync(q.tmp)}catch(x){}r='exists'}else{fs.renameSync(q.tmp,q.dest)}}" +
  "if(r==='ok'&&q.mtime>0){try{const t=q.mtime/1000;fs.utimesSync(q.dest,t,t)}catch(x){}}" + out("r"));

function memberStorage(base: string, osUser: string, localBase: string, project: StorageProject | null): ProjectStorage {
  const self: ProjectStorage = {
    base, osUser, localBase, project,
    list: (abs) => memberNodeJson<StorageEntry[] | null>(osUser, PROJECT_LIST_JS, { dir: abs }),
    search: async (q, limit = 100) => (await memberNodeJson<StorageHit[] | null>(osUser, PROJECT_SEARCH_JS, { base, q, limit })) ?? [],
    manifest: async (limit = MANIFEST_FILE_CAP) =>
      (await memberNodeJson<Manifest | null>(osUser, PROJECT_MANIFEST_JS, { base, limit })) ?? { files: [], truncated: false },
    async stat(abs) {
      const s = await memberStat(osUser, abs);
      return s ? { file: s.file, dir: s.dir, size: s.size, mtime: s.mtime ?? 0 } : null;
    },
    readTo: (abs, dest) => memberReadTo(osUser, abs, dest),
    readText: (abs) => memberNodeJson<string | null>(osUser, PROJECT_READ_TEXT_JS, { path: abs, max: TEXT_MAX }),
    async writeText(abs, data) { await memberNodeJson<boolean>(osUser, PROJECT_WRITE_TEXT_JS, { path: abs, data }); },
    async writeBuffer(abs, data) {
      await receiveUpload(Readable.from([data]), abs, data.length, osUser);   // memberMkdir(부모) → 임시파일 → mv
    },
    receive: (src, abs, maxBytes) => receiveUpload(src, abs, maxBytes, osUser),
    mkdirp: (abs) => memberMkdir(osUser, abs),
    move: (fromAbs, toAbs) => memberMv(osUser, fromAbs, toAbs),
    remove: (abs) => memberRm(osUser, abs),
    grantGroup: async () => { /* 머리말 — 멤버 모드는 권한 비트를 건드리지 않는다 */ },
    confined: (abs) => isConfined(base, abs, (b, t) => memberPathProbe(osUser, b, t)),
  };
  return self;
}

// ── 고르기 ────────────────────────────────────────────────────────────────────

const actorUser = (a: StorageActor): LivelyUser =>
  "user" in a ? a.user : ({ userId: a.memberId, email: "", scopes: [], projects: [] } as unknown as LivelyUser);

const hasIdentity = (a: StorageActor): boolean =>
  "user" in a ? !!(a.user?.userId || a.user?.email) : !!String(a.memberId || "").trim();

/**
 * 이 프로젝트 폴더를 **누구 권한으로 어디서** 만질지 고른다.
 *  ⚠ 저장소가 분리된 배포에서 신원이 없으면 던진다 — 게이트웨이 로컬로 폴백하면 사람이 못 보는 자리에 쓰게 된다
 *   («모르면 안 쓴다»). 요청 밖 호출부(생성물 재생성)는 .catch 로 비치명 처리한다.
 *  project 를 모르면 이관하지 않는다 — 옛 파일이 이 워크스페이스의 것인지 증명할 재료가 없다(아래 «이관»).
 */
export async function projectStorage(folder: string, actor: StorageActor | null, project?: StorageProject | null): Promise<ProjectStorage> {
  const localBase = projectAbsPath(folder);   // 범위 판정은 두 모드 공통 — project/·legacy-project/ 밖이면 여기서 던진다
  const p = project ?? null;
  if (!memberExecConfigured()) return localStorage(localBase, p);   // 저장소가 붙어 있는 배포: 종전 그대로(신원 왕복 0)
  if (!actor || !hasIdentity(actor)) throw new Error("저장소가 분리된 배포에서는 누구 권한으로 프로젝트 파일을 만질지 정해야 합니다");
  const user = actorUser(actor);
  const osUser = await resolveMemberOsUser(userSlug(user));
  if (!fileOpsAtMemberBoundary(osUser)) return localStorage(localBase, p);   // 격리 킬스위치(off) — 종전 폴백
  const { abs: base } = await resolveRootPath(user, "shared", folder, osUser);
  const store = memberStorage(base, osUser as string, localBase, p);
  if (p) await settleMigration(store);
  return store;
}

// ── 이관 ──────────────────────────────────────────────────────────────────────
//  ★★ 소유 확인 — 매니지드 게이트웨이 하나가 모든 워크스페이스를 서빙하는데 게이트웨이 로컬 공유 루트
//   (PROJECT_SHARED_BASE)는 워크스페이스로 갈리지 않는다(lvly-cloud deploy/lvly-gw.sh 는 TERMINAL_ROOT_SHARED 를
//   안 준다). 프로젝트 id 는 워크스페이스끼리 겹칠 수 있다(공용 DB 의 키는 (tenant_id, id) — db/tenant-column.ts).
//   그러니 `project/<id>` 폴더에 **남의 워크스페이스 파일이 섞여 있을 수 있다.** 이관은 이 워크스페이스의 것으로
//   증명된 파일만 옮기고, 증명 못 한 것은 제자리에 둔다(옮기지도 보관하지도 않는다):
//    · 일반 파일 — 이 워크스페이스에 그 좌표(`project:<id>/<rel>`)의 자료 행이 있다. 자료 표는 워크스페이스로 갈리고,
//      게이트웨이 로컬에 파일을 두던 길(곁칸 업로드·노드 업로드 정본·첫 지시 첨부)은 전부 자료로 등록했다.
//    · AGENTS.md — 첫 줄이 이 프로젝트의 머리(`# <이름>   (프로젝트 #<id>)`)다. 이름은 지금 이름이거나 이 워크스페이스가
//      그 프로젝트에 붙였던 옛 이름(감사 기록)이다 — 배포 뒤 첫 접촉이 이름 바꾸기면 게이트웨이 쪽 원본은 옛 이름을 달고 있다.
//    · CLAUDE.md — 우리가 쓴 import 한 줄이면 누구의 것이든 내용이 같다.
//   빈 폴더는 소유를 증명할 수 없어 옮기지 않는다.

export interface MigrationReport { copied: number; same: number; renamed: number; failed: number; foreign: number; more: boolean }
interface LocalFile { rel: string; abs: string; size: number; mtime: number }

/** 이 워크스페이스가 자료로 가진 좌표만 돌려준다(상대경로 집합) */
export type OwnershipCheck = (q: { projectId: number; rels: string[] }) => Promise<Set<string>>;

const dbOwnership: OwnershipCheck = async ({ projectId, rels }) => {
  const out = new Set<string>();
  if (!rels.length) return out;
  //  DB 는 여기서만 늦게 가져온다 — 이 모듈의 나머지는 DB 없이 시험한다.
  const [{ itemsPool }, { normalizeExternalInstance }] = await Promise.all([
    import("../db/client.js"), import("../org/ingest/external-identity.js"),
  ]);
  const byId = new Map(rels.map((r) => [localExternalId({ kind: "project", id: projectId }, r), r]));
  const got = await itemsPool.query(
    `SELECT external_id FROM source WHERE external_system=$1 AND external_instance=$2 AND external_id = ANY($3::text[])`,
    [LOCAL_SYSTEM, normalizeExternalInstance(LOCAL_INSTANCE), [...byId.keys()]]);
  for (const row of got.rows as Array<{ external_id: string }>) {
    const r = byId.get(row.external_id);
    if (r) out.add(r);
  }
  return out;
};
let ownership: OwnershipCheck = dbOwnership;
/** 시험 전용 — 소유 확인을 갈아 끼운다(null = 기본 DB 조회) */
export function setMigrationOwnership(fn: OwnershipCheck | null): void { ownership = fn ?? dbOwnership; }

/** 이 워크스페이스가 그 프로젝트에 붙였던 이름들 */
export type NameHistory = (projectId: number) => Promise<string[]>;

const dbNameHistory: NameHistory = async (projectId) => {
  const { itemsPool } = await import("../db/client.js");
  //  이름 바꾸기는 전부 감사 행(before·after 에 행 전체)을 남긴다(project-store claimProjectName·updateProject).
  const got = await itemsPool.query(
    `SELECT DISTINCT n FROM (
       SELECT before->>'name' AS n FROM org_content_audit WHERE entity='project' AND entity_key=$1
       UNION ALL
       SELECT after->>'name' AS n FROM org_content_audit WHERE entity='project' AND entity_key=$1
     ) t WHERE n IS NOT NULL AND n <> ''`,
    [String(projectId)]);
  return (got.rows as Array<{ n: string }>).map((r) => r.n);
};
let nameHistory: NameHistory = dbNameHistory;
/** 시험 전용 — 이름 이력 조회를 갈아 끼운다(null = 기본 DB 조회) */
export function setMigrationNameHistory(fn: NameHistory | null): void { nameHistory = fn ?? dbNameHistory; }

/**
 * 이 AGENTS.md 가 **이 워크스페이스의 그 프로젝트** 것인가 — 첫 줄이 지금 이름의 머리이거나, 이 워크스페이스가
 *  그 프로젝트에 붙였던 옛 이름의 머리다. 이관과 규칙 폴백(agents-md readRules)이 같은 판정을 쓴다.
 *  이력 조회 실패는 던진다(호출부가 fail-closed 로 다룬다).
 */
export async function ownsAgentsMd(content: string, project: StorageProject): Promise<boolean> {
  if (isAgentsMdOf(content, project)) return true;
  const first = content.split(/\r?\n/, 1)[0] ?? "";
  //  이 프로젝트 번호의 머리 모양이 아니면 이력을 볼 것도 없다(헛조회를 안 한다)
  if (!first.startsWith("# ") || !first.endsWith(`   (프로젝트 #${project.id})`)) return false;
  return (await nameHistory(project.id)).some((name) => isAgentsMdOf(content, { id: project.id, name }));
}

async function walkLocal(base: string, cap: number): Promise<{ files: LocalFile[]; truncated: boolean }> {
  const files: LocalFile[] = [];
  let truncated = false;
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (depth > 24) return;
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= cap) { truncated = true; return; }
      if (e.name.startsWith(".")) continue;   // .lively(마커·이관 보관)·임시파일은 옮기지 않는다
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (await isGitRepoRoot(abs)) continue;   // provision 레포 — 코드는 git 이 소유한다(매니페스트와 같은 규칙)
        await walk(abs, r, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      try { const st = await fsp.stat(abs); files.push({ rel: r, abs, size: st.size, mtime: Math.floor(st.mtimeMs) }); }
      catch { /* 읽기 불가 — 다음에 */ }
    }
  }
  await walk(base, "", 0);
  //  생성물(루트 AGENTS.md·CLAUDE.md)을 맨 앞에 — 사람 규칙이 든 AGENTS.md 가 제일 먼저 건너가야
  //  생성기가 멤버 쪽에서 규칙을 읽는다(요청은 이관을 15초만 기다린다).
  const first = (f: LocalFile): number => (f.rel === "AGENTS.md" ? 0 : f.rel === "CLAUDE.md" ? 1 : 2);
  files.sort((a, b) => first(a) - first(b));
  return { files, truncated };
}

/** 이 워크스페이스의 것으로 증명된 파일(머리말 «소유 확인») */
async function provenOwned(project: StorageProject, files: LocalFile[]): Promise<Set<string>> {
  const out = new Set<string>();
  const plain: string[] = [];
  for (const f of files) {
    if (f.rel === "AGENTS.md") {
      const t = await fsp.readFile(f.abs, "utf8").catch(() => null);
      if (t != null && (await ownsAgentsMd(t, project))) out.add(f.rel);
      continue;
    }
    if (f.rel === "CLAUDE.md") {
      const t = f.size <= 64 ? await fsp.readFile(f.abs, "utf8").catch(() => null) : null;
      if (t != null && t.trim() === CLAUDE_IMPORT) out.add(f.rel);
      continue;
    }
    plain.push(f.rel);
  }
  for (let i = 0; i < plain.length; i += 500) {
    for (const r of await ownership({ projectId: project.id, rels: plain.slice(i, i + 500) })) out.add(r);
  }
  return out;
}

async function sha256Local(abs: string): Promise<string> {
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(abs)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/**
 * 내용은 다르지만 사본으로 남길 정보가 없는 생성물인가.
 *  · 루트 CLAUDE.md 가 우리가 쓴 import 한 줄이면 — 멤버 쪽 CLAUDE.md 가 무엇이든 잃을 것이 없다.
 *  · 루트 AGENTS.md 의 사람 규칙이 멤버 쪽과 같으면 — 다른 것은 자동 영역(digest)뿐이고 생성기가 다시 쓴다.
 */
async function nothingToKeep(store: ProjectStorage, f: LocalFile): Promise<boolean> {
  if (f.rel !== "CLAUDE.md" && f.rel !== "AGENTS.md") return false;
  const mine = await fsp.readFile(f.abs, "utf8").catch(() => null);
  if (mine == null) return false;
  if (f.rel === "CLAUDE.md") return mine.trim() === CLAUDE_IMPORT;
  const theirs = await store.readText(path.join(store.base, "AGENTS.md"));
  return theirs != null && sameRules(mine, theirs);
}

/** 로컬 파일 한 개를 멤버 저장소 rel 자리에 **덮어쓰지 않고** 앉힌다. true=앉힘 · false=이미 있음 */
async function placeCopy(store: ProjectStorage, f: LocalFile, rel: string): Promise<boolean> {
  const osUser = store.osUser as string;
  const dest = path.join(store.base, rel);
  //  임시 이름은 숨김 + 무작위만 — 원래 이름을 붙이면 긴 한글 이름에서 NAME_MAX 를 넘는다.
  const tmp = path.join(path.dirname(dest), `.migrate-${crypto.randomBytes(8).toString("hex")}`);
  //  원본부터 연다 — 못 읽는 파일이면 멤버 쪽에 **아무것도 만들기 전에** 실패한다. 쓰기를 먼저 띄우면 중단된 셸이
  //  정리(memberRm) 뒤에 빈 임시파일을 만들어 남길 수 있다.
  const fh = await fsp.open(f.abs, "r");
  let r: string;
  try {
    await memberWriteFrom(osUser, tmp, fh.createReadStream(), f.size + 1);
    r = await memberNodeJson<string>(osUser, PROJECT_PLACE_JS, { tmp, dest, mtime: f.mtime });
  } catch (e) {
    await memberRm(osUser, tmp).catch(() => { /* 목적지는 무손상 — 숨김 임시파일 하나가 남을 뿐 */ });
    throw e;
  } finally {
    await fh.close().catch(() => { /* 스트림이 이미 닫았다 */ });
  }
  if (r === "ok") return true;
  if (r === "exists") return false;
  throw new Error(`이관 자리잡기 실패: ${String(r)}`);
}

/** 같은 자리에 다른 내용이 있을 때 — «이름 (이관 사본).확장자» 로 나란히 둔다(사람이 둘 다 본다) */
async function placeBeside(store: ProjectStorage, f: LocalFile): Promise<void> {
  const slash = f.rel.lastIndexOf("/");
  const dir = slash >= 0 ? f.rel.slice(0, slash + 1) : "";
  const name = f.rel.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; n <= 50; n++) {
    const cand = `${dir}${stem} (${MIGRATED_COPY_LABEL}${n > 1 ? ` ${n}` : ""})${ext}`;
    if (await placeCopy(store, f, cand)) return;
  }
  throw new Error("이관 사본 이름을 정하지 못했습니다");
}

/** 처리한 원본을 게이트웨이 쪽 .lively/migrated/ 로 — 지우지 않는다(보관), 다음 걷기에서는 빠진다 */
async function stashLocal(localBase: string, rel: string): Promise<void> {
  let to = path.join(localBase, MIGRATED_DIR, rel);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  if (await fsp.stat(to).then(() => true, () => false)) to = `${to}.${Date.now()}`;
  await fsp.rename(path.join(localBase, rel), to);
}

/**
 * 게이트웨이 로컬 → 멤버 저장소. 이 워크스페이스의 것만 · 덮어쓰지 않는다 · 원본은 보관한다 ·
 *  실패한 파일은 제자리에 남긴다(머리말). 멤버 모드가 아니거나 프로젝트를 모르면 할 일이 없다.
 */
export async function migrateLocalToMember(store: ProjectStorage, limit = MIGRATE_BATCH): Promise<MigrationReport> {
  const rep: MigrationReport = { copied: 0, same: 0, renamed: 0, failed: 0, foreign: 0, more: false };
  if (!store.osUser || !store.project || store.localBase === store.base) return rep;
  const osUser = store.osUser;
  const { files: all, truncated } = await walkLocal(store.localBase, MANIFEST_FILE_CAP);
  if (!all.length) return rep;
  const owned = await provenOwned(store.project, all);
  const mine = all.filter((f) => owned.has(f.rel));
  rep.foreign = all.length - mine.length;
  const files = mine.slice(0, limit);
  //  남은 내 파일이 있으면 다음 열기가 이어 간다. 걷기가 상한에 잘렸는데 이번에 옮긴 것이 없으면 더 나아갈 수 없다
  //  — 그때까지 «남았다» 고 하면 미리보기 폴링마다 5천 개를 다시 걷는다.
  rep.more = mine.length > limit || (truncated && files.length > 0);
  if (!files.length) return rep;
  const dirs = [...new Set(files.map((f) => path.posix.dirname(f.rel)).filter((d) => d !== "."))];
  await memberNodeJson<boolean>(osUser, PROJECT_MKDIRS_JS, { dirs: [store.base, ...dirs.map((d) => path.join(store.base, d))] });
  const info = await memberNodeJson<Record<string, { file: boolean; size: number } | null>>(osUser, PROJECT_INFO_JS,
    { items: files.map((f, i) => ({ key: String(i), path: path.join(store.base, f.rel) })) });
  const sameSize = files.map((f, i) => ({ f, key: String(i) })).filter(({ f, key }) => {
    const m = info?.[key];
    return !!m && m.file && m.size === f.size;
  });
  const theirHash = sameSize.length
    ? await memberNodeJson<Record<string, string | null>>(osUser, PROJECT_HASH_JS,
      { items: sameSize.map(({ f, key }) => ({ key, path: path.join(store.base, f.rel) })) })
    : {};
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const key = String(i);
    try {
      const m = info?.[key] ?? null;
      if (!m) {
        if (await placeCopy(store, f, f.rel)) rep.copied++;
        else { await placeBeside(store, f); rep.renamed++; }   // 그 사이 누가 같은 자리에 만들었다
      } else if (theirHash?.[key] && theirHash[key] === (await sha256Local(f.abs))) {
        rep.same++;
      } else if (m.file && (await nothingToKeep(store, f))) {
        rep.same++;
      } else {
        await placeBeside(store, f);
        rep.renamed++;
      }
      await stashLocal(store.localBase, f.rel);
    } catch (e) {
      rep.failed++;
      logger.warn({ err: e, file: f.abs }, "[project-storage] 이관 실패 — 원본은 제자리에 남아 다음 열기에서 다시 간다");
    }
  }
  //  옮긴 파일이 있던 로컬 폴더만 걷는다(깊은 것부터). 남의 파일이 남아 있으면 rmdir 이 실패하고 그대로 남는다.
  const touched = new Set<string>();
  for (const d of dirs) { for (let cur = d; cur && cur !== "."; cur = path.posix.dirname(cur)) touched.add(cur); }
  for (const d of [...touched].sort((a, b) => b.split("/").length - a.split("/").length)) {
    await fsp.rmdir(path.join(store.localBase, d)).catch(() => { /* 남은 것이 있다 */ });
  }
  return rep;
}

const settled = new Set<string>();
const running = new Map<string, Promise<void>>();
const retryAt = new Map<string, number>();

/** 시험 전용 — 이 프로세스의 이관 기억을 비운다 */
export function resetMigrationMemo(): void { settled.clear(); running.clear(); retryAt.clear(); }

async function settleMigration(store: ProjectStorage): Promise<void> {
  const key = JSON.stringify([tenantSlug() ?? "", store.localBase]);
  if (settled.has(key)) return;
  let run = running.get(key);
  if (!run) {
    if ((retryAt.get(key) ?? 0) > Date.now()) return;   // 방금 실패했다 — 미리보기 폴링(1.5초)마다 다시 두드리지 않는다
    run = migrateLocalToMember(store)
      .then((r) => {
        if (r.failed === 0 && !r.more) settled.add(key);
        if (r.failed) retryAt.set(key, Date.now() + MIGRATE_RETRY_MS);
        if (r.copied || r.same || r.renamed || r.failed || r.foreign) {
          logger.info({ ...r, from: store.localBase, to: store.base, project: store.project?.id }, "[project-storage] 게이트웨이 로컬 → 멤버 저장소 이관");
        }
      })
      .catch((e) => {
        retryAt.set(key, Date.now() + MIGRATE_RETRY_MS);
        logger.warn({ err: e, from: store.localBase }, "[project-storage] 이관 중단 — 잠시 뒤 다음 열기에서 다시 간다");
      })
      .finally(() => { running.delete(key); });
    running.set(key, run);
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([run, new Promise<void>((resolve) => { timer = setTimeout(resolve, MIGRATE_WAIT_MS); timer.unref?.(); })]);
  if (timer) clearTimeout(timer);
}
