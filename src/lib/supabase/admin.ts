import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/**
 * 서버 전용 Supabase 클라이언트 (service_role 키).
 * admin_* RPC 는 service_role 에게만 EXECUTE 가 부여되어 있으므로
 * 이 클라이언트는 절대 브라우저로 내보내면 안 된다.
 */
export function getAdminSupabase(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 설정되지 않았습니다.",
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
