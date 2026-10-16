// 앱 폴더 보관(#4778)의 파일 쪽 — 보관 이름 · 고정 스크립트 하나 · apps 자리 고르기 · 보관 지우기.
//  기록(org_app_folder_archive) · 목록 · 관리자 도구 · 정비는 app-folder-archive.ts(이 모듈은 DB 를 모른다).
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
// ── 시간 ──────────────────────────────────────────────────────────────────────────────────
//  op 하나에 상한(OP_TIMEOUT_MS)을 둔다 — 부르는 쪽 일부가 앱 설치 락(풀 연결 하나)을 쥔 채 기다리므로, 헬퍼가 멎어도 락을 놓게.
//  재기 · 지우기는 스크립트 안에서도 예산(항목 수 · 시간)을 지킨다 — 큰 보관은 정비가 여러 번에 나눠 지운다(남은 것은 기록이 남아 다음에 이어 간다).
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "../log.js";
import { APP_ID_RE } from "./manifest.js";
import { roots, APPS_ROOT_KEY } from "../terminal/catalog.js";
import { memberNodeJson } from "../terminal/terminal-member-fs.js";
import { memberExecConfigured, isolationInfraReady, osUsername, memberSlug, OS_USER_PREFIX } from "../terminal/terminal-isolation.js";

const execFileAsync = promisify(execFile);

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
//  ⚠ 링크를 따라가지 않는다 — 재기 · 지우기 · 주인 훑기 모두 lstat(링크는 링크 자체를 지운다), 이름 바꾸기는 링크를 그대로 옮긴다.
//  재기는 예산(항목 수 · 시간 — 한 번 부를 때 전체)에 닿으면 truncated 와 그때까지 센 값을 준다. 지우기는 시간 예산(rm_ms)에 닿으면
//   멈추고 «다음에 이어서» 로 남긴다(지운 만큼은 지워졌다).
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
    const until=Date.now()+(Number(q.rm_ms)>0?Number(q.rm_ms):20000);
    const rmTree=f=>{const st=fs.lstatSync(f);
      if(st.isDirectory()){for(const n of fs.readdirSync(f)){if(Date.now()>until)return false;if(!rmTree(p.join(f,n)))return false}fs.rmdirSync(f);return true}
      fs.unlinkSync(f);return true};
    for(const n of names){const f=at(n,ARC);if(!lst(f)){absent.push(n);continue}
      let err=null,done=false;
      try{done=rmTree(f)}catch(e){err=String(e&&e.message||e)}
      if(!lst(f)){removed.push(n);continue}
      if(!err&&!done){left.push({name:n,error:'시간이 모자라 다 지우지 못했습니다 — 다음에 이어서 지웁니다',owners:[]});continue}
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

/** 재기 예산 — 한 번 부를 때 전체(항목 수 · 시간). 넘으면 truncated(그때까지 센 값). */
export const MEASURE_CAP = { cap_n: 50_000, cap_ms: 5_000 };
/** 지우기 시간 예산 — 넘으면 멈추고 «다음에 이어서»(정비가 다음 판에 · 관리자는 다시 비우기로). */
export const REMOVE_BUDGET_MS = 20_000;
/** op 하나의 상한 — 헬퍼가 멎어도 부르는 쪽이 락 · 풀 연결을 놓게(지우기 예산 · 헬퍼 첫 기동보다 넉넉하게). */
export const OP_TIMEOUT_MS = 60_000;

type Run = <T>(input: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

/** apps 자리 하나 — 어디(base)를 누가(run) 만지나. run 은 질의에 base 를 붙여 보낸다(질의가 base 를 주면 그 값 — 시험이 스크립트의 검사를 본다). */
export interface AppsArea {
  /** apps 자리의 절대경로 — op 가 도는 자리 기준(매니지드 = 감옥 안 `/lvly/tenants/<slug>/apps`). */
  base: string;
  /** 고정 스크립트를 이 자리의 주체로 돌린다(상한 OP_TIMEOUT_MS — 넘으면 던진다). */
  run: Run;
  /** 셀프호스트 격리만 — 게이트웨이가 못 지운 것을 그 폴더 주인 계정으로 다시 지운다(그 밖은 null). */
  runAs: ((osUser: string) => Run) | null;
}

const timeoutError = (ms: number): Error => new Error(`앱 폴더 작업이 ${Math.round(ms / 1000)}초 안에 끝나지 않았습니다 — 잠시 뒤 다시 해 주세요`);

/** 상한을 건 기다림 — 끝나지 않으면 던진다(뒤에서 마저 끝날 수는 있다 — 그 결과는 목록이 파일에서 다시 본다). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeoutError(ms)), ms); timer.unref?.(); });
  return Promise.race([p, limit]).finally(() => { if (timer) clearTimeout(timer); });
}

/** 이 프로세스에서 고정 스크립트를 돌린다(셀프호스트 — 게이트웨이가 apps 자리를 직접 본다). 상한을 넘으면 자식을 죽이고 던진다. */
function localNodeJson<T>(js: string, input: unknown, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ["-e", js], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; c.kill("SIGKILL"); }, timeoutMs);
    timer.unref?.();
    c.stdout.on("data", (b: Buffer) => out.push(b));
    c.stderr.on("data", (b: Buffer) => err.push(b));
    c.on("error", (e) => { clearTimeout(timer); reject(e); });
    c.stdin.on("error", reject);
    c.stdin.end(JSON.stringify(input));
    c.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(timeoutError(timeoutMs));
      if (code !== 0) return reject(new Error(Buffer.concat(err).toString("utf8").trim() || `앱 폴더 op 종료 ${code}`));
      try { resolve(JSON.parse(Buffer.concat(out).toString("utf8") || "null") as T); } catch (e) { reject(e as Error); }
    });
  });
}

