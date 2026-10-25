import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Search,
  RefreshCw,
  ExternalLink,
  Download,
  CheckCircle2,
  XCircle,
  SlidersHorizontal,
  Play,
  Plus,
  KeyRound,
  X,
  ShoppingBag,
  Sparkles,
  Globe,
} from 'lucide-react';
import { usePWAInstall, useOnlineStatus } from './hooks/usePWAInstall';

const DEFAULT_OWNER = 'rehanbabar17-art';
const DEFAULT_REPO = 'pakistan-brand-sale-monitor';
const DEFAULT_BRANCH = 'main';
const STORAGE_KEY = 'link-monitor-github-config';

interface GitHubConfig {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

interface BrandConfigItem {
  name: string;
  url: string;
}

interface BrandSaleState {
  active: boolean;
  checked_at?: string;
  discounts?: string[];
  fingerprint?: string;
  product_count?: number;
  sale_product_count?: number;
  summary?: string;
  title?: string;
  url?: string;
  ads?: {
    active: boolean;
    meta_count?: number;
    google_count?: number;
    sale_ads_count?: number;
    discounts?: string[];
    max_discount?: number;
    checked_at?: string;
  };
}

interface EnrichedBrand {
  name: string;
  url: string;
  active: boolean;
  maxDiscount: number;
  discounts: string[];
  saleProductsCount: number;
  summary: string;
  checkedAt: string;
  source: 'tracked' | 'aggregator';
  aggregatorName?: string;
  upcoming?: boolean;
  ads?: {
    active: boolean;
    meta_count?: number;
    google_count?: number;
    sale_ads_count?: number;
    discounts?: string[];
    max_discount?: number;
    checked_at?: string;
  };
}

function decodeBase64Unicode(value: string): string {
  const bytes = Uint8Array.from(atob(value.replace(/\s/g, '')), c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Unicode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function extractMaxDiscount(discounts: string[] = [], summary = ''): number {
  let max = 0;
  const all = [...discounts, summary];
  for (const text of all) {
    const matches = text.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g);
    for (const m of matches) {
      const val = parseFloat(m[1]);
      if (val > 0 && val <= 95 && val > max) {
        max = val;
      }
    }
  }
  return max;
}

function extractSaleProductCount(state?: BrandSaleState | null): number {
  if (!state) return 0;
  if (typeof state.sale_product_count === 'number' && state.sale_product_count > 0) {
    return state.sale_product_count;
  }
  const match = (state.summary || '').match(/\((\d+)\s+products\s+on\s+sale\)/i);
  if (match) return parseInt(match[1], 10);
  return typeof state.product_count === 'number' ? state.product_count : 0;
}

function formatRelativeTime(iso?: string): string {
  if (!iso) return 'Not checked yet';
  const date = new Date(iso);
  if (isNaN(date.getTime())) return '';
  const diffMin = Math.round((Date.now() - date.getTime()) / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function App() {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const isOnline = useOnlineStatus();

  const [activeSection, setActiveSection] = useState<'brands' | 'top-deals' | 'aggregators' | 'sync'>('brands');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'top50' | 'top60' | 'inactive'>('all');
  const [sortBy, setSortBy] = useState<'products' | 'discount' | 'name'>('products');

  const [config, setConfig] = useState<GitHubConfig>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && saved.owner && saved.repo) {
        return {
          owner: saved.owner || DEFAULT_OWNER,
          repo: saved.repo || DEFAULT_REPO,
          branch: saved.branch || DEFAULT_BRANCH,
          token: saved.token || '',
        };
      }
    } catch {
      // ignore
    }
    return { owner: DEFAULT_OWNER, repo: DEFAULT_REPO, branch: DEFAULT_BRANCH, token: '' };
  });

  const [ownerInput, setOwnerInput] = useState(config.owner);
  const [repoInput, setRepoInput] = useState(config.repo);
  const [branchInput, setBranchInput] = useState(config.branch);
  const [tokenInput, setTokenInput] = useState(config.token);

  const [brandsList, setBrandsList] = useState<BrandConfigItem[]>([]);
  const [rawState, setRawState] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [syncSource, setSyncSource] = useState<'github-pat' | 'github-public' | 'local-cache'>('local-cache');
  const [feedbackMessage, setFeedbackMessage] = useState<{ text: string; type: 'info' | 'error' } | null>(null);
  const [showInstallModal, setShowInstallModal] = useState(false);

  // Add brand form state
  const [newBrandName, setNewBrandName] = useState('');
  const [newBrandUrl, setNewBrandUrl] = useState('');
  const [addingBrand, setAddingBrand] = useState(false);
  const [triggeringScan, setTriggeringScan] = useState(false);

  const showToast = useCallback((text: string, type: 'info' | 'error' = 'info') => {
    setFeedbackMessage({ text, type });
    setTimeout(() => {
      setFeedbackMessage(prev => (prev?.text === text ? null : prev));
    }, 4000);
  }, []);

