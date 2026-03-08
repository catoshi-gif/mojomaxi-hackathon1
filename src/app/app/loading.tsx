export default function Loading() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-10 space-y-6">
      <div className="h-7 w-72 animate-pulse rounded bg-gray-100" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="h-40 animate-pulse rounded-2xl bg-gray-100" />
        <div className="h-40 animate-pulse rounded-2xl bg-gray-100" />
        <div className="h-40 animate-pulse rounded-2xl bg-gray-100" />
      </div>
      <div className="h-56 animate-pulse rounded-2xl bg-gray-100" />
      <div className="h-56 animate-pulse rounded-2xl bg-gray-100" />
    </main>
  );
}
