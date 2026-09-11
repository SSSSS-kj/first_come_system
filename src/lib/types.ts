export type Team = {
  id: string;
  name: string;
  description: string;
  capacity: number;
  taken: number;
  sort_order: number;
};

export type PublicState = {
  server_now: string;
  opens_at: string | null;
  is_closed: boolean;
  teams: Team[];
};

export type Registration = {
  id: string;
  team_id: string;
  name: string;
  student_no4: string;
  seq: number;
  created_at: string;
  is_cancelled: boolean;
  cancelled_at: string | null;
};

export type AuditRow = {
  id: number;
  at: string;
  action: string;
  actor: string;
  success: boolean;
  reason: string;
  team_id: string | null;
  to_team_id: string | null;
  registration_id: string | null;
  name: string | null;
  detail: Record<string, unknown>;
};

/** register_for_team / lookup_registration 의 반환 형태. */
export type RegisterResult =
  | {
      ok: true;
      status: "ok";
      registration_id: string;
      team_id: string;
      team_name: string;
      seq: number;
      name: string;
      created_at: string;
      server_now: string;
    }
  | {
      ok: false;
      status:
        | "not_open"
        | "closed"
        | "team_full"
        | "duplicate_name"
        | "team_not_found"
        | "invalid_name"
        | "invalid_student_no"
        | "not_found";
      server_now: string;
      opens_at?: string | null;
      team_id?: string;
      capacity?: number;
      taken?: number;
      existing?: {
        registration_id: string;
        team_id: string;
        team_name: string;
        seq: number;
        created_at: string;
      } | null;
    };

/** 사용자에게 보여줄 한국어 메시지. */
export const RESULT_MESSAGE: Record<string, string> = {
  not_open: "아직 신청이 열리지 않았습니다.",
  closed: "신청이 마감되었습니다.",
  team_full: "방금 마감되었습니다. 다른 팀을 선택해주세요",
  duplicate_name: "이미 신청된 이름입니다. 운영진에게 문의하세요",
  team_not_found: "존재하지 않는 팀입니다. 화면을 새로고침해주세요.",
  invalid_name: "이름을 다시 확인해주세요. (1~40자)",
  invalid_student_no: "학번 10자리를 숫자로 입력해주세요.",
  not_found: "신청 내역을 찾을 수 없습니다.",
};
