// src/app/webhooks/_components/TokenPicker.tsx
"use client";

import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { connection as _conn } from "@/lib/solana";


declare global {
  interface Window {
    mmTokenLogos?: Record<string, string>;
    mmPickerLogos?: Record<string, string>;
  }
}
import * as React from "react";
import { useWallet } from "@solana/wallet-adapter-react";

type Token = {
  address: string;
  mint?: string;
  symbol: string;
  name?: string;
  logoURI?: string;
  verified?: boolean; // Jupiter verified flag
};

type Props = {
  label?: string;                 // used to choose default (BUY=SOL, SELL=USDC) when empty
  value?: string | null;          // current mint from parent
  onChange: (mint?: string, tok?: Token) => void;
  placeholder?: string;           // keep empty on your page to avoid ghost text
  initialTokens?: Token[];        // Top tokens (from /api/tokens/top)
  locked?: boolean;               // when true, disable changing tokens
};

const SOL_MINT = "So11111111111111111111111111111111111111112";

// Use the Solana token-list canonical logo for native SOL to avoid intermittent icon CDN misses.
const SOL_LOGO_URL = "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png";

const _jupIconUrl = (mint: string) => `https://icons.jup.ag/token/${encodeURIComponent(mint)}`;

/**
 * Ensure we prefer Jupiter-hosted logos over any accidental local/relative assets.
 * This keeps picker visuals consistent and prevents "repo-stored" icons from winning.
 */
function _sanitizeLogoURI(mint: string, logoURI?: string): string | undefined {
  const m = String(mint || "").trim();
  const u = String(logoURI || "").trim();
  if (!u) return undefined;

  // If a relative/local path sneaks in (e.g. "/..."), prefer Jupiter static token logo.
  if (u.startsWith("/")) {
    return m === SOL_MINT ? SOL_LOGO_URL : _jupIconUrl(m);
  }

  // Special-case SOL: some places historically used local assets for SOL.
  // If it's pointing at our own origin or looks non-Jupiter, force Jupiter static.
  if (m === SOL_MINT) {
    try {
      const parsed = new URL(u);
      const host = (parsed.hostname || "").toLowerCase();
      if (!host || host.includes("mojomaxi") || host.includes("vercel")) {
        return SOL_LOGO_URL;
      }
    } catch {
      // If it's not a valid absolute URL, fall back to Jupiter static.
      return SOL_LOGO_URL;
    }
  }

  return u;
}

function _sanitizeTokenLogo(tok?: Token | null): Token | null {
  if (!tok) return null;
  const addr = String((tok as any)?.address || (tok as any)?.mint || "").trim();
  if (!addr) return tok;
  const rawLogo = String((tok as any)?.logoURI || (tok as any)?.logoUri || "").trim();
  const fixed = _sanitizeLogoURI(addr, rawLogo);
  if (fixed === rawLogo) return tok;
  return { ...(tok as any), address: addr, mint: addr, logoURI: fixed || undefined } as any;
}


function _tokenLogo(tok?: Token | null): string | undefined {
  const t: any = _sanitizeTokenLogo(tok) || tok;
  if (!t) return undefined;
  const mint = String(t.address || t.mint || "").trim();
  const url = String(t.logoURI || t.logoUri || "").trim();
  if (url) return url;
  if (mint === SOL_MINT) return SOL_LOGO_URL;
  return undefined;
}