  const fetchFromGitHubContents = async (path: string, cfg: GitHubConfig) => {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (cfg.token.trim()) {
      headers.Authorization = `Bearer ${cfg.token.trim()}`;
    }
    const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}?ref=${encodeURIComponent(cfg.branch)}&_=${Date.now()}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status}`);
    }
    const payload = await res.json();
    return {
      data: JSON.parse(decodeBase64Unicode(payload.content || '')),
      sha: payload.sha as string,
    };
  };

  const loadSaleState = useCallback(
    async (customConfig?: GitHubConfig, notify = false) => {
      const activeCfg = customConfig || config;
      setLoading(true);
      try {
        // 1. Try GitHub REST API (uses PAT if provided, or unauthenticated public API)
        const [brandsRes, stateRes] = await Promise.all([
          fetchFromGitHubContents('brands.json', activeCfg),
          fetchFromGitHubContents('state/sale_state.json', activeCfg),
        ]);
        setBrandsList(brandsRes.data?.brands || []);
        setRawState(stateRes.data || {});
        setSyncSource(activeCfg.token.trim() ? 'github-pat' : 'github-public');
        if (notify) {
          showToast(
            activeCfg.token.trim()
              ? 'Synced live sale_state.json via GitHub PAT'
              : 'Synced live sale_state.json from GitHub'
          );
        }
        setLoading(false);
        return;
      } catch {
        // 2. Fallback to raw.githubusercontent.com
        try {
          const baseRaw = `https://raw.githubusercontent.com/${activeCfg.owner}/${activeCfg.repo}/${activeCfg.branch}`;
          const [bResp, sResp] = await Promise.all([
            fetch(`${baseRaw}/brands.json?_=${Date.now()}`),
            fetch(`${baseRaw}/state/sale_state.json?_=${Date.now()}`),
          ]);
          if (bResp.ok && sResp.ok) {
            const bJson = await bResp.json();
            const sJson = await sResp.json();
            setBrandsList(bJson?.brands || []);
            setRawState(sJson || {});
            setSyncSource('github-public');
            if (notify) showToast('Synced sale_state.json from GitHub Raw');
            setLoading(false);
            return;
          }
        } catch {
          // 3. Fallback to bundled local snapshot in /sale_state.json
        }
      }

      try {
        const [localBrands, localState] = await Promise.all([
          fetch('/brands.json').then(r => r.json()),
          fetch('/sale_state.json').then(r => r.json()),
        ]);
        setBrandsList(localBrands?.brands || []);
        setRawState(localState || {});
        setSyncSource('local-cache');
        if (notify) showToast('Loaded cached sale_state.json snapshot');
      } catch (err: any) {
        showToast(err?.message || 'Could not load sale_state.json', 'error');
      } finally {
        setLoading(false);
      }
    },
    [config, showToast]
  );

  useEffect(() => {
    loadSaleState(config, false);
  }, []);

  const handleSaveConnection = async (e: React.FormEvent) => {
    e.preventDefault();
    const nextConfig: GitHubConfig = {
      owner: ownerInput.trim() || DEFAULT_OWNER,
      repo: repoInput.trim() || DEFAULT_REPO,
      branch: branchInput.trim() || DEFAULT_BRANCH,
      token: tokenInput.trim(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextConfig));
    setConfig(nextConfig);
    await loadSaleState(nextConfig, true);
  };

  const handleClearToken = () => {
    const cleared: GitHubConfig = {
      owner: DEFAULT_OWNER,
      repo: DEFAULT_REPO,
      branch: DEFAULT_BRANCH,
      token: '',
    };
    localStorage.removeItem(STORAGE_KEY);
    setTokenInput('');
    setConfig(cleared);
    loadSaleState(cleared, true);
  };

  const handleTriggerGitHubScan = async () => {
    if (!config.token.trim()) {
      setActiveSection('sync');
      showToast('Add your GitHub PAT in GitHub Sync to trigger a live workflow run', 'error');
      return;
    }
    setTriggeringScan(true);
    try {
      const res = await fetch(
        `https://api.github.com/repos/${config.owner}/${config.repo}/actions/workflows/sale-monitor.yml/dispatches`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            Authorization: `Bearer ${config.token.trim()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ref: config.branch }),
        }
      );
      if (!res.ok) {
        throw new Error(`GitHub Actions returned ${res.status}`);
      }
      showToast('Triggered sale-monitor.yml workflow on GitHub!');
    } catch (err: any) {
      showToast(err?.message || 'Failed to trigger workflow', 'error');
    } finally {
      setTriggeringScan(false);
    }
  };

  const [triggeringAdsScan, setTriggeringAdsScan] = useState(false);
  const handleTriggerAdsScan = async () => {
    if (!config.token.trim()) {
      showToast('Enter your GitHub Personal Access Token in the GitHub Sync tab to trigger workflows', 'error');
      return;
    }
    setTriggeringAdsScan(true);
    try {
      const res = await fetch(
        `https://api.github.com/repos/${config.owner}/${config.repo}/actions/workflows/ads-monitor.yml/dispatches`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            Authorization: `Bearer ${config.token.trim()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ref: config.branch }),
        }
      );
      if (!res.ok) {
        throw new Error(`GitHub Actions returned ${res.status}`);
      }
      showToast('Triggered Facebook & Google Ads monitor workflow on GitHub!');
    } catch (err: any) {
      showToast(err?.message || 'Failed to trigger Ads workflow', 'error');
    } finally {
      setTriggeringAdsScan(false);
    }
  };

  const handleAddBrandToGitHub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!config.token.trim()) {
      showToast('Enter a GitHub PAT with Contents: Read/Write permission first', 'error');
      return;
    }
    const name = newBrandName.trim();
    const url = newBrandUrl.trim();
    if (!name || !url) return;

    setAddingBrand(true);
    try {
      const current = await fetchFromGitHubContents('brands.json', config);
      const existingBrands: BrandConfigItem[] = current.data?.brands || [];
      if (existingBrands.some(b => b.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`${name} is already in brands.json`);
      }
      const updated = { brands: [...existingBrands, { name, url }] };
      const putRes = await fetch(
        `https://api.github.com/repos/${config.owner}/${config.repo}/contents/brands.json`,
        {
          method: 'PUT',
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            Authorization: `Bearer ${config.token.trim()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: `Add brand: ${name}`,
            content: encodeBase64Unicode(JSON.stringify(updated, null, 2) + '\n'),
            branch: config.branch,
            sha: current.sha,
          }),
        }
      );
      if (!putRes.ok) {
        throw new Error(`GitHub commit failed (${putRes.status})`);
      }
      setBrandsList(updated.brands);
      setNewBrandName('');
      setNewBrandUrl('');
      showToast(`Added ${name} to brands.json on GitHub`);
    } catch (err: any) {
      showToast(err?.message || 'Failed to add brand', 'error');
    } finally {
      setAddingBrand(false);
    }
  };

  // Transform rawState + brandsList into unified EnrichedBrand records
  const { trackedBrands, aggregatorBrands, lastCheckedGlobal } = useMemo(() => {
    const tracked: EnrichedBrand[] = [];
    const seenNames = new Set<string>();
    let latestTimestamp = '';

    const sourceBrands: BrandConfigItem[] =
      brandsList.length > 0
        ? brandsList
        : Object.keys(rawState)
            .filter(k => k !== 'tijara_top_deals' && k !== 'salesiren_top_deals' && !k.includes('::'))
            .map(k => ({ name: k, url: rawState[k]?.url || '' }));

    for (const item of sourceBrands) {
      if (item.name.includes('Brand Tijara')) continue;
      seenNames.add(item.name.toLowerCase());
      const st: BrandSaleState | undefined = rawState[item.name];
      const discounts = Array.isArray(st?.discounts) ? st!.discounts! : [];
      const maxDiscount = extractMaxDiscount(discounts, st?.summary || '');
      const saleProductsCount = extractSaleProductCount(st);
      const active = Boolean(st?.active || saleProductsCount > 0 || maxDiscount > 0);
      if (st?.checked_at && st.checked_at > latestTimestamp) {
        latestTimestamp = st.checked_at;
      }
      tracked.push({
        name: item.name,
        url: st?.url || item.url,
        active,
        maxDiscount,
        discounts,
        saleProductsCount,
        summary: st?.summary || item.name,
        checkedAt: st?.checked_at || '',
        source: 'tracked',
        ads: st?.ads,
      });
    }

    // Also parse aggregator deals (Brand Tijara & Sale Siren) from sale_state.json
    const aggMap = new Map<string, EnrichedBrand>();
    const tijaraDeals = rawState.tijara_top_deals || {};
    for (const [slug, val] of Object.entries(tijaraDeals)) {
      if (Array.isArray(val) && val.length >= 2) {
        const displayName = String(val[0]);
        const pct = Number(val[1]) || 0;
        aggMap.set(slug.toLowerCase(), {
          name: displayName,
          url: 'https://www.brandtijara.com/brands-on-sale',
          active: true,
          maxDiscount: pct,
          discounts: [`Up to ${pct}% off`],
          saleProductsCount: 0,
          summary: `${displayName} — Up to ${pct}% off (via Brand Tijara)`,
          checkedAt: latestTimestamp,
          source: 'aggregator',
          aggregatorName: 'Brand Tijara',
        });
      }
    }

    const sirenDeals = rawState.salesiren_top_deals || {};
    for (const [slug, val] of Object.entries(sirenDeals)) {
      if (Array.isArray(val) && val.length >= 2) {
        const displayName = String(val[0]);
        const pct = Number(val[1]) || 0;
        const upcoming = Boolean(val[2]);
        const existing = aggMap.get(slug.toLowerCase());
        if (!existing || pct > existing.maxDiscount) {
          aggMap.set(slug.toLowerCase(), {
            name: displayName,
            url: 'https://salesiren.pk/',
            active: !upcoming,
            maxDiscount: pct,
            discounts: [`Up to ${pct}% off`],
            saleProductsCount: 0,
            summary: `${displayName} — Up to ${pct}% off (via Sale Siren${upcoming ? ' · Upcoming' : ''})`,
            checkedAt: latestTimestamp,
            source: 'aggregator',
            aggregatorName: existing ? 'Brand Tijara & Sale Siren' : 'Sale Siren',
            upcoming,
          });
        }
      }
    }

    return {
      trackedBrands: tracked,
      aggregatorBrands: Array.from(aggMap.values()).sort((a, b) => b.maxDiscount - a.maxDiscount),
      lastCheckedGlobal: latestTimestamp,
    };
  }, [brandsList, rawState]);

  // Filtered and sorted brands
  const filteredTracked = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return trackedBrands
      .filter(b => {
        if (q) {
          const hay = `${b.name} ${b.summary} ${b.discounts.join(' ')}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        if (activeSection === 'top-deals') {
          return b.active && b.maxDiscount >= 50;
        }
        if (statusFilter === 'active') return b.active;
        if (statusFilter === 'top50') return b.active && b.maxDiscount >= 50;
        if (statusFilter === 'top60') return b.active && b.maxDiscount >= 60;
        if (statusFilter === 'inactive') return !b.active;
        return true;
      })
      .sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        if (sortBy === 'products') {
          if (b.saleProductsCount !== a.saleProductsCount) {
            return b.saleProductsCount - a.saleProductsCount;
          }
          return b.maxDiscount - a.maxDiscount;
        }
        if (sortBy === 'discount') {
          if (b.maxDiscount !== a.maxDiscount) {
            return b.maxDiscount - a.maxDiscount;
          }
          return b.saleProductsCount - a.saleProductsCount;
        }
        return a.name.localeCompare(b.name);
      });
  }, [trackedBrands, searchQuery, statusFilter, sortBy, activeSection]);

  // Also match aggregator brands when searching a brand name that might not be in trackedBrands
  const matchingAggregatorDeals = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q && activeSection !== 'aggregators') return [];
    return aggregatorBrands.filter(b => !q || b.name.toLowerCase().includes(q));
  }, [aggregatorBrands, searchQuery, activeSection]);

  const activeSaleCount = useMemo(() => trackedBrands.filter(b => b.active).length, [trackedBrands]);
  const totalProductsOnSale = useMemo(
    () => trackedBrands.reduce((acc, b) => acc + (b.active ? b.saleProductsCount : 0), 0),
    [trackedBrands]
  );
  const top50Count = useMemo(
    () => trackedBrands.filter(b => b.active && b.maxDiscount >= 50).length,
    [trackedBrands]
  );
  const topDealCount = useMemo(
    () => trackedBrands.filter(b => b.active && b.maxDiscount >= 60).length,
    [trackedBrands]
  );

  const handleInstallClick = async () => {
    if (isInstallable) {
      await install();
    } else {
      setShowInstallModal(true);
    }
  };

  return (
    <div className="min-h-screen bg-[#0b1220] text-[#edf2f9] pb-24 md:pb-12">
      {/* Top Bar Contract: Zone 1 (Brand) — Zone 2 (Nav Links) — Zone 3 (1 Primary Action) */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-8 px-4 md:px-8 h-14 bg-[#0b1220]/90 backdrop-blur-md border-b border-slate-800/80">
        <a
          href="#top"
          onClick={e => {
            e.preventDefault();
            setActiveSection('brands');
          }}
          className="flex items-center gap-2.5 text-base md:text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0 font-display"
        >
          <img src="/icon.svg" alt="" className="w-7 h-7 rounded-lg shrink-0" />
          <span>SaleMonitor PK</span>
        </a>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
          <button
            type="button"
            onClick={() => setActiveSection('brands')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeSection === 'brands' ? 'text-white underline underline-offset-8 decoration-sky-400 decoration-2' : ''
            }`}
          >
            All Brands
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('top-deals')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeSection === 'top-deals' ? 'text-white underline underline-offset-8 decoration-sky-400 decoration-2' : ''
            }`}
          >
            Top Deals
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('aggregators')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeSection === 'aggregators' ? 'text-white underline underline-offset-8 decoration-sky-400 decoration-2' : ''
            }`}
          >
            Aggregator Deals
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('sync')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeSection === 'sync' ? 'text-white underline underline-offset-8 decoration-sky-400 decoration-2' : ''
            }`}
          >
            GitHub Sync
          </button>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          {!isInstalled ? (
            <button
              type="button"
              onClick={handleInstallClick}
              className="min-h-[40px] px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors flex items-center gap-2 whitespace-nowrap shrink-0"
            >
              <Download className="w-4 h-4" />
              <span>Install App</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => loadSaleState(config, true)}
              disabled={loading}
              className="min-h-[40px] px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors flex items-center gap-2 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              <span>Sync Now</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Content Container */}
      <main className="max-w-7xl mx-auto px-4 md:px-8 pt-6 space-y-6">
        {/* Offline Banner */}
        {!isOnline && (
          <div className="rounded-xl bg-amber-500/15 border border-amber-500/30 px-4 py-3 text-xs text-amber-200 flex items-center justify-between">
            <span>Offline mode — showing last cached sale_state.json snapshot.</span>
          </div>
        )}

        {/* Search & Instant Brand Sale Lookup */}
        <section className="bg-[#111c31] border border-slate-800 rounded-2xl p-4 md:p-6 space-y-5">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-xl md:text-2xl font-bold text-white tracking-tight text-balance">
                Pakistani Brand Sale Status
              </h1>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span>
                  Source:{' '}
                  <strong className="text-slate-200 font-medium">
                    {syncSource === 'github-pat'
                      ? `${config.owner}/${config.repo} (Authenticated PAT)`
                      : syncSource === 'github-public'
                        ? `${config.owner}/${config.repo} (Live GitHub)`
                        : 'Cached sale_state.json'}
                  </strong>
                </span>
                <span aria-hidden="true">·</span>
                <span>Updated {formatRelativeTime(lastCheckedGlobal)}</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => loadSaleState(config, true)}
                disabled={loading}
                className="min-h-[44px] px-4 py-2 text-xs font-medium text-slate-200 bg-[#17243c] hover:bg-slate-800 border border-slate-700/80 rounded-xl transition-colors flex items-center gap-2 whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-sky-400' : 'text-slate-400'}`} />
                <span>Refresh Status</span>
              </button>

              <button
                type="button"
                onClick={handleTriggerGitHubScan}
                disabled={triggeringScan}
                className="min-h-[44px] px-4 py-2 text-xs font-medium text-slate-200 bg-[#17243c] hover:bg-slate-800 border border-slate-700/80 rounded-xl transition-colors flex items-center gap-2 whitespace-nowrap shrink-0"
              >
                <Play className="w-3.5 h-3.5 text-sky-400" />
                <span>{triggeringScan ? 'Requesting…' : 'Run Website Scan'}</span>
              </button>

              <button
                type="button"
                onClick={handleTriggerAdsScan}
                disabled={triggeringAdsScan}
                className="min-h-[44px] px-4 py-2 text-xs font-medium text-slate-200 bg-[#17243c] hover:bg-slate-800 border border-slate-700/80 rounded-xl transition-colors flex items-center gap-2 whitespace-nowrap shrink-0"
              >
                <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                <span>{triggeringAdsScan ? 'Requesting…' : 'Check FB/Google Ads'}</span>
              </button>
            </div>
          </div>

          {/* Search Input Bar */}
          <div className="relative">
            <Search className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search any brand name (e.g. Starlet, Gul Ahmed, Stylo, Khaadi, Baroque)..."
              aria-label="Search brand name"
              className="w-full min-h-[48px] pl-12 pr-12 py-3 bg-[#0b1220] border border-slate-700/80 focus:border-sky-400 focus:outline-none rounded-xl text-sm md:text-base text-white placeholder:text-slate-500 transition-colors"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
                className="min-h-[44px] min-w-[44px] absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* KPI Summary Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
            <div className="bg-[#0b1220]/70 border border-slate-800/90 rounded-xl p-3.5">
              <div className="text-xs text-slate-400">Brands On Sale Now</div>
              <div className="mt-1 text-xl md:text-2xl font-bold text-emerald-400 font-mono-tabular">
                {activeSaleCount} <span className="text-sm font-normal text-slate-500">/ {trackedBrands.length}</span>
              </div>
            </div>
            <div className="bg-[#0b1220]/70 border border-slate-800/90 rounded-xl p-3.5">
              <div className="text-xs text-slate-400">Total Products On Sale</div>
              <div className="mt-1 text-xl md:text-2xl font-bold text-sky-400 font-mono-tabular">
                {totalProductsOnSale.toLocaleString()}
              </div>
            </div>
            <div className="bg-[#0b1220]/70 border border-slate-800/90 rounded-xl p-3.5">
              <div className="text-xs text-slate-400">60%+ Off Top Deals</div>
              <div className="mt-1 text-xl md:text-2xl font-bold text-amber-400 font-mono-tabular">
                {topDealCount}
              </div>
            </div>
            <div className="bg-[#0b1220]/70 border border-slate-800/90 rounded-xl p-3.5">
              <div className="text-xs text-slate-400">Aggregator Deals (50%+)</div>
              <div className="mt-1 text-xl md:text-2xl font-bold text-white font-mono-tabular">
                {aggregatorBrands.length}
              </div>
            </div>
          </div>
        </section>

        {/* Instant Search Answer Banner when user types a brand query */}
        {searchQuery.trim() !== '' && (
          <section className="bg-[#111c31] border border-sky-500/30 rounded-2xl p-4 md:p-5">
            <div className="text-xs text-sky-400 font-medium mb-1">
              Search Results for &ldquo;{searchQuery.trim()}&rdquo;
            </div>
            {filteredTracked.length === 0 && matchingAggregatorDeals.length === 0 ? (
              <p className="text-sm text-slate-300">
                No tracked or aggregator brand matched &ldquo;{searchQuery.trim()}&rdquo;. You can add it in the{' '}
                <button
                  type="button"
                  onClick={() => setActiveSection('sync')}
                  className="text-sky-400 underline underline-offset-4"
                >
                  GitHub Sync
                </button>{' '}
                tab.
              </p>
            ) : (
              <p className="text-sm text-slate-200">
                Found{' '}
                <strong className="font-mono-tabular text-white">
                  {filteredTracked.length + matchingAggregatorDeals.length}
                </strong>{' '}
                matching brand(s) —{' '}
                <strong className="text-emerald-400 font-mono-tabular">
                  {filteredTracked.filter(b => b.active).length + matchingAggregatorDeals.filter(b => b.active).length}
                </strong>{' '}
                currently have an <strong className="text-emerald-400">Active Sale</strong>.
              </p>
            )}
          </section>
        )}

        {/* Section 1 & 2: Tracked Brands & Top Deals */}
        {(activeSection === 'brands' || activeSection === 'top-deals') && (
          <section className="space-y-4">
            {/* Filter & Sort Controls */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              {/* Interactive Filter Buttons */}
              <div className="flex items-center gap-1 p-1 bg-[#111c31] border border-slate-800 rounded-xl overflow-x-auto">
                <button
                  type="button"
                  onClick={() => {
                    setActiveSection('brands');
                    setStatusFilter('all');
                  }}
                  className={`min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    statusFilter === 'all' && activeSection === 'brands'
                      ? 'bg-sky-400 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  All ({trackedBrands.length})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveSection('brands');
                    setStatusFilter('active');
                  }}
                  className={`min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    statusFilter === 'active' && activeSection === 'brands'
                      ? 'bg-sky-400 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  On Sale ({activeSaleCount})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveSection('brands');
                    setStatusFilter('top50');
                  }}
                  className={`min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    statusFilter === 'top50' && activeSection === 'brands'
                      ? 'bg-sky-400 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  50%+ Off ({top50Count})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveSection('brands');
                    setStatusFilter('top60');
                  }}
                  className={`min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    statusFilter === 'top60' || activeSection === 'top-deals'
                      ? 'bg-sky-400 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  60%+ Off ({topDealCount})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveSection('brands');
                    setStatusFilter('inactive');
                  }}
                  className={`min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    statusFilter === 'inactive' && activeSection === 'brands'
                      ? 'bg-sky-400 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  No Active Sale ({trackedBrands.length - activeSaleCount})
                </button>
              </div>

              {/* Sort Selector */}
              <div className="flex items-center gap-2 self-end sm:self-auto">
                <SlidersHorizontal className="w-4 h-4 text-slate-400 shrink-0" />
                <span className="text-xs text-slate-400 whitespace-nowrap">Sort by:</span>
                <div className="flex items-center gap-1 p-1 bg-[#111c31] border border-slate-800 rounded-xl">
                  <button
                    type="button"
                    onClick={() => setSortBy('products')}
                    className={`min-h-[34px] px-2.5 py-1 text-xs rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                      sortBy === 'products' ? 'bg-[#17243c] text-sky-400 font-semibold' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Products Count
                  </button>
                  <button
                    type="button"
                    onClick={() => setSortBy('discount')}
                    className={`min-h-[34px] px-2.5 py-1 text-xs rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                      sortBy === 'discount' ? 'bg-[#17243c] text-sky-400 font-semibold' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Max Discount
                  </button>
                  <button
                    type="button"
                    onClick={() => setSortBy('name')}
                    className={`min-h-[34px] px-2.5 py-1 text-xs rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                      sortBy === 'name' ? 'bg-[#17243c] text-sky-400 font-semibold' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    A–Z
                  </button>
                </div>
              </div>
            </div>

            {/* Brand Cards Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredTracked.map(brand => (
                <article
                  key={brand.name}
                  className="bg-[#111c31] border border-slate-800/90 hover:border-slate-700 rounded-2xl p-5 flex flex-col justify-between gap-4 transition-colors"
                >
                  <div className="space-y-2.5">
                    {/* Top Row: Brand Title + Explicit Icon/Text Status */}
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="text-lg font-bold text-white leading-snug">{brand.name}</h2>
                      {brand.active ? (
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400 shrink-0">
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                          <span>SALE ACTIVE</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-400 shrink-0">
                          <XCircle className="w-4 h-4 shrink-0" />
                          <span>NO ACTIVE SALE</span>
                        </div>
                      )}
                    </div>

                    {/* Unboxed Metadata Line (Zero-Pill Discipline) */}
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300 font-mono-tabular">
                      {brand.maxDiscount > 0 ? (
                        <span className="text-sky-400 font-semibold">Up to {brand.maxDiscount}% OFF</span>
                      ) : brand.active ? (
                        <span className="text-emerald-300">Sale Page Live</span>
                      ) : (
                        <span className="text-slate-500">Regular Pricing</span>
                      )}

                      {brand.saleProductsCount > 0 && (
                        <>
                          <span aria-hidden="true" className="text-slate-600">
                            ·
                          </span>
                          <span className="text-slate-200 font-semibold">
                            {brand.saleProductsCount.toLocaleString()} products on sale
                          </span>
                        </>
                      )}

                      {brand.checkedAt && (
                        <>
                          <span aria-hidden="true" className="text-slate-600">
                            ·
                          </span>
                          <span className="text-slate-400">{formatRelativeTime(brand.checkedAt)}</span>
                        </>
                      )}
                    </div>

                    {/* Detected Discount Tiers */}
                    {brand.discounts.length > 0 && (
                      <p className="text-xs text-slate-300 leading-relaxed">
                        Discounts: <span className="text-white font-medium">{brand.discounts.join(' · ')}</span>
                      </p>
                    )}

                    {/* Clean Summary */}
                    <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed">{brand.summary}</p>

                    {/* Facebook & Google Ads Badge */}
                    {brand.ads && brand.ads.active && (
                      <div className="flex items-center gap-2 text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2.5 py-1.5 rounded-lg">
                        <span>📢 Active Ads:</span>
                        <span className="font-semibold text-white">
                          {brand.ads.meta_count || 0} Meta (FB/IG) · {brand.ads.google_count || 0} Google
                        </span>
                        {brand.ads.discounts && brand.ads.discounts.length > 0 && (
                          <span className="text-blue-300">({brand.ads.discounts.slice(0, 2).join(', ')})</span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Card Footer Action */}
                  <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between gap-2">
                    <span className="text-xs text-slate-400 truncate max-w-[190px]">
                      {brand.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}
                    </span>
                    <a
                      href={brand.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-h-[40px] px-3.5 py-2 rounded-xl bg-[#17243c] hover:bg-sky-400 hover:text-slate-950 text-xs font-semibold text-slate-200 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
                    >
                      <span>Visit Store</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </article>
              ))}
            </div>

            {/* If user searched a query that also matches Aggregator Deals, show them right below */}
            {searchQuery.trim() !== '' && matchingAggregatorDeals.length > 0 && (
              <div className="pt-4 space-y-3">
                <h3 className="text-sm font-semibold text-slate-300">
                  Additional Matches from Brand Tijara &amp; Sale Siren Aggregators ({matchingAggregatorDeals.length})
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {matchingAggregatorDeals.map(deal => (
                    <article
                      key={`${deal.name}-${deal.aggregatorName}`}
                      className="bg-[#111c31] border border-slate-800 rounded-2xl p-4 flex items-center justify-between gap-4"
                    >
                      <div className="space-y-1">
                        <div className="text-base font-bold text-white">{deal.name}</div>
                        <div className="text-xs text-slate-400 font-mono-tabular">
                          <span className="text-sky-400 font-semibold">Up to {deal.maxDiscount}% OFF</span>
                          <span aria-hidden="true"> · </span>
                          <span>via {deal.aggregatorName}</span>
                        </div>
                      </div>
                      <a
                        href={deal.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-h-[40px] px-3 py-2 rounded-xl bg-[#17243c] hover:bg-sky-400 hover:text-slate-950 text-xs font-semibold text-slate-200 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
                      >
                        <span>View</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </article>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {/* Section 3: Aggregator Deals (Brand Tijara & Sale Siren >= 50% off) */}
        {activeSection === 'aggregators' && (
          <section className="space-y-4">
            <div className="bg-[#111c31] border border-slate-800 rounded-2xl p-4 md:p-5">
              <h2 className="text-lg font-bold text-white">
                Aggregator Deals (Brand Tijara &amp; Sale Siren — 50% to 81% OFF)
              </h2>
              <p className="mt-1 text-xs text-slate-400">
                Extracted automatically by <code>monitor.py</code> into <code>sale_state.json</code> across all
                Pakistani brands with 50%+ discounts.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {matchingAggregatorDeals.map(deal => (
                <article
                  key={`${deal.name}-${deal.aggregatorName}`}
                  className="bg-[#111c31] border border-slate-800 rounded-2xl p-5 flex items-center justify-between gap-4"
                >
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      <h3 className="text-base font-bold text-white">{deal.name}</h3>
                    </div>
                    <div className="text-xs text-slate-300 font-mono-tabular">
                      <span className="text-sky-400 font-semibold">Up to {deal.maxDiscount}% OFF</span>
                      <span aria-hidden="true"> · </span>
                      <span className="text-slate-400">{deal.aggregatorName}</span>
                    </div>
                  </div>
                  <a
                    href={deal.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-h-[40px] px-3.5 py-2 rounded-xl bg-[#17243c] hover:bg-sky-400 hover:text-slate-950 text-xs font-semibold text-slate-200 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    <span>Open</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </article>
              ))}
            </div>
          </section>
        )}

        {/* Section 4: GitHub Sync & PAT Configuration + Add Brand */}
        {activeSection === 'sync' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="bg-[#111c31] border border-slate-800 rounded-2xl p-5 md:p-6 space-y-4">
              <div>
                <h2 className="text-lg font-bold text-white">GitHub Repository &amp; PAT Connection</h2>
                <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                  Link directly to <code>state/sale_state.json</code> in your repository. Your PAT is stored only in
                  this browser&apos;s <code>localStorage</code> and lets you trigger live GitHub Action scans or add
                  brands from your phone.
                </p>
              </div>

              <form onSubmit={handleSaveConnection} className="space-y-3.5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="block text-xs text-slate-300 space-y-1">
                    <span>Repository Owner</span>
                    <input
                      type="text"
                      value={ownerInput}
                      onChange={e => setOwnerInput(e.target.value)}
                      required
                      className="w-full min-h-[44px] px-3.5 py-2 bg-[#0b1220] border border-slate-700 rounded-xl text-sm text-white"
                    />
                  </label>
                  <label className="block text-xs text-slate-300 space-y-1">
                    <span>Repository Name</span>
                    <input
                      type="text"
                      value={repoInput}
                      onChange={e => setRepoInput(e.target.value)}
                      required
                      className="w-full min-h-[44px] px-3.5 py-2 bg-[#0b1220] border border-slate-700 rounded-xl text-sm text-white"
                    />
                  </label>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="block text-xs text-slate-300 space-y-1">
                    <span>Branch</span>
                    <input
                      type="text"
                      value={branchInput}
                      onChange={e => setBranchInput(e.target.value)}
                      required
                      className="w-full min-h-[44px] px-3.5 py-2 bg-[#0b1220] border border-slate-700 rounded-xl text-sm text-white"
                    />
                  </label>
                  <label className="block text-xs text-slate-300 space-y-1">
                    <span>GitHub Personal Access Token (PAT)</span>
                    <input
                      type="password"
                      value={tokenInput}
                      onChange={e => setTokenInput(e.target.value)}
                      placeholder="ghp_... or github_pat_..."
                      className="w-full min-h-[44px] px-3.5 py-2 bg-[#0b1220] border border-slate-700 rounded-xl text-sm text-white"
                    />
                  </label>
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-2">
                  <button
                    type="submit"
                    className="min-h-[44px] px-5 py-2.5 rounded-xl bg-sky-400 hover:bg-sky-300 text-slate-950 font-semibold text-xs transition-colors"
                  >
                    Connect &amp; Sync sale_state.json
                  </button>
                  {config.token && (
                    <button
                      type="button"
                      onClick={handleClearToken}
                      className="min-h-[44px] px-4 py-2.5 rounded-xl bg-rose-950/60 hover:bg-rose-900/70 border border-rose-800/60 text-rose-200 font-medium text-xs transition-colors"
                    >
                      Clear Saved Token
                    </button>
                  )}
                </div>
              </form>
            </section>

            {/* Add New Brand to brands.json */}
            <section className="bg-[#111c31] border border-slate-800 rounded-2xl p-5 md:p-6 space-y-4">
              <div>
                <h2 className="text-lg font-bold text-white">Add Brand to Monitor</h2>
                <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                  Commits a new brand directly to <code>brands.json</code> in your GitHub repository (requires PAT with{' '}
                  <strong>Contents: Read &amp; Write</strong>).
                </p>
              </div>

              <form onSubmit={handleAddBrandToGitHub} className="space-y-3.5">
                <label className="block text-xs text-slate-300 space-y-1">
                  <span>Brand Name</span>
                  <input
                    type="text"
                    value={newBrandName}
                    onChange={e => setNewBrandName(e.target.value)}
                    placeholder="e.g. Borjan Shoes"
                    required
                    className="w-full min-h-[44px] px-3.5 py-2 bg-[#0b1220] border border-slate-700 rounded-xl text-sm text-white"
                  />
                </label>
                <label className="block text-xs text-slate-300 space-y-1">
                  <span>Brand Website or Sale URL</span>
                  <input
                    type="url"
                    value={newBrandUrl}
                    onChange={e => setNewBrandUrl(e.target.value)}
                    placeholder="https://www.borjan.com.pk/"
                    required
                    className="w-full min-h-[44px] px-3.5 py-2 bg-[#0b1220] border border-slate-700 rounded-xl text-sm text-white"
                  />
                </label>
                <button
                  type="submit"
                  disabled={addingBrand}
                  className="min-h-[44px] px-5 py-2.5 rounded-xl bg-[#17243c] hover:bg-sky-400 hover:text-slate-950 border border-slate-700 text-white font-semibold text-xs transition-colors flex items-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  <span>{addingBrand ? 'Committing to GitHub…' : 'Add Brand to brands.json'}</span>
                </button>
              </form>
            </section>
          </div>
        )}
      </main>

      {/* Mobile Fixed Bottom Navigation Bar (44px+ touch targets, <= 15% viewport height) */}
      <nav
        aria-label="Mobile Navigation"
        className="md:hidden fixed bottom-0 left-0 right-0 z-30 h-16 bg-[#0b1220]/95 backdrop-blur-md border-t border-slate-800 grid grid-cols-4 items-center px-2"
      >
        <button
          type="button"
          onClick={() => setActiveSection('brands')}
          className={`min-h-[48px] flex flex-col items-center justify-center rounded-xl transition-colors ${
            activeSection === 'brands' ? 'text-sky-400 font-semibold' : 'text-slate-400'
          }`}
        >
          <ShoppingBag className="w-5 h-5" />
          <span className="text-[11px] mt-0.5 whitespace-nowrap">Brands</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveSection('top-deals')}
          className={`min-h-[48px] flex flex-col items-center justify-center rounded-xl transition-colors ${
            activeSection === 'top-deals' ? 'text-sky-400 font-semibold' : 'text-slate-400'
          }`}
        >
          <Sparkles className="w-5 h-5" />
          <span className="text-[11px] mt-0.5 whitespace-nowrap">Top Deals</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveSection('aggregators')}
          className={`min-h-[48px] flex flex-col items-center justify-center rounded-xl transition-colors ${
            activeSection === 'aggregators' ? 'text-sky-400 font-semibold' : 'text-slate-400'
          }`}
        >
          <Globe className="w-5 h-5" />
          <span className="text-[11px] mt-0.5 whitespace-nowrap">Aggregators</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveSection('sync')}
          className={`min-h-[48px] flex flex-col items-center justify-center rounded-xl transition-colors ${
            activeSection === 'sync' ? 'text-sky-400 font-semibold' : 'text-slate-400'
          }`}
        >
          <KeyRound className="w-5 h-5" />
          <span className="text-[11px] mt-0.5 whitespace-nowrap">GitHub PAT</span>
        </button>
      </nav>

      {/* Chrome Mobile / iOS Install Instructions Modal */}
      {showInstallModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl bg-[#111c31] border border-slate-700 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-white">Install on Chrome Mobile</h3>
              <button
                type="button"
                onClick={() => setShowInstallModal(false)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            {isIOS ? (
              <ol className="text-sm text-slate-300 space-y-2 list-decimal list-inside">
                <li>
                  Tap the <strong>Share</strong> icon in your mobile browser bar.
                </li>
                <li>
                  Scroll down and tap <strong>Add to Home Screen</strong>.
                </li>
              </ol>
            ) : (
              <ol className="text-sm text-slate-300 space-y-2 list-decimal list-inside">
                <li>
                  Open this URL directly in <strong>Google Chrome</strong> on your Android phone (e.g. your GitHub Pages
                  link or App URL).
                </li>
                <li>
                  Tap the <strong>⋮ (three-dot menu)</strong> in the top-right corner of Chrome.
                </li>
                <li>
                  Tap <strong>Add to Home screen</strong> or <strong>Install app</strong>.
                </li>
              </ol>
            )}
            <button
              type="button"
              onClick={() => setShowInstallModal(false)}
              className="w-full min-h-[44px] rounded-xl bg-sky-400 text-slate-950 font-semibold text-xs"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* Toast Feedback */}
      {feedbackMessage && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-xs font-medium shadow-xl border ${
            feedbackMessage.type === 'error'
              ? 'bg-rose-950/95 border-rose-700 text-rose-100'
              : 'bg-slate-900/95 border-slate-700 text-white'
          }`}
        >
          {feedbackMessage.text}
        </div>
      )}
    </div>
  );
}
