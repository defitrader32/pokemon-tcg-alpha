"""
PokéAlpha Backend — Live data scraper & API server for Pokemon TCG market intelligence.
Focused on USA / North America pricing only. No European/Cardmarket data.

Pulls data from:
  - pokemontcg.io (card database + TCGPlayer pricing, free)
  - PokeTrace API (aggregated TCGPlayer + eBay sold + graded — market=US, free tier)
  - eBay sold listings (fallback scraping if PokeTrace unavailable)
  - PriceCharting (graded card values — PSA, BGS, CGC — optional paid API)
  - Reddit API (r/PokemonTCG sentiment)
  - YouTube Data API (TCG video mentions)
  - PokeBeach / PokemonBlog / Pokemon.com (leak news via RSS + scraping)

Run:  pip install flask flask-cors requests feedparser beautifulsoup4
      python backend.py

Then update the React frontend to fetch from http://localhost:5000/api/*
"""

import os
import json
import time
import hashlib
import re
import logging
from datetime import datetime, timedelta
from typing import Optional
from dataclasses import dataclass, field, asdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import feedparser
from bs4 import BeautifulSoup
from flask import Flask, jsonify, request
from flask_cors import CORS

# ─── Config ──────────────────────────────────────────────────────────────────

LOG = logging.getLogger("pokealpha")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")

# API keys — set as environment variables
POKETRACE_API_KEY = os.getenv("POKETRACE_API_KEY", "")  # Free at poketrace.com/developers
REDDIT_CLIENT_ID = os.getenv("REDDIT_CLIENT_ID", "")
REDDIT_CLIENT_SECRET = os.getenv("REDDIT_CLIENT_SECRET", "")
REDDIT_USER_AGENT = os.getenv("REDDIT_USER_AGENT", "PokéAlpha/1.0")
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY", "")

CACHE_TTL = int(os.getenv("CACHE_TTL", "300"))  # 5 min default
PORT = int(os.getenv("PORT", "5000"))

# ─── In-memory cache ────────────────────────────────────────────────────────

_cache: dict[str, tuple[float, any]] = {}


def cache_get(key: str):
    if key in _cache:
        ts, data = _cache[key]
        if time.time() - ts < CACHE_TTL:
            return data
    return None


def cache_set(key: str, data):
    _cache[key] = (time.time(), data)


# ─── Data models ─────────────────────────────────────────────────────────────

@dataclass
class CardPrice:
    card_id: str
    name: str
    set_name: str
    number: str
    rarity: str
    card_type: str
    image_url: str
    # Raw card pricing (US sources)
    tcgplayer_price: Optional[float] = None
    tcgplayer_url: Optional[str] = None
    ebay_sold_avg: Optional[float] = None
    ebay_sold_low: Optional[float] = None
    ebay_sold_high: Optional[float] = None
    price_30d_ago: Optional[float] = None
    price_90d_ago: Optional[float] = None
    low_52w: Optional[float] = None
    high_52w: Optional[float] = None
    # Graded card pricing (via PriceCharting / eBay comps)
    psa_10_price: Optional[float] = None
    bgs_95_price: Optional[float] = None
    cgc_10_price: Optional[float] = None


@dataclass
class SentimentPost:
    platform: str  # "reddit" | "youtube"
    title: str
    author: str
    url: str
    score: int = 0
    comments: int = 0
    views: int = 0
    sentiment: float = 0.5  # 0-1 polarity
    timestamp: str = ""
    mentioned_cards: list = field(default_factory=list)


@dataclass
class LeakArticle:
    source: str  # "PokeBeach" | "PokemonBlog" | "Pokemon.com"
    title: str
    url: str
    summary: str
    date: str
    impact: str = "medium"  # "high" | "medium" | "low"
    mentioned_pokemon: list = field(default_factory=list)


# ─── Pokemon TCG API (pokemontcg.io) ────────────────────────────────────────

POKEMONTCG_BASE = "https://api.pokemontcg.io/v2"


