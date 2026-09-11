import { test, expect } from "@playwright/test";
import { admin, cleanupE2ETeams, createE2ETeam, saveSettings, setSettings, type SettingsRow } from "./helpers";

// T2: 이미 신청한 사람이 같은 이름/학번으로 재신청하면 team_full 이 아니라
// 기존 배정을 그대로 보여줘야 한다. register_for_team 은 (name_key,
// student_no4) 중복 확인을 좌석 확보보다 먼저 하므로, 재신청 대상 팀이
// 마감됐는지 여부와 무관하게 항상 기존 배정이 반환된다. 정원을 2로 둔 건
// (정원 1로 두면 재신청 시 TeamCard 자체가 disabled 되어 버튼을 클릭할 수
// 없어 순수 UI 흐름으로 재현할 수 없기 때문) — 서버 로직은 정원과 무관하게
// 동일하게 동작한다.
test.describe("E3 이미 배정된 사람의 재신청", () => {
  let original: SettingsRow;

  test.beforeEach(async () => {
    original = await saveSettings();
    await cleanupE2ETeams();
  });

  test.afterEach(async () => {
    await setSettings(original.opens_at, original.is_closed);
    await cleanupE2ETeams();
  });

  test("재신청 시 team_full 대신 기존 배정 결과를 보여준다", async ({ page }) => {
    const team = await createE2ETeam("dup-reapply", 2);
    await setSettings(new Date(Date.now() - 60_000).toISOString(), false);

    const name = "재시도테스터";
    const sno = "5555555555";

    await page.goto("/");
    const teamButton = page.getByRole("button", { name: new RegExp(team.name) });

    await teamButton.click();
    await page.getByPlaceholder("홍길동").fill(name);
    await page.getByPlaceholder("2024012345").fill(sno);
    await page.getByRole("button", { name: `${team.name} 팀으로 신청하기` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "신청 확정" }).click();
    await expect(page.getByText("신청 완료", { exact: true })).toBeVisible();
    const firstResultText = await page.getByText(/번으로/).innerText();

    // 새 세션인 것처럼(로컬스토리지 초기화) 같은 이름/학번으로 다시 신청.
    await page.getByRole("button", { name: "다른 사람 신청하기" }).click();

    await teamButton.click();
    await page.getByPlaceholder("홍길동").fill(name);
    await page.getByPlaceholder("2024012345").fill(sno);
    await page.getByRole("button", { name: `${team.name} 팀으로 신청하기` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "신청 확정" }).click();

    // 참고(버그 아님, 발견 사항): RegisterView.submit() 의 duplicate_name
    // 분기는 setBanner("이미 접수된 신청을 불러왔습니다.") 보다 먼저 persist()
    // 로 me 를 세팅하는데, `if (me) return <ResultPanel/>` 가 조기 반환이라
    // 그 배너는 이 경로에서 실제로 그려질 기회가 없다. 대신 ResultPanel 이
    // "새로 만들어진 배정"이 아니라 "기존 배정 그대로"임을 seq 로 검증한다.
    await expect(page.getByText("신청 완료", { exact: true })).toBeVisible();
    const secondResultText = await page.getByText(/번으로/).innerText();
    expect(secondResultText).toBe(firstResultText); // 같은 순번 = 새 신청이 아니라 기존 배정

    const { data: t } = await admin.from("teams").select("taken").eq("id", team.id).single();
    expect(t?.taken).toBe(1); // 새 행이 생기지 않았어야 한다.
  });
});
