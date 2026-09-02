"use client";

import Link from "next/link";
import { formatDateTime } from "@/lib/format";

type Props = {
  teamName: string;
  seq: number;
  name: string;
  createdAt: string;
  onReset: () => void;
};

export default function ResultPanel({
  teamName,
  seq,
  name,
  createdAt,
  onReset,
}: Props) {
  return (
    <div className="animate-fade-in rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center">
      <p className="text-sm font-medium text-emerald-700">신청 완료</p>

      <p className="mt-3 text-2xl font-bold text-emerald-900">
        {teamName} 팀 <span className="font-mono tabular-nums">{seq}</span>번으로
        신청 완료
      </p>

      <dl className="mx-auto mt-5 grid max-w-xs grid-cols-2 gap-y-2 text-sm">
        <dt className="text-left text-emerald-700">이름</dt>
        <dd className="text-right font-medium text-emerald-900">{name}</dd>
        <dt className="text-left text-emerald-700">팀</dt>
        <dd className="text-right font-medium text-emerald-900">{teamName}</dd>
        <dt className="text-left text-emerald-700">팀 내 순번</dt>
        <dd className="text-right font-mono font-medium tabular-nums text-emerald-900">
          {seq}
        </dd>
        <dt className="text-left text-emerald-700">신청 시각</dt>
        <dd className="text-right text-xs font-medium text-emerald-900">
          {formatDateTime(createdAt)}
        </dd>
      </dl>

      <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
        <Link
          href="/board"
          className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
        >
          전체 현황판 보기
        </Link>
        <button
          type="button"
          onClick={onReset}
          className="rounded-xl border border-emerald-300 bg-white px-5 py-2.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100"
        >
          다른 사람 신청하기
        </button>
      </div>

      <p className="mt-4 text-xs text-emerald-700">
        배정 변경이 필요하면 운영진에게 문의하세요.
      </p>
    </div>
  );
}
