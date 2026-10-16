// 앱 폴더 보관(#4778) — 앱을 지우면 그 앱 폴더(<apps 자리>/<앱>/)를 apps 주소로 닿지 않는 보관 자리로 옮기고, 보관 기간이 지나면 지운다.
//
// ── 왜 ───────────────────────────────────────────────────────────────────────────────────
//  앱 폴더(#4671 ② · #4673)는 앱 id 로 정해지는 자리다. 앱을 지우면 그 앱 폴더를 apps 주소로 닿지 않는 보관 자리로 옮기고, 같은 id 로
//   새로 만든 앱은 빈 앱 폴더로 시작한다. 보관 기간이 지나면 지운다. 앱 표는 이미 «떠 둔 뒤 지움»이다(#4226 · #4733) — 앱 폴더도 같은 자세다.
//
// ── 규칙 ──────────────────────────────────────────────────────────────────────────────────
//  · 앱 행을 지우는 모든 입구(remove-run — 관리자 제거 · 나만 보는 앱 지우기 · 시더의 은퇴 회수 · 빈 예약 거두기)가 archiveAppFolder 로
//    그 앱 폴더를 보관으로 옮긴다. 못 옮겨도 지우기는 막지 않는다(명시로 요청한 지우기다 — 응답에 까닭을 싣는다).
//  · 같은 id 로 앱을 새로 만들 때 그 자리에 폴더가 남아 있으면 먼저 보관으로 옮긴다(archiveLeftoverAppFolder) — 새 앱은 늘 빈 앱 폴더로 시작한다.
//    못 옮기면 만들지 않는다(fail-closed). 지우는 사이 들어온 올리기가 폴더를 새로 만든 경우도 여기서 걸린다.
//  · 보관 기간(앱 데이터 떠 두기와 같은 LIVELY_APP_SNAPSHOT_DAYS, 기본 7일)이 지나면 정비가 지운다(pruneAppFolderArchives).
//    관리자는 목록을 보고 비우거나, 같은 id 로 다시 만든 앱에 되돌린다 — 명시로만(app_data_restore 와 같은 자세, 상민 2026-10-16).
//  · 앱 행 없이 폴더만 남은 것(고아)은 정비가 훑지 않는다 — 관리자 목록이 보여 주고 관리자가 보관으로 옮긴다(상민 2026-10-16:
//    매니지드에서 워크스페이스마다 파일 작업 헬퍼를 깨우지 않게 · 셀프호스트 기본 자리 ~/apps 에 원래 있던 폴더를 옮기지 않게).
//
// ── 보관 자리 — apps 자리 **안**의 점 이름(같은 부모) ──────────────────────────────────────────
//  `<apps 자리>/.archived-app.<앱>.<YYYYMMDDTHHMMSSZ>.<16진 6자>`
//   · 점으로 시작하는 이름은 주소가 없다(files/address 가 점 마디를 거부) · 탐색기는 점 이름을 목록에서 빼고 root=apps 는 동의한 앱 id
//     마디만 연다(terminal-files browseGate) · 앱 id 는 점으로 시작할 수 없다(manifest APP_ID_RE) → apps 주소로 닿지 않는다.
//   · 매니지드 파일 작업 헬퍼의 감옥은 `<테넌트>/apps` 를 통째로 붙인다(lvly-cloud fsBinds · #4689) — 바인드를 더하지 않아도 보인다.
//   · **같은 부모 안의 이름 바꾸기**다. 다른 부모로 옮기면 커널이 옮기는 폴더의 `..` 를 고치려고 그 폴더 자신의 쓰기 권한을 본다 —
//     셀프호스트 격리(구성원마다 OS 계정)에선 앱 폴더가 처음 올린 사람 소유(2755)라 게이트웨이가 그 권한이 없다. apps 자리
//     (root:lively-shared 2775)에는 그룹으로 쓸 수 있어 같은 부모 안의 이름 바꾸기는 늘 된다.
//   · 테넌트 백업(restic · apps 포함, lvly-cloud #497)에 함께 담긴다 — 지운 뒤에도 백업 보관 기간 동안은 백업에 남는다.
//
// ── 누가 옮기고 지우나(파일 작업 주체 — 2026-10-16 실측) ────────────────────────────────────────
//  · 매니지드: 파일 작업 헬퍼 — 테넌트 uid 하나(세션 안 `id` = 200069 · 테넌트의 모든 파일이 그 uid). 중계는 osUser 를 쓰지 않는다
//    (lvly-cloud deploy/member-exec-local.mjs). 그래서 누가 시켰든 같은 감옥에서 돈다.
//  · 셀프호스트: 게이트웨이 프로세스. 격리 박스면 apps 자리 = 구성원 격리 기준과 같은 자리(LIVELY_APPS_DIR · 그룹 rwx).
//    구성원 소유 폴더(2755 — sudo 기본 umask 022) 안은 게이트웨이가 못 지우므로, 남은 것은 그 폴더 주인 계정(box-spawn)으로 다시 지운다.
//  어느 쪽이든 op 는 고정 스크립트 하나(APP_FOLDER_OPS_JS)다 — 값은 전부 stdin JSON(memberNodeJson 계약 · 인젝션 표면 없음).
//
// ── 기록 — org_app_folder_archive ─────────────────────────────────────────────────────────────
//  보관 하나 = 행 하나(이름 · 앱 · 언제 · 누가 · 어느 입구 · 크기 · 파일 수). 정비는 이 표만 보고 기간이 지난 보관이 있을 때만 파일을
//   만진다(보관이 없는 워크스페이스는 헬퍼를 깨우지 않는다). 파일 쪽이 진짜다 — 목록은 파일을 훑어 행 없는 보관(옮긴 뒤 기록이
//   실패한 것)을 행으로 채우고, 파일이 없는 행은 «사라짐» 으로 보인다.
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { itemsPool } from "../db/client.js";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import { getApp, withAppInstallLock } from "../org/store/apps.js";
import { APP_ID_RE } from "./manifest.js";
import { snapshotKeepDays } from "./app-snapshot.js";
import { roots, APPS_ROOT_KEY } from "../terminal/catalog.js";
import { memberNodeJson } from "../terminal/terminal-member-fs.js";
import { memberExecConfigured, isolationInfraReady, osUsername, memberSlug, OS_USER_PREFIX } from "../terminal/terminal-isolation.js";

