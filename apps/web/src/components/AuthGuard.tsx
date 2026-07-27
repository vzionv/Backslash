"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";

interface AuthGuardProps {
  children: ReactNode;
}

type AuthState = "checking" | "authenticated" | "unavailable";

export function AuthGuard({ children }: AuthGuardProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [authState, setAuthState] = useState<AuthState>("checking");

  useEffect(() => {
    let cancelled = false;

    async function validateCurrentSession() {
      setAuthState("checking");

      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        if (response.ok) {
          if (!cancelled) setAuthState("authenticated");
          return;
        }

        if (response.status === 401) {
          if (!cancelled) {
            router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
          }
          return;
        }

        if (!cancelled) setAuthState("unavailable");
      } catch {
        if (!cancelled) setAuthState("unavailable");
      }
    }

    void validateCurrentSession();

    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  if (authState === "authenticated") return children;

  if (authState === "unavailable") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary px-6">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold text-text-primary">
            Unable to verify your session
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            Please refresh the page or sign in again.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary">
      <span className="text-sm text-text-muted">Verifying session...</span>
    </div>
  );
}
