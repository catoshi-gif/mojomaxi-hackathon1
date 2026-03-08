// filepath: src/app/offline/page.tsx
export const dynamic = "force-static";

export default function OfflinePage() {
  return (
    <div className="mx-auto max-w-xl py-16 text-center">
      <h1 className="text-2xl font-semibold">You’re offline</h1>
      <p className="mt-3 text-sm opacity-80">
        Mojomaxi needs an internet connection to load fresh vault balances and execute swaps.
        Please reconnect and try again.
      </p>
      <p className="mt-6 text-sm opacity-80">
        Tip: if you’re on Seeker, switching networks (Wi‑Fi ↔ mobile data) often fixes intermittent connectivity.
      </p>
    </div>
  );
}