const execFileAsync = promisify(execFile);

/** 어느 입구에서 옮겼나 — 관리자 목록 · 감사에 그대로 보인다. */
export type AppFolderArchiveEntry =
  | "remove"      // 관리자 제거(org_app_remove)
  | "discard"     // 나만 보는 앱 지우기(app_draft_remove)
  | "retire"      // 시더의 은퇴 앱 회수
  | "draft-drop"  // 첫 판 없는 빈 예약 거두기(설치 실패 · 그만둔 만들기)
  | "create"      // 같은 id 로 새로 만들 때 그 자리에 남아 있던 폴더
  | "orphan";     // 관리자가 고아 폴더를 보관으로

// ── 이름 ──────────────────────────────────────────────────────────────────────────────────

export const APP_FOLDER_ARCHIVE_PREFIX = ".archived-app.";
/** 앱 id 부분 — manifest APP_ID_RE 에서 끝 표시만 뗀 것(한 자리에서 온다 · 시험이 스크립트의 글자와 대조한다). */
export const APP_ID_PART = APP_ID_RE.source.replace(/^\^/, "").replace(/\$$/, "");
const NAME_RE = new RegExp(`^\\.archived-app\\.(${APP_ID_PART})\\.(\\d{8}T\\d{6}Z)\\.([0-9a-f]{6})$`);

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
/** UTC 초까지 — `20261016T031502Z`. */
export function archiveStamp(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** 보관 이름 — 같은 초에 같은 앱을 두 번 옮겨도 겹치지 않게 16진 6자를 붙인다(남이 미리 만들어 둘 수도 없다). */
export function archiveNameFor(appId: string, now: Date, nonce: string = crypto.randomBytes(3).toString("hex")): string {
  if (!APP_ID_RE.test(appId)) throw new Error(`앱 id 꼴이 아닙니다: ${appId}`);
  if (!/^[0-9a-f]{6}$/.test(nonce)) throw new Error("nonce 는 16진 6자");
  return `${APP_FOLDER_ARCHIVE_PREFIX}${appId}.${archiveStamp(now)}.${nonce}`;
}

/** 보관 이름 → 앱 · 옮긴 시각. 꼴이 아니면 null(그 이름은 보관이 아니다 — 아무것도 하지 않는다). */
export function parseArchiveName(name: string): { app_id: string; archived_at: Date } | null {
  const m = NAME_RE.exec(String(name ?? ""));
  if (!m) return null;
  const s = m[2]!;
  const at = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15)));
  //  13월 · 32일처럼 넘친 값은 Date 가 다음 달로 넘겨 버린다 — 되찍은 글자가 같을 때만 시각으로 읽는다.
  return Number.isNaN(at.getTime()) || archiveStamp(at) !== s ? null : { app_id: m[1]!, archived_at: at };
}

