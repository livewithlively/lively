// taskmodal/util.ts — #1313 R56: web/taskmodal.ts 섹션 분할 ①(리프 헬퍼).
//  외부 URL 가드 · 시간 표기(초→사람말/시계) · 파일명 타임스탬프. 여러 섹션이 함께 쓰므로 import 0 리프로 둔다
//  — 섹션끼리 헬퍼를 서로 물면 패키지 안에 순환이 생긴다.
// 외부 URL 가드 — http(s) 만 허용(데이터 유래 href 의 javascript: 등 주입 차단).
function pjvtmSafeUrl(u) {
    const s = String(u || '').trim();
    return /^https?:\/\//i.test(s) ? s : null;
}
function pjvFmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h)
        return h + '시간 ' + (m ? m + '분' : '').trim();
    if (m)
        return m + '분 ' + (s ? s + '초' : '').trim();
    return s + '초';
}
function pjvFmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const z = (x) => String(x).padStart(2, '0');
    return (h ? h + ':' : '') + z(m) + ':' + z(s);
}
// 파일명용 타임스탬프 YYYYMMDD-HHMMSS (브라우저 — Date 사용 가능).
function pjvtmStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
export { pjvFmtClock, pjvFmtDuration, pjvtmSafeUrl, pjvtmStamp };
