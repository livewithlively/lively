// 같은 이름 후보(#4672) — 링크가 가리키는 자리에 아무것도 없을 때(셸 `mv` 로 옮겨 «옛 경로 → 새 경로» 기록이 없는 경우) 그 근처에서
//  이름이 꼭 같은 파일·폴더를 찾는다. 자료 보기 화면(web/filepage)이 «옮겨졌거나 지워졌을 수 있어요» 아래에 후보로 보여 준다 —
//  넘기지는 않는다(짐작이라서). 기록이 있는 옮기기는 «옛 링크 풀기»(#4688 browse/moved)가 먼저 답한다.
//
//  판정은 부르는 쪽(terminal/terminal-files browse/similar)이 진다 — 받은 링크의 경로부터 공개범위를 지나야 하고, 후보도 하나하나
//   같은 판정기를 지난다. 여기는 «어디서 · 무엇을 · 얼마나» 찾는지만 정한다.
//  찾는 일은 두 벌이다 — 격리 멤버면 그 uid 로 한 번 왕복(SAME_NAME_JS · 매니지드는 파일 작업 헬퍼 왕복 한 번), 아니면 게이트웨이 로컬 fs
//   (findSameNameLocal). 둘은 같은 사양이다(시험이 같은 폴더에 둘을 돌려 맞춘다 — project-storage 의 PROJECT_SEARCH_JS ↔ localSearch 와 같은 짝).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/** 훑는 상한 — 디렉터리 항목 수 · 깊이 · 후보 수. 넘으면 거기서 멈추고 truncated 를 세운다(링크 하나 여는 데 폴더 전체를 걷지 않는다). */
export const SAME_NAME_LIMITS = { maxSeen: 5000, maxDepth: 8, maxHits: 20 } as const;
/** 화면에 세우는 후보 수 */
export const SAME_NAME_SHOW = 8;

export interface SameNameHit { path: string; type: "file" | "dir"; size: number; mtime: number }
export interface SameNameFound { hits: SameNameHit[]; truncated: boolean }
export interface SameNameLimits { maxSeen: number; maxDepth: number; maxHits: number }

/**
 * 후보를 찾을 범위(그 자리 기준 상대경로) — 받은 링크의 경로가 든 «덩어리» 하나. 순수.
 *  · 앱 폴더(apps)      — 그 앱 폴더(`<앱>`). 다른 앱 폴더로는 넘어가지 않는다.
 *  · 프로젝트 폴더 안   — 그 프로젝트 폴더(`project/<id>` · `legacy-project/<id>`). 세션 셸은 작업 폴더 하나만 붙여 그 안에서만 옮긴다.
 *  · 그 밖              — 맨 위 폴더(첫 마디). 자리 맨 위에 있던 것이면 자리 전체("") — 상한(SAME_NAME_LIMITS)이 걷는 양을 묶는다.
 */
export function sameNameScope(root: string, rel: string): string {
  const segs = String(rel ?? "").split("/").filter(Boolean);
  if (root === "apps") return segs[0] ?? "";
  if (root === "shared" && (segs[0] === "project" || segs[0] === "legacy-project") && segs.length >= 3) return segs.slice(0, 2).join("/");
  return segs.length >= 2 ? segs[0]! : "";
}

/**
 * 후보 줄 세우기 — 받은 링크의 경로와 앞 폴더가 많이 겹치는 것(가까운 자리) 먼저, 같으면 최근에 고친 것, 그다음 경로 글자순. 순수.
 *  missingRel 과 hits 의 path 는 같은 자리 기준이어야 한다.
 */