function _publishPickerLogo(tok?: Token | null) {
  tok = _sanitizeTokenLogo(tok) as any;
  try {
    if (!tok) return;
    const mint = (tok.address || tok.mint || "").trim();
    const url = String((tok as any)?.logoURI || (tok as any)?.logoUri || "").trim();
    if (!mint || !url) return;
    if (!/^https?:\/\//i.test(url)) return;
    if (typeof window === "undefined") return;
    const g = (window as any);
    g.mmPickerLogos = { ...(g.mmPickerLogos || {}), [mint]: url };
    g.mmTokenLogos = { ...(g.mmTokenLogos || {}), [mint]: url };
    try { window.dispatchEvent(new CustomEvent("mm:picker:logo", { detail: { mint, url } })); } catch {}
    try { window.dispatchEvent(new CustomEvent("mm:tokenlogo", { detail: { mint, url } })); } catch {}
    try {
      const prev = JSON.parse(localStorage.getItem("mmPickerLogos") || "{}");
      prev[mint] = url;
      localStorage.setItem("mmPickerLogos", JSON.stringify(prev));
    } catch {}
  } catch {}
}


function _shortMint(m: string): string {
  const s = String(m || "");
  if (s.length <= 10) return s;
  return s.slice(0, 4) + "…" + s.slice(-4);
}

function _looksLikeMintAddress(input: string): boolean {
  const s = String(input || "").trim();
  // Typical Solana mint/pubkey length is 32..44 base58 chars.
  if (s.length < 32 || s.length > 44) return false;
  // Base58 (no 0,O,I,l). Keep it permissive but safe.
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) return false;
  return true;
}


/** Check if a mint account is owned by Token-2022 program. */
async function _isToken2022Mint(mint: string): Promise<boolean> {
  try {
    const pk = new PublicKey(mint);
    const info = await _conn().getAccountInfo(pk);
    if (!info) return false; // unknown mint: treat as not 2022 (no false positive)
    // Note: TOKEN_2022_PROGRAM_ID is a PublicKey
    return info.owner.equals(TOKEN_2022_PROGRAM_ID);
  } catch {
    return false;
  }
}

function _warnToken2022(nameOrMint: string) {
  const label = nameOrMint || "This token";
  alert(
    label +
      " is a Token‑2022 mint and requires a Mojo Pro Subscription to select. Please choose another token (standard SPL Token Program) to create your vault."
  );
}

function dedupeByAddress(list: Token[]) {
  const seen = new Set<string>();
  const out: Token[] = [];
  for (const t of list || []) {
    const addr = (t?.address || t?.mint || "").trim();
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    out.push({ ...t, address: addr, mint: addr });
  }
  return out;
}



// Treat missing or placeholder symbols as "unknown" (should not be shown as choices).

function _looksLikeShortMintSymbol(sym?: string | null, mint?: string | null): boolean {
  const s = String(sym || "").trim();
  if (!s) return true;
  if (s.toUpperCase() === "UNKNOWN") return true;
  // Many fallback UIs use a "ABCD…WXYZ" pattern. If we see that, treat it as unresolved.
  if (s.includes("…") || s.includes("...")) return true;
  const m = String(mint || "").trim();
  // If the "symbol" is literally the mint, it's unresolved.
  if (m && s === m) return true;
  return false;
}

function _isUnknownSymbol(sym?: string | null): boolean {
  const s = String(sym || "").trim();
  return !s || s.toUpperCase() === "UNKNOWN";
}

// Filter token arrays for safe display: drop duplicates, entries without a mint,
// and any cached placeholders with symbol "UNKNOWN".
function _filterSafeTokens(list: Token[]): Token[] {
  return dedupeByAddress(list).filter((t) => {
    const addr = String((t?.address || t?.mint || "")).trim();
    if (!addr) return false;
    if (_isUnknownSymbol((t as any)?.symbol)) return false;
    return true;
  });
}
function findBySymbol(tokens: Token[], sym: string) {
  const s = sym.toUpperCase();
  return tokens.find((t) => (t.symbol || "").toUpperCase() === s) || null;
}

function pickDefault(tokens: Token[], label?: string): Token | null {
  const wantUSDC = /\bSELL\b/i.test(label || "") || /profit/i.test(label || "");
  const first = wantUSDC ? "USDC" : "SOL";


  return (
    findBySymbol(tokens, first) ||
    findBySymbol(tokens, "SOL") ||
    findBySymbol(tokens, "USDC") ||
    tokens[0] ||
    null
  );
}

