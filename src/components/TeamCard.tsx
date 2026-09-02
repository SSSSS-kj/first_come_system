"use client";

import type { Team } from "@/lib/types";

type Props = {
  team: Team;
  selected: boolean;
  disabled: boolean;
  onSelect: (team: Team) => void;
};

export default function TeamCard({ team, selected, disabled, onSelect }: Props) {
  const remaining = Math.max(0, team.capacity - team.taken);
  const full = remaining === 0;
  const blocked = disabled || full;
  const ratio = team.capacity > 0 ? team.taken / team.capacity : 1;

  return (
    <button
      type="button"
      disabled={blocked}
      aria-pressed={selected}
      onClick={() => onSelect(team)}
      className={[
        "relative w-full rounded-2xl border p-4 text-left transition",
        blocked
          ? "cursor-not-allowed border-slate-200 bg-slate-100 opacity-60"
          : "border-slate-200 bg-white hover:border-blue-400 hover:shadow-sm",
        selected && !blocked ? "border-blue-500 ring-2 ring-blue-200" : "",
      ].join(" ")}
    >
      {full && (
        <span className="absolute right-3 top-3 rounded-full bg-slate-700 px-2 py-0.5 text-[11px] font-semibold text-white">
          마감
        </span>
      )}

      <p className="text-base font-bold text-slate-900">{team.name}</p>
      <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">
        {team.description || " "}
      </p>

      <div className="mt-3 flex items-baseline gap-1">
        <span className="text-xs text-slate-500">잔여</span>
        <span
          className={[
            "font-mono text-xl font-bold tabular-nums",
            full ? "text-slate-400" : remaining <= 2 ? "text-red-600" : "text-slate-900",
          ].join(" ")}
        >
          {remaining}
        </span>
        <span className="font-mono text-sm text-slate-400">/ {team.capacity}</span>
      </div>

      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className={full ? "h-full bg-slate-400" : "h-full bg-blue-500"}
          style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }}
        />
      </div>
    </button>
  );
}