/**
 * 이 배포에서 apps 자리를 누가 만지나.
 *  · detached — 저장소가 분리된 배포(매니지드 · memberExecConfigured): 파일 작업 헬퍼(중계).
 *  · isolated — 셀프호스트 격리 박스(isolationInfraReady): 게이트웨이 로컬 + 남은 것은 주인 계정(box-spawn).
 *  · plain — 그 밖: 게이트웨이 로컬.
 */
export type AppsAreaMode = "detached" | "isolated" | "plain";
export function appsAreaMode(): AppsAreaMode {
  return memberExecConfigured() ? "detached" : isolationInfraReady() ? "isolated" : "plain";
}

/**
 * 이 요청(또는 정비 순회)의 apps 자리 — 서명 주소 · 탐색기와 같은 자리를 본다(catalog roots 의 apps).
 *  · detached: 감옥 안 경로(isolatedBase) · osUser 는 중계가 쓰지 않지만 인자 꼴은 지킨다(시킨 사람 · 없으면 system).
 *  · isolated: 구성원 격리 기준(isolatedBase = LIVELY_APPS_DIR) · 게이트웨이 로컬 + 주인 계정으로 다시 지우기.
 *  · plain: TERMINAL_ROOT_APPS(기본 ~/apps) · 게이트웨이 로컬.
 *  ⚠ 셀프호스트 격리 박스에서 OS 계정이 없는 구성원의 파일 op 는 TERMINAL_ROOT_APPS 를 본다(profiles.resolveRootPath) — 설치 스크립트가
 *   두 값을 같은 자리로 맞춘다(deploy/lib/common.sh). 다르게 둔 배포에선 이 모듈은 격리 기준 자리만 본다.
 */
export function appsAreaFor(by: string | null, mode: AppsAreaMode = appsAreaMode()): AppsArea | null {
  const root = roots().find((r) => r.key === APPS_ROOT_KEY);
  if (!root) return null;
  if (mode === "detached") {
    const base = path.resolve(root.isolatedBase ?? root.base);
    const osUser = osUsername(memberSlug(by || "system"));
    return {
      base,
      run: (q, ms = OP_TIMEOUT_MS) => withTimeout(memberNodeJson(osUser, APP_FOLDER_OPS_JS, { base, ...q }), ms),
      runAs: null,
    };
  }
  const base = path.resolve(mode === "isolated" ? (root.isolatedBase ?? root.base) : root.base);
  return {
    base,
    run: (q, ms = OP_TIMEOUT_MS) => localNodeJson(APP_FOLDER_OPS_JS, { base, ...q }, ms),
    runAs: mode === "isolated" ? (osUser) => (q, ms = OP_TIMEOUT_MS) => withTimeout(memberNodeJson(osUser, APP_FOLDER_OPS_JS, { base, ...q }), ms) : null,
  };
}