export function rankSameName(hits: readonly SameNameHit[], missingRel: string, limit: number = SAME_NAME_SHOW): SameNameHit[] {
  const want = String(missingRel ?? "").split("/").filter(Boolean).slice(0, -1);
  const near = (p: string): number => {
    const segs = p.split("/").filter(Boolean).slice(0, -1);
    let i = 0;
    while (i < segs.length && i < want.length && segs[i] === want[i]) i++;
    return i;
  };
  return [...hits].sort((a, b) => near(b.path) - near(a.path) || b.mtime - a.mtime || a.path.localeCompare(b.path)).slice(0, limit);
}

/**
 * 격리 멤버 uid 로 도는 한 줄(고정 리터럴 — 값은 전부 stdin JSON: memberNodeJson 계약). findSameNameLocal 과 같은 사양:
 *  넓이 우선 · 이름 비교는 NFC 로 맞춰 · 점으로 시작하는 이름 · 링크 · node_modules · git 저장소(.git 을 가진 폴더) 안으로는 안 들어간다.
 */
export const SAME_NAME_JS =
  "const fs=require('fs'),p=require('path');let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>d+=c);" +
  "process.stdin.on('end',()=>{const q=JSON.parse(d||'null');const t=String(q.name).normalize('NFC');const hits=[];let seen=0,trunc=false;" +
  "const Q=[{dir:q.base,rel:'',depth:0}];outer:while(Q.length){const cur=Q.shift();let es;try{es=fs.readdirSync(cur.dir,{withFileTypes:true})}catch(e){continue}" +
  "for(const e of es){if(seen>=q.maxSeen){trunc=true;break outer}seen++;if(e.name.startsWith('.')||e.isSymbolicLink())continue;" +
  "const isDir=e.isDirectory();if(!isDir&&!e.isFile())continue;const r=cur.rel?cur.rel+'/'+e.name:e.name;const full=p.join(cur.dir,e.name);" +
  "if(e.name.normalize('NFC')===t){let s=0,m=0;try{const st=fs.statSync(full);m=Math.floor(st.mtimeMs);if(!isDir)s=st.size}catch(x){}" +
  "hits.push({path:r,type:isDir?'dir':'file',size:s,mtime:m});if(hits.length>=q.maxHits){trunc=true;break outer}}" +
  "if(isDir&&cur.depth+1<=q.maxDepth&&e.name!=='node_modules'&&!fs.existsSync(p.join(full,'.git')))Q.push({dir:full,rel:r,depth:cur.depth+1})}}" +
  "process.stdout.write(JSON.stringify({hits,truncated:trunc}))});";

/** SAME_NAME_JS 와 같은 사양의 게이트웨이 로컬 판(격리 멤버가 없는 배포 · 시험). */
export async function findSameNameLocal(base: string, name: string, lim: SameNameLimits = SAME_NAME_LIMITS): Promise<SameNameFound> {
  const target = String(name).normalize("NFC");
  const hits: SameNameHit[] = [];
  let seen = 0;
  const queue: Array<{ dir: string; rel: string; depth: number }> = [{ dir: base, rel: "", depth: 0 }];
  while (queue.length) {
    const cur = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(cur.dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (seen >= lim.maxSeen) return { hits, truncated: true };
      seen++;
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const isDir = e.isDirectory();
      if (!isDir && !e.isFile()) continue;
      const rel = cur.rel ? `${cur.rel}/${e.name}` : e.name;
      const full = path.join(cur.dir, e.name);
      if (e.name.normalize("NFC") === target) {
        let size = 0, mtime = 0;
        try { const st = await fsp.stat(full); mtime = Math.floor(st.mtimeMs); if (!isDir) size = st.size; } catch { /* 아는 만큼만 */ }
        hits.push({ path: rel, type: isDir ? "dir" : "file", size, mtime });
        if (hits.length >= lim.maxHits) return { hits, truncated: true };
      }
      if (isDir && cur.depth + 1 <= lim.maxDepth && e.name !== "node_modules" && !fs.existsSync(path.join(full, ".git"))) {
        queue.push({ dir: full, rel, depth: cur.depth + 1 });
      }
    }
  }
  return { hits, truncated: false };
}
