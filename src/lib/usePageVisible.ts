// filepath: src/lib/usePageVisible.ts
"use client";
import { useEffect, useState } from "react";

/** Simple page visibility hook (client-only). */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(
    typeof document === "undefined" ? true : document.visibilityState === "visible"
  );

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    // Optional hardening to catch BFCache/alt focus transitions:
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    window.addEventListener("pageshow", update as any);
    window.addEventListener("pagehide", update as any);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      window.removeEventListener("pageshow", update as any);
      window.removeEventListener("pagehide", update as any);
    };
  }, []);

  return visible;
}
