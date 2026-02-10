import { useState, useEffect, useMemo, useCallback } from "react";
import { LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis } from "recharts";
import { Search, TrendingUp, TrendingDown, Star, StarOff, Eye, Filter, RefreshCw, Zap, MessageCircle, Youtube, ExternalLink, AlertTriangle, ChevronRight, ChevronDown, ArrowUpRight, ArrowDownRight, Minus, BarChart3, Layers, Newspaper, BookmarkPlus, Settings, X, Clock, DollarSign, Activity, Target, Flame, Shield, Award } from "lucide-react";

// ============================================================
// SCORING ALGORITHM
// ============================================================
const calculatePriceAlpha = (card) => {
  const { currentPrice, avg30d, avg90d, low52w, high52w, sources } = card.pricing;
  let score = 50;
  const pctBelow30d = ((avg30d - currentPrice) / avg30d) * 100;
  const pctBelow90d = ((avg90d - currentPrice) / avg90d) * 100;
  score += Math.min(25, Math.max(-25, pctBelow30d * 1.5));
  score += Math.min(15, Math.max(-15, pctBelow90d * 0.8));
  const rangePct = high52w > low52w ? ((currentPrice - low52w) / (high52w - low52w)) * 100 : 50;
  if (rangePct < 30) score += 10;
  else if (rangePct > 80) score -= 10;
  if (sources) {
    const prices = Object.values(sources).filter(Boolean);
    if (prices.length > 1) {
      const spread = (Math.max(...prices) - Math.min(...prices)) / Math.min(...prices) * 100;
      if (spread > 15) score += 5;
    }
  }
  return Math.max(0, Math.min(100, Math.round(score)));
};

const calculateSentimentScore = (card) => {
  const { redditMentions, redditSentiment, youtubeMentions, trendDirection } = card.sentiment;
  let score = 50;
  score += Math.min(20, (redditMentions / 10) * 5);
  score += (redditSentiment - 0.5) * 40;
  score += Math.min(10, (youtubeMentions / 5) * 3);
  if (trendDirection === "up") score += 10;
  else if (trendDirection === "down") score -= 10;
  return Math.max(0, Math.min(100, Math.round(score)));
};

const calculateLeakCatalyst = (card) => {
  const { leakMentions, metaRelevance, reprintRisk, upcomingSetSynergy } = card.leaks;
  let score = 40;
  score += leakMentions * 8;
  score += metaRelevance * 15;
  score -= reprintRisk * 20;
  score += upcomingSetSynergy * 12;
  return Math.max(0, Math.min(100, Math.round(score)));
};

const calculateAlphaScore = (card) => {
  const price = calculatePriceAlpha(card);
  const sentiment = calculateSentimentScore(card);
  const leak = calculateLeakCatalyst(card);
  return {
    price, sentiment, leak,
    combined: Math.round(price * 0.40 + sentiment * 0.35 + leak * 0.25),
  };
};

// ============================================================
// DEMO DATA
// ============================================================
const generatePriceHistory = (current, volatility, days = 90) => {
  const data = [];
  let price = current * (1 + (Math.random() - 0.3) * 0.4);
  for (let i = days; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    price = Math.max(price * 0.5, price + (Math.random() - 0.48) * volatility);
    data.push({
      date: date.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      tcgplayer: +(price * (1 + (Math.random() - 0.5) * 0.06)).toFixed(2),
      ebaySold: +(price * (1 + (Math.random() - 0.5) * 0.1)).toFixed(2),
    });
  }
  return data;
};