def fetch_cards(query: str = "", page: int = 1, page_size: int = 50) -> list[dict]:
    """Fetch cards from pokemontcg.io with optional search query."""
    key = f"cards:{query}:{page}:{page_size}"
    cached = cache_get(key)
    if cached:
        return cached

    params = {"page": page, "pageSize": page_size, "orderBy": "-set.releaseDate"}
    if query:
        params["q"] = query

    try:
        resp = requests.get(f"{POKEMONTCG_BASE}/cards", params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json().get("data", [])
        cache_set(key, data)
        return data
    except Exception as e:
        LOG.error(f"pokemontcg.io error: {e}")
        return []


def fetch_card_by_id(card_id: str) -> Optional[dict]:
    """Fetch a single card by ID (e.g. 'sv3-125')."""
    key = f"card:{card_id}"
    cached = cache_get(key)
    if cached:
        return cached

    try:
        resp = requests.get(f"{POKEMONTCG_BASE}/cards/{card_id}", timeout=10)
        resp.raise_for_status()
        data = resp.json().get("data")
        cache_set(key, data)
        return data
    except Exception as e:
        LOG.error(f"Card fetch error for {card_id}: {e}")
        return None


def extract_pricing(card_data: dict) -> CardPrice:
    """Extract US pricing info from a pokemontcg.io card response."""
    tcg_prices = card_data.get("tcgplayer", {}).get("prices", {})

    # Find the best price variant (holofoil > reverseHolofoil > normal)
    tcg_price = None
    tcg_low = None
    tcg_high = None
    for variant in ["holofoil", "reverseHolofoil", "normal", "1stEditionHolofoil"]:
        if variant in tcg_prices:
            tcg_price = tcg_prices[variant].get("market") or tcg_prices[variant].get("mid")
            tcg_low = tcg_prices[variant].get("low")
            tcg_high = tcg_prices[variant].get("high")
            break

    types = card_data.get("types", [])
    card_type = types[0] if types else (
        "Trainer" if card_data.get("supertype") == "Trainer" else "Colorless"
    )

    images = card_data.get("images", {})

    return CardPrice(
        card_id=card_data.get("id", ""),
        name=card_data.get("name", ""),
        set_name=card_data.get("set", {}).get("name", ""),
        number=card_data.get("number", ""),
        rarity=card_data.get("rarity", "Unknown"),
        card_type=card_type,
        image_url=images.get("large") or images.get("small", ""),
        tcgplayer_price=tcg_price,
        tcgplayer_url=card_data.get("tcgplayer", {}).get("url"),
        low_52w=tcg_low,
        high_52w=tcg_high,
    )


# ─── PokeTrace API (primary US pricing — TCGPlayer + eBay + graded) ──────────
#
# PokeTrace aggregates 60K+ Pokemon cards with pricing from TCGPlayer, eBay
# sold listings, and graded card values (PSA, BGS, CGC). The market=US filter
# returns only US marketplace data, excluding Cardmarket/EU entirely.
#
# Free tier: sign up at https://poketrace.com/developers
# Auth: X-API-Key header

POKETRACE_BASE = "https://api.poketrace.com/v1"


def fetch_poketrace_card(card_name: str, set_name: str = "") -> Optional[dict]:
    """Fetch US-only card pricing from PokeTrace (TCGPlayer + eBay sold + graded).
    Returns the full PokeTrace response dict or None.
    """
    if not POKETRACE_API_KEY:
        return None

    search = card_name
    if set_name:
        search += f" {set_name}"

    key = f"poketrace:{search}"
    cached = cache_get(key)
    if cached:
        return cached

    try:
        resp = requests.get(
            f"{POKETRACE_BASE}/cards",
            params={"search": search, "market": "US"},  # US only — no EU/Cardmarket
            headers={"X-API-Key": POKETRACE_API_KEY},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()

        # PokeTrace returns a list of matches; take the best one
        results = data if isinstance(data, list) else data.get("data", data.get("results", []))
        if results and isinstance(results, list) and len(results) > 0:
            card = results[0]
            cache_set(key, card)
            return card
        elif isinstance(data, dict) and "name" in data:
            # Single card response
            cache_set(key, data)
            return data

        return None
    except Exception as e:
        LOG.warning(f"PokeTrace API error for '{search}': {e}")
        return None


def extract_poketrace_pricing(pt_data: dict) -> dict:
    """Extract US-only pricing fields from a PokeTrace response.
    Adapts to whatever field names PokeTrace returns.
    Returns { tcgplayer, ebay_sold_avg, ebay_sold_low, ebay_sold_high,
              psa10, bgs95, cgc10 }.
    """
    result = {
        "tcgplayer": None, "ebay_sold_avg": None, "ebay_sold_low": None,
        "ebay_sold_high": None, "psa10": None, "bgs95": None, "cgc10": None,
    }

    if not pt_data:
        return result

    # PokeTrace field extraction — adapt to actual API response shape
    # Common patterns: prices.tcgplayer.market, prices.ebay.average, etc.
    prices = pt_data.get("prices", pt_data)

    # TCGPlayer pricing
    tcg = prices.get("tcgplayer", prices.get("tcg", {}))
    if isinstance(tcg, dict):
        result["tcgplayer"] = tcg.get("market") or tcg.get("average") or tcg.get("mid")
    elif isinstance(tcg, (int, float)):
        result["tcgplayer"] = float(tcg)

    # eBay sold pricing (US only since we passed market=US)
    ebay = prices.get("ebay", prices.get("ebay_sold", {}))
    if isinstance(ebay, dict):
        result["ebay_sold_avg"] = ebay.get("average") or ebay.get("avg") or ebay.get("market")
        result["ebay_sold_low"] = ebay.get("low") or ebay.get("min")
        result["ebay_sold_high"] = ebay.get("high") or ebay.get("max")
    elif isinstance(ebay, (int, float)):
        result["ebay_sold_avg"] = float(ebay)

    # Graded pricing
    graded = prices.get("graded", prices.get("grades", {}))
    if isinstance(graded, dict):
        # Try PSA 10
        psa = graded.get("psa_10") or graded.get("PSA 10") or graded.get("psa10")
        if isinstance(psa, dict):
            result["psa10"] = psa.get("average") or psa.get("market") or psa.get("price")
        elif isinstance(psa, (int, float)):
            result["psa10"] = float(psa)

        # Try BGS 9.5
        bgs = graded.get("bgs_9.5") or graded.get("BGS 9.5") or graded.get("bgs95")
        if isinstance(bgs, dict):
            result["bgs95"] = bgs.get("average") or bgs.get("market") or bgs.get("price")
        elif isinstance(bgs, (int, float)):
            result["bgs95"] = float(bgs)

        # Try CGC 10
        cgc = graded.get("cgc_10") or graded.get("CGC 10") or graded.get("cgc10")
        if isinstance(cgc, dict):
            result["cgc10"] = cgc.get("average") or cgc.get("market") or cgc.get("price")
        elif isinstance(cgc, (int, float)):
            result["cgc10"] = float(cgc)

    # Also check top-level fields as fallback
    for field_name, result_key in [
        ("tcgplayer_price", "tcgplayer"), ("ebay_price", "ebay_sold_avg"),
        ("ebay_average", "ebay_sold_avg"), ("psa_10", "psa10"),
        ("bgs_9_5", "bgs95"), ("cgc_10", "cgc10"),
    ]:
        if result[result_key] is None and field_name in prices:
            val = prices[field_name]
            if isinstance(val, (int, float)):
                result[result_key] = float(val)

    return result


# ─── eBay Sold Listings (fallback scraping if PokeTrace unavailable) ─────────

def _scrape_ebay_sold(search_query: str, min_price: int = 5) -> dict:
    """Scrape eBay recently sold listings as a fallback.
    Returns { avg, low, high, count }.
    """
    key = f"ebay_scrape:{search_query}"
    cached = cache_get(key)
    if cached:
        return cached

    try:
        query = search_query.replace(" ", "+")
        url = f"https://www.ebay.com/sch/i.html?_nkw={query}&_sop=13&LH_Sold=1&LH_Complete=1&_udlo={min_price}"
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        resp = requests.get(url, headers=headers, timeout=15)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")

        prices = []
        for item in soup.select(".s-item__price"):
            text = item.get_text(strip=True)
            matches = re.findall(r"\$(\d+[\d,.]*)", text)
            for m in matches:
                try:
                    prices.append(float(m.replace(",", "")))
                except ValueError:
                    continue

        if not prices:
            return {"avg": None, "low": None, "high": None, "count": 0}

        prices.sort()
        trim = max(1, len(prices) // 10)
        trimmed = prices[trim:-trim] if len(prices) > 5 else prices

        result = {
            "avg": round(sum(trimmed) / len(trimmed), 2),
            "low": round(trimmed[0], 2),
            "high": round(trimmed[-1], 2),
            "count": len(prices),
        }
        cache_set(key, result)
        return result
    except Exception as e:
        LOG.warning(f"eBay scrape fallback error for '{search_query}': {e}")
        return {"avg": None, "low": None, "high": None, "count": 0}


# ─── PriceCharting (graded card values — optional paid API) ──────────────────

PRICECHARTING_API_KEY = os.getenv("PRICECHARTING_API_KEY", "")


# ─── Unified US Pricing: PokeTrace → PriceCharting → eBay scrape ─────────────

def fetch_us_pricing(card_name: str, set_name: str = "") -> dict:
    """Fetch all US pricing for a card using this priority chain:
      1. PokeTrace API (TCGPlayer + eBay sold + graded, market=US)
      2. PriceCharting API (graded only, if key set)
      3. eBay sold scraping (fallback for anything still missing)

    Returns { tcgplayer, ebay_sold_avg, ebay_sold_low, ebay_sold_high,
              psa10, bgs95, cgc10, source }.
    """
    key = f"us_pricing:{card_name}:{set_name}"
    cached = cache_get(key)
    if cached:
        return cached

    result = {
        "tcgplayer": None, "ebay_sold_avg": None, "ebay_sold_low": None,
        "ebay_sold_high": None, "psa10": None, "bgs95": None, "cgc10": None,
        "source": "none",
    }

    # ── 1. Try PokeTrace first (best source: aggregated US data) ──
    if POKETRACE_API_KEY:
        pt_data = fetch_poketrace_card(card_name, set_name)
        if pt_data:
            pt_pricing = extract_poketrace_pricing(pt_data)
            for k, v in pt_pricing.items():
                if v is not None:
                    result[k] = v
            result["source"] = "poketrace"
            LOG.info(f"PokeTrace hit for '{card_name}': TCG=${result['tcgplayer']}, eBay=${result['ebay_sold_avg']}")

    # ── 2. PriceCharting for any missing graded values ──
    if PRICECHARTING_API_KEY and not all([result["psa10"], result["bgs95"], result["cgc10"]]):
        try:
            search = f"Pokemon {card_name}"
            if set_name:
                search += f" {set_name}"
            resp = requests.get(
                "https://www.pricecharting.com/api/product",
                params={"t": PRICECHARTING_API_KEY, "q": search},
                timeout=10,
            )
            if resp.status_code == 200:
                data = resp.json()
                if "graded-price" in data and not result["psa10"]:
                    result["psa10"] = data["graded-price"] / 100.0
                if "manual-only-price" in data and not result["bgs95"]:
                    result["bgs95"] = data["manual-only-price"] / 100.0
                if result["source"] == "none":
                    result["source"] = "pricecharting"
                else:
                    result["source"] += "+pricecharting"
        except Exception as e:
            LOG.warning(f"PriceCharting API error: {e}")

    # ── 3. eBay scraping fallback for anything still missing ──
    search_base = f"Pokemon {card_name}"
    if set_name:
        search_base += f" {set_name}"

    if not result["ebay_sold_avg"]:
        ebay = _scrape_ebay_sold(search_base, min_price=5)
        if ebay["avg"]:
            result["ebay_sold_avg"] = ebay["avg"]
            result["ebay_sold_low"] = ebay["low"]
            result["ebay_sold_high"] = ebay["high"]
            result["source"] = result["source"].replace("none", "") + "+ebay_scrape" if result["source"] != "none" else "ebay_scrape"

    if not result["psa10"]:
        psa = _scrape_ebay_sold(f"{search_base} PSA 10", min_price=10)
        result["psa10"] = psa["avg"]
    if not result["bgs95"]:
        bgs = _scrape_ebay_sold(f"{search_base} BGS 9.5", min_price=10)
        result["bgs95"] = bgs["avg"]
    if not result["cgc10"]:
        cgc = _scrape_ebay_sold(f"{search_base} CGC 10", min_price=10)
        result["cgc10"] = cgc["avg"]

    result["source"] = result["source"].strip("+") or "ebay_scrape"
    cache_set(key, result)
    return result


def enrich_with_us_pricing(card_price: CardPrice) -> CardPrice:
    """Enrich a CardPrice with full US market data (PokeTrace → fallbacks)."""
    pricing = fetch_us_pricing(card_price.name, card_price.set_name)

    # Raw pricing
    card_price.ebay_sold_avg = pricing["ebay_sold_avg"]
    card_price.ebay_sold_low = pricing["ebay_sold_low"]
    card_price.ebay_sold_high = pricing["ebay_sold_high"]

    # Override TCGPlayer price if PokeTrace has a fresher one
    if pricing["tcgplayer"] and not card_price.tcgplayer_price:
        card_price.tcgplayer_price = pricing["tcgplayer"]

    # Graded pricing
    card_price.psa_10_price = pricing["psa10"]
    card_price.bgs_95_price = pricing["bgs95"]
    card_price.cgc_10_price = pricing["cgc10"]

    return card_price


# ─── Reddit Sentiment ────────────────────────────────────────────────────────

REDDIT_SUBREDDITS = ["PokemonTCG", "pokemoncardcollectors", "PokeInvesting"]


def _get_reddit_token() -> Optional[str]:
    """Get OAuth token for Reddit API."""
    if not REDDIT_CLIENT_ID or not REDDIT_CLIENT_SECRET:
        return None

    key = "reddit_token"
    cached = cache_get(key)
    if cached:
        return cached

    try:
        resp = requests.post(
            "https://www.reddit.com/api/v1/access_token",
            auth=(REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET),
            data={"grant_type": "client_credentials"},
            headers={"User-Agent": REDDIT_USER_AGENT},
            timeout=10,
        )
        resp.raise_for_status()
        token = resp.json().get("access_token")
        cache_set(key, token)
        return token
    except Exception as e:
        LOG.error(f"Reddit auth error: {e}")
        return None


def fetch_reddit_sentiment(card_name: str = "", limit: int = 25) -> list[SentimentPost]:
    """Fetch recent Reddit posts about Pokemon TCG, optionally filtered by card name."""
    key = f"reddit:{card_name}:{limit}"
    cached = cache_get(key)
    if cached:
        return cached

    token = _get_reddit_token()
    if not token:
        LOG.warning("Reddit API not configured — set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET")
        return []

    posts = []
    headers = {"Authorization": f"Bearer {token}", "User-Agent": REDDIT_USER_AGENT}

    for sub in REDDIT_SUBREDDITS:
        try:
            params = {"limit": limit, "t": "week"}
            if card_name:
                params["q"] = card_name
                url = f"https://oauth.reddit.com/r/{sub}/search"
                params["restrict_sr"] = "on"
                params["sort"] = "relevance"
            else:
                url = f"https://oauth.reddit.com/r/{sub}/hot"

            resp = requests.get(url, headers=headers, params=params, timeout=10)
            if resp.status_code != 200:
                continue

            for child in resp.json().get("data", {}).get("children", []):
                d = child.get("data", {})
                title = d.get("title", "")

                # Simple sentiment analysis (keyword-based)
                sentiment = _simple_sentiment(title + " " + d.get("selftext", "")[:500])

                posts.append(SentimentPost(
                    platform="reddit",
                    title=title,
                    author=f"u/{d.get('author', 'unknown')}",
                    url=f"https://reddit.com{d.get('permalink', '')}",
                    score=d.get("score", 0),
                    comments=d.get("num_comments", 0),
                    sentiment=sentiment,
                    timestamp=datetime.fromtimestamp(d.get("created_utc", 0)).isoformat(),
                    mentioned_cards=_extract_card_mentions(title),
                ))
        except Exception as e:
            LOG.error(f"Reddit error for r/{sub}: {e}")

    posts.sort(key=lambda p: p.score, reverse=True)
    cache_set(key, posts[:limit])
    return posts[:limit]


def _simple_sentiment(text: str) -> float:
    """Quick keyword-based sentiment scoring (0 = negative, 1 = positive)."""
    text = text.lower()
    positive = [
        "undervalued", "buy", "invest", "bullish", "gem", "sleeper", "amazing",
        "beautiful", "love", "great", "awesome", "incredible", "spike", "moon",
        "gain", "profit", "deal", "steal", "rare", "grail", "fire", "must have",
    ]
    negative = [
        "overvalued", "sell", "crash", "dump", "bearish", "scam", "overpriced",
        "reprint", "fake", "drop", "decline", "loss", "bubble", "waste", "avoid",
        "disappointed", "horrible", "terrible", "bad",
    ]

    pos_count = sum(1 for w in positive if w in text)
    neg_count = sum(1 for w in negative if w in text)
    total = pos_count + neg_count
    if total == 0:
        return 0.55  # Slightly positive default for collector communities
    return round(min(1.0, max(0.0, 0.5 + (pos_count - neg_count) / (total * 2))), 2)


def _extract_card_mentions(text: str) -> list[str]:
    """Extract Pokemon card names from text."""
    known = [
        "Charizard", "Pikachu", "Umbreon", "Lugia", "Mew", "Mewtwo", "Rayquaza",
        "Giratina", "Arceus", "Gardevoir", "Gengar", "Eevee", "Iono", "Miraidon",
        "Koraidon", "Sylveon", "Espeon", "Vaporeon", "Jolteon", "Flareon",
    ]
    return [name for name in known if name.lower() in text.lower()]


# ─── YouTube API ─────────────────────────────────────────────────────────────

def fetch_youtube_sentiment(query: str = "Pokemon TCG", max_results: int = 10) -> list[SentimentPost]:
    """Fetch recent YouTube videos about Pokemon TCG."""
    key = f"youtube:{query}:{max_results}"
    cached = cache_get(key)
    if cached:
        return cached

    if not YOUTUBE_API_KEY:
        LOG.warning("YouTube API not configured — set YOUTUBE_API_KEY")
        return []

    try:
        params = {
            "part": "snippet",
            "q": query,
            "type": "video",
            "order": "date",
            "maxResults": max_results,
            "key": YOUTUBE_API_KEY,
            "publishedAfter": (datetime.utcnow() - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        resp = requests.get("https://www.googleapis.com/youtube/v3/search", params=params, timeout=10)
        resp.raise_for_status()
        items = resp.json().get("items", [])

        posts = []
        for item in items:
            snippet = item.get("snippet", {})
            title = snippet.get("title", "")
            posts.append(SentimentPost(
                platform="youtube",
                title=title,
                author=snippet.get("channelTitle", "Unknown"),
                url=f"https://youtube.com/watch?v={item.get('id', {}).get('videoId', '')}",
                sentiment=_simple_sentiment(title + " " + snippet.get("description", "")),
                timestamp=snippet.get("publishedAt", ""),
                mentioned_cards=_extract_card_mentions(title),
            ))

        cache_set(key, posts)
        return posts
    except Exception as e:
        LOG.error(f"YouTube API error: {e}")
        return []


# ─── Leak / News Scraping ───────────────────────────────────────────────────

LEAK_SOURCES = {
    "PokemonBlog": {
        "rss": "https://pokemonblog.com/feed",
        "type": "rss",
    },
    "PokeBeach": {
        "url": "https://www.pokebeach.com/",
        "type": "scrape",
    },
    "Pokemon.com": {
        "url": "https://www.pokemon.com/us/pokemon-news",
        "type": "scrape",
    },
}


def fetch_leak_news() -> list[LeakArticle]:
    """Fetch latest Pokemon TCG news from all leak sources."""
    key = "leaks:all"
    cached = cache_get(key)
    if cached:
        return cached

    articles = []
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            executor.submit(_fetch_pokemonblog_rss): "PokemonBlog",
            executor.submit(_fetch_pokebeach): "PokeBeach",
            executor.submit(_fetch_pokemon_official): "Pokemon.com",
        }
        for future in as_completed(futures):
            source = futures[future]
            try:
                result = future.result()
                articles.extend(result)
            except Exception as e:
                LOG.error(f"Leak fetch error for {source}: {e}")

    articles.sort(key=lambda a: a.date, reverse=True)
    cache_set(key, articles)
    return articles


def _fetch_pokemonblog_rss() -> list[LeakArticle]:
    """Fetch from PokemonBlog RSS feed."""
    try:
        feed = feedparser.parse("https://pokemonblog.com/feed")
        articles = []
        for entry in feed.entries[:15]:
            title = entry.get("title", "")
            summary = BeautifulSoup(entry.get("summary", ""), "html.parser").get_text()[:300]
            impact = _assess_impact(title, summary)
            pokemon = _extract_card_mentions(title + " " + summary)

            articles.append(LeakArticle(
                source="PokemonBlog",
                title=title,
                url=entry.get("link", ""),
                summary=summary.strip(),
                date=entry.get("published", ""),
                impact=impact,
                mentioned_pokemon=pokemon,
            ))
        return articles
    except Exception as e:
        LOG.error(f"PokemonBlog RSS error: {e}")
        return []


def _fetch_pokebeach() -> list[LeakArticle]:
    """Scrape PokeBeach front page for news."""
    try:
        headers = {"User-Agent": "Mozilla/5.0 (compatible; PokéAlpha/1.0)"}
        resp = requests.get("https://www.pokebeach.com/", headers=headers, timeout=15)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")

        articles = []
        # PokeBeach uses article tags or specific div classes
        for article in soup.select("article, .entry-title, h2.title a")[:15]:
            link_tag = article.find("a") if article.name != "a" else article
            if not link_tag:
                continue
            title = link_tag.get_text(strip=True)
            url = link_tag.get("href", "")
            if not title or len(title) < 10:
                continue
            if not url.startswith("http"):
                url = "https://www.pokebeach.com" + url

            impact = _assess_impact(title, "")
            pokemon = _extract_card_mentions(title)

            articles.append(LeakArticle(
                source="PokeBeach",
                title=title,
                url=url,
                summary="",  # Would need to fetch article page for full summary
                date=datetime.now().isoformat(),
                impact=impact,
                mentioned_pokemon=pokemon,
            ))
        return articles
    except Exception as e:
        LOG.error(f"PokeBeach scrape error: {e}")
        return []


def _fetch_pokemon_official() -> list[LeakArticle]:
    """Scrape Pokemon.com for official news."""
    try:
        headers = {"User-Agent": "Mozilla/5.0 (compatible; PokéAlpha/1.0)"}
        resp = requests.get("https://www.pokemon.com/us/pokemon-news", headers=headers, timeout=15)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")

        articles = []
        for item in soup.select("a[href*='/pokemon-news/']")[:15]:
            title = item.get_text(strip=True)
            url = item.get("href", "")
            if not title or len(title) < 10:
                continue
            if not url.startswith("http"):
                url = "https://www.pokemon.com" + url

            # Only include TCG-relevant articles
            tcg_keywords = ["tcg", "card", "expansion", "set", "deck", "tournament", "championship"]
            if not any(kw in title.lower() for kw in tcg_keywords):
                continue

            articles.append(LeakArticle(
                source="Pokemon.com",
                title=title,
                url=url,
                summary="",
                date=datetime.now().isoformat(),
                impact=_assess_impact(title, ""),
                mentioned_pokemon=_extract_card_mentions(title),
            ))
        return articles
    except Exception as e:
        LOG.error(f"Pokemon.com scrape error: {e}")
        return []


def _assess_impact(title: str, summary: str) -> str:
    """Assess the market impact of a news article."""
    text = (title + " " + summary).lower()
    high_impact = [
        "new set", "reveal", "leaked", "ban", "rotation", "reprint",
        "championship", "special art", "secret rare", "illustration rare",
        "new expansion", "release date", "errata",
    ]
    medium_impact = [
        "tournament", "deck", "strategy", "meta", "price",
        "collection", "promo", "event",
    ]

    if any(kw in text for kw in high_impact):
        return "high"
    if any(kw in text for kw in medium_impact):
        return "medium"
    return "low"


# ─── Alpha Score Computation ─────────────────────────────────────────────────

def compute_alpha_score(
    card_price: CardPrice,
    reddit_posts: list[SentimentPost],
    youtube_posts: list[SentimentPost],
    leaks: list[LeakArticle],
    weights: dict = None,
) -> dict:
    """
    Compute the combined Alpha Score for a card.

    Returns: { price_alpha, sentiment_score, leak_catalyst, combined, signals }
    """
    if weights is None:
        weights = {"price": 0.40, "sentiment": 0.35, "leak": 0.25}

    # ── Price Alpha (0–100) ──
    price_score = 50
    current = card_price.tcgplayer_price or card_price.ebay_sold_avg or 0
    if current > 0:
        avg30 = card_price.price_30d_ago or current
        avg90 = card_price.price_90d_ago or current

        pct_below_30d = ((avg30 - current) / avg30) * 100 if avg30 > 0 else 0
        pct_below_90d = ((avg90 - current) / avg90) * 100 if avg90 > 0 else 0

        price_score += min(25, max(-25, pct_below_30d * 1.5))
        price_score += min(15, max(-15, pct_below_90d * 0.8))

        # Price spread across US sources
        prices = [p for p in [card_price.tcgplayer_price, card_price.ebay_sold_avg] if p]
        if len(prices) > 1:
            spread = (max(prices) - min(prices)) / min(prices) * 100
            if spread > 15:
                price_score += 5

        # 52-week range position
        if card_price.low_52w and card_price.high_52w and card_price.high_52w > card_price.low_52w:
            range_pct = (current - card_price.low_52w) / (card_price.high_52w - card_price.low_52w) * 100
            if range_pct < 30:
                price_score += 10
            elif range_pct > 80:
                price_score -= 10

    price_score = max(0, min(100, round(price_score)))

    # ── Sentiment Score (0–100) ──
    sentiment_score = 50
    card_name_lower = card_price.name.lower()

    relevant_reddit = [p for p in reddit_posts if card_name_lower in p.title.lower() or
                       any(card_name_lower in m.lower() for m in p.mentioned_cards)]
    relevant_youtube = [p for p in youtube_posts if card_name_lower in p.title.lower() or
                        any(card_name_lower in m.lower() for m in p.mentioned_cards)]

    reddit_count = len(relevant_reddit)
    youtube_count = len(relevant_youtube)

    sentiment_score += min(20, reddit_count * 5)
    sentiment_score += min(10, youtube_count * 3)

    if relevant_reddit:
        avg_sentiment = sum(p.sentiment for p in relevant_reddit) / len(relevant_reddit)
        sentiment_score += (avg_sentiment - 0.5) * 40

    sentiment_score = max(0, min(100, round(sentiment_score)))

    # ── Leak Catalyst (0–100) ──
    leak_score = 40
    relevant_leaks = [l for l in leaks if any(
        card_name_lower in p.lower() for p in l.mentioned_pokemon
    )]

    leak_score += len(relevant_leaks) * 8
    high_impact_leaks = sum(1 for l in relevant_leaks if l.impact == "high")
    leak_score += high_impact_leaks * 10

    leak_score = max(0, min(100, round(leak_score)))

    # ── Combined ──
    combined = round(
        price_score * weights["price"] +
        sentiment_score * weights["sentiment"] +
        leak_score * weights["leak"]
    )

    signals = []
    if price_score >= 70:
        signals.append("Price below moving averages")
    if sentiment_score >= 70:
        signals.append("Strong positive community sentiment")
    if leak_score >= 60:
        signals.append("Upcoming catalyst from leaks/news")
    if relevant_leaks:
        signals.append(f"{len(relevant_leaks)} related leak(s) found")

    return {
        "price_alpha": price_score,
        "sentiment_score": sentiment_score,
        "leak_catalyst": leak_score,
        "combined": combined,
        "signals": signals,
        "reddit_mentions": reddit_count,
        "youtube_mentions": youtube_count,
        "leak_mentions": len(relevant_leaks),
    }


# ─── Flask API ───────────────────────────────────────────────────────────────

app = Flask(__name__)
CORS(app)


@app.route("/api/health")
def health():
    """Health check with status of all data sources."""
    return jsonify({
        "status": "ok",
        "timestamp": datetime.now().isoformat(),
        "region": "USA / North America",
        "sources": {
            "pokemontcg": True,
            "poketrace": bool(POKETRACE_API_KEY),
            "tcgplayer": True,
            "ebay_sold": True,
            "pricecharting_graded": bool(PRICECHARTING_API_KEY),
            "ebay_scrape_fallback": not bool(POKETRACE_API_KEY),
            "reddit": bool(REDDIT_CLIENT_ID),
            "youtube": bool(YOUTUBE_API_KEY),
            "pokebeach": True,
            "pokemonblog": True,
        },
        "cache_entries": len(_cache),
    })


@app.route("/api/cards")
def api_cards():
    """Search and list cards with pricing data.

    Query params:
      q      — search query (e.g. "Charizard ex")
      page   — page number (default 1)
      limit  — results per page (default 20, max 50)
    """
    q = request.args.get("q", "")
    page = int(request.args.get("page", 1))
    limit = min(50, int(request.args.get("limit", 20)))

    # Build query for pokemontcg.io
    search = ""
    if q:
        search = f'name:"{q}"'

    raw_cards = fetch_cards(query=search, page=page, page_size=limit)
    results = []
    for card_data in raw_cards:
        price = extract_pricing(card_data)
        results.append(asdict(price))

    return jsonify({"cards": results, "page": page, "total": len(results)})


@app.route("/api/cards/<card_id>")
def api_card_detail(card_id):
    """Get detailed card info with US pricing from TCGPlayer + eBay + graded."""
    card_data = fetch_card_by_id(card_id)
    if not card_data:
        return jsonify({"error": "Card not found"}), 404

    price = extract_pricing(card_data)

    # Enrich with eBay sold comps and graded pricing
    enrich = request.args.get("enrich", "true").lower() == "true"
    if enrich:
        price = enrich_with_us_pricing(price)

    return jsonify({
        "card": asdict(price),
        "raw": {
            "pokemontcg": card_data,
        }
    })


@app.route("/api/cards/<card_id>/alpha")
def api_card_alpha(card_id):
    """Compute Alpha Score for a specific card."""
    card_data = fetch_card_by_id(card_id)
    if not card_data:
        return jsonify({"error": "Card not found"}), 404

    price = extract_pricing(card_data)
    card_name = card_data.get("name", "")

    # Fetch all data sources in parallel
    with ThreadPoolExecutor(max_workers=3) as executor:
        reddit_future = executor.submit(fetch_reddit_sentiment, card_name, 25)
        youtube_future = executor.submit(fetch_youtube_sentiment, f"Pokemon TCG {card_name}", 10)
        leaks_future = executor.submit(fetch_leak_news)

        reddit_posts = reddit_future.result()
        youtube_posts = youtube_future.result()
        leaks = leaks_future.result()

    # Parse weights from query params
    weights = {
        "price": float(request.args.get("w_price", 0.40)),
        "sentiment": float(request.args.get("w_sentiment", 0.35)),
        "leak": float(request.args.get("w_leak", 0.25)),
    }

    alpha = compute_alpha_score(price, reddit_posts, youtube_posts, leaks, weights)

    return jsonify({
        "card": asdict(price),
        "alpha": alpha,
    })


@app.route("/api/scanner")
def api_scanner():
    """Run the Alpha Scanner across popular/trending cards.

    Returns cards sorted by Alpha Score.

    Query params:
      q           — optional card name filter
      sort        — "alpha" (default), "price", "sentiment", "dip"
      type        — card type filter (Fire, Water, etc.)
      min_alpha   — minimum Alpha Score (default 0)
      w_price     — price weight (default 0.40)
      w_sentiment — sentiment weight (default 0.35)
      w_leak      — leak weight (default 0.25)
    """
    q = request.args.get("q", "")
    sort = request.args.get("sort", "alpha")
    card_type = request.args.get("type", "")
    min_alpha = int(request.args.get("min_alpha", 0))

    weights = {
        "price": float(request.args.get("w_price", 0.40)),
        "sentiment": float(request.args.get("w_sentiment", 0.35)),
        "leak": float(request.args.get("w_leak", 0.25)),
    }

    # Fetch cards — use popular search terms for the scanner
    searches = ["Charizard ex", "Pikachu VMAX", "Umbreon VMAX", "Lugia V", "Mew ex",
                "Iono", "Gardevoir ex", "Giratina VSTAR", "Miraidon ex", "Eevee"]
    if q:
        searches = [q]

    all_cards = []
    for name in searches:
        raw = fetch_cards(query=f'name:"{name}" rarity:"Special Art Rare" OR rarity:"Illustration Rare" OR rarity:"Secret Rare"', page_size=5)
        all_cards.extend(raw)

    # Fetch sentiment & leaks once
    reddit_posts = fetch_reddit_sentiment(limit=50)
    youtube_posts = fetch_youtube_sentiment(max_results=20)
    leaks = fetch_leak_news()

    results = []
    for card_data in all_cards:
        price = extract_pricing(card_data)
        if card_type and price.card_type != card_type:
            continue
        alpha = compute_alpha_score(price, reddit_posts, youtube_posts, leaks, weights)
        if alpha["combined"] >= min_alpha:
            results.append({
                "card": asdict(price),
                "alpha": alpha,
            })

    # Sort
    if sort == "alpha":
        results.sort(key=lambda r: r["alpha"]["combined"], reverse=True)
    elif sort == "price":
        results.sort(key=lambda r: r["card"].get("tcgplayer_price") or 0, reverse=True)
    elif sort == "sentiment":
        results.sort(key=lambda r: r["alpha"]["sentiment_score"], reverse=True)
    elif sort == "dip":
        results.sort(key=lambda r: (
            ((r["card"].get("tcgplayer_price") or 0) - (r["card"].get("price_30d_ago") or 0)) /
            (r["card"].get("price_30d_ago") or 1)
        ))

    return jsonify({"results": results, "total": len(results)})


@app.route("/api/sentiment")
def api_sentiment():
    """Get aggregated sentiment from Reddit and YouTube.

    Query params:
      q     — card name to filter by
      limit — max posts (default 25)
    """
    q = request.args.get("q", "")
    limit = int(request.args.get("limit", 25))

    reddit = fetch_reddit_sentiment(q, limit)
    youtube = fetch_youtube_sentiment(f"Pokemon TCG {q}" if q else "Pokemon TCG", min(limit, 10))

    all_posts = [asdict(p) for p in reddit + youtube]
    all_posts.sort(key=lambda p: p.get("timestamp", ""), reverse=True)

    # Aggregate stats
    sentiments = [p["sentiment"] for p in all_posts if p["sentiment"]]
    avg_sentiment = sum(sentiments) / len(sentiments) if sentiments else 0.5

    return jsonify({
        "posts": all_posts[:limit],
        "stats": {
            "total_posts": len(all_posts),
            "reddit_posts": len(reddit),
            "youtube_videos": len(youtube),
            "avg_sentiment": round(avg_sentiment, 2),
            "community_mood": "Bullish" if avg_sentiment > 0.6 else "Neutral" if avg_sentiment > 0.4 else "Bearish",
        }
    })


@app.route("/api/leaks")
def api_leaks():
    """Get latest leak and news articles from all sources.

    Query params:
      source  — filter by source (PokeBeach, PokemonBlog, Pokemon.com)
      impact  — filter by impact (high, medium, low)
    """
    source = request.args.get("source", "")
    impact = request.args.get("impact", "")

    articles = fetch_leak_news()
    if source:
        articles = [a for a in articles if a.source == source]
    if impact:
        articles = [a for a in articles if a.impact == impact]

    return jsonify({
        "articles": [asdict(a) for a in articles],
        "total": len(articles),
        "sources": {
            "PokeBeach": sum(1 for a in articles if a.source == "PokeBeach"),
            "PokemonBlog": sum(1 for a in articles if a.source == "PokemonBlog"),
            "Pokemon.com": sum(1 for a in articles if a.source == "Pokemon.com"),
        },
    })


@app.route("/api/cards/<card_id>/graded")
def api_card_graded(card_id):
    """Get graded card pricing via PokeTrace → PriceCharting → eBay sold comps.

    Returns PSA 10, BGS 9.5, and CGC 10 US market values.
    """
    card_data = fetch_card_by_id(card_id)
    if not card_data:
        return jsonify({"error": "Card not found"}), 404

    card_name = card_data.get("name", "")
    set_name = card_data.get("set", {}).get("name", "")

    us_data = fetch_us_pricing(card_name, set_name)

    # Also get raw price for grade premium calculation
    price = extract_pricing(card_data)
    raw = price.tcgplayer_price or 0

    return jsonify({
        "card_id": card_id,
        "card_name": card_name,
        "set_name": set_name,
        "raw_price": raw,
        "graded": {
            "psa_10": us_data["psa10"],
            "bgs_9_5": us_data["bgs95"],
            "cgc_10": us_data["cgc10"],
        },
        "grade_premium": {
            "psa_10_multiplier": round(us_data["psa10"] / raw, 1) if raw and us_data["psa10"] else None,
            "bgs_9_5_multiplier": round(us_data["bgs95"] / raw, 1) if raw and us_data["bgs95"] else None,
            "cgc_10_multiplier": round(us_data["cgc10"] / raw, 1) if raw and us_data["cgc10"] else None,
        },
        "source": us_data["source"],
    })


# ─── Entry point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    LOG.info("=" * 60)
    LOG.info(" PokéAlpha Backend v1.0 — USA / North America")
    LOG.info("=" * 60)
    LOG.info(f"  Port:           {PORT}")
    LOG.info(f"  Cache TTL:      {CACHE_TTL}s")
    LOG.info(f"  Region:         USA / North America only")
    LOG.info(f"  Reddit API:     {'Configured' if REDDIT_CLIENT_ID else 'Not configured'}")
    LOG.info(f"  YouTube API:    {'Configured' if YOUTUBE_API_KEY else 'Not configured'}")
    LOG.info(f"  PokeTrace API: {'Configured' if POKETRACE_API_KEY else 'Not configured (using fallbacks)'}")
    LOG.info(f"  PriceCharting:  {'Configured' if PRICECHARTING_API_KEY else 'Using eBay fallback'}")
    LOG.info("")
    LOG.info("Pricing chain (US-only):")
    LOG.info("  1. PokeTrace API (market=US) — TCGPlayer + eBay sold + graded")
    LOG.info("  2. PriceCharting API          — graded supplement (PSA, BGS, CGC)")
    LOG.info("  3. eBay sold scraping          — fallback for missing values")
    LOG.info("")
    LOG.info("Endpoints:")
    LOG.info("  GET /api/health             — Service status")
    LOG.info("  GET /api/cards?q=...        — Search cards with US pricing")
    LOG.info("  GET /api/cards/<id>         — Card detail + eBay + graded")
    LOG.info("  GET /api/cards/<id>/alpha   — Alpha Score for a card")
    LOG.info("  GET /api/cards/<id>/graded  — Graded card values (PSA/BGS/CGC)")
    LOG.info("  GET /api/scanner            — Run full Alpha Scanner")
    LOG.info("  GET /api/sentiment          — Social sentiment feed")
    LOG.info("  GET /api/leaks              — Leak & news tracker")
    LOG.info("=" * 60)

    app.run(host="0.0.0.0", port=PORT, debug=True)
