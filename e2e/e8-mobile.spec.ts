import { test, expect, type Page } from "@playwright/test";
import { cleanupE2ETeams, createE2ETeam, saveSettings, setSettings, type SettingsRow } from "./helpers";

async function assertNoHorizontalScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1); // 서브픽셀 오차 허용
}

// 390px 모바일 뷰포트에서 신청 흐름이 정상 동작하고 가로 스크롤이 생기지 않아야 한다.
test.describe("E8 모바일 뷰포트(390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  let original: SettingsRow;

  test.beforeEach(async () => {
    original = await saveSettings();
    await cleanupE2ETeams();
  });

  test.afterEach(async () => {
    await setSettings(original.opens_at, original.is_closed);
    await cleanupE2ETeams();
  });

  test("390px 에서 신청 흐름 완료 + 가로 스크롤 없음", async ({ page }) => {
    const team = await createE2ETeam("mobile", 10);
    await setSettings(new Date(Date.now() - 60_000).toISOString(), false);

    await page.goto("/");
    await assertNoHorizontalScroll(page);

    await page.getByRole("button", { name: new RegExp(team.name) }).click();
    await assertNoHorizontalScroll(page);

    await page.getByPlaceholder("홍길동").fill("모바일테스터");
    await page.getByPlaceholder("2024012345").fill("2222222222");
    await assertNoHorizontalScroll(page);

    await page.getByRole("button", { name: `${team.name} 팀으로 신청하기` }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await assertNoHorizontalScroll(page);

    await page.getByRole("dialog").getByRole("button", { name: "신청 확정" }).click();
    await expect(page.getByText("신청 완료", { exact: true })).toBeVisible();
    await assertNoHorizontalScroll(page);
  });
});