const DEMO_CARDS = [
  {
    id: "mev1-SAR1", name: "Mega Gengar ex SAR", set: "Ascended Heroes", number: "SAR/???",
    rarity: "Special Art Rare", type: "Psychic", image: "👻",
    pricing: { currentPrice: 462.00, avg30d: 395.00, avg90d: null, low52w: 340.00, high52w: 510.00, sources: { tcgplayer: 462.00, ebaySold: 478.00 }, graded: { psa10: 2200.00, bgs95: 1850.00, cgc10: 1600.00 } },
    sentiment: { redditMentions: 95, redditSentiment: 0.92, youtubeMentions: 38, trendDirection: "up" },
    leaks: { leakMentions: 5, metaRelevance: 3, reprintRisk: 0.05, upcomingSetSynergy: 4 },
    priceHistory: null,
  },
  {
    id: "mev1-SAR2", name: "Mega Lucario ex SAR", set: "Ascended Heroes", number: "SAR/???",
    rarity: "Special Art Rare", type: "Fighting", image: "💪",
    pricing: { currentPrice: 318.00, avg30d: 280.00, avg90d: null, low52w: 245.00, high52w: 350.00, sources: { tcgplayer: 318.00, ebaySold: 330.00 }, graded: { psa10: 1500.00, bgs95: 1250.00, cgc10: 1100.00 } },
    sentiment: { redditMentions: 72, redditSentiment: 0.88, youtubeMentions: 30, trendDirection: "up" },
    leaks: { leakMentions: 4, metaRelevance: 4, reprintRisk: 0.05, upcomingSetSynergy: 5 },
    priceHistory: null,
  },
  {
    id: "mev1-SAR3", name: "Mega Dragonite ex SAR", set: "Ascended Heroes", number: "SAR/???",
    rarity: "Special Art Rare", type: "Dragon", image: "🐉",
    pricing: { currentPrice: 396.00, avg30d: 350.00, avg90d: null, low52w: 290.00, high52w: 425.00, sources: { tcgplayer: 396.00, ebaySold: 408.00 }, graded: { psa10: 1900.00, bgs95: 1600.00, cgc10: 1400.00 } },
    sentiment: { redditMentions: 68, redditSentiment: 0.86, youtubeMentions: 28, trendDirection: "up" },
    leaks: { leakMentions: 3, metaRelevance: 3, reprintRisk: 0.05, upcomingSetSynergy: 4 },
    priceHistory: null,
  },
  {
    id: "swsh4-44", name: "Pikachu VMAX", set: "Vivid Voltage", number: "44/185",
    rarity: "Secret Rare", type: "Lightning", image: "⚡",
    pricing: { currentPrice: 345.00, avg30d: 320.00, avg90d: 310.00, low52w: 235.00, high52w: 410.00, sources: { tcgplayer: 345.00, ebaySold: 360.00 }, graded: { psa10: 1950.00, bgs95: 1700.00, cgc10: 1480.00 } },
    sentiment: { redditMentions: 55, redditSentiment: 0.84, youtubeMentions: 22, trendDirection: "up" },
    leaks: { leakMentions: 0, metaRelevance: 1, reprintRisk: 0.1, upcomingSetSynergy: 1 },
    priceHistory: null,
  },
  {
    id: "swsh7-TG30", name: "Umbreon VMAX", set: "Evolving Skies", number: "TG30/TG30",
    rarity: "Trainer Gallery", type: "Dark", image: "🌙",
    pricing: { currentPrice: 205.00, avg30d: 225.00, avg90d: 240.00, low52w: 180.00, high52w: 330.00, sources: { tcgplayer: 205.00, ebaySold: 218.00 }, graded: { psa10: 1150.00, bgs95: 980.00, cgc10: 880.00 } },
    sentiment: { redditMentions: 42, redditSentiment: 0.80, youtubeMentions: 18, trendDirection: "up" },
    leaks: { leakMentions: 1, metaRelevance: 2, reprintRisk: 0.15, upcomingSetSynergy: 2 },
    priceHistory: null,
  },
  {
    id: "sv3-125", name: "Charizard ex", set: "Obsidian Flames", number: "125/197",
    rarity: "Special Art Rare", type: "Fire", image: "🔥",
    pricing: { currentPrice: 72.00, avg30d: 95.00, avg90d: 110.00, low52w: 65.00, high52w: 185.00, sources: { tcgplayer: 72.00, ebaySold: 78.00 }, graded: { psa10: 420.00, bgs95: 360.00, cgc10: 320.00 } },
    sentiment: { redditMentions: 48, redditSentiment: 0.68, youtubeMentions: 15, trendDirection: "down" },
    leaks: { leakMentions: 2, metaRelevance: 4, reprintRisk: 0.2, upcomingSetSynergy: 2 },
    priceHistory: null,
  },
  {
    id: "sv2-191", name: "Iono SAR", set: "Paldea Evolved", number: "191/193",
    rarity: "Special Art Rare", type: "Trainer", image: "💜",
    pricing: { currentPrice: 58.00, avg30d: 72.00, avg90d: 82.00, low52w: 50.00, high52w: 130.00, sources: { tcgplayer: 58.00, ebaySold: 62.00 }, graded: { psa10: 290.00, bgs95: 250.00, cgc10: 215.00 } },
    sentiment: { redditMentions: 52, redditSentiment: 0.78, youtubeMentions: 20, trendDirection: "down" },
    leaks: { leakMentions: 2, metaRelevance: 5, reprintRisk: 0.55, upcomingSetSynergy: 2 },
    priceHistory: null,
  },
  {
    id: "sv3pt5-207", name: "Mew ex SAR", set: "Scarlet & Violet 151", number: "207/165",
    rarity: "Special Art Rare", type: "Psychic", image: "🧬",
    pricing: { currentPrice: 82.00, avg30d: 88.00, avg90d: 96.00, low52w: 62.00, high52w: 145.00, sources: { tcgplayer: 82.00, ebaySold: 86.00 }, graded: { psa10: 410.00, bgs95: 350.00, cgc10: 305.00 } },
    sentiment: { redditMentions: 48, redditSentiment: 0.80, youtubeMentions: 18, trendDirection: "up" },
    leaks: { leakMentions: 2, metaRelevance: 3, reprintRisk: 0.2, upcomingSetSynergy: 3 },
    priceHistory: null,
  },
  {
    id: "sv4-228", name: "Charizard ex SAR", set: "Paradox Rift", number: "228/182",
    rarity: "Special Art Rare", type: "Fire", image: "🔥",
    pricing: { currentPrice: 88.00, avg30d: 105.00, avg90d: 122.00, low52w: 78.00, high52w: 175.00, sources: { tcgplayer: 88.00, ebaySold: 94.00 }, graded: { psa10: 520.00, bgs95: 440.00, cgc10: 385.00 } },
    sentiment: { redditMentions: 55, redditSentiment: 0.72, youtubeMentions: 18, trendDirection: "down" },
    leaks: { leakMentions: 2, metaRelevance: 3, reprintRisk: 0.15, upcomingSetSynergy: 2 },
    priceHistory: null,
  },
  {
    id: "sv8a-IR1", name: "Umbreon ex SAR", set: "Prismatic Evolutions", number: "IR/???",
    rarity: "Special Art Rare", type: "Dark", image: "🌑",
    pricing: { currentPrice: 155.00, avg30d: 185.00, avg90d: 210.00, low52w: 140.00, high52w: 280.00, sources: { tcgplayer: 155.00, ebaySold: 162.00 }, graded: { psa10: 850.00, bgs95: 720.00, cgc10: 630.00 } },
    sentiment: { redditMentions: 65, redditSentiment: 0.75, youtubeMentions: 24, trendDirection: "down" },
    leaks: { leakMentions: 3, metaRelevance: 2, reprintRisk: 0.65, upcomingSetSynergy: 1 },
    priceHistory: null,
  },
  {
    id: "sv4pt5-162", name: "Arceus VSTAR Gold", set: "Paldean Fates", number: "162/091",
    rarity: "Gold Rare", type: "Colorless", image: "✨",
    pricing: { currentPrice: 32.00, avg30d: 36.00, avg90d: 42.00, low52w: 22.00, high52w: 65.00, sources: { tcgplayer: 32.00, ebaySold: 35.00 }, graded: { psa10: 140.00, bgs95: 115.00, cgc10: 98.00 } },
    sentiment: { redditMentions: 18, redditSentiment: 0.62, youtubeMentions: 6, trendDirection: "up" },
    leaks: { leakMentions: 0, metaRelevance: 2, reprintRisk: 0.3, upcomingSetSynergy: 1 },
    priceHistory: null,
  },
  {
    id: "mev1-RMT", name: "Rocket's Mewtwo ex SAR", set: "Ascended Heroes", number: "SAR/???",
    rarity: "Special Art Rare", type: "Psychic", image: "🟣",
    pricing: { currentPrice: 285.00, avg30d: 260.00, avg90d: null, low52w: 220.00, high52w: 320.00, sources: { tcgplayer: 285.00, ebaySold: 298.00 }, graded: { psa10: 1350.00, bgs95: 1150.00, cgc10: 1000.00 } },
    sentiment: { redditMentions: 82, redditSentiment: 0.90, youtubeMentions: 32, trendDirection: "up" },
    leaks: { leakMentions: 4, metaRelevance: 3, reprintRisk: 0.05, upcomingSetSynergy: 4 },
    priceHistory: null,
  },
].map(card => ({
  ...card,
  priceHistory: generatePriceHistory(card.pricing.currentPrice, card.pricing.currentPrice * 0.03),
  alpha: null,
})).map(card => ({ ...card, alpha: calculateAlphaScore(card) }));

