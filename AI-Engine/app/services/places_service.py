"""
OpenStreetMap Places Service — free location search for the chatbot.

Uses two OSM APIs:
  • Nominatim  — search places by name (e.g., "KFC Surigao City")
  • Overpass   — find nearby POIs by category (e.g., "restaurants in Surigao")

No API key needed. Completely free. Just respect the 1 req/sec rate limit.
"""

import asyncio
import re
import logging
from typing import List, Dict, Optional

import httpx

logger = logging.getLogger(__name__)

# ── Nominatim (geocoding / place search) ──────────────────────────────────────
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
# Required by Nominatim usage policy — identifies your application
USER_AGENT = "DTSChatbot/1.0 (Surigao City DTS AI Engine)"

# Surigao City bounding box for biased search (south,north,west,east)
SURIGAO_VIEWBOX = "125.45,9.73,125.55,9.85"

# ── Overpass (POI category search) ────────────────────────────────────────────
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Surigao City area for Overpass queries
SURIGAO_BBOX = "(9.73,125.42,9.88,125.55)"

# ── Category mapping — user keywords → OSM amenity/shop/tourism tags ─────────
_CATEGORY_MAP = {
    # Restaurants & food
    "restaurant":  'node["amenity"="restaurant"]',
    "restaurants": 'node["amenity"="restaurant"]',
    "food":        'node["amenity"~"restaurant|fast_food|cafe"]',
    "eat":         'node["amenity"~"restaurant|fast_food|cafe"]',
    "kainan":      'node["amenity"~"restaurant|fast_food|cafe"]',
    "fast food":   'node["amenity"="fast_food"]',
    "cafe":        'node["amenity"="cafe"]',
    "coffee":      'node["amenity"="cafe"]',
    "bakery":      'node["shop"="bakery"]',

    # Hotels
    "hotel":       'node["tourism"~"hotel|guest_house|hostel"]',
    "hotels":      'node["tourism"~"hotel|guest_house|hostel"]',
    "inn":         'node["tourism"~"hotel|guest_house|hostel"]',
    "resort":      'node["tourism"="resort"]',
    "accommodation": 'node["tourism"~"hotel|guest_house|hostel|resort"]',

    # Health
    "hospital":    'node["amenity"="hospital"]',
    "clinic":      'node["amenity"="clinic"]',
    "pharmacy":    'node["amenity"="pharmacy"]',
    "drugstore":   'node["amenity"="pharmacy"]',
    "botika":      'node["amenity"="pharmacy"]',

    # Government
    "government":  'node["office"="government"]',
    "city hall":   'node["office"="government"]',
    "barangay":    'node["office"="government"]',
    "police":      'node["amenity"="police"]',
    "fire":        'node["amenity"="fire_station"]',

    # Education
    "school":      'node["amenity"~"school|college|university"]',
    "university":  'node["amenity"="university"]',
    "college":     'node["amenity"="college"]',

    # Shopping
    "mall":        'node["shop"="mall"]',
    "supermarket": 'node["shop"="supermarket"]',
    "grocery":     'node["shop"~"supermarket|convenience"]',
    "store":       'node["shop"]',
    "shop":        'node["shop"]',
    "market":      'node["amenity"="marketplace"]',

    # Transport
    "gas":         'node["amenity"="fuel"]',
    "gasoline":    'node["amenity"="fuel"]',
    "fuel":        'node["amenity"="fuel"]',
    "bus":         'node["amenity"="bus_station"]',
    "port":        'node["amenity"~"ferry_terminal|port"]',
    "airport":     'node["aeroway"="aerodrome"]',

    # Banks
    "bank":        'node["amenity"="bank"]',
    "atm":         'node["amenity"="atm"]',

    # Tourism
    "tourist":     'node["tourism"]',
    "tourist spot": 'node["tourism"~"attraction|viewpoint|museum"]',
    "attraction":  'node["tourism"="attraction"]',
    "beach":       'node["natural"="beach"]',
    "church":      'node["amenity"="place_of_worship"]',
    "park":        'node["leisure"="park"]',
}

# Keywords that signal a places/location query
PLACES_KEYWORDS = {
    "where", "located", "location", "address", "find", "directions",
    "near", "nearest", "nearby", "contact", "hours", "open", "closed",
    "restaurant", "hotel", "hospital", "school", "church", "mall",
    "store", "shop", "cafe", "bar", "pharmacy", "gas", "station",
    "bank", "atm", "park", "beach", "resort", "tourist", "spot",
    "kfc", "jollibee", "mcdo", "mcdonald", "greenwich", "chowking",
    # Tagalog
    "saan", "nasaan", "malapit", "oras", "bukas",
}


def is_places_query(message: str) -> bool:
    """Check if the message is asking about a physical location/place."""
    words = set(re.findall(r'\b[a-zA-Z]+\b', message.lower()))
    return bool(words & PLACES_KEYWORDS)


def _detect_category(message: str) -> Optional[str]:
    """
    Check if the message is asking about a general category
    (e.g., 'restaurants near surigao') rather than a specific place.
    Returns the Overpass query filter or None.
    """
    msg_lower = message.lower()
    for keyword, osm_filter in _CATEGORY_MAP.items():
        if keyword in msg_lower:
            return osm_filter
    return None


