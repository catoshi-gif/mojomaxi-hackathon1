"use client";
import * as React from "react";

export function LogoBadge({
  logo,
  alt,
  className = "",
}: {
  logo?: string | null;
  alt?: string;
  className?: string;
}) {
  return (
    <span className={`inline-flex shrink-0 items-center ${className}`}>
      {logo ? (
        <img
          src={logo}
          alt={alt || "token"}
          width={18}
          height={18}
          className="mr-1 inline-block h-4 w-4 rounded-full ring-1 ring-white/20"
        />
      ) : (
        <span className="mr-1 inline-block h-4 w-4 rounded-full bg-white/10 ring-1 ring-white/10" />
      )}
    </span>
  );
}
