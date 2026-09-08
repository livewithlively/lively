// 파일 API 경로 봉쇄 — **심링크를 해소한 뒤** 접두를 본다(#3668 T1).
//
// 왜 필요한가: `path.resolve` 는 `..` 를 **글자로** 접을 뿐 심링크를 해석하지 않는다. 그래서 세션(테넌트 uid 로 도는
//  임의 코드)이 자기 폴더에 `ln -s <바깥> x` 를 만들어 두면 파일 API 의 `?path=x/...` 가 글자 판정을 통과한다 —
//  read 는 `cat`, ls 는 `statSync` 라 **둘 다 링크를 따라간다**(따라가는 것이 #1744 의 설계 의도다).
//  지금 그게 안 터지는 이유는 경로검사가 아니라 **감옥**(파일 op 컨테이너에 그 테넌트 마운트만 있다)이고,
//  #3668 T2·T3 가 그 감옥의 모양을 바꾼다. 감옥을 걷기 전에 앞단이 실제로 막고 있어야 한다.
//
// ★ 어디서 해소하나 — **op 가 실제로 도는 그 자리**다. 게이트웨이 프로세스에서 realpath 를 부르면 안 된다:
//  격리 배포에선 그 경로가 멤버 700 이라 못 읽고, 매니지드에선 게이트웨이 시야에 **아예 없다**(gVisor·마운트 0).
//  그래서 해소(probe)는 seam 으로 두고 — 멤버 경계면 PROBE_JS 한 줄이, 아니면 로컬 fs 가 — 판정(confined)은
//  한 함수가 한다. 두 벌이 되면 격리 조직에서만 옛 동작이 남는 신고가 된다(#1744 가 그 실측이다).
//
// ⚠ 한계(인정하고 설계한다): 해소와 op 사이에 심링크를 바꿀 수 있는 **TOCTOU 창**이 남는다 —
//  Node 에 `openat2(RESOLVE_BENEATH)` 바인딩이 없어 "열면서 봉쇄"가 불가능하다. 그래서 이 검사는 감옥을
//  **대체**하지 않고 **병행**한다. 감옥을 걷는 단계(#3668 T3)에서는 이 창을 줄일 다음 수(연 뒤 fstat 재확인)가 필요하다.
import path from "node:path";
import fsp from "node:fs/promises";

/** 해소 결과(사실만) — 판정은 confined 가 한다. 멤버 경계 한 줄(PROBE_JS)과 로컬 probe 가 같은 모양을 낸다. */
export interface PathProbe {
  /** realpath(base). 베이스가 아직 없으면 null(그 밑에 존재하는 것도 없다 → 글자 판정으로 충분). */
  base: string | null;
  /** 존재하는 **가장 깊은 조상**의 realpath. 해소 자체가 불가능했으면 null(→ 거부). */
  real: string | null;
  /** 그 조상 아래로 **아직 없는** 이름들(존재하지 않으므로 심링크일 수 없다). */
  rest: string[];
  /** 어느 칸이 "링크는 있는데 대상이 없다"(댕글링) — 없는 이름과 다른 상태다 → 거부. */
  dangling?: boolean;
  /** ENOENT 아닌 해소 실패(권한 등) → 거부(fail-closed). */
  error?: string;
}

/** 이름 한 칸인가 — 구분자·`.`·`..` 가 섞인 값은 붙이지 않는다(해소 결과를 그대로 신뢰하지 않는다). */
const plainName = (s: unknown): s is string =>
  typeof s === "string" && s !== "" && s !== "." && s !== ".." && !s.includes("/") && !s.includes("\\");

/**
 * (순수 — 테스트 seam) 해소 결과가 베이스 **안**인가.
 *  · 베이스 미존재(base:null) → 통과(밑에 아무것도 없다).
 *  · 댕글링·해소불가·해소실패 → 거부(fail-closed) — 통과시키면 검사 뒤 대상이 생겨 바깥을 가리키게 된다
 *    (`broker/exec.ts:22` 가 같은 문제를 같은 규율로 이미 풀었다: "존재+해석돼야 통과, 댕글링 거부").
 */
