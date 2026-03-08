// filepath: src/app/community/page.tsx
import type { Metadata } from "next";
import Image from "next/image";

export const metadata: Metadata = {
  title: "Community",
  description:
    "Join the mojomaxi community, connect on X for updates and inspiration, watch videos on YouTube and hop into Discord for friendly assistance and strategy discussion.",
};

export default function CommunityPage() {
  return (
    <main className="relative min-h-[80vh] w-full overflow-hidden">
      {/* decorative tiled background using site icon (matches not-found.tsx) */}
      <div
        className="pointer-events-none absolute inset-0 -z-20 opacity-5"
        style={{
          backgroundImage: "url(/icon-192.png)",
          backgroundRepeat: "repeat",
          backgroundSize: "48px 48px",
        }}
        aria-hidden
      />

      <section className="relative mx-auto max-w-5xl py-10">
        {/* HERO image */}
        <div className="mb-10 overflow-hidden rounded-3xl border border-fuchsia-400/20">
          <div className="relative aspect-[3/2]">
            <Image
              src="/img/giza3d.webp"
              alt="Cats gathered before a pyramid in a starry desert — Mojomaxi community artwork"
              fill
              className="object-cover"
              priority
              sizes="(min-width: 1024px) 1024px, 100vw"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/25 to-transparent" />
          </div>
        </div>

        {/* Title + intro (follows homepage typography style) */}
        <div className="mb-10 space-y-4">
          <h1 className="inline-block text-3xl md:text-4xl font-semibold tracking-tight bg-gradient-to-r from-blue-500 to-teal-400 bg-clip-text text-transparent">
            Community
          </h1>
          <p className="max-w-3xl text-white/80 leading-relaxed">
            Great trading is rarely solo. we share ideas, pressure-test strategies, celebrate wins, and learn from the
            misses — together.{" "}
            <span className="text-white/70">
              Follow our daily flow on X for education, updates, and inspiration; drop into Discord for friendly help
              and strategy discussion.
            </span>
          </p>
        </div>

        {/* Big graphical links */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* X (Twitter) */}
          <SocialBubbleCard
            href="https://x.com/yomojomaxi"
            ariaLabel="Visit mojomaxi on X (opens in a new tab)"
            iconSrc="/assets/xmojo.webp"
            iconAlt="Mojomaxi X icon"
            title="Follow us on X"
            pill="Education • Updates • Inspiration"
            desc="@yomojomaxi — your daily dose of trading ideas and platform news"
          />

          {/* Discord */}
          <SocialBubbleCard
            href="https://discord.gg/PEhUAvp5wF"
            ariaLabel="Join the mojomaxi Discord (opens in a new tab)"
            iconSrc="/assets/discomojo.webp"
            iconAlt="Mojomaxi Discord icon"
            title="Join our Discord"
            pill="Assistance • Mindshare • Connections"
            desc="Get friendly help, discuss strategies, and connect with fellow traders"
          />

          {/* YouTube */}
          <SocialBubbleCard
            href="https://www.youtube.com/@mojomaxi"
            ariaLabel="Visit the mojomaxi YouTube channel (opens in a new tab)"
            iconSrc="/assets/ytmojo.webp"
            iconAlt="Mojomaxi YouTube icon"
            title="Watch on YouTube"
            pill="Tutorials • Demos • Education"
            desc="@mojomaxi — walkthroughs, strategy breakdowns, and product updates"
          />
        </div>

        {/* support 101 (lowercase as requested) */}
        <div className="mt-10 rounded-2xl border border-white/10 bg-white/5 p-5">
          <h2 className="text-base font-medium text-white">support 101</h2>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-white/80">
            <li>Join Discord → #ticket to create a ticket</li>
            <li>include your wallet address, set id and the vault address.</li>
            <li>Never share seed phrases / private keys / screenshots of secret keys / our mods will never dm you.</li>
          </ul>
        </div>

        {/* community code of conduct (lowercase as requested) */}
        <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-5">
          <h2 className="text-base font-medium text-white">community code of conduct</h2>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-white/80">
            <li>Respect everyone.</li>
            <li>No DM solicitations.</li>
            <li>No financial advice.</li>
            <li>Report Scams to mods.</li>
            <li>Our mods will never dm you.</li>
            <li>Never share sensitive information.</li>
          </ul>
        </div>

        {/* share the love (lowercase as requested) */}
        <div className="mt-6">
          <a
            href="https://twitter.com/intent/tweet?text=automating%20with%20%40yomojomaxi%20%E2%80%94%20non-custodial%2C%20webhook-driven%20vaults%20and%20rebalancing%20baskets.%20join%20the%20community%3A%20https%3A%2F%2Fwww.mojomaxi.com%2Fcommunity"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm underline decoration-dotted underline-offset-4 text-white/80 hover:text-white"
            aria-label="share on x (opens in a new tab)"
          >
            Share on X
          </a>
        </div>

        {/* subtle footer note */}
        <p className="mt-8 text-xs text-white/50">tip: both links open in a new tab.</p>
      </section>
    </main>
  );
}

function SocialBubbleCard({
  href,
  ariaLabel,
  iconSrc,
  iconAlt,
  title,
  pill,
  desc,
}: {
  href: string;
  ariaLabel: string;
  iconSrc: string;
  iconAlt: string;
  title: string;
  pill: string;
  desc: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-center gap-4 rounded-2xl border border-fuchsia-400/20 bg-black/40 p-5 transition-colors hover:border-fuchsia-400/35"
      aria-label={ariaLabel}
    >
      {/* icon bubble: fixed size so logos never get resized */}
      <div className="flex h-14 w-14 flex-none items-center justify-center rounded-xl border border-white/10 bg-white/5">
        <Image
          src={iconSrc}
          alt={iconAlt}
          width={32}
          height={32}
          className="h-8 w-8 object-contain"
        />
      </div>

      {/* text: allow wrapping; do not truncate */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base font-medium">{title}</span>
          <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/70">
            {pill}
          </span>
        </div>
        <p className="mt-1 text-sm text-white/70 leading-relaxed break-words">{desc}</p>
      </div>

      <span className="ml-auto inline-flex h-8 w-8 flex-none items-center justify-center rounded-full border border-white/10 bg-white/5 transition-transform group-hover:translate-x-0.5">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
          <path d="M13 5l7 7-7 7v-5H4v-4h9V5z" />
        </svg>
      </span>
    </a>
  );
}
