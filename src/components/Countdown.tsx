"use client";

import { useEffect, useState } from "react";
import { formatCountdown, formatDateTime } from "@/lib/format";

type Props = {
  opensAt: string | null;
  clockOffsetMs: number;
  /** 오픈 시각이 지나면 호출된다. (상태 재조회 트리거) */
  onOpen?: () => void;
};

export default function Countdown({ opensAt, clockOffsetMs, onOpen }: Props) {
  const [remaining, setRemaining] = useState<number>(() =>
    opensAt ? new Date(opensAt).getTime() - (Date.now() + clockOffsetMs) : 0,
  );

  useEffect(() => {
    if (!opensAt) return;
    const target = new Date(opensAt).getTime();
    let fired = false;

    const id = setInterval(() => {
      const left = target - (Date.now() + clockOffsetMs);
      setRemaining(left);
      // 오픈 순간 한 번만 알린다. (매 틱 호출하면 refresh 가 폭주한다)
      if (left <= 0 && !fired) {
        fired = true;
        clearInterval(id);
        onOpen?.();
      }
    }, 200);

    setRemaining(target - (Date.now() + clockOffsetMs));
    return () => clearInterval(id);
  }, [opensAt, clockOffsetMs, onOpen]);

  if (!opensAt) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        아직 오픈 시각이 지정되지 않았습니다. 운영진의 안내를 기다려주세요.
      </div>
    );
  }

  if (remaining <= 0) return null;

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-4 text-center">
      <p className="text-xs font-medium text-blue-700">신청 오픈까지</p>
      <p className="mt-1 font-mono text-4xl font-bold tabular-nums tracking-tight text-blue-900">
        {formatCountdown(remaining)}
      </p>
      <p className="mt-1 text-xs text-blue-600">
        오픈 {formatDateTime(opensAt)} (서버 시각 기준)
      </p>
    </div>
  );
}