const DEMO_LEAKS = [
  { id: 1, source: "PokeBeach", title: "Mega Zygarde ex & Mega Starmie ex Revealed for 'Perfect Order'", date: "3h ago", impact: "high", pokemon: ["Zygarde", "Starmie"], url: "#", summary: "Japanese leaks reveal Mega Zygarde ex and Mega Starmie ex as chase cards in Perfect Order, dropping March 27. First-ever Mega Evolution TCG cards for both." },
  { id: 2, source: "Pokemon.com", title: "April 10 Standard Rotation: G-Regulation Cards Leaving Format", date: "6h ago", impact: "high", pokemon: ["Multiple"], url: "#", summary: "Official rotation confirmed: all G-regulation mark cards (Scarlet & Violet base through Paradox Rift) become illegal April 10. Only H, I, J marks remain legal." },
  { id: 3, source: "PokemonBlog", title: "Toronto Regional: Gardevoir ex/Jellicent ex Takes the Crown", date: "10h ago", impact: "medium", pokemon: ["Gardevoir"], url: "#", summary: "Giovanny Sasso piloted Gardevoir ex/Jellicent ex to a 15-2-1 record at Toronto Regionals (2,270 Masters). Raging Bolt ex and Dragapult ex rounded out top 3." },
  { id: 4, source: "PokeBeach", title: "First Partner Illustration Collections — Full Promo List Leaked", date: "14h ago", impact: "high", pokemon: ["Bulbasaur", "Charmander", "Squirtle"], url: "#", summary: "All 9 Illustration Rare starter promos for the 30th Anniversary collection revealed. Series 1 covers Kanto, Sinnoh, and Alola starters — releasing March 30." },
  { id: 5, source: "PokeBeach", title: "Mega Gengar ex SAR Confirmed as Ultra Premium Pull", date: "1d ago", impact: "high", pokemon: ["Gengar"], url: "#", summary: "Mega Gengar ex SAR from Ascended Heroes already hitting $460+ in early sales. Expected to be the chase card of the Mega Evolution era." },
  { id: 6, source: "PokemonBlog", title: "Prismatic Evolutions Reprint Wave Hitting Shelves Now", date: "1d ago", impact: "medium", pokemon: ["Eevee", "Umbreon"], url: "#", summary: "New Prismatic Evolutions reprint stock appearing at retailers. Expect short-term price dip on singles as supply increases." },
  { id: 7, source: "Pokemon.com", title: "Europe International Championships This Weekend in London", date: "2d ago", impact: "medium", pokemon: ["Multiple"], url: "#", summary: "$240K prize pool at 2026 EUIC. Note: Ascended Heroes NOT legal for this event — legality pushed to post-EUIC." },
  { id: 8, source: "PokeBeach", title: "Pokémon Day 2026 Exclusive Bulbasaur Promo — Single Print Run", date: "3d ago", impact: "low", pokemon: ["Bulbasaur"], url: "#", summary: "Reverse holo Bulbasaur promo stamped 'Pokémon Day 2026' will be League-exclusive with no reprint planned. Feb 27 distribution." },
];

const DEMO_SENTIMENT = [
  { id: 1, platform: "reddit", author: "u/TCGInvestor99", title: "Mega Gengar ex SAR already at $460 — is Ascended Heroes the next Evolving Skies?", score: 412, comments: 103, sentiment: 0.88, time: "1h ago", url: "#" },
  { id: 2, platform: "reddit", author: "u/PokemonCollector", title: "April rotation is going to CRUSH G-regulation singles — sell now or hold?", score: 287, comments: 94, sentiment: 0.45, time: "3h ago", url: "#" },
  { id: 3, platform: "youtube", author: "Pokemon TCG Radio", title: "Perfect Order Full Set Breakdown — 4 NEW Mega Evolutions!", views: "89K", sentiment: 0.82, time: "5h ago", url: "#" },
  { id: 4, platform: "reddit", author: "u/CardFlipKing", title: "Prismatic Evolutions reprint hitting stores — buy the dip on Umbreon ex SAR?", score: 198, comments: 67, sentiment: 0.72, time: "7h ago", url: "#" },
  { id: 5, platform: "youtube", author: "TCA Gaming", title: "Top 10 Cards to Buy BEFORE April Rotation Hits", views: "152K", sentiment: 0.74, time: "9h ago", url: "#" },
  { id: 6, platform: "reddit", author: "u/VintagePokeCollector", title: "Paldean Fates sealed is the play — post-rotation packs could hit $20+", score: 234, comments: 71, sentiment: 0.83, time: "11h ago", url: "#" },
  { id: 7, platform: "youtube", author: "PokéRev", title: "Pokémon 30th Anniversary: Which Cards Will MOON? 🌙", views: "73K", sentiment: 0.78, time: "1d ago", url: "#" },
  { id: 8, platform: "reddit", author: "u/MetaAnalyst", title: "Post-Toronto meta: Gardevoir ex/Jellicent is Tier 0 — what does this mean for EUIC?", score: 321, comments: 88, sentiment: 0.71, time: "1d ago", url: "#" },
];

// ============================================================
// UTILITY COMPONENTS
// ============================================================
const ScoreBadge = ({ score, size = "md" }) => {
  const bg = score >= 75 ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" :
    score >= 55 ? "bg-amber-500/20 text-amber-400 border-amber-500/30" :
    "bg-red-500/20 text-red-400 border-red-500/30";
  const sz = size === "lg" ? "text-2xl px-4 py-2 font-bold" : size === "sm" ? "text-xs px-2 py-0.5" : "text-sm px-2.5 py-1 font-semibold";
  return <span className={`${bg} ${sz} rounded-lg border inline-flex items-center gap-1`}>{score}</span>;
};

