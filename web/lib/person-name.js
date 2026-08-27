// lib/person-name.ts — **사람 이름을 화면에 어떻게 쓰나**의 단일 판정 (#1813).
//
//  왜 필요한가: 종전엔 규칙이 두 갈래로 흩어져 있었다.
//   · 사이드바·레일·워크스페이스 사람 목록·프로필 창 → `display_name || email || id`
//   · 활동 로그·알림 위젯                              → `nickname || display_name`
//  그래서 온보딩의 「어떻게 불러 드릴까요」 답을 nickname 에 넣었더니, 정작 그 사람이 자기 이름을
//  보는 자리(사이드바)에는 이메일 앞부분이 그대로 떠 있었다(원준님 실측 2026-08-26).
//
//  이제 규칙은 하나다 — **닉네임을 쓰겠다고 켠 사람만 닉네임으로 불린다.**
//   ① use_nickname 이 켜져 있고 nickname 이 있으면 → nickname
//   ② 아니면 display_name
//   ③ 그것도 없으면 email → id (빈 이름을 화면에 내지 않는다)
//
//  ⚠ 켜고 끄는 자리는 프로필 한 곳이다(내 설정 ▸ 프로필의 「이 닉네임을 내 이름으로 사용」).
//   저장 쪽(upsertMember)이 **닉네임이 비면 플래그를 끈다** — 켜 둔 채 닉네임만 지우면 이름이 사라진 것처럼 보인다.
/** 화면에 쓸 이름 하나. 어느 자리에서든 이 함수만 부른다. */
export function personName(p) {
    if (!p)
        return '';
    const nick = String(p.nickname ?? '').trim();
    if (p.use_nickname && nick)
        return nick;
    const dn = String(p.display_name ?? '').trim();
    if (dn)
        return dn;
    const email = String(p.email ?? '').trim();
    if (email)
        return email;
    return String(p.id ?? p.userId ?? p.member_id ?? '').trim();
}
//# sourceMappingURL=person-name.js.map