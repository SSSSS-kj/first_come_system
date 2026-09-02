import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "모의투자 대회 팀 배정",
  description: "주식 동아리 모의투자 대회 선착순 팀 배정 시스템",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body className="min-h-full font-sans">
        <div className="mx-auto flex min-h-screen w-full max-w-4xl flex-col px-4">
          <header className="flex items-center justify-between py-5">
            <Link href="/" className="text-base font-bold tracking-tight">
              모의투자 대회 <span className="text-blue-600">팀 배정</span>
            </Link>
            <nav className="flex items-center gap-4 text-sm text-slate-500">
              <Link href="/" className="hover:text-slate-900">
                신청
              </Link>
              <Link href="/board" className="hover:text-slate-900">
                현황판
              </Link>
              <Link href="/admin" className="hover:text-slate-900">
                관리자
              </Link>
            </nav>
          </header>

          <main className="flex-1 pb-16">{children}</main>

          <footer className="border-t border-slate-200 py-4 text-center text-xs text-slate-400">
            순번과 시각은 모두 서버 기준으로 기록됩니다.
          </footer>
        </div>
      </body>
    </html>
  );
}