const PriceChange = ({ current, previous }) => {
  const pct = ((current - previous) / previous * 100).toFixed(1);
  const isUp = current >= previous;
  return (
    <span className={`inline-flex items-center gap-0.5 text-sm ${isUp ? "text-emerald-400" : "text-red-400"}`}>
      {isUp ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
      {isUp ? "+" : ""}{pct}%
    </span>
  );
};

const SourceBadge = ({ source }) => {
  const colors = {
    PokeBeach: "bg-blue-500/20 text-blue-400",
    PokemonBlog: "bg-purple-500/20 text-purple-400",
    "Pokemon.com": "bg-yellow-500/20 text-yellow-400",
  };
  return <span className={`text-xs px-2 py-0.5 rounded-full ${colors[source] || "bg-gray-500/20 text-gray-400"}`}>{source}</span>;
};

const ImpactBadge = ({ impact }) => {
  const c = impact === "high" ? "bg-red-500/20 text-red-400" : impact === "medium" ? "bg-amber-500/20 text-amber-400" : "bg-gray-500/20 text-gray-400";
  return <span className={`text-xs px-2 py-0.5 rounded-full uppercase tracking-wider font-medium ${c}`}>{impact}</span>;
};

const TypeBadge = ({ type }) => {
  const colors = {
    Fire: "bg-orange-500/20 text-orange-400", Lightning: "bg-yellow-500/20 text-yellow-300",
    Dark: "bg-purple-500/20 text-purple-400", Colorless: "bg-gray-500/20 text-gray-300",
    Psychic: "bg-pink-500/20 text-pink-400", Dragon: "bg-indigo-500/20 text-indigo-400",
    Trainer: "bg-teal-500/20 text-teal-400", Water: "bg-cyan-500/20 text-cyan-400",
  };
  return <span className={`text-xs px-2 py-0.5 rounded-full ${colors[type] || "bg-gray-500/20 text-gray-400"}`}>{type}</span>;
};

// ============================================================
// MAIN APP
// ============================================================
export default function PokemonTCGAlpha() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [selectedCard, setSelectedCard] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [watchlist, setWatchlist] = useState(new Set(["sv3-125", "swsh7-TG30", "sv2-191"]));
  const [sortBy, setSortBy] = useState("alpha");
  const [filterType, setFilterType] = useState("all");
  const [showSettings, setShowSettings] = useState(false);
  const [weights, setWeights] = useState({ price: 0.40, sentiment: 0.35, leak: 0.25 });
  const [backendStatus, setBackendStatus] = useState("demo");

  const cards = useMemo(() => {
    let filtered = DEMO_CARDS.filter(c =>
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.set.toLowerCase().includes(searchQuery.toLowerCase())
    );
    if (filterType !== "all") filtered = filtered.filter(c => c.type === filterType);
    const sorted = [...filtered];
    if (sortBy === "alpha") sorted.sort((a, b) => b.alpha.combined - a.alpha.combined);
    else if (sortBy === "price") sorted.sort((a, b) => b.pricing.currentPrice - a.pricing.currentPrice);
    else if (sortBy === "sentiment") sorted.sort((a, b) => b.alpha.sentiment - a.alpha.sentiment);
    else if (sortBy === "change") sorted.sort((a, b) => {
      const aChg = (a.pricing.currentPrice - a.pricing.avg30d) / a.pricing.avg30d;
      const bChg = (b.pricing.currentPrice - b.pricing.avg30d) / b.pricing.avg30d;
      return aChg - bChg;
    });
    return sorted;
  }, [searchQuery, sortBy, filterType]);

  const toggleWatchlist = useCallback((id) => {
    setWatchlist(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const topAlpha = useMemo(() => [...DEMO_CARDS].sort((a, b) => b.alpha.combined - a.alpha.combined).slice(0, 5), []);
  const biggestDips = useMemo(() => [...DEMO_CARDS].sort((a, b) =>
    ((a.pricing.currentPrice - a.pricing.avg30d) / a.pricing.avg30d) -
    ((b.pricing.currentPrice - b.pricing.avg30d) / b.pricing.avg30d)
  ).slice(0, 5), []);

  const watchlistCards = useMemo(() => DEMO_CARDS.filter(c => watchlist.has(c.id)), [watchlist]);

  // Card detail view
  if (selectedCard) {
    const card = DEMO_CARDS.find(c => c.id === selectedCard);
    if (!card) return null;
    const radarData = [
      { metric: "Price Alpha", value: card.alpha.price },
      { metric: "Sentiment", value: card.alpha.sentiment },
      { metric: "Leak Catalyst", value: card.alpha.leak },
      { metric: "Volume", value: Math.min(100, card.sentiment.redditMentions + card.sentiment.youtubeMentions) },
      { metric: "Liquidity", value: 65 + Math.random() * 20 },
    ];
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100">
        <div className="max-w-7xl mx-auto p-4 sm:p-6">
          <button onClick={() => setSelectedCard(null)} className="flex items-center gap-2 text-gray-400 hover:text-white mb-6 transition-colors">
            <ChevronRight className="w-4 h-4 rotate-180" /> Back to {activeTab === "watchlist" ? "Watchlist" : "Scanner"}
          </button>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Card Info */}
            <div className="lg:col-span-1 space-y-4">
              <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800">
                <div className="text-6xl text-center mb-4">{card.image}</div>
                <h1 className="text-2xl font-bold text-center">{card.name}</h1>
                <p className="text-gray-400 text-center mt-1">{card.set} · {card.number}</p>
                <div className="flex justify-center gap-2 mt-3">
                  <TypeBadge type={card.type} />
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-300">{card.rarity}</span>
                </div>
                <div className="mt-6 text-center">
                  <p className="text-sm text-gray-400">Alpha Score</p>
                  <div className="mt-1"><ScoreBadge score={card.alpha.combined} size="lg" /></div>
                </div>
                <div className="mt-6 grid grid-cols-3 gap-3 text-center">
                  <div>
                    <p className="text-xs text-gray-500">Price</p>
                    <ScoreBadge score={card.alpha.price} size="sm" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Sentiment</p>
                    <ScoreBadge score={card.alpha.sentiment} size="sm" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Catalyst</p>
                    <ScoreBadge score={card.alpha.leak} size="sm" />
                  </div>
                </div>
                <button onClick={() => toggleWatchlist(card.id)} className={`mt-6 w-full py-2.5 rounded-xl text-sm font-medium flex items-center justify-center gap-2 transition-colors ${watchlist.has(card.id) ? "bg-amber-500/20 text-amber-400 border border-amber-500/30" : "bg-gray-800 text-gray-300 border border-gray-700 hover:border-gray-600"}`}>
                  {watchlist.has(card.id) ? <Star className="w-4 h-4 fill-amber-400" /> : <StarOff className="w-4 h-4" />}
                  {watchlist.has(card.id) ? "On Watchlist" : "Add to Watchlist"}
                </button>
              </div>

              <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
                <h3 className="font-semibold mb-4 flex items-center gap-2"><Target className="w-4 h-4 text-indigo-400" /> Score Breakdown</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <RadarChart data={radarData}>
                    <PolarGrid stroke="#374151" />
                    <PolarAngleAxis dataKey="metric" tick={{ fill: "#9CA3AF", fontSize: 11 }} />
                    <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
                    <Radar dataKey="value" stroke="#818CF8" fill="#818CF8" fillOpacity={0.2} strokeWidth={2} />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Price & Analysis */}
            <div className="lg:col-span-2 space-y-4">
              <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="font-semibold flex items-center gap-2"><DollarSign className="w-4 h-4 text-emerald-400" /> Price History (90 Days)</h2>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>TCGPlayer</span>
                    <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-blue-400"></span>eBay Sold</span>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-4 my-4">
                  <div className="bg-gray-800/50 rounded-xl p-3">
                    <p className="text-xs text-gray-500">Current</p>
                    <p className="text-lg font-bold text-white">${card.pricing.currentPrice.toFixed(2)}</p>
                    <PriceChange current={card.pricing.currentPrice} previous={card.pricing.avg30d} />
                  </div>
                  <div className="bg-gray-800/50 rounded-xl p-3">
                    <p className="text-xs text-gray-500">30d Avg</p>
                    <p className="text-lg font-bold text-gray-300">${card.pricing.avg30d.toFixed(2)}</p>
                  </div>
                  <div className="bg-gray-800/50 rounded-xl p-3">
                    <p className="text-xs text-gray-500">52w Low</p>
                    <p className="text-lg font-bold text-red-400">${card.pricing.low52w.toFixed(2)}</p>
                  </div>
                  <div className="bg-gray-800/50 rounded-xl p-3">
                    <p className="text-xs text-gray-500">52w High</p>
                    <p className="text-lg font-bold text-emerald-400">${card.pricing.high52w.toFixed(2)}</p>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={card.priceHistory}>
                    <defs>
                      <linearGradient id="tcg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#34D399" stopOpacity={0.15} /><stop offset="95%" stopColor="#34D399" stopOpacity={0} /></linearGradient>
                      <linearGradient id="ebay" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#60A5FA" stopOpacity={0.1} /><stop offset="95%" stopColor="#60A5FA" stopOpacity={0} /></linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1F2937" />
                    <XAxis dataKey="date" stroke="#4B5563" tick={{ fontSize: 11 }} interval={14} />
                    <YAxis stroke="#4B5563" tick={{ fontSize: 11 }} domain={["auto", "auto"]} />
                    <Tooltip contentStyle={{ background: "#111827", border: "1px solid #374151", borderRadius: "12px", padding: "12px" }} labelStyle={{ color: "#9CA3AF" }} />
                    <Area type="monotone" dataKey="tcgplayer" stroke="#34D399" fill="url(#tcg)" strokeWidth={2} name="TCGPlayer" />
                    <Area type="monotone" dataKey="ebaySold" stroke="#60A5FA" fill="url(#ebay)" strokeWidth={1.5} name="eBay Sold" strokeDasharray="4 2" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
                  <h3 className="font-semibold mb-3 flex items-center gap-2"><MessageCircle className="w-4 h-4 text-orange-400" /> Social Sentiment</h3>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">Reddit Mentions (7d)</span>
                      <span className="font-medium">{card.sentiment.redditMentions}</span>
                    </div>
                    <div className="w-full bg-gray-800 rounded-full h-2">
                      <div className="h-2 rounded-full bg-orange-400" style={{ width: `${Math.min(100, card.sentiment.redditMentions * 1.5)}%` }}></div>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">Sentiment Polarity</span>
                      <span className={`font-medium ${card.sentiment.redditSentiment > 0.6 ? "text-emerald-400" : card.sentiment.redditSentiment > 0.4 ? "text-amber-400" : "text-red-400"}`}>{(card.sentiment.redditSentiment * 100).toFixed(0)}% Positive</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">YouTube Videos (7d)</span>
                      <span className="font-medium">{card.sentiment.youtubeMentions}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">Trend Direction</span>
                      <span className={`font-medium flex items-center gap-1 ${card.sentiment.trendDirection === "up" ? "text-emerald-400" : "text-red-400"}`}>
                        {card.sentiment.trendDirection === "up" ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                        {card.sentiment.trendDirection === "up" ? "Bullish" : "Bearish"}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
                  <h3 className="font-semibold mb-3 flex items-center gap-2"><Newspaper className="w-4 h-4 text-blue-400" /> Leak Catalysts</h3>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">Leak Mentions</span>
                      <span className="font-medium">{card.leaks.leakMentions}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">Meta Relevance</span>
                      <div className="flex gap-0.5">{[...Array(5)].map((_, i) => <div key={i} className={`w-3 h-3 rounded-sm ${i < card.leaks.metaRelevance ? "bg-blue-400" : "bg-gray-700"}`}></div>)}</div>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">Reprint Risk</span>
                      <span className={`font-medium ${card.leaks.reprintRisk > 0.5 ? "text-red-400" : card.leaks.reprintRisk > 0.25 ? "text-amber-400" : "text-emerald-400"}`}>{card.leaks.reprintRisk > 0.5 ? "High" : card.leaks.reprintRisk > 0.25 ? "Medium" : "Low"}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">Set Synergy</span>
                      <div className="flex gap-0.5">{[...Array(5)].map((_, i) => <div key={i} className={`w-3 h-3 rounded-sm ${i < card.leaks.upcomingSetSynergy ? "bg-purple-400" : "bg-gray-700"}`}></div>)}</div>
                    </div>
                  </div>
                  <div className="mt-4 pt-3 border-t border-gray-800">
                    <p className="text-xs text-gray-500">Related Leaks</p>
                    {DEMO_LEAKS.filter(l => l.pokemon.some(p => card.name.toLowerCase().includes(p.toLowerCase()))).slice(0, 2).map(l => (
                      <div key={l.id} className="mt-2 p-2 bg-gray-800/50 rounded-lg">
                        <div className="flex items-center gap-2">
                          <SourceBadge source={l.source} />
                          <span className="text-xs text-gray-400">{l.date}</span>
                        </div>
                        <p className="text-sm mt-1 text-gray-300">{l.title}</p>
                      </div>
                    ))}
                    {DEMO_LEAKS.filter(l => l.pokemon.some(p => card.name.toLowerCase().includes(p.toLowerCase()))).length === 0 && (
                      <p className="text-sm text-gray-500 mt-2">No related leaks found</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Raw Price Comparison */}
              <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
                <h3 className="font-semibold mb-4 flex items-center gap-2"><BarChart3 className="w-4 h-4 text-cyan-400" /> Raw Card — US Market Prices</h3>
                <ResponsiveContainer width="100%" height={120}>
                  <BarChart data={[
                    { source: "TCGPlayer", price: card.pricing.sources.tcgplayer },
                    { source: "eBay Sold", price: card.pricing.sources.ebaySold },
                  ]} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#1F2937" />
                    <XAxis type="number" stroke="#4B5563" tick={{ fontSize: 11 }} tickFormatter={v => `$${v}`} />
                    <YAxis type="category" dataKey="source" stroke="#4B5563" tick={{ fontSize: 12 }} width={85} />
                    <Tooltip contentStyle={{ background: "#111827", border: "1px solid #374151", borderRadius: "12px" }} formatter={v => [`$${v.toFixed(2)}`, "Price"]} />
                    <Bar dataKey="price" fill="#06B6D4" radius={[0, 6, 6, 0]} />
                  </BarChart>
                </ResponsiveContainer>
                <p className="text-xs text-gray-500 mt-2">
                  Spread: ${(Math.abs(card.pricing.sources.tcgplayer - card.pricing.sources.ebaySold)).toFixed(2)} ({((Math.abs(card.pricing.sources.tcgplayer - card.pricing.sources.ebaySold)) / Math.min(card.pricing.sources.tcgplayer, card.pricing.sources.ebaySold) * 100).toFixed(1)}%)
                  {" · "}Best buy: {card.pricing.sources.tcgplayer <= card.pricing.sources.ebaySold ? "TCGPlayer" : "eBay Sold"} at ${Math.min(card.pricing.sources.tcgplayer, card.pricing.sources.ebaySold).toFixed(2)}
                </p>
              </div>

              {/* Graded Card Pricing */}
              <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
                <h3 className="font-semibold mb-4 flex items-center gap-2"><Award className="w-4 h-4 text-amber-400" /> Graded Card Values (eBay Sold / PriceCharting)</h3>
                <div className="grid grid-cols-3 gap-4">
                  <div className="bg-gradient-to-br from-red-500/10 to-transparent rounded-xl p-4 border border-gray-800">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-bold px-2 py-0.5 rounded bg-red-500/20 text-red-400">PSA 10</span>
                    </div>
                    <p className="text-xl font-bold text-white">${card.pricing.graded.psa10.toFixed(2)}</p>
                    <p className="text-xs text-gray-500 mt-1">{(card.pricing.graded.psa10 / card.pricing.currentPrice).toFixed(1)}x raw</p>
                  </div>
                  <div className="bg-gradient-to-br from-blue-500/10 to-transparent rounded-xl p-4 border border-gray-800">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-bold px-2 py-0.5 rounded bg-blue-500/20 text-blue-400">BGS 9.5</span>
                    </div>
                    <p className="text-xl font-bold text-white">${card.pricing.graded.bgs95.toFixed(2)}</p>
                    <p className="text-xs text-gray-500 mt-1">{(card.pricing.graded.bgs95 / card.pricing.currentPrice).toFixed(1)}x raw</p>
                  </div>
                  <div className="bg-gradient-to-br from-amber-500/10 to-transparent rounded-xl p-4 border border-gray-800">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-bold px-2 py-0.5 rounded bg-amber-500/20 text-amber-400">CGC 10</span>
                    </div>
                    <p className="text-xl font-bold text-white">${card.pricing.graded.cgc10.toFixed(2)}</p>
                    <p className="text-xs text-gray-500 mt-1">{(card.pricing.graded.cgc10 / card.pricing.currentPrice).toFixed(1)}x raw</p>
                  </div>
                </div>
                <div className="mt-3 p-3 bg-indigo-500/5 rounded-xl border border-indigo-500/10">
                  <p className="text-xs text-indigo-300">
                    <Shield className="w-3 h-3 inline mr-1" />
                    Grade premium: {((card.pricing.graded.psa10 / card.pricing.currentPrice - 1) * 100).toFixed(0)}% above raw for PSA 10.
                    {card.pricing.graded.psa10 / card.pricing.currentPrice > 5 ? " High grade premium — strong collector demand." : " Moderate premium — consider grading if card is mint."}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ============================================================
  // MAIN VIEWS
  // ============================================================
  const tabs = [
    { id: "dashboard", label: "Dashboard", icon: <Activity className="w-4 h-4" /> },
    { id: "scanner", label: "Alpha Scanner", icon: <Zap className="w-4 h-4" /> },
    { id: "sentiment", label: "Sentiment", icon: <MessageCircle className="w-4 h-4" /> },
    { id: "leaks", label: "Leak Tracker", icon: <Newspaper className="w-4 h-4" /> },
    { id: "watchlist", label: "Watchlist", icon: <Star className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-gray-950/80 backdrop-blur-xl border-b border-gray-800/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-gradient-to-br from-amber-400 to-orange-600 rounded-xl flex items-center justify-center text-lg font-bold text-white shadow-lg shadow-orange-500/20">α</div>
              <div>
                <h1 className="text-lg font-bold tracking-tight">PokéAlpha</h1>
                <p className="text-[10px] text-gray-500 -mt-0.5 tracking-wider uppercase">TCG Market Intelligence</p>
              </div>
            </div>

            <nav className="hidden md:flex items-center gap-1">
              {tabs.map(tab => (
                <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${activeTab === tab.id ? "bg-gray-800 text-white shadow-inner" : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50"}`}>
                  {tab.icon}{tab.label}
                  {tab.id === "watchlist" && watchlist.size > 0 && <span className="bg-amber-500/20 text-amber-400 text-xs px-1.5 py-0.5 rounded-full">{watchlist.size}</span>}
                </button>
              ))}
            </nav>

            <div className="flex items-center gap-3">
              <div className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full ${backendStatus === "live" ? "bg-emerald-500/20 text-emerald-400" : "bg-amber-500/20 text-amber-400"}`}>
                <div className={`w-1.5 h-1.5 rounded-full ${backendStatus === "live" ? "bg-emerald-400 animate-pulse" : "bg-amber-400"}`}></div>
                {backendStatus === "live" ? "Live" : "Demo Data"}
              </div>
              <button onClick={() => setShowSettings(!showSettings)} className="p-2 rounded-xl text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"><Settings className="w-4 h-4" /></button>
            </div>
          </div>
          {/* Mobile nav */}
          <div className="flex md:hidden gap-1 pb-3 overflow-x-auto">
            {tabs.map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${activeTab === tab.id ? "bg-gray-800 text-white" : "text-gray-400"}`}>
                {tab.icon}{tab.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Settings Panel */}
      {showSettings && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 mt-4">
          <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold flex items-center gap-2"><Settings className="w-4 h-4" /> Alpha Score Weights</h3>
              <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                { key: "price", label: "Price Alpha", icon: <DollarSign className="w-4 h-4 text-emerald-400" /> },
                { key: "sentiment", label: "Sentiment", icon: <MessageCircle className="w-4 h-4 text-orange-400" /> },
                { key: "leak", label: "Leak Catalyst", icon: <Newspaper className="w-4 h-4 text-blue-400" /> },
              ].map(w => (
                <div key={w.key} className="bg-gray-800/50 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">{w.icon}<span className="text-sm">{w.label}</span><span className="ml-auto text-sm font-mono text-gray-400">{(weights[w.key] * 100).toFixed(0)}%</span></div>
                  <input type="range" min="0" max="100" value={weights[w.key] * 100}
                    onChange={e => {
                      const val = parseInt(e.target.value) / 100;
                      const others = Object.keys(weights).filter(k => k !== w.key);
                      const remaining = 1 - val;
                      const otherTotal = weights[others[0]] + weights[others[1]];
                      setWeights({
                        ...weights,
                        [w.key]: val,
                        [others[0]]: otherTotal > 0 ? (weights[others[0]] / otherTotal) * remaining : remaining / 2,
                        [others[1]]: otherTotal > 0 ? (weights[others[1]] / otherTotal) * remaining : remaining / 2,
                      });
                    }}
                    className="w-full accent-indigo-500" />
                </div>
              ))}
            </div>
            <div className="mt-4 p-3 bg-indigo-500/10 rounded-xl border border-indigo-500/20">
              <p className="text-xs text-indigo-300">To connect live data, run the Python backend: <code className="bg-gray-800 px-1.5 py-0.5 rounded text-xs">python backend.py</code></p>
            </div>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">

        {/* ==================== DASHBOARD ==================== */}
        {activeTab === "dashboard" && (
          <div className="space-y-6">
            {/* Metrics */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: "Cards Tracked", value: DEMO_CARDS.length, icon: <Layers className="w-5 h-5 text-indigo-400" />, bg: "from-indigo-500/10 to-transparent" },
                { label: "Top Alpha Score", value: topAlpha[0]?.alpha.combined, icon: <Zap className="w-5 h-5 text-amber-400" />, bg: "from-amber-500/10 to-transparent" },
                { label: "Watchlist Value", value: `$${watchlistCards.reduce((s, c) => s + c.pricing.currentPrice, 0).toFixed(0)}`, icon: <Star className="w-5 h-5 text-yellow-400" />, bg: "from-yellow-500/10 to-transparent" },
                { label: "Active Leaks", value: DEMO_LEAKS.filter(l => l.impact === "high").length, icon: <AlertTriangle className="w-5 h-5 text-red-400" />, bg: "from-red-500/10 to-transparent" },
              ].map((m, i) => (
                <div key={i} className={`bg-gradient-to-br ${m.bg} bg-gray-900 rounded-2xl p-5 border border-gray-800`}>
                  <div className="flex items-center justify-between mb-2">{m.icon}</div>
                  <p className="text-2xl font-bold">{m.value}</p>
                  <p className="text-xs text-gray-500 mt-1">{m.label}</p>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Top Alpha Opportunities */}
              <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
                <h2 className="font-semibold flex items-center gap-2 mb-4"><Zap className="w-4 h-4 text-amber-400" /> Top Alpha Opportunities</h2>
                <div className="space-y-2">
                  {topAlpha.map((card, i) => (
                    <button key={card.id} onClick={() => setSelectedCard(card.id)}
                      className="w-full flex items-center gap-3 p-3 rounded-xl bg-gray-800/30 hover:bg-gray-800/60 transition-all group text-left">
                      <span className="text-lg w-8 text-center font-bold text-gray-600">#{i + 1}</span>
                      <span className="text-2xl">{card.image}</span>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate group-hover:text-white transition-colors">{card.name}</p>
                        <p className="text-xs text-gray-500">{card.set}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-medium">${card.pricing.currentPrice.toFixed(2)}</p>
                        <PriceChange current={card.pricing.currentPrice} previous={card.pricing.avg30d} />
                      </div>
                      <ScoreBadge score={card.alpha.combined} />
                    </button>
                  ))}
                </div>
              </div>

              {/* Biggest Dips */}
              <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
                <h2 className="font-semibold flex items-center gap-2 mb-4"><TrendingDown className="w-4 h-4 text-red-400" /> Biggest Dips (vs 30d Avg)</h2>
                <div className="space-y-2">
                  {biggestDips.map((card, i) => (
                    <button key={card.id} onClick={() => setSelectedCard(card.id)}
                      className="w-full flex items-center gap-3 p-3 rounded-xl bg-gray-800/30 hover:bg-gray-800/60 transition-all group text-left">
                      <span className="text-2xl">{card.image}</span>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{card.name}</p>
                        <p className="text-xs text-gray-500">{card.set}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-medium">${card.pricing.currentPrice.toFixed(2)}</p>
                        <PriceChange current={card.pricing.currentPrice} previous={card.pricing.avg30d} />
                      </div>
                      <ScoreBadge score={card.alpha.combined} />
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Recent Leaks */}
            <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold flex items-center gap-2"><Flame className="w-4 h-4 text-orange-400" /> Latest Leak Intelligence</h2>
                <button onClick={() => setActiveTab("leaks")} className="text-sm text-indigo-400 hover:text-indigo-300 flex items-center gap-1">View all <ChevronRight className="w-4 h-4" /></button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {DEMO_LEAKS.slice(0, 3).map(leak => (
                  <div key={leak.id} className="bg-gray-800/40 rounded-xl p-4 hover:bg-gray-800/60 transition-all">
                    <div className="flex items-center gap-2 mb-2"><SourceBadge source={leak.source} /><ImpactBadge impact={leak.impact} /><span className="text-xs text-gray-500 ml-auto">{leak.date}</span></div>
                    <p className="text-sm font-medium">{leak.title}</p>
                    <p className="text-xs text-gray-500 mt-2 line-clamp-2">{leak.summary}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ==================== ALPHA SCANNER ==================== */}
        {activeTab === "scanner" && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                <input type="text" placeholder="Search cards by name or set..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-gray-900 border border-gray-800 rounded-xl text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all" />
              </div>
              <div className="flex gap-2">
                <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="bg-gray-900 border border-gray-800 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-indigo-500 appearance-none">
                  <option value="alpha">Sort: Alpha Score</option>
                  <option value="price">Sort: Price</option>
                  <option value="sentiment">Sort: Sentiment</option>
                  <option value="change">Sort: Biggest Dip</option>
                </select>
                <select value={filterType} onChange={e => setFilterType(e.target.value)} className="bg-gray-900 border border-gray-800 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-indigo-500 appearance-none">
                  <option value="all">All Types</option>
                  {["Fire","Lightning","Dark","Colorless","Psychic","Dragon","Trainer","Water"].map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>

            <div className="bg-gray-900 rounded-2xl border border-gray-800 overflow-hidden">
              <div className="hidden md:grid grid-cols-12 gap-4 px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <div className="col-span-4">Card</div>
                <div className="col-span-2 text-right">Price</div>
                <div className="col-span-1 text-center">30d Chg</div>
                <div className="col-span-1 text-center">Price α</div>
                <div className="col-span-1 text-center">Sentiment</div>
                <div className="col-span-1 text-center">Catalyst</div>
                <div className="col-span-1 text-center">Alpha</div>
                <div className="col-span-1 text-center">Watch</div>
              </div>
              {cards.map(card => (
                <div key={card.id} className="grid grid-cols-12 gap-4 items-center px-5 py-3.5 border-b border-gray-800/50 hover:bg-gray-800/30 transition-all cursor-pointer group"
                  onClick={() => setSelectedCard(card.id)}>
                  <div className="col-span-12 md:col-span-4 flex items-center gap-3">
                    <span className="text-2xl">{card.image}</span>
                    <div>
                      <p className="font-medium group-hover:text-white transition-colors">{card.name}</p>
                      <div className="flex items-center gap-2 mt-0.5"><TypeBadge type={card.type} /><span className="text-xs text-gray-500">{card.set}</span></div>
                    </div>
                  </div>
                  <div className="col-span-3 md:col-span-2 text-right">
                    <p className="font-medium">${card.pricing.currentPrice.toFixed(2)}</p>
                    <p className="text-xs text-gray-500">eBay: ${card.pricing.sources.ebaySold.toFixed(2)}</p>
                  </div>
                  <div className="col-span-3 md:col-span-1 text-center"><PriceChange current={card.pricing.currentPrice} previous={card.pricing.avg30d} /></div>
                  <div className="col-span-2 md:col-span-1 text-center"><ScoreBadge score={card.alpha.price} size="sm" /></div>
                  <div className="col-span-2 md:col-span-1 text-center"><ScoreBadge score={card.alpha.sentiment} size="sm" /></div>
                  <div className="col-span-2 md:col-span-1 text-center"><ScoreBadge score={card.alpha.leak} size="sm" /></div>
                  <div className="hidden md:block col-span-1 text-center"><ScoreBadge score={card.alpha.combined} /></div>
                  <div className="hidden md:flex col-span-1 justify-center">
                    <button onClick={e => { e.stopPropagation(); toggleWatchlist(card.id); }}
                      className={`p-1.5 rounded-lg transition-colors ${watchlist.has(card.id) ? "text-amber-400 hover:bg-amber-500/10" : "text-gray-600 hover:text-gray-400 hover:bg-gray-800"}`}>
                      {watchlist.has(card.id) ? <Star className="w-4 h-4 fill-amber-400" /> : <StarOff className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              ))}
              {cards.length === 0 && <div className="p-12 text-center text-gray-500">No cards match your search.</div>}
            </div>
          </div>
        )}

        {/* ==================== SENTIMENT ==================== */}
        {activeTab === "sentiment" && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
                <div className="flex items-center gap-2 mb-2 text-orange-400"><MessageCircle className="w-5 h-5" /><span className="font-semibold">Reddit</span></div>
                <p className="text-3xl font-bold">{DEMO_SENTIMENT.filter(s => s.platform === "reddit").length}</p>
                <p className="text-xs text-gray-500 mt-1">Trending posts (24h)</p>
              </div>
              <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
                <div className="flex items-center gap-2 mb-2 text-red-400"><Youtube className="w-5 h-5" /><span className="font-semibold">YouTube</span></div>
                <p className="text-3xl font-bold">{DEMO_SENTIMENT.filter(s => s.platform === "youtube").length}</p>
                <p className="text-xs text-gray-500 mt-1">Relevant videos (24h)</p>
              </div>
              <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
                <div className="flex items-center gap-2 mb-2 text-blue-400"><Activity className="w-5 h-5" /><span className="font-semibold">Overall Sentiment</span></div>
                <p className="text-3xl font-bold text-emerald-400">73%</p>
                <p className="text-xs text-gray-500 mt-1">Community is Bullish</p>
              </div>
            </div>

            <div className="bg-gray-900 rounded-2xl border border-gray-800 overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-800">
                <h2 className="font-semibold flex items-center gap-2"><Zap className="w-4 h-4 text-amber-400" /> Live Sentiment Feed</h2>
              </div>
              {DEMO_SENTIMENT.map(post => (
                <div key={post.id} className="px-5 py-4 border-b border-gray-800/50 hover:bg-gray-800/20 transition-all">
                  <div className="flex items-start gap-4">
                    <div className={`mt-1 p-2 rounded-xl ${post.platform === "reddit" ? "bg-orange-500/10 text-orange-400" : "bg-red-500/10 text-red-400"}`}>
                      {post.platform === "reddit" ? <MessageCircle className="w-5 h-5" /> : <Youtube className="w-5 h-5" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium">{post.title}</p>
                      <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                        <span>{post.author}</span>
                        <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{post.time}</span>
                        {post.score && <span>↑ {post.score}</span>}
                        {post.comments && <span>💬 {post.comments}</span>}
                        {post.views && <span>👁 {post.views} views</span>}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={`text-sm font-medium ${post.sentiment > 0.7 ? "text-emerald-400" : post.sentiment > 0.5 ? "text-amber-400" : "text-red-400"}`}>
                        {(post.sentiment * 100).toFixed(0)}%
                      </div>
                      <p className="text-xs text-gray-500">sentiment</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ==================== LEAK TRACKER ==================== */}
        {activeTab === "leaks" && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-gray-400">Sources:</span>
              {["All", "PokeBeach", "PokemonBlog", "Pokemon.com"].map(src => (
                <button key={src} className="px-3 py-1.5 rounded-lg text-sm bg-gray-800/50 hover:bg-gray-800 border border-gray-700/50 text-gray-300 transition-colors">{src}</button>
              ))}
            </div>
            <div className="space-y-3">
              {DEMO_LEAKS.map(leak => (
                <div key={leak.id} className="bg-gray-900 rounded-2xl p-5 border border-gray-800 hover:border-gray-700 transition-all">
                  <div className="flex items-start gap-4">
                    <div className={`mt-1 p-2.5 rounded-xl ${leak.impact === "high" ? "bg-red-500/10 text-red-400" : leak.impact === "medium" ? "bg-amber-500/10 text-amber-400" : "bg-gray-800 text-gray-400"}`}>
                      <Newspaper className="w-5 h-5" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <SourceBadge source={leak.source} />
                        <ImpactBadge impact={leak.impact} />
                        <span className="text-xs text-gray-500 flex items-center gap-1"><Clock className="w-3 h-3" />{leak.date}</span>
                      </div>
                      <h3 className="font-semibold text-lg">{leak.title}</h3>
                      <p className="text-sm text-gray-400 mt-2">{leak.summary}</p>
                      <div className="flex items-center gap-2 mt-3">
                        <span className="text-xs text-gray-500">Related:</span>
                        {leak.pokemon.map(p => <span key={p} className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">{p}</span>)}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ==================== WATCHLIST ==================== */}
        {activeTab === "watchlist" && (
          <div className="space-y-6">
            {watchlistCards.length === 0 ? (
              <div className="bg-gray-900 rounded-2xl p-16 border border-gray-800 text-center">
                <Star className="w-12 h-12 text-gray-700 mx-auto mb-4" />
                <h3 className="text-xl font-semibold text-gray-400">No cards in your watchlist</h3>
                <p className="text-sm text-gray-600 mt-2">Add cards from the Alpha Scanner to track them here.</p>
                <button onClick={() => setActiveTab("scanner")} className="mt-4 px-4 py-2 bg-indigo-500/20 text-indigo-400 rounded-xl text-sm hover:bg-indigo-500/30 transition-colors">Go to Scanner</button>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
                    <p className="text-xs text-gray-500">Total Value</p>
                    <p className="text-2xl font-bold mt-1">${watchlistCards.reduce((s, c) => s + c.pricing.currentPrice, 0).toFixed(2)}</p>
                  </div>
                  <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
                    <p className="text-xs text-gray-500">Cards Tracked</p>
                    <p className="text-2xl font-bold mt-1">{watchlistCards.length}</p>
                  </div>
                  <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
                    <p className="text-xs text-gray-500">Avg Alpha Score</p>
                    <p className="text-2xl font-bold mt-1">{Math.round(watchlistCards.reduce((s, c) => s + c.alpha.combined, 0) / watchlistCards.length)}</p>
                  </div>
                  <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
                    <p className="text-xs text-gray-500">Best Opportunity</p>
                    <p className="text-lg font-bold mt-1">{[...watchlistCards].sort((a, b) => b.alpha.combined - a.alpha.combined)[0]?.name}</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {watchlistCards.map(card => (
                    <div key={card.id} onClick={() => setSelectedCard(card.id)}
                      className="bg-gray-900 rounded-2xl p-5 border border-gray-800 hover:border-gray-700 transition-all cursor-pointer group">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <span className="text-3xl">{card.image}</span>
                          <div>
                            <p className="font-semibold group-hover:text-white transition-colors">{card.name}</p>
                            <p className="text-xs text-gray-500">{card.set}</p>
                          </div>
                        </div>
                        <button onClick={e => { e.stopPropagation(); toggleWatchlist(card.id); }} className="text-amber-400 hover:bg-amber-500/10 p-1.5 rounded-lg transition-colors">
                          <Star className="w-4 h-4 fill-amber-400" />
                        </button>
                      </div>
                      <div className="h-24 mb-3">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={card.priceHistory.slice(-30)}>
                            <defs><linearGradient id={`wl-${card.id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={card.pricing.currentPrice < card.pricing.avg30d ? "#EF4444" : "#34D399"} stopOpacity={0.2} /><stop offset="95%" stopColor="#000" stopOpacity={0} /></linearGradient></defs>
                            <Area type="monotone" dataKey="tcgplayer" stroke={card.pricing.currentPrice < card.pricing.avg30d ? "#EF4444" : "#34D399"} fill={`url(#wl-${card.id})`} strokeWidth={1.5} dot={false} />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-lg font-bold">${card.pricing.currentPrice.toFixed(2)}</p>
                          <PriceChange current={card.pricing.currentPrice} previous={card.pricing.avg30d} />
                        </div>
                        <ScoreBadge score={card.alpha.combined} />
                      </div>
                      <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-gray-800">
                        <div className="text-center"><p className="text-xs text-gray-500">Price</p><ScoreBadge score={card.alpha.price} size="sm" /></div>
                        <div className="text-center"><p className="text-xs text-gray-500">Sent.</p><ScoreBadge score={card.alpha.sentiment} size="sm" /></div>
                        <div className="text-center"><p className="text-xs text-gray-500">Leak</p><ScoreBadge score={card.alpha.leak} size="sm" /></div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-800/50 mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between text-xs text-gray-600">
          <span>PokéAlpha · TCG Market Intelligence</span>
          <span>USA/NA Pricing · TCGPlayer · eBay Sold · PriceCharting (Graded) · Reddit · PokeBeach · PokemonBlog</span>
        </div>
      </footer>
    </div>
  );
}