// ── 파일 op — 고정 스크립트 하나 ───────────────────────────────────────────────────────────────
//  op: archive(앱 폴더 → 보관 이름 · 크기 재기) · scan(보관 · 고아 훑기) · remove(보관 지우기) · restore(보관 → 앱 폴더).
//  ⚠ 이름 규칙(APP · ARC)은 스크립트 **안의 글자**로 다시 본다 — 부르는 쪽이 틀린 이름을 넘겨도 apps 자리 밖이나 보관이 아닌 것을 건드리지
//   않게(겹 방어). 위 APP_ID_PART · NAME_RE 와 같은 글자인지는 시험이 잰다.
//  ⚠ 링크를 따라가지 않는다 — 크기 재기 · 주인 훑기는 lstat, 지우기는 링크 자체를 지운다(fs.rmSync), 이름 바꾸기는 링크를 그대로 옮긴다.
//  크기 재기는 상한(항목 수 · 시간 — 한 번 부를 때 전체)에 닿으면 truncated 와 그때까지 센 값을 준다.
export const APP_FOLDER_OPS_JS = String.raw`
const fs=require('fs'),p=require('path');
let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{d+=c});
process.stdin.on('end',()=>{try{main(JSON.parse(d||'{}'))}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(1)}});
function main(q){
  const APP=/^[a-z0-9][a-z0-9-]{1,31}$/;
  const ARC=/^\.archived-app\.[a-z0-9][a-z0-9-]{1,31}\.\d{8}T\d{6}Z\.[0-9a-f]{6}$/;
  const out=v=>process.stdout.write(JSON.stringify(v));
  const base=String(q.base||'');
  if(!p.isAbsolute(base)||p.resolve(base)!==base)throw new Error('apps 자리가 정규화된 절대경로가 아닙니다');
  const at=(n,re)=>{if(typeof n!=='string'||!re.test(n))throw new Error('이름 꼴이 아닙니다: '+String(n).slice(0,80));return p.join(base,n)};
  const lst=f=>{try{return fs.lstatSync(f)}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')return null;throw e}};
  const kind=s=>s.isDirectory()?'dir':s.isSymbolicLink()?'link':'file';
  const budget={left:Number(q.cap_n)>0?Number(q.cap_n):50000,until:Date.now()+(Number(q.cap_ms)>0?Number(q.cap_ms):5000)};
  const measure=(f,s)=>{const r={files:0,bytes:0,truncated:false};
    const walk=(x,st)=>{if(!st.isDirectory()){r.files++;if(st.isFile())r.bytes+=st.size;return true}
      let es;try{es=fs.readdirSync(x)}catch(e){r.truncated=true;return true}
      for(const n of es){if(budget.left--<=0||Date.now()>budget.until){r.truncated=true;return false}
        const c=p.join(x,n);let cs;try{cs=fs.lstatSync(c)}catch(e){continue}
        if(!walk(c,cs))return false}
      return true};
    walk(f,s);return r};
  if(q.op==='archive'){
    const src=at(q.app,APP),dst=at(q.name,ARC);
    const s=lst(src);if(!s)return out({moved:false});
    if(lst(dst))throw new Error('보관 이름이 이미 있습니다: '+q.name);
    fs.renameSync(src,dst);
    return out(Object.assign({moved:true,kind:kind(s)},measure(dst,s)));
  }
  if(q.op==='scan'){
    const live=new Set(Array.isArray(q.live)?q.live:[]),known=new Set(Array.isArray(q.known)?q.known:[]);
    let es;try{es=fs.readdirSync(base)}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')return out({exists:false,archives:[],orphans:[]});throw e}
    const archives=[],orphans=[];
    for(const n of es.sort()){const f=p.join(base,n);
      if(ARC.test(n)){const s=lst(f);if(!s)continue;const it={name:n,kind:kind(s)};if(!known.has(n))Object.assign(it,measure(f,s));archives.push(it);continue}
      if(APP.test(n)&&!live.has(n)){const s=lst(f);if(!s)continue;orphans.push(Object.assign({name:n,kind:kind(s)},measure(f,s)))}}
    return out({exists:true,archives,orphans});
  }
  if(q.op==='remove'){
    const removed=[],absent=[],left=[];
    const names=Array.isArray(q.names)?q.names:[];names.forEach(n=>at(n,ARC));   // 이름을 전부 먼저 본다 — 하나라도 틀리면 아무것도 안 지운다
    for(const n of names){const f=at(n,ARC);if(!lst(f)){absent.push(n);continue}let err=null;
      try{fs.rmSync(f,{recursive:true,force:true})}catch(e){err=String(e&&e.message||e)}
      if(!lst(f)){removed.push(n);continue}
      const owners=new Set();
      const own=(x,st)=>{if(!st.isDirectory()||owners.size>=20||budget.left--<=0)return;owners.add(st.uid);let es;try{es=fs.readdirSync(x)}catch(e){return}
        for(const c of es){let cs;try{cs=fs.lstatSync(p.join(x,c))}catch(e){continue}own(p.join(x,c),cs)}};
      const s=lst(f);if(s)own(f,s);
      left.push({name:n,error:err||'지우지 못했습니다',owners:[...owners]})}
    return out({removed,absent,left});
  }
  if(q.op==='restore'){
    const src=at(q.name,ARC),dst=at(q.app,APP);
    if(!lst(src))return out({ok:false,why:'missing'});
    const t=lst(dst);
    if(t){if(!t.isDirectory())return out({ok:false,why:'occupied'});
      let n=0;try{n=fs.readdirSync(dst).length}catch(e){return out({ok:false,why:'occupied'})}
      if(n>0)return out({ok:false,why:'occupied'});
      fs.rmdirSync(dst)}
    fs.renameSync(src,dst);
    return out({ok:true});
  }
  throw new Error('모르는 op: '+String(q.op).slice(0,40));
}
`;

