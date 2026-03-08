// File: src/app/admin/login/page.tsx
"use client";

import React, { useEffect, useState, useTransition } from "react";

export const dynamic = "force-dynamic";

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export default function AdminLoginPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 text-gray-100">
      <div className="mx-auto max-w-md px-4 py-16">
        <header className="mb-8 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">
            Mojomaxi <span className="opacity-70">— Admin</span>
          </h1>
          <p className="mt-1 text-sm text-gray-400">Password + Google Authenticator (2FA)</p>
        </header>
        <div className="rounded-2xl border border-white/10 bg-white/5 shadow-xl backdrop-blur">
          <LoginForm />
        </div>
        <p className="mt-6 text-center text-xs text-gray-500">
          Your email & password are validated on the server. 2FA uses TOTP (SHA‑1, 30s).
        </p>
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-gray-200">
        {label}
      </label>
      {children}
    </div>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        "block w-full rounded-lg bg-white/95 text-gray-900 placeholder-gray-400",
        "ring-1 ring-gray-300 focus:ring-2 focus:ring-black focus:outline-none",
        "px-3 py-2 text-sm",
        props.className
      )}
    />
  );
}

function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  const { loading, className, children, ...rest } = props;
  return (
    <button
      {...rest}
      className={cx(
        "w-full inline-flex items-center justify-center rounded-lg px-4 py-2.5",
        "text-sm font-medium shadow-sm",
        loading ? "bg-gray-300 text-gray-700 cursor-not-allowed" : "bg-black text-white hover:bg-gray-900",
        className
      )}
    >
      {loading ? "Verifying…" : children}
    </button>
  );
}

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    (document.getElementById("email") as HTMLInputElement | null)?.focus();
  }, []);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, totp }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setError(data?.error || "Login failed");
          return;
        }
        setSuccess(true);
        const next = new URLSearchParams(window.location.search).get("next") || "/admin";
        window.location.href = next;
      } catch (e: any) {
        setError(e?.message || "Login error");
      }
    });
  };

  return (
    <form onSubmit={onSubmit} className="p-6 sm:p-8 space-y-5">
      {error && (
        <div className="rounded-lg border border-red-300/60 bg-red-50/90 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-lg border border-emerald-300/60 bg-emerald-50/90 px-3 py-2 text-sm text-emerald-700">
          Success! Redirecting…
        </div>
      )}

      <Field id="email" label="Email">
        <Input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="admin@yourdomain.com"
        />
      </Field>

      <Field id="password" label="Password">
        <div className="relative">
          <Input
            id="password"
            type={showPw ? "text" : "password"}
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setShowPw((s) => !s)}
            className="absolute inset-y-0 right-0 px-3 text-xs text-gray-600 hover:text-gray-900"
            aria-label={showPw ? "Hide password" : "Show password"}
          >
            {showPw ? "Hide" : "Show"}
          </button>
        </div>
      </Field>

      <Field id="totp" label="2FA Code">
        <Input
          id="totp"
          type="text"
          inputMode="numeric"
          pattern="\d{6}"
          autoComplete="one-time-code"
          required
          value={totp}
          onChange={(e) => setTotp(e.target.value)}
          placeholder="6-digit code"
        />
      </Field>

      <Button type="submit" loading={isPending}>
        Log in
      </Button>
    </form>
  );
}
