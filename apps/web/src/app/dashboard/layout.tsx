"use client";

import { AppHeader } from "@/components/AppHeader";
import { AuthGuard } from "@/components/AuthGuard";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <div className="min-h-screen bg-bg-primary">
        <AppHeader />
        <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
      </div>
    </AuthGuard>
  );
}
