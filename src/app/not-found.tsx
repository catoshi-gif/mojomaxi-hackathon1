import Image from "next/image";
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="relative min-h-[80vh] w-full overflow-hidden">
      {/* decorative tiled background using site icon */}
      <div
        className="pointer-events-none absolute inset-0 -z-20 opacity-5"
        style={{
          backgroundImage: "url(/icon-192.png)",
          backgroundRepeat: "repeat",
          backgroundSize: "48px 48px",
        }}
        aria-hidden
      />
      {/* soft purple glow */}
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(1200px_500px_at_50%_-120px,rgba(168,85,247,0.18),transparent_60%)]" />

      <section className="mx-auto flex max-w-3xl flex-col items-center justify-center px-6 py-24 text-center md:py-32">
        <Image
          src="/mojomaxi-logo.png"
          alt="mojomaxi"
          width={260}
          height={120}
          priority
          className="drop-shadow-2xl"
        />
        <h1 className="mt-8 text-4xl font-semibold tracking-tight">page not found</h1>
        <p className="mt-3 text-sm text-white/70">
          this page doesn&apos;t exist or has moved.
        </p>

        <div className="mt-8 flex items-center gap-3">
          <Link
            href="/"
            className="rounded-full border border-fuchsia-400/20 bg-fuchsia-400/10 px-4 py-2 text-sm font-medium text-fuchsia-100 hover:bg-fuchsia-400/15 hover:border-fuchsia-400/30 transition-colors"
          >
            go home
          </Link>
        </div>

        <p className="mt-6 text-xs text-white/50">
          error code: 404
        </p>
      </section>
    </main>
  );
}