type Run = <T>(input: Record<string, unknown>) => Promise<T>;

/** apps 자리 하나 — 어디(base)를 누가(run) 만지나. */
export interface AppsArea {
  /** apps 자리의 절대경로 — op 가 도는 자리 기준(매니지드 = 감옥 안 `/lvly/tenants/<slug>/apps`). */
  base: string;
  /** 고정 스크립트를 이 자리의 주체로 돌린다. */
  run: Run;
  /** 셀프호스트 격리만 — 게이트웨이가 못 지운 것을 그 폴더 주인 계정으로 다시 지운다(그 밖은 null). */
  runAs: ((osUser: string) => Run) | null;
}

/** 이 프로세스에서 고정 스크립트를 돌린다(셀프호스트 — 게이트웨이가 apps 자리를 직접 본다). */
function localNodeJson<T>(js: string, input: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ["-e", js], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    c.stdout.on("data", (b: Buffer) => out.push(b));
    c.stderr.on("data", (b: Buffer) => err.push(b));
    c.on("error", reject);
    c.stdin.on("error", reject);
    c.stdin.end(JSON.stringify(input));
    c.on("close", (code) => {
      if (code !== 0) return reject(new Error(Buffer.concat(err).toString("utf8").trim() || `앱 폴더 op 종료 ${code}`));
      try { resolve(JSON.parse(Buffer.concat(out).toString("utf8") || "null") as T); } catch (e) { reject(e as Error); }
    });
  });
}

/**
 * 이 요청(또는 정비 순회)의 apps 자리 — 서명 주소 · 탐색기와 같은 자리를 본다(catalog roots 의 apps).
 *  · 매니지드(저장소 분리 — memberExecConfigured): 감옥 안 경로(isolatedBase) · 파일 작업 헬퍼. osUser 는 중계가 쓰지 않지만 인자 꼴은
 *    지킨다(시킨 사람 · 없으면 system).
 *  · 셀프호스트 격리 박스(isolationInfraReady): 구성원 격리 기준(LIVELY_APPS_DIR) · 게이트웨이 로컬 + 주인 계정으로 다시 지우기.
 *  · 그 밖: TERMINAL_ROOT_APPS(기본 ~/apps) · 게이트웨이 로컬.
 */
export function appsAreaFor(by: string | null): AppsArea | null {
  const root = roots().find((r) => r.key === APPS_ROOT_KEY);
  if (!root) return null;
  if (memberExecConfigured()) {
    const osUser = osUsername(memberSlug(by || "system"));
    return { base: path.resolve(root.isolatedBase ?? root.base), run: (q) => memberNodeJson(osUser, APP_FOLDER_OPS_JS, q), runAs: null };
  }
  const isolated = isolationInfraReady();
  const base = path.resolve(isolated ? (root.isolatedBase ?? root.base) : root.base);
  return {
    base,
    run: (q) => localNodeJson(APP_FOLDER_OPS_JS, q),
    runAs: isolated ? (osUser) => (q) => memberNodeJson(osUser, APP_FOLDER_OPS_JS, q) : null,
  };
}

/** 크기 재기 상한 — 한 번 부를 때 전체(항목 수 · 시간). 넘으면 truncated(그때까지 센 값). */
export const MEASURE_CAP = { cap_n: 50_000, cap_ms: 5_000 };

// ── 기록(org_app_folder_archive) ────────────────────────────────────────────────────────────

export interface AppFolderArchive {
  name: string;
  app_id: string;
  archived_at: string;
  archived_by: string | null;
  entry: AppFolderArchiveEntry | "unknown";
  kind: "dir" | "file" | "link";
  files: number | null;
  bytes: number | null;
  truncated: boolean;
}

type Row = Omit<AppFolderArchive, "archived_at"> & { archived_at: Date };

const rowOf = (r: Record<string, unknown>): Row => ({
  name: String(r.name), app_id: String(r.app_id),
  archived_at: r.archived_at instanceof Date ? r.archived_at : new Date(String(r.archived_at)),
  archived_by: r.archived_by == null ? null : String(r.archived_by),
  entry: String(r.entry) as Row["entry"], kind: (String(r.kind || "dir")) as Row["kind"],
  files: r.files == null ? null : Number(r.files), bytes: r.bytes == null ? null : Number(r.bytes), truncated: r.truncated === true,
});
const publicOf = (r: Row): AppFolderArchive => ({ ...r, archived_at: r.archived_at.toISOString() });

