// src/components/ui/button.tsx
import * as React from "react";
import { twMerge } from "tailwind-merge";

export type ButtonVariant =
  | "primary"    // brand: fuchsia → violet
  | "success"    // Start
  | "warning"    // Stop
  | "dangerSoft" // Withdraw All (soft destructive)
  | "secondary"  // subtle glass
  | "ghost"
  | "default";   // alias to "primary" for backward-compat

export type ButtonSize = "sm" | "md" | "lg";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
};

const base =
  [
    "inline-flex items-center justify-center gap-2",
    "rounded-2xl border",
    "px-3.5 min-h-[44px] h-9 sm:h-10 text-sm font-medium",
    "transition duration-200",
    "active:translate-y-[0.5px]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400/40",
    "disabled:opacity-60 disabled:pointer-events-none",
  ].join(" ");

const brand =
  "text-white border-fuchsia-500/30 bg-gradient-to-b from-fuchsia-500 to-violet-600 " +
  "shadow-[0_0_0_1px_rgba(255,255,255,.08)_inset,0_10px_24px_-8px_rgba(217,70,239,.45)] " +
  "hover:from-fuchsia-500 hover:to-violet-500";

const variants: Record<ButtonVariant, string> = {
  primary: brand,
  default: brand, // keep older uses working

  success:
    "text-white border-emerald-500/30 bg-gradient-to-b from-emerald-500 to-teal-600 " +
    "shadow-[0_0_0_1px_rgba(255,255,255,.06)_inset,0_10px_22px_-8px_rgba(16,185,129,.45)] " +
    "hover:from-emerald-500 hover:to-teal-600",

  warning:
    "text-black/90 border-amber-500/30 bg-gradient-to-b from-amber-400 to-orange-500 " +
    "shadow-[0_0_0_1px_rgba(255,255,255,.06)_inset,0_10px_22px_-8px_rgba(245,158,11,.45)] " +
    "hover:from-amber-400 hover:to-orange-500",

  dangerSoft:
    "text-rose-50 border-rose-500/25 bg-rose-500/10 hover:bg-rose-500/15 " +
    "shadow-[0_0_0_1px_rgba(255,255,255,.06)_inset,0_8px_18px_-10px_rgba(244,63,94,.35)]",

  secondary:
    "text-white border-white/10 bg-white/5 hover:bg-white/10 backdrop-blur-sm",

  ghost:
    "text-slate-200 border-transparent hover:bg-white/5",
};

const sizes: Record<ButtonSize, string> = {
  sm: "px-3 h-8 text-[13px]",
  md: "px-3.5 h-9 sm:h-10 text-sm",
  lg: "px-4 h-11 text-base",
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  onClick,
  onTouchEnd,
  type,
  ...rest
}: ButtonProps) {
  // iOS 10–12 Safari sometimes drops click events on buttons.
  // We synthesize a click on touchend and de-dupe against the real click.
  const lastTouchTs = React.useRef(0);

  const handleTouchEnd = React.useCallback((e: React.TouchEvent<HTMLButtonElement>) => {
    lastTouchTs.current = Date.now();
    // Call consumer touch handler first
    if (onTouchEnd) {
      try { onTouchEnd(e); } catch {}
    }
    // Fallback: call onClick immediately for older Safari where click may never fire
    if (onClick) {
      try { (onClick as any)(e); } catch {}
    }
  }, [onTouchEnd, onClick]);

  const handleClick = React.useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const now = Date.now();
    if (now - lastTouchTs.current < 700) {
      // Likely already handled via touchend
      return;
    }
    if (onClick) {
      onClick(e);
    }
  }, [onClick]);

  return (
    <button
      type={type ?? "button"}
      onClick={handleClick}
      onTouchEnd={handleTouchEnd}
      className={twMerge(base, variants[variant], sizes[size], className)}
      style={{ touchAction: "manipulation" as any }}
      {...rest}
    />
  );
}
