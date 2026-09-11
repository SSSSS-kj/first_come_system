import { test, expect } from "@playwright/test";
import { admin, cleanupE2ETeams, createE2ETeam, directRegister, saveSettings, setSettings, type SettingsRow } from "./helpers";

// 현황판(/board)은 신청/취소/이관을 5초 이내(Realtime 즉시 + 폴링 5초 안전망)
// 반영해야 한다.
test.describe("E6 현황판 실시간 반영", () => {
  let original: SettingsRow;

  test.beforeEach(async () => {
    original = await saveSettings();
    await cleanupE2ETeams();
  });

  test.afterEach(async () => {
    await setSettings(original.opens_at, original.is_closed);
    await cleanupE2ETeams();
  });

  test("신청/이관/취소가 5초 내 화면에 반영된다", async ({ page }) => {
    const teamA = await createE2ETeam("board-a", 10);
    const teamB = await createE2ETeam("board-b", 10);
    await setSettings(new Date(Date.now() - 60_000).toISOString(), false);

    await page.goto("/board");
    await expect(page.getByText(teamA.name)).toBeVisible();
    await expect(page.getByText(teamB.name)).toBeVisible();

    const name = "현황판테스터";
    const sno = "7777777777";
    const reg = await directRegister(teamA.id, name, sno);
    expect(reg.ok).toBe(true);
    const registrationId = reg.registration_id!;

    const sectionA = page.locator("section", { hasText: teamA.name });
    const sectionB = page.locator("section", { hasText: teamB.name });

    await expect(sectionA.getByText(name)).toBeVisible({ timeout: 5_500 });

    const { error: transferErr } = await admin.rpc("admin_transfer_registration", {
      p_registration_id: registrationId,
      p_to_team_id: teamB.id,
    });
    expect(transferErr).toBeNull();

    await expect(sectionB.getByText(name)).toBeVisible({ timeout: 5_500 });
    await expect(sectionA.getByText(name)).toBeHidden({ timeout: 5_500 });

    const { error: cancelErr } = await admin.rpc("admin_cancel_registration", {
      p_registration_id: registrationId,
    });
    expect(cancelErr).toBeNull();

    await expect(sectionB.getByText(name)).toBeHidden({ timeout: 5_500 });
  });
});