async function insertRow(r: Row): Promise<void> {
  // ON CONFLICT 타깃에 tenant_id — ensureTenantColumn 이 PK 를 (tenant_id, name) 으로 다시 쓴다(attachAppRow 와 같은 규약).
  await itemsPool.query(
    `INSERT INTO org_app_folder_archive(name, app_id, archived_at, archived_by, entry, kind, files, bytes, truncated)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id, name) DO NOTHING`,
    [r.name, r.app_id, r.archived_at, r.archived_by, r.entry, r.kind, r.files, r.bytes, r.truncated]);
}
async function allRows(): Promise<Row[]> {
  return (await itemsPool.query(`SELECT * FROM org_app_folder_archive ORDER BY archived_at DESC, name`)).rows.map(rowOf);
}
async function rowsByNames(names: string[]): Promise<Row[]> {
  if (!names.length) return [];
  return (await itemsPool.query(`SELECT * FROM org_app_folder_archive WHERE name = ANY($1::text[])`, [names])).rows.map(rowOf);
}
async function deleteRows(names: string[]): Promise<void> {
  if (names.length) await itemsPool.query(`DELETE FROM org_app_folder_archive WHERE name = ANY($1::text[])`, [names]);
}

/** 보관 기한 — 옮긴 시각 + 보관 일수. */
export function expiresAt(archivedAt: Date | string, keepDays: number = snapshotKeepDays()): string {
  return new Date(new Date(archivedAt).getTime() + Math.floor(keepDays) * 24 * 60 * 60 * 1000).toISOString();
}

// ── 옮기기 ─────────────────────────────────────────────────────────────────────────────────

export interface AppFolderArchiveOutcome {
  /** 옮긴 보관(없으면 null — 그 앱 폴더가 없었다). */
  archived: AppFolderArchive | null;
  /** 옮길 것을 찾지도 않은 까닭(앱 id 꼴이 아님 · apps 자리 없음). */
  skipped?: string;
}

/**
 * 그 앱 폴더를 보관으로 옮긴다 — 없으면 아무것도 안 한다(archived=null). 파일 op 가 실패하면 던진다(부르는 쪽이 정한다 —
 *  지우기는 까닭만 싣고 계속, 새로 만들기는 멈춘다). 옮긴 뒤 기록을 못 남기면 경고만 — 목록이 파일에서 다시 채운다.
 */
export async function archiveAppFolder(appId: string, opts: { by: string | null; entry: AppFolderArchiveEntry; now?: Date; area?: AppsArea | null }): Promise<AppFolderArchiveOutcome> {
  if (!APP_ID_RE.test(appId)) return { archived: null, skipped: "앱 id 꼴이 아니라 앱 폴더가 없습니다" };
  const area = opts.area !== undefined ? opts.area : appsAreaFor(opts.by);
  if (!area) return { archived: null, skipped: "앱 폴더 자리가 없습니다" };
  const now = opts.now ?? new Date();
  const name = archiveNameFor(appId, now);
  const r = await area.run<{ moved: boolean; kind?: Row["kind"]; files?: number; bytes?: number; truncated?: boolean }>(
    { op: "archive", base: area.base, app: appId, name, ...MEASURE_CAP });
  if (!r?.moved) return { archived: null };
  const row: Row = {
    name, app_id: appId, archived_at: now, archived_by: opts.by, entry: opts.entry,
    kind: r.kind ?? "dir", files: r.files ?? null, bytes: r.bytes ?? null, truncated: r.truncated === true,
  };
  await insertRow(row).catch((err) => logger.warn({ err, name, app: appId }, "[app-folder] 보관으로 옮겼는데 기록을 못 남겼다 — 관리자 목록이 파일에서 다시 채운다"));
  logger.info({ app: appId, name, entry: opts.entry, files: row.files, bytes: row.bytes, truncated: row.truncated }, "[app-folder] 앱 폴더를 보관으로 옮김");
  return { archived: publicOf(row) };
}

/**
 * 새 앱을 만들기 직전 — 같은 id 의 앱 폴더가 남아 있으면 보관으로 옮긴다(새 앱은 늘 빈 앱 폴더로 시작한다). 못 보면 만들지 않는다(503).
 *  앱 행이 아직 없는 자리에서만 부른다(부르는 쪽이 설치 락 안에서 «없음» 을 본 뒤).
 */
export async function archiveLeftoverAppFolder(appId: string, by: string | null): Promise<AppFolderArchive | null> {
  try {
    return (await archiveAppFolder(appId, { by, entry: "create" })).archived;
  } catch (err) {
    logger.warn({ err, app: appId }, "[app-folder] 새 앱의 앱 폴더 자리를 확인하지 못해 만들기를 멈춘다");
    throw new HttpError(503, `앱 '${appId}' 의 앱 폴더 자리를 확인하지 못해 만들지 않았습니다 — 잠시 뒤 다시 해 주세요(새 앱이 빈 앱 폴더로 시작하도록 먼저 확인합니다)`, { cause: err });
  }
}

// ── 지우기(셀프호스트 격리는 주인 계정으로 다시) ────────────────────────────────────────────────

/** removed = 있던 것을 지웠다 · absent = 처음부터 없었다 · left = 못 지웠다(owners = 남은 폴더들의 주인 uid — 셀프호스트 격리용). */
export interface RemoveResult { removed: string[]; absent: string[]; left: Array<{ name: string; error: string; owners?: number[] }> }