// ── 지우기(셀프호스트 격리는 주인 계정으로 다시) ────────────────────────────────────────────────

/** removed = 있던 것을 지웠다 · absent = 처음부터 없었다 · left = 못 지웠다(owners = 남은 폴더들의 주인 uid — 셀프호스트 격리용). */
export interface RemoveResult { removed: string[]; absent: string[]; left: Array<{ name: string; error: string; owners?: number[] }> }

/** uid → `getent passwd <uid>` 의 한 줄(없거나 못 물으면 ""). 시험이 갈아 끼운다. */
export type PasswdLookup = (uid: number) => Promise<string>;
const getentPasswd: PasswdLookup = (uid) => execFileAsync("getent", ["passwd", String(uid)]).then((r) => String(r.stdout)).catch(() => "");

/** uid → 구성원 OS 계정 이름(box-spawn 은 구성원 계정에만 허락된다 — 접두가 아니면 뺀다 · root(0)는 묻지도 않는다). */
export async function memberOsUsersOf(uids: number[], lookup: PasswdLookup = getentPasswd): Promise<string[]> {
  const names: string[] = [];
  for (const uid of [...new Set(uids)].filter((u) => Number.isInteger(u) && u > 0)) {
    const line = (await lookup(uid)).split("\n")[0] ?? "";
    const [name, , u] = line.split(":");
    if (name && name.startsWith(OS_USER_PREFIX) && Number(u) === uid && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * 보관을 지운다. 셀프호스트 격리면 남은 것을 그 폴더 주인 계정으로 지우고 다시 게이트웨이로(빈 폴더 · 맨 위 이름) — 최대 세 바퀴.
 *  끝까지 남은 것은 까닭과 함께 돌려준다(기록은 부르는 쪽이 남긴다 — 목록에 계속 보이고 다음 정비가 다시 본다). 이름이 없으면 아무것도 안 부른다.
 */
export async function removeArchives(area: AppsArea, names: string[], osUsersOf: (uids: number[]) => Promise<string[]> = memberOsUsersOf): Promise<RemoveResult> {
  const out: RemoveResult = { removed: [], absent: [], left: [] };
  if (!names.length) return out;
  const q = { op: "remove", names, rm_ms: REMOVE_BUDGET_MS, ...MEASURE_CAP };
  const first = await area.run<RemoveResult>(q);
  out.removed.push(...first.removed);
  out.absent.push(...(first.absent ?? []));
  let left = first.left;
  for (let round = 0; left.length && area.runAs && round < 3; round++) {
    const users = await osUsersOf(left.flatMap((x) => x.owners ?? []));
    if (!users.length) break;
    const leftNames = left.map((x) => x.name);
    for (const u of users) {
      //  주인 계정은 제 폴더 안을 비운다(남의 하위 폴더는 못 비운다 — 그 주인이 다음 차례에). 맨 위 이름도 지울 수 있으면 지운다.
      await area.runAs(u)<RemoveResult>({ ...q, names: leftNames })
        .then((x) => { out.removed.push(...x.removed); })
        .catch((err) => logger.warn({ err, osUser: u }, "[app-folder] 주인 계정으로 보관 지우기 실패"));
    }
    const still = leftNames.filter((n) => !out.removed.includes(n));
    if (!still.length) { left = []; break; }
    //  다시 게이트웨이로 — 비워진 폴더 · 맨 위 이름. 그새 주인 계정이 통째로 지운 것은 absent 로 오지만 처음엔 있던 것이다(removed).
    const again = await area.run<RemoveResult>({ ...q, names: still });
    out.removed.push(...again.removed, ...(again.absent ?? []));
    left = again.left;
  }
  out.removed = [...new Set(out.removed)];
  out.left = left.filter((x) => !out.removed.includes(x.name)).map(({ name, error }) => ({ name, error }));
  return out;
}
