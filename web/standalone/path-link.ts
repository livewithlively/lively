// path-link.ts — 글 속 **파일 경로**와 **지식 이름 후보**를 찾는 순수 판정(#4562 · #5650).
//  터미널(standalone/terminal.ts)과 대화 화면(web/chat-view.ts)이 같은 규칙으로 링크를 긋는다(원준 2026-11-24 «회수·오류로 끝난 세션의
//   대화 화면에서도 경로를 누르면 열리게»).
//  ⚠ 정본은 여기(web/standalone/path-link.ts), web/lib/path-link.ts 는 **사본**이다 — 단독 터미널 번들과 SPA 는 서로를 import 할 수 없다
//   (tsconfig 가 갈린다 — ui-link.ts 와 같은 사본 규약). scripts/path-link-copies.test.mjs 가 두 사본이 글자까지 같은지 본다.

// (순수 — 테스트 대상) 글 속 **파일 경로** — AI 가 파일을 만들고 «여기 저장했어요» 하고 찍어 준 자리(#4562 원준님
//  «정리해서 경로 알려주잖아. 그거 클릭하면 링크 클릭하듯이 … 곁칸에서 자료랑 그거 보는 뷰어 바로»).
//  두 형태만 링크로 본다 — 눌렀을 때 **열 수 있는 것만** 밑줄을 긋는다(열리지 않는 밑줄은 고장으로 읽힌다):
//   ① 프로젝트 자료 — `project/<번호>/` 마디가 있는 경로. 절대(`/work/shared/project/12/a.md` · 노드 `/Users/…/project/12/a.md`)
//      · `~/…` · 공유 루트 기준(`project/12/a.md`). 셸이 같은 프로젝트면 곁칸 뷰어로 연다.
//   ② 세션 폴더 기준 상대 경로 — `docs/a.md` · `./a.md`. 셸이 세션 파일 API 로 연다(그 API 의 기준이 세션 폴더다).
//  경로는 **확장자로 끝나야** 한다(`.md` · `.hwp` …, 글자가 하나는 섞인 것) — 한국어 조사가 붙어도(`a.md에`) 확장자에서 끊고,
//   `1/2.5` 같은 숫자는 안 잡는다.
//  ★ 이름에 **빈칸**이 든 경로(원준님 10-05 «파일 경로 클릭해도 안되는데?» — `데모데이 발표덱/원준수정/…_B.html` 이 빈칸 뒤
//   `발표덱/…` 만 링크가 되어 «파일을 읽지 못했어요»). 이 조직의 폴더 이름엔 빈칸이 흔하다. 두 갈래로 잇는다:
//   · 절대·프로젝트 경로(`/…` · `~/…` · `./…` · `project/<번호>/…`)는 시작이 분명하다 — 빈칸 **한 칸**을 건너 뒤 낱말을 붙여 가다가
//     처음으로 확장자에서 끝나는 자리에서 멈춘다(최대 5낱말). 밑줄도 경로 전체에 그어진다.
//   · 상대 경로는 시작을 글만으로 모른다(`파일은 docs/a.md` 와 `데모데이 발표덱/a.md` 가 같은 꼴) — 앞 낱말을 붙인 후보(alts,
//     긴 것 먼저)를 함께 실어 보내고, **셸이 실제로 있는 것**을 고른다(셸 pathExists).
//  절대 경로인데 `project/<번호>/` 가 없으면 잡지 않는다 — 게이트웨이가 그 자리를 열 길이 없다.
//  url 은 **화면에 찍힌 경로 그대로**다(넓은 글자 자리표만 뺀다) — [링크 복사]가 그 경로를 복사하고, 여는 쪽이 판정한다.
export function pathMatches(text: string): { start: number; end: number; url: string; alts?: string[] }[] {
  //  덩어리는 **끊기지 않는 글자 줄 전체**다. 괄호는 경로 글자로 치지 않는다 — Claude Code 의 도구 머리 `Write(/…/a.md)` 에서
  //   `Write(` 를 경로에 붙이지 않게(그래서 `a(1).md` 같은 이름은 괄호에서 끊긴다).
  const re = /[^\s"'`<>|()[\]{}\u3000\u0001]+/g;
  const toks: { s: string; at: number }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) toks.push({ s: m[0], at: m.index });
  //  경로 속 빈칸은 **한 칸**이다 — 두 칸·탭·줄바꿈을 건너 잇지 않는다.
  const oneSpace = (a: { s: string; at: number }, b: { at: number }): boolean => text[a.at + a.s.length] === ' ' && b.at === a.at + a.s.length + 1;
  //  확장자 뒤에서 끊는다 — 가장 뒤의 «.확장자»(글자로 시작) 중 뒤에 영숫자가 안 붙는 것(`a.md)` · `a.md에` · `a.md**` → `a.md`).
  //   그 자리까지가 열 수 있는 경로면 화면 글(넓은 글자 자리표 포함)을 돌려준다.
  const fileAt = (chunk: string): string | null => {
    const cut = /^(.*\.[A-Za-z][A-Za-z0-9]{0,9})(?![A-Za-z0-9_])/.exec(chunk);
    return cut && pathLinkTarget(cut[1].replace(/\u0000/g, '')) ? cut[1] : null;
  };
  const clean = (raw: string): string => raw.replace(/\u0000/g, '');
  const out: { start: number; end: number; url: string; alts?: string[] }[] = [];
  for (let i = 0; i < toks.length; i++) {
    let chunk = toks[i].s, at = toks[i].at;
    //  URL 이 든 덩어리는 URL 의 몫이다 — `url=https://…/a.html` · `→https://…` 처럼 앞에 글자가 붙어도(리뷰 지적: 종전엔 경로가
    //   먼저 시작해 URL 을 밀어냈다).
    if (chunk.includes('://')) continue;
    //  `src/a.ts:12:5` 의 줄·칸 꼬리는 먼저 뗀다 — 코드를 짚는 가장 흔한 꼴이고, 안 떼면 아래 `:` 가르기가 `5` 만 남긴다(리뷰 지적).
    chunk = chunk.replace(/(?::\d+){1,2}:?$/, '');
    //  `path=/…` · `저장:/…` · `--out=docs/a.md` — 마지막 `=`·`:` 뒤가 경로다.
    //   ★ 윈도우 드라이브(`C:\…` · `C:/…`)의 `:` 는 이름표가 아니다(#5650 실측: `C:\Users\…\project\12\a.md` 가 `C` 를 잃고 세션 경로로 읽혔다).
    const eq = lastLabelColon(chunk);
    if (eq >= 0) { at += eq + 1; chunk = chunk.slice(eq + 1); }
    //  꾸밈 글자(`**/…**` · `→/…` · `- `)를 앞에서 뗀다. 셸 변수(`$HOME/…`)는 열 자리를 모르니 버린다.
    const lead = /^[^A-Za-z0-9_~./\u3131-\u318E\uAC00-\uD7A3\u4E00-\u9FFF]*/.exec(chunk)![0];
    if (lead.includes('$')) continue;
    at += lead.length; chunk = chunk.slice(lead.length);
    const trimmed = at !== toks[i].at;
    const one = fileAt(chunk);
    if (one) {
      const p = clean(one);
      //  상대 경로면 앞 낱말을 붙인 후보 — 앞에서 아무것도 안 뗀 덩어리일 때만(`path=docs/a.md` 의 앞은 이름표다).
      const alts: string[] = [];
      if (!trimmed && pathLinkTarget(p)?.kind === 'session') {
        let lead2 = '';
        for (let k = i - 1; k >= 0 && k >= i - 3; k--) {
          const w = toks[k].s;
          if (!oneSpace(toks[k], toks[k + 1]) || w.includes('/') || /[:=]$/.test(w) || !/[A-Za-z0-9\u3131-\u318E\uAC00-\uD7A3]/.test(w)) break;   // 목록 표지(`-`·`•`·`├──`)는 이름이 아니다
          lead2 = clean(w) + ' ' + lead2;
          const cand = lead2 + p;
          if (pathLinkTarget(cand)) alts.unshift(cand);
        }
      }
      out.push(alts.length ? { start: at, end: at + one.length, url: p, alts } : { start: at, end: at + one.length, url: p });
      continue;
    }
    //  시작이 분명한 경로만 빈칸 너머로 잇는다.
    if (!/^(?:\/|~\/|\.\/|project\/\d+\/|[A-Za-z]:[\\/])/.test(chunk) || /[.,!?;:]$/.test(chunk)) continue;   // 문장부호로 끝난 경로는 거기서 끝났다
    //  산문을 경로로 삼키지 않게(리뷰 지적: `/…/out then open a.md` 가 한 링크가 됐다) — 이은 끝 낱말에 `/` 가 있거나(빈칸 든
    //   폴더: `데모데이 발표덱/원준수정/x.html`), 딱 두 낱말일 때(빈칸 하나 든 파일 이름: `사업 계획서.hwp`)만 잇는다. 문장부호로
    //   끝난 낱말·새 경로의 시작(`project/<번호>/` · `./` · `~/` · `/`)에서 멈춘다.
    //   #5650 빈칸 든 폴더 **뒤의** 빈칸 하나 든 파일 이름(`데모 데이/발표 자료.html`)도 — 마지막 `/` 뒤 파일 이름에 빈칸이 하나일 때.
    let joined = chunk;
    let slashAt = -1;                                 // `/` 가 든 마지막 이은 낱말
    for (let j = i + 1; j < toks.length && j <= i + 5; j++) {
      const w = toks[j].s;
      if (!oneSpace(toks[j - 1], toks[j]) || w.includes('://') || /^(?:\/|~\/|\.\/|project\/\d+\/|[A-Za-z]:[\\/])/.test(w)) break;
      joined += ' ' + w;
      const hit = fileAt(joined);
      if (hit) {
        if (j === i + 1 || w.includes('/') || (slashAt > 0 && j === slashAt + 1)) { out.push({ start: at, end: at + hit.length, url: clean(hit) }); i = j; }
        break;
      }
      if (w.includes('/')) slashAt = j;
      if (/[.,!?;:]$/.test(w)) break;
    }
  }
  return out;
}