/** uid → OS 계정 이름(구성원 계정만 — box-spawn 은 그 그룹에만 허락된다). 못 찾으면 뺀다. */
async function memberOsUsersOf(uids: number[]): Promise<string[]> {
  const names: string[] = [];
  for (const uid of [...new Set(uids)].filter((u) => Number.isInteger(u) && u > 0)) {
    const line = await execFileAsync("getent", ["passwd", String(uid)]).then((r) => String(r.stdout)).catch(() => "");
    const name = line.split(":")[0]?.trim() ?? "";
    if (name.startsWith(OS_USER_PREFIX)) names.push(name);
  }
  return names;
}

/**
 * 보관을 지운다. 셀프호스트 격리면 남은 것을 그 폴더 주인 계정으로 지우고 다시 게이트웨이로(빈 폴더 · 맨 위 이름) — 진전이 없을 때까지,
 *  최대 세 바퀴. 끝까지 남은 것은 까닭과 함께 돌려준다(행은 남는다 — 목록에 계속 보인다).
 */
export async function removeArchives(area: AppsArea, names: string[], osUsersOf: (uids: number[]) => Promise<string[]> = memberOsUsersOf): Promise<RemoveResult> {
  const out: RemoveResult = { removed: [], absent: [], left: [] };
  if (!names.length) return out;
  const first = await area.run<RemoveResult>({ op: "remove", base: area.base, names, ...MEASURE_CAP });
  out.removed.push(...first.removed);
  out.absent.push(...(first.absent ?? []));
  let left = first.left;
  for (let round = 0; left.length && area.runAs && round < 3; round++) {
    const users = await osUsersOf(left.flatMap((x) => x.owners ?? []));
    if (!users.length) break;
    const leftNames = left.map((x) => x.name);
    for (const u of users) {
      //  주인 계정은 제 폴더 안을 비운다(남의 하위 폴더는 못 비운다 — 그 주인이 다음 차례에). 맨 위 이름도 지울 수 있으면 지운다.
      await area.runAs(u)<RemoveResult>({ op: "remove", base: area.base, names: leftNames, ...MEASURE_CAP })
        .then((x) => { out.removed.push(...x.removed); })
        .catch((err) => logger.warn({ err, osUser: u }, "[app-folder] 주인 계정으로 보관 지우기 실패"));
    }
    const still = leftNames.filter((n) => !out.removed.includes(n));
    if (!still.length) { left = []; break; }
    //  다시 게이트웨이로 — 비워진 폴더 · 맨 위 이름. 그새 주인 계정이 통째로 지운 것은 absent 로 오지만 처음엔 있던 것이다(removed).
    const again = await area.run<RemoveResult>({ op: "remove", base: area.base, names: still, ...MEASURE_CAP });
    out.removed.push(...again.removed, ...(again.absent ?? []));
    left = again.left;
  }
  out.removed = [...new Set(out.removed)];
  out.left = left.filter((x) => !out.removed.includes(x.name)).map(({ name, error }) => ({ name, error }));
  return out;
}

// ── 목록(관리자) ───────────────────────────────────────────────────────────────────────────

export interface AppFolderArchiveItem extends AppFolderArchive {
  expires_at: string;
  /** 지금 같은 id 의 앱이 있나 — 되돌리기는 있을 때만 된다. */
  app_exists: boolean;
  /** 기록은 있는데 파일이 없다(누가 셸에서 지웠다 · 옮기기가 실패한 기록) — 다음 정비가 기록을 걷는다. */
  missing?: true;
}
export interface AppFolderOrphan { app_id: string; kind: "dir" | "file" | "link"; files: number; bytes: number; truncated: boolean }
export interface AppFolderArchiveListing {
  keep_days: number;
  archives: AppFolderArchiveItem[];
  /** 앱 행 없이 남은 앱 폴더 — 관리자가 보관으로 옮긴다(app_folder_orphans_archive). */
  orphans: AppFolderOrphan[];
  count: number; bytes: number; orphan_count: number; orphan_bytes: number;
  /** 파일을 못 훑었으면 그 까닭 — 그때 archives 는 기록만(사라짐 · 고아를 모른다). */
  scan_error?: string;
}

interface ScanResult {
  exists: boolean;
  archives: Array<{ name: string; kind: Row["kind"]; files?: number; bytes?: number; truncated?: boolean }>;
  orphans: Array<{ name: string; kind: Row["kind"]; files: number; bytes: number; truncated: boolean }>;
}

