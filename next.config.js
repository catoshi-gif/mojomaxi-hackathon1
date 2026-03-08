// filepath: next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Next.js 15: typedRoutes moved out of `experimental`
  typedRoutes: false,

  experimental: {
    // Intentionally left empty (kept for future flags).
  },

  // ✅ keep only transpilePackages for Solana/Anchor libs
  transpilePackages: [
    "@solana/web3.js",
    "@solana/spl-token",
    "@coral-xyz/anchor",
  ],

  async headers() {
    // Baseline app-level security headers. Cloudflare may already enforce CSP,
    // but these help protect direct Vercel domains, previews, and edge cases.
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Pragma", value: "no-cache" },
          { key: "Expires", value: "0" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/site.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Content-Type", value: "application/manifest+json" },
        ],
      },
      {
        source: "/(icon-192.png|icon-512.png|icon-512-maskable.png|apple-touch-icon.png|favicon.ico)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" }
        ],
      },
    ];
  },

  webpack: (config, { isServer }) => {
    // keep your existing pino/WalletConnect aliases
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      "pino-pretty": false,
      "pino-abstract-transport": false,
      "sonic-boom": false,
      ...(isServer ? {} : { pino: "pino/browser" }),
    };

    // avoid pulling Node built-ins into client bundles
    config.resolve.fallback = {
      ...(config.resolve.fallback || {}),
      fs: false,
      net: false,
      tls: false,
      child_process: false,
    };

    return config;
  },
};

module.exports = nextConfig;
