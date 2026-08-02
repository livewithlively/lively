// 크로스멤버 결정적 신원 — git origin URL → 정규 키(#905 P1-③). DB·git·fs 무접촉(순수).
//
//  왜 필요한가: 프로젝트 마커(.lively/project.json)는 **설계상 절대 동기화되지 않는다**(공유 매니페스트가
//   '.' 시작 항목을 전량 제외 + pull 단방향 — project-manifest.ts). 그래서 A 가 자기 폴더를 프로젝트로 만들어도
//   B 의 클론엔 마커가 없다 → B 에게 마커 탐색은 **원리적으로 100% 미스**다. 마커 미스 시 '새로 만들기'로
//   폴백하면 **중복 생성이 기본 동작**이 된다(같은 프로젝트가 멤버 수만큼 생김).
//   → 멤버 간 동일한 유일 값 = **레포의 origin URL**. 그걸 프로토콜·자격·표기 차이를 넘어 같은 키로 만든다.
//
//  기존 헬퍼와의 관계(왜 새로 만드나):
//   · sanitizeCloneUrl(domainmap/core/url-util.ts) — 자격(userinfo)만 벗긴다. 스킴은 보존하므로
//     `git@github.com:o/r.git` 와 `https://github.com/o/r.git` 가 **다른 문자열**로 남는다 = 같은 레포인데 키가 갈린다.
//   · hostOf(org/credentials/git-credential-store.ts) — 호스트만 뽑는다(자격 매칭용). 경로가 없어 레포를 특정 못 한다.
//   ⇒ 둘 다 신원 키로는 부족하다. 이 모듈이 그 간극(스킴·포트·.git·대소문자·트레일링)을 메운다.

// origin URL 의 정규 신원 키 — `<host>/<path>`(스킴·자격·포트·.git·트레일링 슬래시 제거).
//  해석 불가면 null(fail-closed — 애매한 값으로 남의 프로젝트에 바인딩하지 않는다).
//
//  같은 키로 모이는 것(멤버마다 클론 방식이 달라도 같은 레포):
//    git@github.com:livewithlively/context-ontology.git
//    https://github.com/livewithlively/context-ontology.git
//    https://github.com/livewithlively/context-ontology
//    ssh://git@github.com/livewithlively/context-ontology.git
//    https://<token>@github.com/livewithlively/context-ontology.git
//      → 전부 "github.com/livewithlively/context-ontology"
//
//  정규화 규칙과 그 근거:
//   · **스킴 제거** — ssh/https 는 같은 레포에 접근하는 두 방법일 뿐 신원이 아니다(멤버마다 다른 게 정상).
//   · **자격(userinfo) 제거** — `git@`(ssh 로그인 유저)·PAT 토큰 모두 신원 아님. 키에 토큰이 섞이면 시크릿 유출.
//   · **포트 제거** — 같은 서비스의 ssh(22/2222)·https(443)가 갈리는 걸 막는다. 같은 host+path 인데 포트만
//     다른 '서로 다른 레포'는 현실에 사실상 없고, 있어도 포트를 남기면 정상 케이스가 전부 깨진다.
//   · **호스트 소문자화** — DNS 는 대소문자 무시(Github.com == github.com).
//   · **경로 대소문자 보존** — GitHub 은 무시하지만 Gitea/일부 셀프호스팅은 구분한다. 여기서 소문자화하면
//     서로 다른 레포가 **같은 키가 되어(false positive) 남의 프로젝트에 바인딩**될 수 있다. 반대 오류
//     (false negative = 키가 갈려 중복 후보)는 "애매하면 사람에게 묻기"(C2a)가 잡아준다. 되돌릴 수 없는
//     쪽(오바인딩)을 피하는 게 맞다 → 보존.
//   · **`.git` 접미사·트레일링 슬래시 제거** — 같은 레포의 표기 차이일 뿐.
export function originKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;

  let host: string | null = null;
  let pathPart = "";

  // scp-식 ssh: user@host:group/repo.git (스킴 없음 — URL 파서가 못 읽는다)
  const scp = s.match(/^[\w.-]+@([\w.-]+):(.+)$/);
  if (scp && !s.includes("://")) {
    host = scp[1];
    pathPart = scp[2];
  } else {
    let u: URL;
    try { u = new URL(s); } catch { return null; } // 해석 불가 → 신원 없음(잠재 시크릿 문자열일 수도)
    if (!u.hostname) return null;
    host = u.hostname;   // URL 파서가 userinfo·포트를 이미 분리해 준다
    pathPart = u.pathname;
  }

  host = host.toLowerCase().replace(/^\[|\]$/g, ""); // IPv6 리터럴 대괄호 제거(주소는 그대로)
  if (!host) return null;

  const cleanedPath = pathPart
    .replace(/^\/+/, "")            // 선행 슬래시(URL pathname)
    .replace(/\/+$/, "")            // 트레일링 슬래시
    .replace(/\.git$/i, "")         // .git 접미사
    .replace(/\/+$/, "");           // ".git/" 처럼 둘 다 붙은 경우
  if (!cleanedPath) return null;    // 호스트만으론 레포를 특정 못 한다

  return `${host}/${cleanedPath}`;
}

// 두 git URL 이 같은 레포를 가리키나 — 표기·프로토콜 차이 무시. 어느 한쪽이라도 해석 불가면 false
//  (모르면 '같다'고 하지 않는다 — 오바인딩 금지).
export function sameOrigin(a: unknown, b: unknown): boolean {
  const ka = originKey(a);
  const kb = originKey(b);
  return ka !== null && ka === kb;
}
