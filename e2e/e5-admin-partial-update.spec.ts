import { test, expect } from "@playwright/test";
import { ADMIN_PASSWORD, saveSettings, setSettings, toLocalInputValue, type SettingsRow } from "./helpers";

// T4: 관리자 탭 두 개가 서로 다른 필드를 저장해도 상대방 필드를 덮어쓰면
// 안 된다. 탭 A 가 즉시 마감 → 탭 B 가 오픈 시각만 저장해도 is_closed 는
// 유지돼야 한다. 오픈 시각 입력이 비어 있으면 저장 버튼은 비활성.
test.describe("E5 관리자 설정 부분 업데이트", () => {
  let original: SettingsRow;

  test.beforeEach(async () => {
    original = await saveSettings();
  });

  test.afterEach(async () => {
    await setSettings(original.opens_at, original.is_closed);
  });

  async function login(page: import("@playwright/test").Page) {
    await page.goto("/admin");
    await page.getByPlaceholder("관리자 비밀번호").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "로그인" }).click();
    await expect(page.getByRole("heading", { name: "관리자", exact: true })).toBeVisible();
  }

  test("탭 A 즉시마감 후 탭 B 오픈시각만 저장해도 마감 상태가 유지된다", async ({ browser }) => {
    await setSettings(null, false);

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await login(pageA);
      await login(pageB);

      // "팀 관리" 표의 정원 저장 버튼과 텍스트가 겹치므로 오픈 설정 섹션으로 범위를 좁힌다.
      const settingsSectionB = pageB.locator("section", { hasText: "신청 오픈 설정" });
      // 오픈 시각이 비어 있는 동안은 저장 버튼이 비활성이어야 한다.
      const saveButtonB = settingsSectionB.getByRole("button", { name: "저장" });
      await expect(saveButtonB).toBeDisabled();

      // 탭 A: 즉시 마감.
      await pageA.getByRole("button", { name: "즉시 마감" }).click();
      await expect(pageA.getByText("마감됨")).toBeVisible();

      // 탭 B: is_closed 를 전혀 건드리지 않고 오픈 시각만 저장.
      const future = new Date(Date.now() + 3600_000);
      await pageB.getByLabel(/오픈 시각/).fill(toLocalInputValue(future));
      await expect(saveButtonB).toBeEnabled();
      await saveButtonB.click();
      await expect(pageB.getByText("오픈 시각을 저장했습니다.")).toBeVisible();

      // 탭 B 화면도 (부분 업데이트이므로) is_closed=true 를 그대로 반영해
      // "마감됨"으로 보여야 한다.
      await expect(pageB.getByText("마감됨")).toBeVisible();

      const after = await saveSettings();
      expect(after.is_closed).toBe(true);
      expect(after.opens_at).not.toBeNull();
      // datetime-local 입력은 분 단위까지만 담으므로 초 단위 오차를 허용한다.
      expect(Math.abs(new Date(after.opens_at!).getTime() - future.getTime())).toBeLessThan(65_000);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