def _make_osm_url(lat: float, lon: float, name: str = "") -> str:
    """Generate an OpenStreetMap link for a location."""
    return f"https://www.openstreetmap.org/?mlat={lat}&mlon={lon}#map=17/{lat}/{lon}"


async def search_place_by_name(query: str, max_results: int = 3) -> List[Dict]:
    """
    Search for a specific place by name using Nominatim.

    Example: "KFC Surigao City" → returns address, coordinates, map link
    """
    # Add "Surigao City" context if not already present
    q = query.strip()
    if "surigao" not in q.lower():
        q += ", Surigao City"

    params = {
        "q": q,
        "format": "jsonv2",
        "addressdetails": 1,
        "limit": max_results,
        "viewbox": SURIGAO_VIEWBOX,
        "bounded": 0,  # prefer viewbox but don't exclude outside results
        "countrycodes": "ph",
    }

    headers = {"User-Agent": USER_AGENT}

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(NOMINATIM_URL, params=params, headers=headers)
            res.raise_for_status()
            data = res.json()
    except Exception as e:
        logger.error(f"[Places] Nominatim error: {e}")
        return []

    results = []
    for item in data:
        lat = float(item.get("lat", 0))
        lon = float(item.get("lon", 0))
        name = item.get("display_name", "Unknown")
        addr = item.get("address", {})

        # Build a clean short address
        parts = []
        for key in ("road", "suburb", "city", "state", "postcode"):
            if addr.get(key):
                parts.append(addr[key])
        short_address = ", ".join(parts) if parts else name

        results.append({
            "name": item.get("name", name.split(",")[0]),
            "address": short_address,
            "full_address": name,
            "latitude": lat,
            "longitude": lon,
            "type": item.get("type", ""),
            "category": item.get("category", ""),
            "maps_url": _make_osm_url(lat, lon, item.get("name", "")),
        })

    logger.info(f"[Places] Nominatim found {len(results)} result(s) for '{q}'")
    return results


async def search_places_by_category(
    osm_filter: str,
    max_results: int = 5,
) -> List[Dict]:
    """
    Search for places by category using Overpass API.

    Example: find all restaurants in Surigao City area.
    """
    query = f"""
    [out:json][timeout:10];
    (
      {osm_filter}{SURIGAO_BBOX};
    );
    out center {max_results};
    """

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.post(OVERPASS_URL, data={"data": query})
            res.raise_for_status()
            data = res.json()
    except Exception as e:
        logger.error(f"[Places] Overpass error: {e}")
        return []

    results = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        lat = el.get("lat", el.get("center", {}).get("lat", 0))
        lon = el.get("lon", el.get("center", {}).get("lon", 0))
        name = tags.get("name", "Unnamed")

        if name == "Unnamed":
            continue

        # Build address from available tags
        addr_parts = []
        for key in ("addr:street", "addr:city", "addr:province"):
            if tags.get(key):
                addr_parts.append(tags[key])
        address = ", ".join(addr_parts) if addr_parts else ""

        results.append({
            "name": name,
            "address": address,
            "phone": tags.get("phone", tags.get("contact:phone", "")),
            "hours": tags.get("opening_hours", ""),
            "website": tags.get("website", ""),
            "latitude": lat,
            "longitude": lon,
            "maps_url": _make_osm_url(lat, lon, name),
        })

    logger.info(f"[Places] Overpass found {len(results)} result(s)")
    return results


async def search_places(message: str, max_results: int = 3) -> List[Dict]:
    """
    Main entry point — decides whether to do a name search or category search.

    Returns a list of place dicts.
    """
    # Check for category search first (e.g., "restaurants near surigao")
    category_filter = _detect_category(message)
    if category_filter:
        # Check if there's also a specific name (e.g., "KFC restaurant")
        # If the message has a proper noun, prefer name search
        words = message.split()
        has_proper_noun = any(w[0].isupper() and w.lower() not in PLACES_KEYWORDS for w in words if len(w) > 1)

        if not has_proper_noun:
            results = await search_places_by_category(category_filter, max_results=max_results)
            if results:
                return results

    # Fall back to name search via Nominatim
    return await search_place_by_name(message, max_results=max_results)


def format_place_response(places: List[Dict], query: str = "") -> str:
    """Format place results into a chat-friendly markdown response."""
    if not places:
        return ""

    if len(places) == 1:
        p = places[0]
        lines = [f"📍 **{p['name']}**"]
        if p.get("address"):
            lines.append(f"📫 **Address:** {p['address']}")
        if p.get("phone"):
            lines.append(f"📞 **Contact:** {p['phone']}")
        if p.get("hours"):
            lines.append(f"🕐 **Hours:** {p['hours']}")
        if p.get("website"):
            lines.append(f"🌐 **Website:** {p['website']}")
        if p.get("maps_url"):
            lines.append(f"\n🗺️ **Map:** {p['maps_url']}")
        return "\n".join(lines)

    # Multiple results
    lines = [f"I found **{len(places)} places** matching your query:\n"]
    for i, p in enumerate(places, 1):
        lines.append(f"**{i}. {p['name']}**")
        if p.get("address"):
            lines.append(f"   📫 {p['address']}")
        if p.get("phone"):
            lines.append(f"   📞 {p['phone']}")
        if p.get("maps_url"):
            lines.append(f"   🗺️ {p['maps_url']}")
        lines.append("")

    return "\n".join(lines)
