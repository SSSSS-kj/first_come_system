import { test, expect } from "@playwright/test";
import { cleanupE2ETeams, createE2ETeam, saveSettings, setSettings, type SettingsRow } from "./helpers";

// T3: register_for_team 응답이 오지 않으면 10초(코드의 abortSignal 타임아웃)
// 근처에서 "제출 중…" 이 풀려야 한다("응답을 받지 못했다" 복구 경로).
test.describe("E4 제출 응답 타임아웃", () => {
  let original: SettingsRow;

  test.beforeEach(async () => {
    original = await saveSettings();
    await cleanupE2ETeams();
  });

  test.afterEach(async () => {
    await setSettings(original.opens_at, original.is_closed);
    await cleanupE2ETeams();
  });

  test("register_for_team 이 응답하지 않으면 약 10초 후 제출 중 상태가 풀린다", async ({ page }) => {
    const team = await createE2ETeam("submit-timeout", 10);
    await setSettings(new Date(Date.now() - 60_000).toISOString(), false);

    // 실제 요청이 서버에 닿지 않도록 15초 지연 후 중단한다
    // (abortSignal(10_000) 이 먼저 클라이언트에서 요청을 끊는다).
    await page.route("**/rest/v1/rpc/register_for_team", async (route) => {
      await new Promise((r) => setTimeout(r, 15_000));
      await route.abort().catch(() => {});
    });

    await page.goto("/");
    await page.getByRole("button", { name: new RegExp(team.name) }).click();
    await page.getByPlaceholder("홍길동").fill("타임아웃테스터");
    await page.getByPlaceholder("2024012345").fill("1111111111");
    await page.getByRole("button", { name: `${team.name} 팀으로 신청하기` }).click();

    const dialog = page.getByRole("dialog");
    const t0 = Date.now();
    await dialog.getByRole("button", { name: "신청 확정" }).click();
    await expect(dialog.getByRole("button", { name: "제출 중…" })).toBeVisible();

    await expect(dialog).toBeHidden({ timeout: 16_000 });
    const elapsedMs = Date.now() - t0;
    expect(elapsedMs).toBeGreaterThan(8_000);

    await expect(
      page.getByText("응답이 늦어 신청 여부를 확인하지 못했어요. 다시 눌러주세요."),
    ).toBeVisible();

    // 제출 중 상태가 완전히 풀려 다시 신청을 시도할 수 있어야 한다.
    await expect(page.getByRole("button", { name: `${team.name} 팀으로 신청하기` })).toBeEnabled();
  });
});