function VerifiedDot() {
  return (
    <span
      className="ml-1 inline-flex h-3 w-3 items-center justify-center rounded-full border border-emerald-400/40 bg-emerald-400/15 text-[9px] leading-[9px] text-emerald-300"
      title="Verified by Jupiter"
    >
      ✓
    </span>
  );
}

export default function TokenPicker({
  label,
  value,
  onChange,
  placeholder,
  initialTokens = [],
  locked = false,
}: Props) {
  const [query, setQuery] = React.useState("");
  const [focused, setFocused] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [items, setItems] = React.useState<Token[]>(() => _filterSafeTokens(initialTokens));
  const [error, setError] = React.useState<string | null>(null);
  // iOS/Safari input composition + network race guards
  const composingRef = React.useRef(false);
  const searchAbortRef = React.useRef<AbortController | null>(null);
  const searchSeqRef = React.useRef(0);
  const metaCacheRef = React.useRef<Map<string, Token>>(new Map());

  const [picked, setPicked] = React.useState<Token | null>(null);
  // Prevent a parent value sync effect from overwriting the freshly-picked token on the first click.
  const pendingPickRef = React.useRef<{ mint: string; tok: Token } | null>(null);
  React.useEffect(() => {
    _publishPickerLogo(picked);
  }, [picked?.mint, (picked as any)?.logoURI, (picked as any)?.logoUri]);



  const fetchMetaToken = React.useCallback(async (mint: string): Promise<Token | null> => {
    const m = String(mint || "").trim();
    if (!m) return null;
    const cached = metaCacheRef.current.get(m);
    if (cached) return cached;
    try {
      const r = await fetch(`/api/tokens/meta?mints=${encodeURIComponent(m)}`, { cache: "no-store" });
      if (!r.ok) return null;
      const j = await r.json();
      const it = (Array.isArray(j?.items) ? j.items : [])[0];
      if (!it) return null;
      const addr = String(it.address || it.mint || m).trim();
      const tokRaw: Token = {
        address: addr,
        mint: addr,
        symbol: String(it.symbol || "").trim() || _shortMint(addr),
        name: String(it.name || "").trim() || String(it.symbol || "").trim() || undefined,
        logoURI: String(it.logoURI || it.logoUri || "").trim() || undefined,
        verified: (it.verified === true) || undefined,
      };
      const tok = (_sanitizeTokenLogo(tokRaw) || tokRaw) as Token;
      metaCacheRef.current.set(m, tok);
      return tok;
    } catch {
      return null;
    }
  }, []);




  // Backfill token metadata (symbol/name/logo) for mint-only selections (common when loading from saved config).
  React.useEffect(() => {
    const m = String((picked?.address || picked?.mint || "")).trim();
    if (!m) return;
    const sym = (picked as any)?.symbol;
    const name = (picked as any)?.name;
    const logo = (picked as any)?.logoURI || (picked as any)?.logoUri;
    if (!_looksLikeShortMintSymbol(sym, m) && !!logo && !!name) return;

    let cancelled = false;
    (async () => {
      const meta = await fetchMetaToken(m);
      if (!meta || cancelled) return;
      setPicked((prev) => {
        const p: any = prev || {};
        const merged: any = { ...p, ...meta };
        // Never downgrade an existing non-empty field.
        merged.symbol = String(p.symbol || "").trim() && !_looksLikeShortMintSymbol(p.symbol, m) ? p.symbol : meta.symbol;
        merged.name = String(p.name || "").trim() ? p.name : meta.name;
        merged.logoURI = String(p.logoURI || p.logoUri || "").trim() ? (p.logoURI || p.logoUri) : meta.logoURI;
        return merged;
      });
    })();
    return () => { cancelled = true; };
  }, [picked?.mint, fetchMetaToken]);

  // Recognize active Mojo Pro subscription (enables Token‑2022 selection)
  const { publicKey } = useWallet();
  const [proActive, setProActive] = React.useState<boolean>(false);
  React.useEffect(() => {
    let on = true;
    const wallet = publicKey?.toBase58?.() || "";
    if (!wallet) { setProActive(false); return; }
    (async () => {
      try {
        const r = await fetch(`/api/subs/mojo-pro/status?wallet=${encodeURIComponent(wallet)}`, { cache: "no-store" });
        const j = await r.json();
        if (on) setProActive(!!j?.status?.active);
      } catch {
        if (on) setProActive(false);
      }
    })();
    return () => { on = false };
  }, [publicKey]);

  // --- NEW: warn throttling + skip resolver for this interaction ---
  const warnedRef = React.useRef(false);
  const skipResolveRef = React.useRef(false);

  const warnOnce = React.useCallback((label: string) => {
    if (warnedRef.current) return;
    warnedRef.current = true;
    if (!proActive) _warnToken2022(label);
    // Skip the very next blur/resolve cycle and then allow future resolves.
    skipResolveRef.current = true;
    setTimeout(() => {
      warnedRef.current = false;
      skipResolveRef.current = false;
    }, 250);
  }, [proActive]);

  // --- NEW: revert helper used after a Token-2022 attempt ---
  const revertToSafeSelection = React.useCallback(() => {
    // drop the typed text and close the list
    setQuery("");
    setFocused(false);
    // if we already have a valid selection, reflect it in parent
    if (picked && picked.mint) {
      _publishPickerLogo(picked); onChange(picked.mint, picked);
      return;
    }
    // otherwise, pick a sensible default and persist it
    const base = items.length ? items : _filterSafeTokens(initialTokens);
    const def = pickDefault(base, label);
    if (def) {
      const addr = (def.address || def.mint || "").trim();
      if (addr) {
        const tokRaw = { ...def, address: addr, mint: addr };
        const tok = (_sanitizeTokenLogo(tokRaw) || tokRaw) as Token;
        setPicked(tok);
        _publishPickerLogo(tok); onChange(addr, tok);
      }
    }
  }, [picked, items, initialTokens, label, onChange]);

  // keep items synced with Top-20 while idle
  React.useEffect(() => {
    if (!query.trim()) setItems(_filterSafeTokens(initialTokens));
  }, [initialTokens, query]);
  // Preserve picked logoURI on refresh: never downgrade to empty when items update.
  React.useEffect(() => {
    if (!picked) return;
    const addr = String(picked.address || picked.mint || "").trim();
    if (!addr) return;
    const hit = items.find((t) => String(t.address || t.mint || "").trim() === addr) || null;
    if (!hit) return;
    const newLogo = (hit as any)?.logoURI || (hit as any)?.logoUri || "";
    const oldLogo = (picked as any)?.logoURI || (picked as any)?.logoUri || "";
    // If incoming item has no logo but we already have one, keep the old one.
    // If incoming item has a different non-empty logo, we intentionally
    // do *not* override the picked logo here, to avoid reverting to an
    // incorrect cached image (see USDC icon bug).
    if (!newLogo && oldLogo) {
      setPicked((prev) => ({
        ...(prev || {}),
        ...hit,
        address: addr,
        mint: addr,
        logoURI: newLogo || oldLogo || undefined,
      }));
    }
  }, [items]);


  // When there's no current value/picked (e.g., brand-new set), choose a default.
  React.useEffect(() => {
    if (value) return;           // parent already has a value
    if (picked) return;          // we already picked one
    const def = pickDefault(items.length ? items : _filterSafeTokens(initialTokens), label);
    if (def) {
      const addr = (def.address || def.mint || "").trim();
      if (addr) {
        const tokRaw = { ...def, address: addr, mint: addr };
        const tok = (_sanitizeTokenLogo(tokRaw) || tokRaw) as Token;
        setPicked(tok);
        _publishPickerLogo(tok); onChange(addr, tok);     // persist default to parent
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, picked, initialTokens, items, label, onChange]);

  // keep "picked" in sync with parent value, even if not in items
  React.useEffect(() => {
    const mint = (value || "").trim();
    if (!mint) return;
    if (picked?.mint === mint) return;
    // If we just picked this mint (first click), do not let the value-sync effect overwrite it.
    if (pendingPickRef.current?.mint === mint) {
      const pt = pendingPickRef.current.tok;
      if (pt && (picked?.mint !== mint)) setPicked(pt);
      return;
    }


    // first try in current items
    const fromItems =
      items.find((t) => (t.address || t.mint || "").trim() === mint) || null;
    if (fromItems) {
      const addr = fromItems.address || fromItems.mint!;
      const mergedLogo =
        (fromItems as any)?.logoURI || (fromItems as any)?.logoUri || (picked as any)?.logoURI || (picked as any)?.logoUri;
      const prevSym = String((picked as any)?.symbol || "").trim();
      const nextSym = String((fromItems as any)?.symbol || "").trim();
      const safeSym = !_isUnknownSymbol(nextSym) ? nextSym : prevSym;
      const prevName = (picked as any)?.name;
      const nextName = (fromItems as any)?.name;
      const fixedLogo = _sanitizeLogoURI(addr, mergedLogo);
      setPicked({
        ...(picked || {}),
        ...fromItems,
        address: addr,
        mint: addr,
        logoURI: (fixedLogo || mergedLogo) || undefined,
        symbol: (safeSym || nextSym || prevSym) as string,
        name: (nextName || prevName) as any,
      });
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const meta = await fetchMetaToken(mint);
        if (meta) {
          if (!cancelled) {
            setPicked((prev) => ({ ...(prev || {}), ...meta, address: meta.address, mint: meta.mint }));
          }
          return;
        }
        const r = await fetch(`/api/tokens/search?q=${encodeURIComponent(mint)}`, {
          cache: "no-store",
        });
        const j = await r.json();
        const arr: Token[] = Array.isArray(j?.tokens)
          ? j.tokens
          : Array.isArray(j?.items)
          ? j.items
          : [];
        const exact =
          arr.find(
            (t) =>
              (t.address || t.mint || "").trim().toLowerCase() === mint.toLowerCase()
          ) || null;
        if (!cancelled && exact) {
          const addr = exact.address || exact.mint!;
          const tokRaw = { ...exact, address: addr, mint: addr } as any;
          const tok = (_sanitizeTokenLogo(tokRaw) || tokRaw) as Token;
          // If the search result is missing logo/name (happens for mint-only lookups), keep any existing picked fields.
          setPicked((prev) => ({ ...(prev || {}), ...tok, address: addr, mint: addr }));
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [value, picked?.mint, fetchMetaToken, items]);

  
async function search(q: string) {
    const qq = q.trim();
    // fast path: empty query restores default list without flashing errors
    if (!qq) { setItems(_filterSafeTokens(initialTokens)); setError(null); setLoading(false); return; }
    // bump sequence id to mark this invocation as the latest
    const seq = ++searchSeqRef.current;
    setLoading(true);
    setError(null);
    // cancel any in‑flight request
    try { if (searchAbortRef.current) { try { searchAbortRef.current.abort(); } catch {} } } catch {}
    const _ctrl = new AbortController();
    searchAbortRef.current = _ctrl;
    try {
      const r = await fetch(`/api/tokens/search?q=${encodeURIComponent(qq)}`, { cache: "no-store", signal: _ctrl.signal });
      // Ignore non-2xx without surfacing noisy errors—just show empty results
      if (!r.ok) {
        if (seq === searchSeqRef.current && !_ctrl.signal.aborted) { setItems([]); }
        return;
      }
      let j: any = null;
      try { j = await r.json(); } catch { j = null; }
      // if a newer search started, drop this result
      if (seq !== searchSeqRef.current || _ctrl.signal.aborted) return;
      const arrRaw = Array.isArray(j?.tokens) ? j.tokens : Array.isArray(j?.items) ? j.items : [];
      const arr = arrRaw as Token[];

      // If the user pasted a mint address, some backends return a placeholder token
      // (e.g. symbol "UNKNOWN" / empty) which our safe-filter intentionally hides.
      // In that mint-paste case, keep the exact mint match by synthesizing a displayable token.
      const qqLower = qq.toLowerCase();
      const exactRaw =
        arr.find((t) => ((t?.address || t?.mint || "") as string).trim().toLowerCase() === qqLower) || null;

      let exactFromRaw: Token | null = null;
      if (exactRaw) {
        const addr = String((exactRaw as any)?.address || (exactRaw as any)?.mint || qq).trim();
        exactFromRaw = {
          ...(exactRaw as any),
          address: addr,
          mint: addr,
          symbol: String((exactRaw as any)?.symbol || "").trim() || _shortMint(addr),
          name:
            String((exactRaw as any)?.name || "").trim() ||
            String((exactRaw as any)?.symbol || "").trim() ||
            undefined,
          logoURI: String((exactRaw as any)?.logoURI || (exactRaw as any)?.logoUri || "").trim() || undefined,
          verified: ((exactRaw as any)?.verified === true) || undefined,
        } as any;
        exactFromRaw = (_sanitizeTokenLogo(exactFromRaw) || exactFromRaw) as Token;
      }

      const deduped = _filterSafeTokens(arr as Token[]);
      const ranked = [...deduped.filter((t) => t?.verified === true), ...deduped.filter((t) => t?.verified !== true)];
      let out = ranked;

      // Mint-paste UX: if the query is a mint, surface the exact mint match even if it would
      // otherwise be filtered out (e.g. placeholder "UNKNOWN" symbol).
      if (_looksLikeMintAddress(qq)) {
        if (exactFromRaw) {
          const exAddr = String(exactFromRaw.address || exactFromRaw.mint || "").trim();
          out = [exactFromRaw, ...ranked.filter((t) => String(t.address || t.mint || "").trim() !== exAddr)];
        } else if (ranked.length === 0) {
          // As a fallback (some backends don't return the mint on search), ask meta endpoint directly.
          const meta = await fetchMetaToken(qq);
          if (meta) out = [meta];
        }
      }

      setItems(out);

    } catch (e: any) {
      // Swallow expected aborts and transient races without raising error UI
      if (e?.name === "AbortError" || e?.code === 20) { return; }
      // If this isn't the latest search anymore, ignore the error
      if (seq !== searchSeqRef.current || _ctrl.signal?.aborted) { return; }
      setError(e?.message || "search failed");
    } finally {
      if (seq === searchSeqRef.current && !_ctrl.signal.aborted) setLoading(false);
    }
  }
React.useEffect(() => {
    const id = setTimeout(() => { if (!composingRef.current) void search(query); }, 180);
    return () => clearTimeout(id);
  }, [query]);

  // Resolve a typed value on blur; if no exact match, clear and RESTORE last selection (or default)
  const resolveTypedOrRestore = React.useCallback(async () => {
    if (skipResolveRef.current) return; // NEW: skip once after a warn

    const q = query.trim();
    if (!q) { setQuery(""); return; }

    const ql = q.toLowerCase();
    const byItems =
      items.find(
        (t) =>
          t.symbol?.toLowerCase() === ql ||
          (t.address || t.mint || "").toLowerCase() === ql
      ) || null;

    let cand = byItems;

    if (!cand) {
      try {
        const r = await fetch(`/api/tokens/search?q=${encodeURIComponent(q)}`, { cache: "no-store", signal: searchAbortRef.current?.signal });
        const j = await r.json();
        const arr: Token[] = Array.isArray(j?.tokens) ? j.tokens : Array.isArray(j?.items) ? j.items : [];
        cand =
          arr.find(
            (t) =>
              t.symbol?.toLowerCase() === ql ||
              (t.address || t.mint || "").toLowerCase() === ql
          ) || null;
      } catch { /* ignore */ }
    }

    if (cand) {
      const addr = (cand.address || cand.mint || "").trim();
      if (addr) {
        // Token-2022 pre-check at the moment of user selection via typing/enter
        if (!proActive && await _isToken2022Mint(addr)) {
          const sym = (cand.symbol || "") || _shortMint(addr);
          warnOnce(sym);          // NEW: warn exactly once
          revertToSafeSelection();// NEW: clear + close + restore
          return;                 // abort selection
        }
        const tokRaw = { ...cand, address: addr, mint: addr } as any;
        const tok = (_sanitizeTokenLogo(tokRaw) || tokRaw) as Token;
        setPicked(tok);
        setQuery("");
        _publishPickerLogo(tok); onChange(addr, tok);
        return;
      }
    }

    // No match: drop free text and restore last selection (or pick a default if none yet)
    setQuery("");
    if (!picked) {
      const def = pickDefault(items.length ? items : _filterSafeTokens(initialTokens), label);
      if (def) {
        const addr = (def.address || def.mint || "").trim();
        if (addr) {
          const tokRaw = { ...def, address: addr, mint: addr };
        const tok = (_sanitizeTokenLogo(tokRaw) || tokRaw) as Token;
          setPicked(tok);
          _publishPickerLogo(tok); onChange(addr, tok);
        }
      }
    } else {
      // Ensure parent reflects the last valid selection
      _publishPickerLogo(picked); onChange(picked.mint, picked);
    }
  }, [query, items, picked, initialTokens, label, onChange, warnOnce, revertToSafeSelection]);

  const pickedLogo = _tokenLogo(picked);
  return (
    <div className="space-y-1">
      {label && <div className="text-xs text-slate-400">{label}</div>}

      <div className="relative">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={(e) => { composingRef.current = false; setQuery(e.currentTarget.value); }}
          disabled={locked}
          title={locked ? "locked after vault creation — delete set to change" : undefined}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            // allow list item onClick to run first
            setTimeout(() => setFocused(false), 120);
            // then resolve/restore the free text (skip once if we just warned)
            setTimeout(() => { if (!skipResolveRef.current) void resolveTypedOrRestore(); }, 140);
          }}
          onKeyDown={async (e) => {
            if (e.key === "Enter") {
              const ql = query.trim().toLowerCase();
              const cand =
                items.find(
                  (t) =>
                    t.symbol?.toLowerCase() === ql ||
                    (t.address || t.mint || "").toLowerCase() === ql
                ) || null;
              if (cand) {
                const addr = (cand.address || cand.mint || "").trim();
                if (addr) {
                  // Guard the Enter path as well
                  if (!proActive && await _isToken2022Mint(addr)) {
                    const sym = (cand.symbol || "") || _shortMint(addr);
                    warnOnce(sym);           // NEW: warn exactly once
                    revertToSafeSelection(); // NEW: clear + close + restore
                    return;                  // abort selection
                  }
                  const tokRaw = { ...cand, address: addr, mint: addr } as any;
        const tok = (_sanitizeTokenLogo(tokRaw) || tokRaw) as Token;
                  setPicked(tok);
                  setQuery("");
                  setFocused(false);
                  _publishPickerLogo(tok); onChange(addr, tok);
                  return;
                }
              }
              // no exact match → restore
              setFocused(false);
              void resolveTypedOrRestore();
            }
          }}
          placeholder={placeholder || ""}
          // Give extra right padding so the lock can sit inside the field.
          className="w-full rounded-lg border border-white/10 bg-black/50 px-3 pr-8 py-2 text-sm text-slate-100 outline-none focus:ring-1 focus:ring-white/20"
        />

        {/* Selected overlay (icon + symbol + tiny verified check) when no query */}
        {!query && picked && (
          <div className="pointer-events-none absolute inset-0 flex items-center px-3 h-10">
            {pickedLogo ? (
              <img
                src={pickedLogo}
                alt=""
                className="mr-2 h-4 w-4 rounded-full"
                loading="lazy"
                onError={(e) => {
                  const el = e.currentTarget;
                  const m = String((picked?.mint || picked?.address || "")).trim();
                  if (!m) return;
                  const next = _jupIconUrl(m);
                  if (el.src !== next) {
                    el.onerror = null;
                    el.src = next;
                  }
                }}
              />
            ) : null}
            <span className="text-sm text-slate-100 font-medium">{picked.symbol}</span>
            {picked.verified ? <VerifiedDot /> : null}
          </div>
        )}

        {/* Lock emoji INSIDE the field, right-aligned */}
        {locked ? (
          <span
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
            title="locked after vault creation — delete set to change"
            aria-label="Locked"
          >
            🔒
          </span>
        ) : null}

        {/* MM: CA caption under picker */}
        {picked && (picked.address || picked.mint) ? (
          <div className="mt-1 block w-full text-left text-[10px] text-white/40 font-mono truncate">
            {(picked.address || picked.mint) as string}
          </div>
        ) : null}

        {/* Dropdown */}
        {focused && (
          <div className="absolute z-40 mt-1 w-full rounded-md border border-white/10 bg-[#0A0A0A] shadow-lg">
            <div className="max-h-64 overflow-auto p-1">
              {loading && <div className="px-3 py-2 text-xs text-slate-400">Searching…</div>}
              {error && <div className="px-3 py-2 text-xs text-rose-300">{error}</div>}
              {!loading && !error && items.length === 0 && (
                <div className="px-3 py-2 text-xs text-slate-400">No tokens.</div>
              )}
              {!loading && !error && items.length > 0 && (
                <ul className="divide-y divide-white/5">
                  {items.map((t) => {
                    const addr = (t.address || t.mint || "").trim();
                    return (
                      <li
                        key={addr}
                        className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-white/5"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={async () => {
                          if (!addr) return;
                          // No selection if the mint is Token-2022
                          if (!proActive && await _isToken2022Mint(addr)) {
                            const sym = (t.symbol || "") || _shortMint(addr);
                            warnOnce(sym);           // NEW: single alert
                            revertToSafeSelection(); // NEW: clear + close + restore
                            return;
                          }


                          const tokRaw = { ...t, address: addr, mint: addr };
                          const tok = (_sanitizeTokenLogo(tokRaw) || tokRaw) as Token;
                          pendingPickRef.current = { mint: addr, tok };
                          setPicked(tok);             // local display update
                          setQuery("");               // clear query so overlay shows
                          setFocused(false);          // close dropdown
                          _publishPickerLogo(tok); onChange(addr, tok);        // persist prefs
                          // Allow the next value-sync pass after this commit.
                          queueMicrotask(() => { pendingPickRef.current = null; });
                        }}
                      >
                        {_tokenLogo(t) ? (
                          <img
                            src={_sanitizeLogoURI(addr, t.logoURI) || t.logoURI}
                            alt=""
                            className="h-5 w-5 rounded-full"
                            loading="lazy"
                            onError={(e) => {
                              const el = e.currentTarget;
                              const next = _jupIconUrl(addr);
                              if (el.src !== next) {
                                el.onerror = null;
                                el.src = next;
                              }
                            }}
                          />
                        ) : (
                          <span className="inline-block h-5 w-5 rounded-full bg-white/10" />
                        )}
                        <div className="flex min-w-0 items-center">
                          <div className="truncate text-sm text-slate-100">
                            {t.symbol}
                            {t.verified ? <VerifiedDot /> : null}
                            <span className="text-xs text-slate-400"> · {t.name || "—"}</span>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