/** 기록 + 파일 훑기 → 목록(순수). 파일에만 있는 보관은 채울 행(fill)으로 돌려준다. */
export function mergeListing(rows: Row[], scan: ScanResult | null, liveIds: ReadonlySet<string>, keepDays: number): { items: AppFolderArchiveItem[]; fill: Row[]; orphans: AppFolderOrphan[] } {
  const present = scan ? new Set(scan.archives.map((a) => a.name)) : null;
  const known = new Set(rows.map((r) => r.name));
  const fill: Row[] = [];
  for (const a of scan?.archives ?? []) {
    if (known.has(a.name)) continue;
    const parsed = parseArchiveName(a.name);
    if (!parsed) continue;
    fill.push({ name: a.name, app_id: parsed.app_id, archived_at: parsed.archived_at, archived_by: null, entry: "unknown",
      kind: a.kind, files: a.files ?? null, bytes: a.bytes ?? null, truncated: a.truncated === true });
  }
  const items = [...rows, ...fill]
    .sort((a, b) => b.archived_at.getTime() - a.archived_at.getTime() || a.name.localeCompare(b.name))
    .map((r): AppFolderArchiveItem => ({
      ...publicOf(r), expires_at: expiresAt(r.archived_at, keepDays), app_exists: liveIds.has(r.app_id),
      ...(present && !present.has(r.name) ? { missing: true as const } : {}),
    }));
  const orphans = (scan?.orphans ?? []).map((o) => ({ app_id: o.name, kind: o.kind, files: o.files, bytes: o.bytes, truncated: o.truncated }));
  return { items, fill, orphans };
}

/** 이 워크스페이스의 앱 id 전부(기본 앱 포함 — 행이 있으면 그 폴더는 고아가 아니다). */
async function liveAppIds(): Promise<string[]> {
  return (await itemsPool.query(`SELECT id FROM org_app`)).rows.map((r) => String(r.id));
}

export async function listAppFolderArchives(by: string | null = null): Promise<AppFolderArchiveListing> {
  const keepDays = snapshotKeepDays();
  const rows = await allRows();
  const live = await liveAppIds();
  const area = appsAreaFor(by);
  let scan: ScanResult | null = null, scanError: string | undefined;
  if (area) {
    try { scan = await area.run<ScanResult>({ op: "scan", base: area.base, live, known: rows.map((r) => r.name), ...MEASURE_CAP }); }
    catch (err) { scanError = (err as Error)?.message ?? String(err); logger.warn({ err }, "[app-folder] apps 자리를 훑지 못했다 — 기록만 보인다"); }
  }
  const { items, fill, orphans } = mergeListing(rows, scan, new Set(live), keepDays);
  for (const r of fill) await insertRow(r).catch((err) => logger.warn({ err, name: r.name }, "[app-folder] 파일에만 있던 보관을 기록하지 못했다"));
  return {
    keep_days: keepDays, archives: items, orphans,
    count: items.length, bytes: items.reduce((n, a) => n + (a.missing ? 0 : a.bytes ?? 0), 0),
    orphan_count: orphans.length, orphan_bytes: orphans.reduce((n, o) => n + o.bytes, 0),
    ...(scanError ? { scan_error: scanError } : {}),
  };
}

// ── 비우기 · 되돌리기 · 고아 옮기기(관리자) ─────────────────────────────────────────────────────

export interface ClearFolderArchivesOutcome {
  /** 지운 것 — was_missing 이면 파일은 이미 없었고 기록만 걷었다. */
  cleared: Array<{ name: string; app_id: string; was_missing?: true }>;
  /** 못 지워 남긴 것과 까닭(행도 남는다). */
  kept: Array<{ name: string; why: string }>;
  /** 보관 이름 꼴이 아니거나 기록도 파일도 없는 이름 — 아무것도 하지 않았다. */
  missing: string[];
}

/** 보관을 지운다(되살릴 길이 없다 — 이 보관이 마지막 사본이다. 테넌트 백업 보관 기간 동안은 백업에만 남는다). */
export async function clearAppFolderArchives(names: string[], by: string | null = null): Promise<ClearFolderArchivesOutcome> {
  const want = [...new Set(names.map((n) => String(n ?? "").trim()).filter(Boolean))];
  const out: ClearFolderArchivesOutcome = { cleared: [], kept: [], missing: [] };
  const valid = want.filter((n) => parseArchiveName(n));
  out.missing.push(...want.filter((n) => !parseArchiveName(n)));
  if (!valid.length) return out;
  const area = appsAreaFor(by);
  if (!area) throw new HttpError(503, "앱 폴더 자리가 없습니다");
  const rows = new Map((await rowsByNames(valid)).map((r) => [r.name, r]));
  const r = await removeArchives(area, valid);
  const appOf = (n: string): string => rows.get(n)?.app_id ?? parseArchiveName(n)!.app_id;
  for (const n of r.removed) out.cleared.push({ name: n, app_id: appOf(n) });
  //  파일이 처음부터 없던 이름 — 기록이 있으면 기록만 걷고(사라진 보관) · 기록도 없으면 아무것도 안 한 것으로 알린다.
  for (const n of r.absent) {
    if (rows.has(n)) out.cleared.push({ name: n, app_id: appOf(n), was_missing: true });
    else out.missing.push(n);
  }
  for (const k of r.left) out.kept.push({ name: k.name, why: `지우지 못했습니다 — ${k.error}` });
  await deleteRows([...r.removed, ...r.absent.filter((n) => rows.has(n))]);
  return out;
}

/**
 * 보관을 같은 id 의 앱 폴더로 되돌린다 — 그 앱이 지금 있고(다시 만든 뒤) 그 앱 폴더가 없거나 비었을 때만. 설치 락 안에서(그 앱의 설치 ·
 *  지우기와 엇갈리지 않게). 되돌리면 기록을 지운다.
 */