export function confined(probe: PathProbe | null | undefined): boolean {
  if (!probe || probe.error || probe.dangling) return false;
  if (probe.base === null) return true;
  if (probe.real === null) return false;
  const rest = Array.isArray(probe.rest) ? probe.rest : [];
  if (!rest.every(plainName)) return false;
  const resolved = rest.length ? path.resolve(probe.real, ...rest) : path.resolve(probe.real);
  const base = path.resolve(probe.base);
  return resolved === base || resolved.startsWith(base + path.sep);
}

/** 멤버 경계에서 도는 한 줄(argv[1]=base, argv[2]=target → PathProbe JSON). 로컬 probeLocal 과 **같은 사양**이다. */
export const PROBE_JS =
  "const fs=require('fs'),path=require('path'),b=path.resolve(process.argv[1]),t=path.resolve(process.argv[2]);" +
  "let rb=null;try{rb=fs.realpathSync(b)}catch{}" +
  "let out=rb===null?{base:null,real:null,rest:[]}:null;" +
  "if(!out){let cur=t;const rest=[];let n=0;" +
  "while(cur!==b){if(++n>4096){out={base:rb,real:null,rest:[],error:'DEPTH'};break}" +
  "try{out={base:rb,real:fs.realpathSync(cur),rest:rest};break}catch(e){" +
  "if(e.code!=='ENOENT'){out={base:rb,real:null,rest:[],error:String(e.code||'ERR')};break}" +
  "let l=false;try{fs.lstatSync(cur);l=true}catch{}" +
  "if(l){out={base:rb,real:null,rest:[],dangling:true};break}" +
  "const up=path.dirname(cur);if(up===cur){out={base:rb,real:null,rest:[],error:'ROOT'};break}" +
  "rest.unshift(path.basename(cur));cur=up}}" +
  "if(!out)out={base:rb,real:rb,rest:rest}}" +
  "process.stdout.write(JSON.stringify(out))";

/**
 * 로컬 fs 해소(게이트웨이가 그 파일을 직접 보는 배포 · 노드 세션). PROBE_JS 와 **같은 사양**이어야 한다 —
 * 두 구현을 같은 엣지 표로 함께 재는 시험이 `path-jail.test.ts` 에 있다.
 * ⚠ 위로 올라가는 걸음은 **base 에서 멈춘다** — 넘어서면 "가장 깊은 조상"이 베이스 밖이 되어 판정이 뒤집힌다.
 */
export async function probeLocal(base: string, target: string): Promise<PathProbe> {
  const b = path.resolve(base);
  const t = path.resolve(target);
  let rb: string | null = null;
  try { rb = await fsp.realpath(b); } catch { /* 베이스 미존재 */ }
  if (rb === null) return { base: null, real: null, rest: [] };
  let cur = t;
  const rest: string[] = [];
  for (let n = 0; cur !== b; n++) {
    if (n > 4096) return { base: rb, real: null, rest: [], error: "DEPTH" };
    try { return { base: rb, real: await fsp.realpath(cur), rest }; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") return { base: rb, real: null, rest: [], error: String(code || "ERR") };
      let link = false;
      try { await fsp.lstat(cur); link = true; } catch { /* 이름 자체가 없다 */ }
      if (link) return { base: rb, real: null, rest: [], dangling: true };
      const up = path.dirname(cur);
      if (up === cur) return { base: rb, real: null, rest: [], error: "ROOT" };
      rest.unshift(path.basename(cur));
      cur = up;
    }
  }
  return { base: rb, real: rb, rest };
}

/**
 * 베이스 안인가 — 해소는 넘겨받은 probe 가(=op 가 도는 자리에서) 한다.
 * ⚠ 대상이 **곧 베이스**면 해소할 것이 없다 → probe 를 부르지 않는다(첫 화면 목록에 왕복을 더하지 않는다).
 *   글자 판정(`..` 탈출 거부)은 호출부가 이미 끝냈다는 전제다 — 이 검사는 그 **뒤에** 서는 2차 관문이다.
 */
export async function isConfined(
  base: string, abs: string, probe: (base: string, target: string) => Promise<PathProbe>,
): Promise<boolean> {
  if (path.resolve(abs) === path.resolve(base)) return true;
  return confined(await probe(base, abs));
}
