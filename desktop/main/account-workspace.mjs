// 계정 서버가 확인한 워크스페이스 입장만 앱 창으로 보낸다.
// 일반 외부 링크와 계정 서버의 다른 경로는 기존 브라우저 규칙을 따른다.
export function workspaceEnterRequest(raw, cloudOrigin) {
  let u;
  try { u = new URL(String(raw || "")); } catch { return null; }
  if (u.origin !== cloudOrigin || u.username || u.password || u.hash) return null;
  const m = /^\/ws\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/enter$/i.exec(u.pathname);
  if (!m) return null;
  const to = u.searchParams.get("to");
  return { id: m[1], hash: to && to.length <= 500 && /^#\/[A-Za-z0-9_./?:=&%+-]+$/.test(to) ? to : null };
}

export function workspaceExchange(raw, cloudOrigin) {
  let u, cloud;
  try { u = new URL(String(raw || "")); cloud = new URL(cloudOrigin); } catch { return null; }
  if (u.protocol !== cloud.protocol || u.username || u.password || u.pathname !== "/api/ui/session/exchange" || !u.searchParams.get("code")) return null;
  // 운영: 테넌트는 <slug>.app.lvly.io. 개발: 같은 로컬 호스트의 별도 포트 허용.
  const local = cloud.hostname === "localhost" || cloud.hostname === "127.0.0.1";
  if (local ? u.hostname !== cloud.hostname :
    (u.port !== cloud.port || !u.hostname.endsWith(`.${cloud.hostname}`) ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(u.hostname.slice(0, -(cloud.hostname.length + 1))))) return null;
  return { exchangeUrl: u.href, gatewayUrl: u.origin, uiUrl: `${u.origin}/ui/` };
}

export function accountHomeNavigation(raw, cloudOrigin) {
  try {
    const u = new URL(String(raw || ""));
    return u.origin === cloudOrigin && !u.username && !u.password && u.pathname === "/home";
  } catch { return false; }
}
