import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// scripts/load-test.mjs / event-sim.mjs 와 동일한 방식으로 .env.local / .env 를 로드한다.
for (const file of [".env.local", ".env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
export const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.",
  );
}

export const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const anon = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const TEAM_PREFIX = "__e2e__";

export type SettingsRow = { opens_at: string | null; is_closed: boolean };

export async function saveSettings(): Promise<SettingsRow> {
  const { data } = await admin
    .from("settings")
    .select("opens_at, is_closed")
    .eq("id", 1)
    .maybeSingle();
  return data ?? { opens_at: null, is_closed: false };
}

export async function setSettings(opensAt: string | null, isClosed: boolean) {
  const { error } = await admin
    .from("settings")
    .upsert({ id: 1, opens_at: opensAt, is_closed: isClosed, updated_at: new Date().toISOString() });
  if (error) throw new Error(`settings 갱신 실패: ${error.message}`);
}

export async function cleanupE2ETeams() {
  const { data: teams } = await admin
    .from("teams")
    .select("id, name")
    .like("name", `${TEAM_PREFIX}%`);
  for (const t of teams ?? []) {
    await admin.from("registrations").delete().eq("team_id", t.id);
    await admin.from("teams").delete().eq("id", t.id);
  }
}

export async function createE2ETeam(suffix: string, capacity: number) {
  const name = `${TEAM_PREFIX}${suffix}`;
  const { data, error } = await admin
    .from("teams")
    .insert({ name, description: "e2e", capacity, sort_order: 9000 })
    .select("id, name, capacity, taken")
    .single();
  if (error) throw new Error(`e2e 팀 생성 실패: ${error.message}`);
  return data as { id: string; name: string; capacity: number; taken: number };
}

/** anon 키로 직접 register_for_team 을 호출한다 (다른 사람의 신청을 흉내). */
export async function directRegister(teamId: string, name: string, sno: string) {
  const { data, error } = await anon.rpc("register_for_team", {
    p_team_id: teamId,
    p_name: name,
    p_student_no4: sno,
  });
  if (error) throw new Error(error.message);
  return data as {
    ok: boolean;
    status: string;
    registration_id?: string;
    team_id?: string;
    seq?: number;
    existing?: { registration_id: string; team_id: string; seq: number } | null;
  };
}

/** "YYYY-MM-DDTHH:mm" — AdminView 의 datetime-local input 에 그대로 채울 수 있는 로컬 시각 문자열. */
export function toLocalInputValue(d: Date): string {
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}