// (순수 — 테스트 대상) 경로 → 어디서 열까. 프로젝트 자료면 그 번호와 프로젝트 폴더 기준 경로, 세션 폴더 기준이면 그 경로. 못 열면 null.
//  ⚠ 상대 경로의 `src/project/12/x.ts` 는 프로젝트 12 가 아니다(레포 안의 폴더 이름) — 상대 경로는 **맨 앞**이 `project/<번호>/` 일 때만.
export function pathLinkTarget(p: string): { kind: 'project'; id: number; rel: string } | { kind: 'session'; rel: string } | null {
  const s = String(p || '').replace(/\\/g, '/');
  //  윈도우 드라이브(`C:/…`)는 절대 경로다(#5650 — 윈도우 노드의 세션은 `C:\Users\…\project\12\…` 로 찍는다).
  const drive = /^[A-Za-z]:\//.test(s);
  if (!s || (!drive && /^[a-z][a-z0-9+.-]*:/i.test(s))) return null;   // 스킴이 붙은 것(URL)은 경로 링크가 아니다
  if (!/\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(s)) return null;  // 파일만 — 확장자(글자로 시작)로 끝나야 한다
  const abs = drive || s.startsWith('/') || s.startsWith('~/');
  const m = abs ? /^.*?\/project\/(\d+)\/(.+)$/.exec(s) : /^(?:\.\/)?project\/(\d+)\/(.+)$/.exec(s);
  const safe = (r: string): boolean => !!r && !r.split('/').some((x) => x === '' || x === '..' || x === '.');
  if (m) {
    const id = Number(m[1]);
    return id > 0 && safe(m[2]) ? { kind: 'project', id, rel: m[2] } : null;
  }
  if (abs) return null;
  const rel = s.replace(/^\.\//, '');
  //  `./` 없는 상대 경로는 `/` 가 하나는 있어야 한다 — 글 속 `package.json` 같은 낱말마다 밑줄이 그어지지 않게.
  if (!s.startsWith('./') && !rel.includes('/')) return null;
  //  상대 경로는 열어 보기 전엔 있는지 모르는 짐작이다 — 확장자를 더 좁힌다(소문자 2자 이상): `yes/no.Then` · `e.g./i.e.` ·
  //   `TCP/IP.Next` 를 링크로 읽지 않게. 프로젝트 경로는 `project/<번호>/` 가 이미 증거라 대문자 확장자(.HWP)도 받는다.
  if (!/\.[a-z][a-z0-9]{1,9}$/.test(rel)) return null;
  return safe(rel) ? { kind: 'session', rel } : null;
}

// 경로 링크인가 — URL 은 늘 스킴이 붙어 온다(urlMatches 가 https:// 를 붙인다). 스킴 없는 것은 pathMatches 가 낸 경로다.
export function isPathLink(link: string): boolean {
  return !!link && (isDrivePath(link) || !/^[a-z][a-z0-9+.-]*:/i.test(link));
}
/** 윈도우 드라이브 경로(`C:\…` · `C:/…`)인가 — 한 글자 스킴처럼 생겼지만 경로다. */
export function isDrivePath(s: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(String(s || ''));
}
/** 덩어리에서 이름표 뒤를 가르는 마지막 `=`·`:` 자리(없으면 -1). 드라이브 글자 뒤의 `:`(`C:\` · `C:/`)는 건너뛴다. */
function lastLabelColon(chunk: string): number {
  for (let k = chunk.length - 1; k >= 0; k--) {
    const c = chunk[k];
    if (c !== '=' && c !== ':') continue;
    if (c === ':' && /[\\/]/.test(chunk[k + 1] || '') && /[A-Za-z]/.test(chunk[k - 1] || '') && (k === 1 || /[=:]/.test(chunk[k - 2] || ''))) continue;
    return k;
  }
  return -1;
}


export const KN_CH = 'a-z0-9\\u0000\\u3131-\\u318E\\uAC00-\\uD7A3';   // \0 = 넓은 글자(한글)의 뒤 칸 자리표(칸 정렬 글)
export function knowledgeCandidates(text: string): { start: number; names: { name: string; end: number }[] }[] {
  //  첫 글자는 자리표(\0)가 아니다 — 이모지(넓은 글자) 바로 뒤의 이름이 그 뒤 칸부터 밑줄을 긋지 않게(리뷰 지적).
  const re = new RegExp(`(?<![A-Za-z0-9_/.\\-\\u3131-\\u318E\\uAC00-\\uD7A3])[a-z0-9\\u3131-\\u318E\\uAC00-\\uD7A3][${KN_CH}]*(?:-[${KN_CH}]+){2,}(?![A-Za-z0-9_/\\-]|\\.[A-Za-z0-9])`, 'g');
  const out: { start: number; names: { name: string; end: number }[] }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const raw = m[0], full = raw.replace(/\u0000/g, '');
    if (full.length < 8 || full.length > 64) continue;
    //  묻기 전에 거른다(묻는 값이 서버 왕복이다) — UUID · 날짜·번호 줄(`2026-10-05-00`)처럼 글자 든 마디가 둘 못 되는 것은 이름이 아니다.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(full)) continue;
    if (full.split('-').filter((x) => /[a-z\u3131-\u318E\uAC00-\uD7A3]/.test(x)).length < 2) continue;
    const names = [{ name: full, end: m.index + raw.length }];
    const tail = /[a-z0-9]((?:[\u3131-\u318E\uAC00-\uD7A3]\u0000?){1,3})$/.exec(raw);   // `…-4562에` → `…-4562`
    if (tail) {
      const rawBare = raw.slice(0, raw.length - tail[1].length), bare = rawBare.replace(/\u0000/g, '');
      if (bare.length >= 8) names.push({ name: bare, end: m.index + rawBare.length });
    }
    out.push({ start: m.index, names });
  }
  return out;
}
// (순수 — 테스트 대상) 확인된 지식 이름만 링크로. 조사를 뗀 꼴이 있는 것이면 밑줄도 그 꼴까지만.
export function knowledgeMatches(text: string, known: (name: string) => boolean): { start: number; end: number; url: string }[] {
  const out: { start: number; end: number; url: string }[] = [];
  for (const c of knowledgeCandidates(text)) {
    const n = c.names.find((x) => known(x.name));
    if (n) out.push({ start: c.start, end: n.end, url: n.name });
  }
  return out;
}
