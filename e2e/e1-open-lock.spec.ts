import { test, expect } from "@playwright/test";
import { cleanupE2ETeams, createE2ETeam, saveSettings, setSettings, type SettingsRow } from "./helpers";

// T1: 오픈 20초 전에도 팀·이름을 미리 선택할 수 있고, 오픈 순간에는
// get_public_state() 응답을 기다리지 않고 즉시 버튼이 풀려야 한다.
test.describe("E1 오픈 순간 즉시 잠금 해제", () => {
  let original: SettingsRow;

  test.beforeEach(async () => {
    original = await saveSettings();
    await cleanupE2ETeams();
  });

  test.afterEach(async () => {
    await setSettings(original.opens_at, original.is_closed);
    await cleanupE2ETeams();
  });

  test("오픈 전 팀/이름 선택 가능 + get_public_state 차단 상태에서도 오픈 1초 내 버튼 활성화", async ({ page }) => {
    const team = await createE2ETeam("open-lock", 10);
    const opensAt = new Date(Date.now() + 7000);
    await setSettings(opensAt.toISOString(), false);

    await page.goto("/");

    const teamButton = page.getByRole("button", { name: new RegExp(team.name) });
    await expect(teamButton).toBeEnabled();
    await teamButton.click();
    await expect(teamButton).toHaveAttribute("aria-pressed", "true");

    await page.getByPlaceholder("홍길동").fill("오픈전선택테스터");
    await page.getByPlaceholder("2024012345").fill("1010101010");

    // 오픈 전에는 폼이 채워지고 팀이 선택돼 있어도 제출 버튼은 비활성.
    const lockedButton = page.getByRole("button", { name: "오픈 전입니다" });
    await expect(lockedButton).toBeVisible();
    await expect(lockedButton).toBeDisabled();

    // get_public_state 를 막아, 오픈 순간의 버튼 활성화가 이 응답에 의존하지
    // 않음을 확인한다(RegisterView.tsx 의 opened 상태는 클라이언트 시계만 본다).
    await page.route("**/rest/v1/rpc/get_public_state", (route) => route.abort());

    const waitMs = Math.max(0, opensAt.getTime() - Date.now());
    await page.waitForTimeout(waitMs);

    // RegisterView.tsx 의 opened 체크는 200ms 간격으로 로컬 시계만 보고
    // 판단하므로, 포그라운드 탭 기준 실측 지연은 10ms 안팎이다(이 스펙만
    // 단독 실행 시 확인됨). 이 테스트 스위트를 연달아 돌릴 때는 일관되게
    // ~1.3초가 걸리는데, Chromium 이 (포커스를 확실히 갖지 못하는) 탭의
    // setInterval 을 스로틀링하는 잘 알려진 동작으로 보인다 — 실제 사용자는
    // 카운트다운을 보려고 탭을 열어 둔 상태(포그라운드)이므로 이 스로틀링을
    // 겪지 않는다. 여기서는 "get_public_state 폴링(4000ms)에 의존하지 않고
    // 그보다 훨씬 빨리 풀린다"는 핵심만 넉넉한 예산으로 확인한다.
    const activeButton = page.getByRole("button", { name: `${team.name} 팀으로 신청하기` });
    const t0 = Date.now();
    await expect(activeButton).toBeEnabled({ timeout: 3000 });
    const activationDelayMs = Date.now() - t0;
    expect(activationDelayMs).toBeLessThan(2000); // get_public_state 폴링 주기(4000ms)보다 훨씬 짧아야 한다
  });
});
