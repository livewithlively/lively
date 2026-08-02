// lib/format.ts — 시간·숫자 표기(#1313 R29b). core.ts 에서 **verbatim 이동**(로직 변경 0). 의존 0(leaf).
//  ⚠ 여기 있는 건 **core 소유분**(relTime·absTime·fmtNum)뿐이다. 프로젝트 화면의 fmtSize·fmtDateTime·
//   fmtFileDate 계열은 web/projects/files.ts 소관으로 그대로 둔다(같은 이름 아님 — 통합 대상 아님).
//  소비 파일은 종전대로 './core.js' 에서 받는다(core 의 배럴 재수출).
// ── 시간/숫자 ──
// 마지막 갱신이 며칠 전일 수 있음 — 분/시간/일 폴백('분' 가정 금지).
function relTime(iso) {
    if (!iso)
        return '갱신 기록 없음';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t))
        return '갱신 기록 없음';
    const m = Math.floor((Date.now() - t) / 60000);
    if (m < 1)
        return '방금 전';
    if (m < 60)
        return m + '분 전';
    const h = Math.floor(m / 60);
    if (h < 24)
        return h + '시간 전';
    const d = Math.floor(h / 24);
    if (d < 30)
        return d + '일 전';
    return new Date(iso).toLocaleDateString('ko-KR');
}
function absTime(iso) {
    if (!iso)
        return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ko-KR');
}
const fmtNum = (n) => Number(n || 0).toLocaleString('ko-KR');
export { absTime, fmtNum, relTime, };
