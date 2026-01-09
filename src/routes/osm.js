/**
 * TOW Backend - OSM Proxy Routes
 * Proxies OpenStreetMap Overpass API with caching and rate limiting
 */

const express = require('express');
const router = express.Router();

// In-memory cache (for Render free tier - no Redis)
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;  // 24 hours

// Rate limiting per session
const rateLimits = new Map();
const RATE_LIMIT = 10;  // requests per minute
const RATE_WINDOW = 60 * 1000;  // 1 minute

// ============================================
// Helpers
// ============================================

/**
 * Get cache key for bbox
 */
function getCacheKey(south, west, north, east) {
    // Round to 3 decimal places for cache efficiency
    const s = parseFloat(south).toFixed(3);
    const w = parseFloat(west).toFixed(3);
    const n = parseFloat(north).toFixed(3);
    const e = parseFloat(east).toFixed(3);
    return `osm:${s}:${w}:${n}:${e}`;
}

/**
 * Check rate limit
 */
function checkRateLimit(sessionId) {
    const now = Date.now();
    const key = sessionId || 'anonymous';

    if (!rateLimits.has(key)) {
        rateLimits.set(key, { count: 1, windowStart: now });
        return true;
    }

    const limit = rateLimits.get(key);

    // Reset window if expired
    if (now - limit.windowStart > RATE_WINDOW) {
        rateLimits.set(key, { count: 1, windowStart: now });
        return true;
    }

    // Check limit
    if (limit.count >= RATE_LIMIT) {
        return false;
    }

    limit.count++;
    return true;
}

/**
 * Calculate bbox area in km²
 */
function calculateArea(south, west, north, east) {
    const latDiff = Math.abs(north - south);
    const lngDiff = Math.abs(east - west);
    const avgLat = (parseFloat(north) + parseFloat(south)) / 2;

    // Approximate conversion to km
    const latKm = latDiff * 111;
    const lngKm = lngDiff * 111 * Math.cos(avgLat * Math.PI / 180);

    return latKm * lngKm;
}

/**
 * Estimate building height from tags
 */
function estimateHeight(tags) {
    if (!tags) return 10;  // Default 10m

    // Explicit height
    if (tags.height) {
        const h = parseFloat(tags.height);
        if (!isNaN(h)) return h;
    }

    // Building levels (assume 3m per level)
    if (tags['building:levels']) {
        const levels = parseInt(tags['building:levels']);
        if (!isNaN(levels)) return levels * 3;
    }

    // Estimate by building type
    const type = tags.building || 'yes';
    const heights = {
        'house': 8,
        'residential': 12,
        'apartments': 18,
        'commercial': 15,
        'industrial': 10,
        'retail': 8,
        'office': 20,
        'church': 15,
        'cathedral': 30,
        'school': 10,
        'hospital': 20,
        'hotel': 25,
        'warehouse': 8,
        'garage': 4,
        'shed': 3,
        'hut': 3,
        'yes': 10
    };

    return heights[type] || 10;
}

/**
 * Fetch from Overpass API
 */
async function fetchFromOverpass(south, west, north, east) {
    const query = `
        [out:json][timeout:25];
        (
            way["building"](${south},${west},${north},${east});
        );
        out body;
        >;
        out skel qt;
    `;

    const overpassUrl = 'https://overpass-api.de/api/interpreter';

    const response = await fetch(overpassUrl, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });

    if (!response.ok) {
        throw new Error(`Overpass API error: ${response.status}`);
    }

    return await response.json();
}

/**
 * Process Overpass response to simplified building data
 */
function processBuildings(overpassData) {
    const buildings = [];
    const nodes = new Map();

    // Index nodes
    for (const el of overpassData.elements || []) {
        if (el.type === 'node') {
            nodes.set(el.id, { lat: el.lat, lon: el.lon });
        }
    }

    // Process ways (buildings)
    for (const el of overpassData.elements || []) {
        if (el.type !== 'way' || !el.tags?.building) continue;

        // Calculate bounding box from nodes
        let minLat = Infinity, maxLat = -Infinity;
        let minLon = Infinity, maxLon = -Infinity;
        let sumLat = 0, sumLon = 0;
        let nodeCount = 0;

        for (const nodeId of el.nodes || []) {
            const node = nodes.get(nodeId);
            if (node) {
                minLat = Math.min(minLat, node.lat);
                maxLat = Math.max(maxLat, node.lat);
                minLon = Math.min(minLon, node.lon);
                maxLon = Math.max(maxLon, node.lon);
                sumLat += node.lat;
                sumLon += node.lon;
                nodeCount++;
            }
        }

        if (nodeCount === 0) continue;

        buildings.push({
            id: el.id,
            center: {
                lat: sumLat / nodeCount,
                lng: sumLon / nodeCount
            },
            bounds: {
                minlat: minLat,
                maxlat: maxLat,
                minlon: minLon,
                maxlon: maxLon
            },
            height: estimateHeight(el.tags),
            type: el.tags.building || 'yes',
            name: el.tags.name || null
        });
    }

    return buildings;
}

// ============================================
// Routes
// ============================================

/**
 * GET /api/osm/buildings
 * Returns building bounding boxes for an area
 *
 * Query params:
 *   south, west, north, east - Bounding box coordinates
 */
router.get('/buildings', async (req, res) => {
    try {
        const { south, west, north, east } = req.query;

        // Validate params
        if (!south || !west || !north || !east) {
            return res.status(400).json({
                error: 'Missing required parameters: south, west, north, east',
                code: 'MISSING_PARAMS'
            });
        }

        // Validate bbox size (max 1km²)
        const area = calculateArea(south, west, north, east);
        if (area > 1) {
            return res.status(400).json({
                error: `Bounding box too large: ${area.toFixed(2)}km² (max 1km²)`,
                code: 'BBOX_TOO_LARGE'
            });
        }

        // Check rate limit
        const sessionId = req.headers['x-session-id'] || req.ip;
        if (!checkRateLimit(sessionId)) {
            return res.status(429).json({
                error: 'Rate limit exceeded. Max 10 requests per minute.',
                code: 'RATE_LIMITED'
            });
        }

        // Check cache
        const cacheKey = getCacheKey(south, west, north, east);
        const cached = cache.get(cacheKey);

        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            return res.json({
                buildings: cached.data,
                cached: true,
                count: cached.data.length
            });
        }

        // Fetch from Overpass
        console.log(`OSM: Fetching buildings for bbox ${south},${west},${north},${east}`);
        const overpassData = await fetchFromOverpass(south, west, north, east);

        // Process to simplified format
        const buildings = processBuildings(overpassData);

        // Cache result
        cache.set(cacheKey, {
            data: buildings,
            timestamp: Date.now()
        });

        // Clean old cache entries periodically
        if (cache.size > 1000) {
            const now = Date.now();
            for (const [key, value] of cache) {
                if (now - value.timestamp > CACHE_TTL) {
                    cache.delete(key);
                }
            }
        }

        res.json({
            buildings,
            cached: false,
            count: buildings.length
        });

    } catch (error) {
        console.error('OSM proxy error:', error);
        res.status(500).json({
            error: 'Failed to fetch building data',
            code: 'FETCH_ERROR',
            details: error.message
        });
    }
});

/**
 * GET /api/osm/status
 * Returns cache and rate limit status
 */
router.get('/status', (req, res) => {
    res.json({
        cacheSize: cache.size,
        rateLimitWindow: RATE_WINDOW,
        rateLimitMax: RATE_LIMIT,
        cacheTTL: CACHE_TTL
    });
});

module.exports = router;
