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
  Flame,
  Radio,
  Tag,
  CreditCard,
  Utensils,
  Smartphone,
  Store,
  Shirt,
  Footprints,
  Wifi,
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

interface BrandAdsItem {
  name: string;
  category: string;
  url: string;
  search_terms?: string;
  keywords?: string[];
}

interface AdCampaignDetail {
  id: string;
  platform: string;
  page_name?: string;
  headline?: string;
  body?: string;
  url?: string;
  publisher_platforms?: string[];
  started_at?: string;
  discounts?: string[];
  max_discount?: number;
  is_sale?: boolean;
}

interface BrandAdState {
  brand: string;
  category?: string;
  url?: string;
  meta_ads_count: number;
  google_ads_count: number;
  sale_ads_count: number;
  has_sale_ads: boolean;
  discounts: string[];
  max_discount: number;
  checked_at?: string;
  top_ads?: AdCampaignDetail[];
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
    category?: string;
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
  category: string;
  url: string;
  active: boolean;
  maxDiscount: number;
  discounts: string[];
  saleProductsCount: number;
  summary: string;
  checkedAt: string;
  source: 'tracked' | 'aggregator' | 'ad_only';
  aggregatorName?: string;
  upcoming?: boolean;
  ads?: {
    active: boolean;
    category?: string;
    meta_count?: number;
    google_count?: number;
    sale_ads_count?: number;
    discounts?: string[];
    max_discount?: number;
    checked_at?: string;
    top_ads?: AdCampaignDetail[];
  };
}

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  'Food & Dining': <Utensils className="w-3.5 h-3.5 text-amber-400" />,
  'Banks & Cards': <CreditCard className="w-3.5 h-3.5 text-emerald-400" />,
  'Fintech & Wallets': <Smartphone className="w-3.5 h-3.5 text-purple-400" />,
  'Marketplaces & Groceries': <Store className="w-3.5 h-3.5 text-rose-400" />,
  'Fashion & Apparel': <Shirt className="w-3.5 h-3.5 text-sky-400" />,
  'Footwear & Leather': <Footprints className="w-3.5 h-3.5 text-teal-400" />,
  'Telecom & Internet': <Wifi className="w-3.5 h-3.5 text-cyan-400" />,
};

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

  const [activeSection, setActiveSection] = useState<'brands' | 'ads' | 'top-deals' | 'aggregators' | 'sync'>('brands');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'ads_only' | 'top50' | 'top60' | 'inactive'>('all');
  const [sortBy, setSortBy] = useState<'products' | 'discount' | 'name'>('discount');

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
  const [brandsAdsList, setBrandsAdsList] = useState<BrandAdsItem[]>([]);
  const [rawState, setRawState] = useState<Record<string, any>>({});
  const [adsState, setAdsState] = useState<Record<string, BrandAdState>>({});
  const [loading, setLoading] = useState(true);
  const [syncSource, setSyncSource] = useState<'github-pat' | 'github-public' | 'local-cache'>('local-cache');
  const [feedbackMessage, setFeedbackMessage] = useState<{ text: string; type: 'info' | 'error' } | null>(null);
  const [showInstallModal, setShowInstallModal] = useState(false);

  // Add brand form state
  const [newBrandName, setNewBrandName] = useState('');
  const [newBrandUrl, setNewBrandUrl] = useState('');
  const [newBrandCategory, setNewBrandCategory] = useState('Fashion & Apparel');
  const [addingBrand, setAddingBrand] = useState(false);
  const [triggeringScan, setTriggeringScan] = useState(false);
  const [triggeringAdsScan, setTriggeringAdsScan] = useState(false);

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

      // Helper to fetch either via GitHub contents or raw or local
      let loadedBrands: BrandConfigItem[] = [];
      let loadedBrandsAds: BrandAdsItem[] = [];
      let loadedSaleState: Record<string, any> = {};
      let loadedAdsState: Record<string, BrandAdState> = {};
      let source: 'github-pat' | 'github-public' | 'local-cache' = 'local-cache';

      try {
        // 1. Try authenticated or public GitHub REST API
        const [brandsRes, adsConfigRes, stateRes, adsStateRes] = await Promise.allSettled([
          fetchFromGitHubContents('brands.json', activeCfg),
          fetchFromGitHubContents('brands_ads.json', activeCfg),
          fetchFromGitHubContents('state/sale_state.json', activeCfg),
          fetchFromGitHubContents('state/ads_state.json', activeCfg),
        ]);

        if (brandsRes.status === 'fulfilled') loadedBrands = brandsRes.value.data?.brands || [];
        if (adsConfigRes.status === 'fulfilled') loadedBrandsAds = adsConfigRes.value.data?.brands || [];
        if (stateRes.status === 'fulfilled') loadedSaleState = stateRes.value.data || {};
        if (adsStateRes.status === 'fulfilled') loadedAdsState = adsStateRes.value.data || {};

        if (loadedBrands.length || loadedBrandsAds.length) {
          source = activeCfg.token.trim() ? 'github-pat' : 'github-public';
        }
      } catch {
        // Continue to raw fallback
      }

      // 2. Try raw fallback if needed
      if (!loadedBrandsAds.length && !loadedBrands.length) {
        try {
          const baseRaw = `https://raw.githubusercontent.com/${activeCfg.owner}/${activeCfg.repo}/${activeCfg.branch}`;
          const [bResp, baResp, sResp, aResp] = await Promise.all([
            fetch(`${baseRaw}/brands.json?_=${Date.now()}`).catch(() => null),
            fetch(`${baseRaw}/brands_ads.json?_=${Date.now()}`).catch(() => null),
            fetch(`${baseRaw}/state/sale_state.json?_=${Date.now()}`).catch(() => null),
            fetch(`${baseRaw}/state/ads_state.json?_=${Date.now()}`).catch(() => null),
          ]);

          if (bResp?.ok) loadedBrands = (await bResp.json())?.brands || [];
          if (baResp?.ok) loadedBrandsAds = (await baResp.json())?.brands || [];
          if (sResp?.ok) loadedSaleState = await sResp.json();
          if (aResp?.ok) loadedAdsState = await aResp.json();

          if (loadedBrands.length || loadedBrandsAds.length) {
            source = 'github-public';
          }
        } catch {
          // Continue to local snapshot
        }
      }

      // 3. Fallback to local snapshot
      if (!loadedBrandsAds.length && !loadedBrands.length) {
        try {
          const [localBrands, localBrandsAds, localState, localAdsState] = await Promise.all([
            fetch('/brands.json').then(r => r.json()).catch(() => ({ brands: [] })),
            fetch('/brands_ads.json').then(r => r.json()).catch(() => ({ brands: [] })),
            fetch('/sale_state.json').then(r => r.json()).catch(() => ({})),
            fetch('/ads_state.json').then(r => r.json()).catch(() => ({})),
          ]);
          loadedBrands = localBrands?.brands || [];
          loadedBrandsAds = localBrandsAds?.brands || [];
          loadedSaleState = localState || {};
          loadedAdsState = localAdsState || {};
          source = 'local-cache';
        } catch (err: any) {
          showToast(err?.message || 'Could not load brands data', 'error');
        }
      }

      setBrandsList(loadedBrands);
      setBrandsAdsList(loadedBrandsAds);
      setRawState(loadedSaleState);
      setAdsState(loadedAdsState);
      setSyncSource(source);

      if (notify) {
        showToast(
          source === 'github-pat'
            ? 'Synced live brand sales & ads via GitHub PAT'
            : source === 'github-public'
              ? 'Synced live brand sales & ads from GitHub'
              : 'Loaded cached sale & ads snapshot'
        );
      }
      setLoading(false);
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

  const handleTriggerAdsScan = async () => {
    if (!config.token.trim()) {
      setActiveSection('sync');
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
      // 1. Add to brands_ads.json
      const currentAds = await fetchFromGitHubContents('brands_ads.json', config).catch(() => null);
      const existingAdsBrands: BrandAdsItem[] = currentAds?.data?.brands || [];
      if (!existingAdsBrands.some(b => b.name.toLowerCase() === name.toLowerCase())) {
        const updatedAds = {
          ...currentAds?.data,
          brands: [
            ...existingAdsBrands,
            {
              name,
              category: newBrandCategory,
              url,
              search_terms: `"${name}" ("sale" OR "discount" OR "offer") Pakistan`,
              keywords: ['sale', 'discount', 'deal', '% off'],
            },
          ],
        };
        await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}/contents/brands_ads.json`, {
          method: 'PUT',
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            Authorization: `Bearer ${config.token.trim()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: `Add ${name} to brands_ads.json [${newBrandCategory}]`,
            content: encodeBase64Unicode(JSON.stringify(updatedAds, null, 2) + '\n'),
            branch: config.branch,
            sha: currentAds?.sha,
          }),
        });
      }

      setNewBrandName('');
      setNewBrandUrl('');
      showToast(`Added ${name} to Pakistan Brand Monitor on GitHub!`);
      await loadSaleState(config, false);
    } catch (err: any) {
      showToast(err?.message || 'Failed to add brand', 'error');
    } finally {
      setAddingBrand(false);
    }
  };

  // Transform rawState + brandsAdsList + brandsList into unified EnrichedBrand records
  const { allBrands, aggregatorBrands, lastCheckedGlobal, categoriesList } = useMemo(() => {
    const list: EnrichedBrand[] = [];
    const brandMap = new Map<string, EnrichedBrand>();
    let latestTimestamp = '';

    // First index from brands_ads.json (the full 96+ brands across all Pakistani sectors)
    for (const item of brandsAdsList) {
      const name = item.name;
      const category = item.category || 'General';
      const adData = adsState[name];
      const websiteData = rawState[name];

      const discounts = Array.isArray(websiteData?.discounts)
        ? websiteData.discounts
        : Array.isArray(adData?.discounts)
          ? adData.discounts
          : [];
      const maxDiscount = Math.max(
        extractMaxDiscount(discounts, websiteData?.summary || ''),
        adData?.max_discount || 0
      );
      const saleProductsCount = extractSaleProductCount(websiteData);
      const hasActiveSale = Boolean(websiteData?.active || saleProductsCount > 0 || maxDiscount > 0);
      const hasActiveAds = Boolean(adData?.has_sale_ads || (adData && (adData.meta_ads_count > 0 || adData.google_ads_count > 0)));

      const brandChecked = websiteData?.checked_at || adData?.checked_at || '';
      if (brandChecked && brandChecked > latestTimestamp) {
        latestTimestamp = brandChecked;
      }

      brandMap.set(name.toLowerCase(), {
        name,
        category,
        url: item.url || websiteData?.url || adData?.url || '',
        active: hasActiveSale || hasActiveAds,
        maxDiscount,
        discounts,
        saleProductsCount,
        summary: websiteData?.summary || (hasActiveAds ? `Active Ads: ${adData?.discounts?.join(' · ') || 'Campaign live'}` : `${name} Official Store`),
        checkedAt: brandChecked,
        source: 'tracked',
        ads: adData
          ? {
              active: adData.has_sale_ads || adData.meta_ads_count > 0 || adData.google_ads_count > 0,
              category: adData.category || category,
              meta_count: adData.meta_ads_count,
              google_count: adData.google_ads_count,
              sale_ads_count: adData.sale_ads_count,
              discounts: adData.discounts,
              max_discount: adData.max_discount,
              checked_at: adData.checked_at,
              top_ads: adData.top_ads,
            }
          : websiteData?.ads,
      });
    }

    // Merge any brands from brands.json that might not be in brands_ads.json
    for (const item of brandsList) {
      if (item.name.includes('Brand Tijara')) continue;
      const key = item.name.toLowerCase();
      if (!brandMap.has(key)) {
        const websiteData = rawState[item.name];
        const adData = adsState[item.name];
        const discounts = Array.isArray(websiteData?.discounts)
          ? websiteData.discounts
          : Array.isArray(adData?.discounts)
            ? adData.discounts
            : [];
        const maxDiscount = Math.max(
          extractMaxDiscount(discounts, websiteData?.summary || ''),
          adData?.max_discount || 0
        );
        const saleProductsCount = extractSaleProductCount(websiteData);
        const hasActiveSale = Boolean(websiteData?.active || saleProductsCount > 0 || maxDiscount > 0);
        const hasActiveAds = Boolean(adData?.has_sale_ads || (adData && (adData.meta_ads_count > 0 || adData.google_ads_count > 0)));
        const brandChecked = websiteData?.checked_at || adData?.checked_at || '';
        if (brandChecked && brandChecked > latestTimestamp) latestTimestamp = brandChecked;

        brandMap.set(key, {
          name: item.name,
          category: 'Fashion & Apparel',
          url: websiteData?.url || item.url,
          active: hasActiveSale || hasActiveAds,
          maxDiscount,
          discounts,
          saleProductsCount,
          summary: websiteData?.summary || item.name,
          checkedAt: brandChecked,
          source: 'tracked',
          ads: websiteData?.ads,
        });
      }
    }

    // Convert map to list
    for (const b of brandMap.values()) {
      list.push(b);
    }

    // Also parse aggregator deals (Brand Tijara & Sale Siren)
    const aggMap = new Map<string, EnrichedBrand>();
    const tijaraDeals = rawState.tijara_top_deals || {};
    for (const [slug, val] of Object.entries(tijaraDeals)) {
      if (Array.isArray(val) && val.length >= 2) {
        const displayName = String(val[0]);
        const pct = Number(val[1]) || 0;
        aggMap.set(slug.toLowerCase(), {
          name: displayName,
          category: 'Fashion & Apparel',
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
            category: 'Fashion & Apparel',
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

    const uniqueCategories = Array.from(new Set(list.map(b => b.category))).filter(Boolean);

    return {
      allBrands: list,
      aggregatorBrands: Array.from(aggMap.values()).sort((a, b) => b.maxDiscount - a.maxDiscount),
      lastCheckedGlobal: latestTimestamp,
      categoriesList: uniqueCategories,
    };
  }, [brandsAdsList, brandsList, rawState, adsState]);

  // Filtered and sorted brands
  const filteredBrands = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allBrands
      .filter(b => {
        // Sector / Category filter
        if (selectedCategory !== 'all' && b.category !== selectedCategory) {
          return false;
        }

        // Query filter
        if (q) {
          const hay = `${b.name} ${b.category} ${b.summary} ${b.discounts.join(' ')}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }

        // Active tab filters
        if (activeSection === 'ads') {
          return b.ads && b.ads.active;
        }
        if (activeSection === 'top-deals') {
          return b.active && b.maxDiscount >= 50;
        }

        if (statusFilter === 'active') return b.active;
        if (statusFilter === 'ads_only') return b.ads && b.ads.active;
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
  }, [allBrands, selectedCategory, searchQuery, statusFilter, sortBy, activeSection]);

  // Matching aggregator deals when searching
  const matchingAggregatorDeals = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q && activeSection !== 'aggregators') return [];
    return aggregatorBrands.filter(b => !q || b.name.toLowerCase().includes(q));
  }, [aggregatorBrands, searchQuery, activeSection]);

  const activeSaleCount = useMemo(() => allBrands.filter(b => b.active).length, [allBrands]);
  const activeAdsCount = useMemo(() => allBrands.filter(b => b.ads && b.ads.active).length, [allBrands]);
  const totalProductsOnSale = useMemo(
    () => allBrands.reduce((acc, b) => acc + (b.active ? b.saleProductsCount : 0), 0),
    [allBrands]
  );
  const top50Count = useMemo(
    () => allBrands.filter(b => b.active && b.maxDiscount >= 50).length,
    [allBrands]
  );
  const topDealCount = useMemo(
    () => allBrands.filter(b => b.active && b.maxDiscount >= 60).length,
    [allBrands]
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
      {/* Header Bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-8 px-4 md:px-8 h-14 bg-[#0b1220]/90 backdrop-blur-md border-b border-slate-800/80">
        <a
          href="#top"
          onClick={e => {
            e.preventDefault();
            setActiveSection('brands');
            setSelectedCategory('all');
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
            All Brands &amp; Deals
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('ads')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 py-1 flex items-center gap-1.5 ${
              activeSection === 'ads' ? 'text-white underline underline-offset-8 decoration-sky-400 decoration-2' : ''
            }`}
          >
            <Radio className="w-3.5 h-3.5 text-blue-400" />
            <span>FB &amp; Google Ads</span>
            {activeAdsCount > 0 && (
              <span className="text-[10px] bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded-full font-mono">
                {activeAdsCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('top-deals')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeSection === 'top-deals' ? 'text-white underline underline-offset-8 decoration-sky-400 decoration-2' : ''
            }`}
          >
            Top Deals (50%+)
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('aggregators')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeSection === 'aggregators' ? 'text-white underline underline-offset-8 decoration-sky-400 decoration-2' : ''
            }`}
          >
            Aggregators
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

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 md:px-8 pt-6 space-y-6">
        {/* Offline Banner */}
        {!isOnline && (
          <div className="rounded-xl bg-amber-500/15 border border-amber-500/30 px-4 py-3 text-xs text-amber-200 flex items-center justify-between">
            <span>Offline mode — showing last cached brand sales &amp; ad snapshot.</span>
          </div>
        )}

        {/* Search & Overview Hero */}
        <section className="bg-[#111c31] border border-slate-800 rounded-2xl p-4 md:p-6 space-y-5">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-xl md:text-2xl font-bold text-white tracking-tight">
                Pakistan Brand Sale &amp; Ad Campaign Monitor
              </h1>
              <p className="text-xs text-slate-400">
                Tracking all major Pakistani brands: Food &amp; Dining, Banks &amp; Card Discounts, Fintech, Supermarkets, Fashion, Footwear, and Telecom on Facebook, Google, and Web.
              </p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 pt-1">
                <span>
                  Source:{' '}
                  <strong className="text-slate-200 font-medium">
                    {syncSource === 'github-pat'
                      ? `${config.owner}/${config.repo} (Authenticated PAT)`
                      : syncSource === 'github-public'
                        ? `${config.owner}/${config.repo} (Live GitHub)`
                        : 'Cached Snapshot'}
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
                onClick={handleTriggerAdsScan}
                disabled={triggeringAdsScan}
                className="min-h-[44px] px-4 py-2 text-xs font-semibold text-blue-200 bg-blue-950/60 hover:bg-blue-900/70 border border-blue-700/80 rounded-xl transition-colors flex items-center gap-2 whitespace-nowrap shrink-0"
              >
                <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                <span>{triggeringAdsScan ? 'Triggering…' : 'Check FB/Google Ads'}</span>
              </button>

              <button
                type="button"
                onClick={handleTriggerGitHubScan}
                disabled={triggeringScan}
                className="min-h-[44px] px-4 py-2 text-xs font-medium text-slate-200 bg-[#17243c] hover:bg-slate-800 border border-slate-700/80 rounded-xl transition-colors flex items-center gap-2 whitespace-nowrap shrink-0"
              >
                <Play className="w-3.5 h-3.5 text-sky-400" />
                <span>{triggeringScan ? 'Triggering…' : 'Run Website Scan'}</span>
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
              placeholder="Search any brand or deal (e.g. KFC, HBL, Bank Alfalah, Cheezious, Daraz, Sapphire, Bata)..."
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

          {/* Sector / Category Filter Strip */}
          <div className="space-y-2 pt-1">
            <div className="text-xs text-slate-400 font-medium">Browse by Sector:</div>
            <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
              <button
                type="button"
                onClick={() => setSelectedCategory('all')}
                className={`min-h-[36px] px-3.5 py-1.5 text-xs font-medium rounded-xl transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 border ${
                  selectedCategory === 'all'
                    ? 'bg-sky-400 text-slate-950 font-semibold border-sky-400'
                    : 'bg-[#0b1220] border-slate-800 text-slate-300 hover:text-white hover:border-slate-700'
                }`}
              >
                <span>All Sectors</span>
                <span className="text-[10px] font-mono opacity-80">({allBrands.length})</span>
              </button>

              {categoriesList.map(cat => {
                const count = allBrands.filter(b => b.category === cat).length;
                const isSelected = selectedCategory === cat;
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setSelectedCategory(cat)}
                    className={`min-h-[36px] px-3.5 py-1.5 text-xs font-medium rounded-xl transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 border ${
                      isSelected
                        ? 'bg-sky-400 text-slate-950 font-semibold border-sky-400'
                        : 'bg-[#0b1220] border-slate-800 text-slate-300 hover:text-white hover:border-slate-700'
                    }`}
                  >
                    {CATEGORY_ICONS[cat] || <Tag className="w-3.5 h-3.5" />}
                    <span>{cat}</span>
                    <span className="text-[10px] font-mono opacity-80">({count})</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* KPI Summary Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
            <div className="bg-[#0b1220]/70 border border-slate-800/90 rounded-xl p-3.5">
              <div className="text-xs text-slate-400">Total Tracked Brands</div>
              <div className="mt-1 text-xl md:text-2xl font-bold text-white font-mono-tabular">
                {allBrands.length} <span className="text-xs font-normal text-slate-500">across 7 sectors</span>
              </div>
            </div>
            <div className="bg-[#0b1220]/70 border border-slate-800/90 rounded-xl p-3.5">
              <div className="text-xs text-slate-400">Brands on Active Sale</div>
              <div className="mt-1 text-xl md:text-2xl font-bold text-emerald-400 font-mono-tabular">
                {activeSaleCount}
              </div>
            </div>
            <div className="bg-[#0b1220]/70 border border-slate-800/90 rounded-xl p-3.5">
              <div className="text-xs text-slate-400">50%+ Off Deals</div>
              <div className="mt-1 text-xl md:text-2xl font-bold text-amber-400 font-mono-tabular">
                {top50Count}
              </div>
            </div>
            <div className="bg-[#0b1220]/70 border border-slate-800/90 rounded-xl p-3.5">
              <div className="text-xs text-slate-400">Active FB / Google Ads</div>
              <div className="mt-1 text-xl md:text-2xl font-bold text-blue-400 font-mono-tabular">
                {activeAdsCount} <span className="text-xs font-normal text-slate-500">campaigns</span>
              </div>
            </div>
          </div>
        </section>

        {/* Instant Search Answer Banner */}
        {searchQuery.trim() !== '' && (
          <section className="bg-[#111c31] border border-sky-500/30 rounded-2xl p-4 md:p-5">
            <div className="text-xs text-sky-400 font-medium mb-1">
              Search Results for &ldquo;{searchQuery.trim()}&rdquo;
            </div>
            {filteredBrands.length === 0 && matchingAggregatorDeals.length === 0 ? (
              <p className="text-sm text-slate-300">
                No tracked brand matched &ldquo;{searchQuery.trim()}&rdquo;. You can add it in the{' '}
                <button
                  type="button"
                  onClick={() => setActiveSection('sync')}
                  className="text-sky-400 underline underline-offset-4"
                >
                  GitHub Sync
                </button>{' '}
                tab to track its sales and ads!
              </p>
            ) : (
              <p className="text-sm text-slate-200">
                Found{' '}
                <strong className="font-mono-tabular text-white">
                  {filteredBrands.length + matchingAggregatorDeals.length}
                </strong>{' '}
                matching brand(s) —{' '}
                <strong className="text-emerald-400 font-mono-tabular">
                  {filteredBrands.filter(b => b.active).length + matchingAggregatorDeals.filter(b => b.active).length}
                </strong>{' '}
                currently have an <strong className="text-emerald-400">Active Sale / Discount</strong>.
              </p>
            )}
          </section>
        )}

        {/* Section: Brands & Ads Grid */}
        {(activeSection === 'brands' || activeSection === 'ads' || activeSection === 'top-deals') && (
          <section className="space-y-4">
            {/* Filter & Sort Controls */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              {/* Status Filter Buttons */}
              <div className="flex items-center gap-1 p-1 bg-[#111c31] border border-slate-800 rounded-xl overflow-x-auto">
                <button
                  type="button"
                  onClick={() => setStatusFilter('all')}
                  className={`min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    statusFilter === 'all'
                      ? 'bg-sky-400 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  All ({allBrands.length})
                </button>
                <button
                  type="button"
                  onClick={() => setStatusFilter('active')}
                  className={`min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    statusFilter === 'active'
                      ? 'bg-sky-400 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  On Sale ({activeSaleCount})
                </button>
                <button
                  type="button"
                  onClick={() => setStatusFilter('top50')}
                  className={`min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    statusFilter === 'top50'
                      ? 'bg-sky-400 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  50%+ Off ({top50Count})
                </button>
                <button
                  type="button"
                  onClick={() => setStatusFilter('ads_only')}
                  className={`min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    statusFilter === 'ads_only'
                      ? 'bg-sky-400 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  Active FB/Google Ads ({activeAdsCount})
                </button>
                <button
                  type="button"
                  onClick={() => setStatusFilter('inactive')}
                  className={`min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    statusFilter === 'inactive'
                      ? 'bg-sky-400 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  Regular ({allBrands.length - activeSaleCount})
                </button>
              </div>

              {/* Sort Selector */}
              <div className="flex items-center gap-2 self-end sm:self-auto">
                <SlidersHorizontal className="w-4 h-4 text-slate-400 shrink-0" />
                <span className="text-xs text-slate-400 whitespace-nowrap">Sort:</span>
                <div className="flex items-center gap-1 p-1 bg-[#111c31] border border-slate-800 rounded-xl">
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
                    onClick={() => setSortBy('products')}
                    className={`min-h-[34px] px-2.5 py-1 text-xs rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                      sortBy === 'products' ? 'bg-[#17243c] text-sky-400 font-semibold' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Products Count
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
              {filteredBrands.map(brand => (
                <article
                  key={brand.name}
                  className="bg-[#111c31] border border-slate-800/90 hover:border-slate-700 rounded-2xl p-5 flex flex-col justify-between gap-4 transition-colors"
                >
                  <div className="space-y-2.5">
                    {/* Top Row: Brand Title + Category + Explicit Status */}
                    <div className="space-y-1.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                          <h2 className="text-lg font-bold text-white leading-snug">{brand.name}</h2>
                          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
                            {CATEGORY_ICONS[brand.category] || <Tag className="w-3 h-3" />}
                            <span>{brand.category}</span>
                          </div>
                        </div>

                        {brand.active ? (
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400 shrink-0">
                            <CheckCircle2 className="w-4 h-4 shrink-0" />
                            <span>SALE ACTIVE</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 shrink-0">
                            <XCircle className="w-4 h-4 shrink-0" />
                            <span>NO ACTIVE SALE</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Metadata Line */}
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300 font-mono-tabular">
                      {brand.maxDiscount > 0 ? (
                        <span className="text-sky-400 font-semibold">Up to {brand.maxDiscount}% OFF</span>
                      ) : brand.active ? (
                        <span className="text-emerald-300">Campaign Live</span>
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

                    {/* Detected Discount Badges */}
                    {brand.discounts.length > 0 && (
                      <p className="text-xs text-slate-300 leading-relaxed">
                        Offers: <span className="text-white font-medium">{brand.discounts.join(' · ')}</span>
                      </p>
                    )}

                    {/* Summary / Notes */}
                    <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed">{brand.summary}</p>

                    {/* Facebook & Google Ads Status Block */}
                    {brand.ads && (
                      <div className="p-2.5 rounded-xl bg-[#0b1220]/70 border border-slate-800 space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-blue-400 font-medium flex items-center gap-1">
                            <Radio className="w-3 h-3" />
                            FB &amp; Google Ads
                          </span>
                          <span className="font-mono text-slate-300">
                            {brand.ads.meta_count || 0} Meta · {brand.ads.google_count || 0} Google
                          </span>
                        </div>
                        {brand.ads.discounts && brand.ads.discounts.length > 0 && (
                          <div className="text-[11px] text-blue-300 font-mono">
                            Ad Deals: {brand.ads.discounts.join(', ')}
                          </div>
                        )}
                        {brand.ads.top_ads && brand.ads.top_ads.length > 0 && (
                          <div className="pt-1 text-[11px] text-slate-400 line-clamp-1 border-t border-slate-800">
                            Latest: &ldquo;{brand.ads.top_ads[0].headline}&rdquo;
                          </div>
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
                      <span>Visit Brand / Offer</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </article>
              ))}
            </div>

            {/* Additional Matches from Aggregators */}
            {searchQuery.trim() !== '' && matchingAggregatorDeals.length > 0 && (
              <div className="pt-4 space-y-3">
                <h3 className="text-sm font-semibold text-slate-300">
                  Additional Matches from Aggregators ({matchingAggregatorDeals.length})
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

        {/* Section: Aggregator Deals (Brand Tijara & Sale Siren >= 50% off) */}
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

        {/* Section: GitHub Sync & PAT Configuration + Add Brand */}
        {activeSection === 'sync' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="bg-[#111c31] border border-slate-800 rounded-2xl p-5 md:p-6 space-y-4">
              <div>
                <h2 className="text-lg font-bold text-white">GitHub Repository &amp; PAT Connection</h2>
                <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                  Link directly to <code>state/sale_state.json</code> and <code>state/ads_state.json</code> in your repository. Your PAT is stored only in
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
                    Connect &amp; Sync State
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

            {/* Add New Brand */}
            <section className="bg-[#111c31] border border-slate-800 rounded-2xl p-5 md:p-6 space-y-4">
              <div>
                <h2 className="text-lg font-bold text-white">Add Brand to Pakistan Monitor</h2>
                <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                  Adds a brand into <code>brands_ads.json</code> in your GitHub repository for continuous Facebook &amp; Google Ads and website tracking.
                </p>
              </div>

              <form onSubmit={handleAddBrandToGitHub} className="space-y-3.5">
                <label className="block text-xs text-slate-300 space-y-1">
                  <span>Brand Name</span>
                  <input
                    type="text"
                    value={newBrandName}
                    onChange={e => setNewBrandName(e.target.value)}
                    placeholder="e.g. Gloria Jean's Pakistan"
                    required
                    className="w-full min-h-[44px] px-3.5 py-2 bg-[#0b1220] border border-slate-700 rounded-xl text-sm text-white"
                  />
                </label>
                <label className="block text-xs text-slate-300 space-y-1">
                  <span>Sector / Category</span>
                  <select
                    value={newBrandCategory}
                    onChange={e => setNewBrandCategory(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 py-2 bg-[#0b1220] border border-slate-700 rounded-xl text-sm text-white"
                  >
                    <option value="Food & Dining">Food &amp; Dining (QSR / Restaurants / Delivery)</option>
                    <option value="Banks & Cards">Banks &amp; Cards (Card Deals / Dining Offers)</option>
                    <option value="Fintech & Wallets">Fintech &amp; Digital Wallets</option>
                    <option value="Marketplaces & Groceries">Marketplaces &amp; Supermarkets</option>
                    <option value="Fashion & Apparel">Fashion &amp; Apparel</option>
                    <option value="Footwear & Leather">Footwear &amp; Leather</option>
                    <option value="Telecom & Internet">Telecom &amp; Internet</option>
                  </select>
                </label>
                <label className="block text-xs text-slate-300 space-y-1">
                  <span>Website URL</span>
                  <input
                    type="url"
                    value={newBrandUrl}
                    onChange={e => setNewBrandUrl(e.target.value)}
                    placeholder="https://example.com.pk/"
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
                  <span>{addingBrand ? 'Committing to GitHub…' : 'Add Brand to Monitor'}</span>
                </button>
              </form>
            </section>
          </div>
        )}
      </main>

      {/* Mobile Fixed Bottom Navigation */}
      <nav
        aria-label="Mobile Navigation"
        className="md:hidden fixed bottom-0 left-0 right-0 z-30 h-16 bg-[#0b1220]/95 backdrop-blur-md border-t border-slate-800 grid grid-cols-5 items-center px-1"
      >
        <button
          type="button"
          onClick={() => {
            setActiveSection('brands');
            setSelectedCategory('all');
          }}
          className={`min-h-[48px] flex flex-col items-center justify-center rounded-xl transition-colors ${
            activeSection === 'brands' ? 'text-sky-400 font-semibold' : 'text-slate-400'
          }`}
        >
          <ShoppingBag className="w-5 h-5" />
          <span className="text-[10px] mt-0.5 whitespace-nowrap">Brands</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveSection('ads')}
          className={`min-h-[48px] flex flex-col items-center justify-center rounded-xl transition-colors ${
            activeSection === 'ads' ? 'text-blue-400 font-semibold' : 'text-slate-400'
          }`}
        >
          <Radio className="w-5 h-5" />
          <span className="text-[10px] mt-0.5 whitespace-nowrap">Ads</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveSection('top-deals')}
          className={`min-h-[48px] flex flex-col items-center justify-center rounded-xl transition-colors ${
            activeSection === 'top-deals' ? 'text-sky-400 font-semibold' : 'text-slate-400'
          }`}
        >
          <Sparkles className="w-5 h-5" />
          <span className="text-[10px] mt-0.5 whitespace-nowrap">Deals</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveSection('aggregators')}
          className={`min-h-[48px] flex flex-col items-center justify-center rounded-xl transition-colors ${
            activeSection === 'aggregators' ? 'text-sky-400 font-semibold' : 'text-slate-400'
          }`}
        >
          <Globe className="w-5 h-5" />
          <span className="text-[10px] mt-0.5 whitespace-nowrap">Aggregator</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveSection('sync')}
          className={`min-h-[48px] flex flex-col items-center justify-center rounded-xl transition-colors ${
            activeSection === 'sync' ? 'text-sky-400 font-semibold' : 'text-slate-400'
          }`}
        >
          <KeyRound className="w-5 h-5" />
          <span className="text-[10px] mt-0.5 whitespace-nowrap">Sync</span>
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
                  Open this URL directly in <strong>Google Chrome</strong> on your Android phone.
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
