import { test, expect } from "@playwright/test";
import { cleanupE2ETeams, createE2ETeam, directRegister, saveSettings, setSettings, type SettingsRow } from "./helpers";

// T1: 선택해 둔 팀이 실시간 갱신으로 정원이 차면 선택이 자동 해제되어야 한다.
test.describe("E2 선택한 팀이 타인 신청으로 마감되면 선택 해제", () => {
  let original: SettingsRow;

  test.beforeEach(async () => {
    original = await saveSettings();
    await cleanupE2ETeams();
  });

  test.afterEach(async () => {
    await setSettings(original.opens_at, original.is_closed);
    await cleanupE2ETeams();
  });

  test("다른 사람이 마지막 자리를 채우면 선택이 풀리고 안내 배너가 뜬다", async ({ page }) => {
    const team = await createE2ETeam("team-full-deselect", 1);
    await setSettings(new Date(Date.now() - 60_000).toISOString(), false);

    await page.goto("/");
    const teamButton = page.getByRole("button", { name: new RegExp(team.name) });
    await teamButton.click();
    await expect(teamButton).toHaveAttribute("aria-pressed", "true");

    // 다른 사람이 앱과 같은 경로(anon RPC)로 마지막 1자리를 채운다.
    const res = await directRegister(team.id, "타인신청자", "9999999999");
    expect(res.ok).toBe(true);

    await expect(
      page.getByText("선택하신 팀이 방금 마감되어 선택이 해제되었습니다."),
    ).toBeVisible({ timeout: 6000 });
    await expect(teamButton).toHaveAttribute("aria-pressed", "false");
    await expect(teamButton).toBeDisabled();
  });
});