export async function restoreAppFolderArchive(name: string, by: string | null = null): Promise<{ app_id: string; name: string }> {
  const parsed = parseArchiveName(name);
  if (!parsed) throw new HttpError(400, `보관 이름 꼴이 아닙니다: ${String(name).slice(0, 80)} — app_folder_archives 의 name 을 그대로 주세요`);
  const appId = parsed.app_id;
  return withAppInstallLock(appId, async () => {
    if (!(await getApp(appId))) {
      throw new HttpError(409, `앱 '${appId}' 이(가) 지금 없습니다 — 같은 id 로 앱을 다시 만든 뒤 되돌리세요(보관은 ${expiresAt(parsed.archived_at)} 까지 남습니다)`);
    }
    const area = appsAreaFor(by);
    if (!area) throw new HttpError(503, "앱 폴더 자리가 없습니다");
    const r = await area.run<{ ok: boolean; why?: "missing" | "occupied" }>({ op: "restore", base: area.base, name, app: appId });
    if (!r?.ok && r?.why === "missing") {
      await deleteRows([name]);
      throw new HttpError(410, `보관 '${name}' 이(가) 없습니다 — 이미 지워졌습니다`);
    }
    if (!r?.ok) throw new HttpError(409, `앱 '${appId}' 의 앱 폴더에 지금 파일이 있어 되돌리지 않았습니다 — 아무것도 바꾸지 않았습니다(새 앱의 파일을 덮지 않습니다)`);
    await deleteRows([name]);
    logger.info({ app: appId, name }, "[app-folder] 보관을 앱 폴더로 되돌림");
    return { app_id: appId, name };
  });
}

export interface OrphanArchiveOutcome {
  archived: AppFolderArchive[];
  skipped: Array<{ app_id: string; why: string }>;
}

/** 고아 앱 폴더(앱 행이 없는 것)를 보관으로 옮긴다 — 앱마다 설치 락 안에서 «앱 없음» 을 다시 본 뒤. */
export async function archiveOrphanAppFolders(appIds: string[], by: string | null = null): Promise<OrphanArchiveOutcome> {
  const out: OrphanArchiveOutcome = { archived: [], skipped: [] };
  for (const id of [...new Set(appIds.map((x) => String(x ?? "").trim()).filter(Boolean))]) {
    if (!APP_ID_RE.test(id)) { out.skipped.push({ app_id: id, why: "앱 id 꼴이 아닙니다" }); continue; }
    await withAppInstallLock(id, async () => {
      if (await getApp(id)) { out.skipped.push({ app_id: id, why: "같은 id 의 앱이 있습니다 — 고아가 아니라 그 앱의 폴더입니다" }); return; }
      const r = await archiveAppFolder(id, { by, entry: "orphan" });
      if (r.archived) out.archived.push(r.archived);
      else out.skipped.push({ app_id: id, why: r.skipped ?? "앱 폴더가 없습니다" });
    });
  }
  return out;
}

// ── 정비 — 보관 기간이 지난 것 지우기 ──────────────────────────────────────────────────────────

export interface PruneFolderArchivesOutcome { pruned: string[]; kept: Array<{ name: string; why: string }>; due: number }

/**
 * 보관 기간이 지난 보관을 지운다 — 기록(표)만 먼저 본다. 지울 것이 없으면 파일을 만지지 않는다(매니지드에서 헬퍼를 깨우지 않는다).
 *  파일이 이미 없으면 기록만 걷는다. 못 지운 것은 기록을 남긴다(다음 정비가 다시 · 관리자 목록에 보인다).
 */
export async function pruneAppFolderArchives(now: Date = new Date(), keepDays: number = snapshotKeepDays()): Promise<PruneFolderArchivesOutcome> {
  const cutoff = new Date(now.getTime() - Math.floor(keepDays) * 24 * 60 * 60 * 1000);
  const due = (await itemsPool.query(`SELECT * FROM org_app_folder_archive WHERE archived_at < $1 ORDER BY archived_at`, [cutoff])).rows.map(rowOf);
  if (!due.length) return { pruned: [], kept: [], due: 0 };
  const area = appsAreaFor(null);
  if (!area) return { pruned: [], kept: due.map((r) => ({ name: r.name, why: "앱 폴더 자리가 없습니다" })), due: due.length };
  const r = await removeArchives(area, due.map((x) => x.name));
  const pruned = [...r.removed, ...r.absent];   // 파일이 이미 없던 것은 기록만 걷는다
  await deleteRows(pruned);
  if (pruned.length) logger.info({ pruned: pruned.length, keepDays }, "[app-folder] 보관 기간이 지난 앱 폴더 보관을 지움");
  for (const k of r.left) logger.warn({ name: k.name, err: k.error }, "[app-folder] 보관 기간이 지난 보관을 지우지 못했다 — 다음 정비가 다시");
  return { pruned, kept: r.left.map((k) => ({ name: k.name, why: k.error })), due: due.length };
}
