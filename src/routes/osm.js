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

// ============================================
// Phase 2: Tile-based endpoint
// ============================================

// Tile size in metres (matching TileManager)
const TILE_SIZE_M = 200;

// Metres per degree at equator (approximately)
const METERS_PER_DEG_LAT = 111320;

/**
 * Convert GPS to local tile coordinates (metres from tile origin)
 */
function gpsToTileLocal(lat, lng, tileOrigin, metersPerDegLng) {
    return {
        x: (lng - tileOrigin.lng) * metersPerDegLng,
        z: (lat - tileOrigin.lat) * METERS_PER_DEG_LAT
    };
}

/**
 * Get tile ID from bbox (for caching)
 */
function getTileId(south, west, north, east) {
    // Use bbox centre rounded to tile grid
    const centreLat = (parseFloat(south) + parseFloat(north)) / 2;
    const centreLng = (parseFloat(west) + parseFloat(east)) / 2;
    return `tile_${centreLat.toFixed(4)}_${centreLng.toFixed(4)}`;
}

/**
 * Estimate road width from highway type
 */
function getRoadWidth(type) {
    const widths = {
        'motorway': 14, 'motorway_link': 8,
        'trunk': 12, 'trunk_link': 7,
        'primary': 10, 'primary_link': 6,
        'secondary': 8, 'secondary_link': 5,
        'tertiary': 7, 'tertiary_link': 5,
        'residential': 6, 'living_street': 5,
        'service': 4, 'unclassified': 5,
        'footway': 2, 'pedestrian': 3,
        'path': 1.5, 'cycleway': 2,
        'track': 3, 'steps': 2
    };
    return widths[type] || 5;
}

// Overpass mirrors for failover
const OVERPASS_MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];

/**
 * Fetch all OSM features for a tile from Overpass with retry
 */
async function fetchTileFromOverpass(south, west, north, east) {
    // Single query for all feature types
    const query = `
        [out:json][timeout:25];
        (
            // Buildings
            way["building"](${south},${west},${north},${east});

            // Roads and paths
            way["highway"](${south},${west},${north},${east});

            // Water bodies
            way["natural"="water"](${south},${west},${north},${east});
            way["waterway"](${south},${west},${north},${east});
            relation["natural"="water"](${south},${west},${north},${east});

            // Landuse (parks, forests, etc.)
            way["leisure"="park"](${south},${west},${north},${east});
            way["landuse"~"grass|forest|meadow|recreation_ground"](${south},${west},${north},${east});
            way["natural"~"wood|grassland|scrub"](${south},${west},${north},${east});

            // Railways
            way["railway"~"rail|light_rail|tram|subway"](${south},${west},${north},${east});
        );
        out body geom;
    `;

    let lastError = null;

    // Try each mirror in sequence
    for (const overpassUrl of OVERPASS_MIRRORS) {
        try {
            console.log(`OSM Tile: Trying ${overpassUrl.split('/')[2]}...`);

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 20000); // 20s timeout

            const response = await fetch(overpassUrl, {
                method: 'POST',
                body: `data=${encodeURIComponent(query)}`,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (response.ok) {
                const data = await response.json();
                console.log(`OSM Tile: Success from ${overpassUrl.split('/')[2]}`);
                return data;
            }

            lastError = new Error(`HTTP ${response.status}`);
            console.log(`OSM Tile: ${overpassUrl.split('/')[2]} returned ${response.status}, trying next...`);

        } catch (err) {
            lastError = err;
            console.log(`OSM Tile: ${overpassUrl.split('/')[2]} failed: ${err.message}, trying next...`);
        }
    }

    // All mirrors failed - return null instead of throwing
    console.log('OSM Tile: All Overpass mirrors failed');
    return null;
}

/**
 * Process Overpass response into structured tile features
 * Converts GPS to local tile coordinates
 */
function processTileFeatures(overpassData, tileOrigin, metersPerDegLng) {
    const features = {
        buildings: [],
        roads: [],
        water: [],
        landuse: [],
        rail: [],
        poi: []
    };

    // Hard caps per tile for performance
    const MAX_BUILDINGS = 200;
    const MAX_ROADS = 150;
    const MAX_WATER = 50;
    const MAX_LANDUSE = 50;
    const MAX_RAIL = 30;

    for (const el of overpassData.elements || []) {
        if (el.type !== 'way' && el.type !== 'relation') continue;
        if (!el.geometry || el.geometry.length < 2) continue;

        const tags = el.tags || {};

        // Convert geometry to local coords
        const localGeom = el.geometry.map(p =>
            gpsToTileLocal(p.lat, p.lon, tileOrigin, metersPerDegLng)
        );

        // Classify by tags
        if (tags.building && features.buildings.length < MAX_BUILDINGS) {
            // Calculate centroid and bounds
            let sumX = 0, sumZ = 0;
            let minX = Infinity, maxX = -Infinity;
            let minZ = Infinity, maxZ = -Infinity;

            for (const p of localGeom) {
                sumX += p.x; sumZ += p.z;
                minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
                minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
            }

            features.buildings.push({
                id: `way/${el.id}`,
                footprint: localGeom.map(p => [p.x, p.z]),
                center: { x: sumX / localGeom.length, z: sumZ / localGeom.length },
                bounds: { minX, maxX, minZ, maxZ },
                heightM: estimateHeight(tags),
                minHeightM: parseFloat(tags['min_height']) || 0,
                kind: tags.building,
                tags: { building: tags.building, name: tags.name }
            });
        }
        else if (tags.highway && features.roads.length < MAX_ROADS) {
            features.roads.push({
                id: `way/${el.id}`,
                path: localGeom.map(p => [p.x, p.z]),
                kind: tags.highway,
                widthM: getRoadWidth(tags.highway),
                surface: tags.surface || 'asphalt',
                tags: { highway: tags.highway, name: tags.name, lanes: tags.lanes }
            });
        }
        else if ((tags.natural === 'water' || tags.waterway) && features.water.length < MAX_WATER) {
            features.water.push({
                id: `way/${el.id}`,
                polygon: localGeom.map(p => [p.x, p.z]),
                kind: tags.waterway || 'water',
                tags: { natural: tags.natural, waterway: tags.waterway, name: tags.name }
            });
        }
        else if ((tags.leisure === 'park' || tags.landuse || tags.natural) &&
                 !tags.building && !tags.highway && !tags.waterway &&
                 features.landuse.length < MAX_LANDUSE) {
            const kind = tags.leisure || tags.landuse || tags.natural;
            if (['park', 'grass', 'forest', 'meadow', 'recreation_ground', 'wood', 'grassland', 'scrub'].includes(kind)) {
                features.landuse.push({
                    id: `way/${el.id}`,
                    polygon: localGeom.map(p => [p.x, p.z]),
                    kind: kind,
                    tags: { leisure: tags.leisure, landuse: tags.landuse, natural: tags.natural, name: tags.name }
                });
            }
        }
        else if (tags.railway && features.rail.length < MAX_RAIL) {
            features.rail.push({
                id: `way/${el.id}`,
                path: localGeom.map(p => [p.x, p.z]),
                kind: tags.railway,
                electrified: tags.electrified || 'no',
                tags: { railway: tags.railway, name: tags.name }
            });
        }
    }

    return features;
}

/**
 * GET /api/osm/tile
 * Returns all OSM features for a tile in local coordinates
 *
 * Query params:
 *   south, west, north, east - Bounding box coordinates
 *   originLat, originLng - World origin for coordinate transformation (optional)
 *
 * Response contract:
 * {
 *   tileId: string,
 *   bounds: { south, west, north, east },
 *   tileOrigin: { lat, lng },  // SW corner of tile
 *   generatedAt: number,
 *   expiresAt: number,
 *   source: 'overpass' | 'cache',
 *   dataVersion: 1,
 *   features: {
 *     buildings: [{ id, footprint, center, bounds, heightM, minHeightM, kind, tags }],
 *     roads: [{ id, path, kind, widthM, surface, tags }],
 *     water: [{ id, polygon, kind, tags }],
 *     landuse: [{ id, polygon, kind, tags }],
 *     rail: [{ id, path, kind, electrified, tags }],
 *     poi: []
 *   },
 *   elevation: {
 *     mode: 'none' | 'grid',
 *     gridSize: number,
 *     origin: { x, z },
 *     stepM: number,
 *     heights: number[]
 *   },
 *   stats: {
 *     buildings: number,
 *     roads: number,
 *     water: number,
 *     landuse: number,
 *     rail: number
 *   }
 * }
 */
router.get('/tile', async (req, res) => {
    try {
        const { south, west, north, east, originLat, originLng } = req.query;

        // Validate params
        if (!south || !west || !north || !east) {
            return res.status(400).json({
                error: 'Missing required parameters: south, west, north, east',
                code: 'MISSING_PARAMS'
            });
        }

        // Validate bbox size (max 0.25 km² for tiles)
        const area = calculateArea(south, west, north, east);
        if (area > 0.25) {
            return res.status(400).json({
                error: `Bounding box too large: ${area.toFixed(3)}km² (max 0.25km² for tiles)`,
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

        // Tile origin is SW corner
        const tileOrigin = {
            lat: parseFloat(south),
            lng: parseFloat(west)
        };

        // Calculate metres per degree longitude at this latitude
        const avgLat = (parseFloat(south) + parseFloat(north)) / 2;
        const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos(avgLat * Math.PI / 180);

        // Cache key using tile ID
        const tileId = getTileId(south, west, north, east);
        const cacheKey = `tile:${tileId}`;
        const cached = cache.get(cacheKey);

        const now = Date.now();
        const expiresAt = now + CACHE_TTL;

        const entryTTL = cached?.ttl || CACHE_TTL;
        if (cached && now - cached.timestamp < entryTTL) {
            return res.json({
                ...cached.data,
                source: 'cache',
                generatedAt: cached.timestamp,
                expiresAt: cached.timestamp + entryTTL
            });
        }

        // Fetch from Overpass
        console.log(`OSM Tile: Fetching ${tileId} bbox ${south},${west},${north},${east}`);
        const overpassData = await fetchTileFromOverpass(south, west, north, east);

        // Process features to local coordinates (or empty if Overpass failed)
        let features;
        let source = 'overpass';

        if (overpassData && overpassData.elements) {
            features = processTileFeatures(overpassData, tileOrigin, metersPerDegLng);
        } else {
            // Overpass failed - return empty tile so frontend can still render terrain
            console.log(`OSM Tile: Returning empty tile for ${tileId} (Overpass unavailable)`);
            features = {
                buildings: [],
                roads: [],
                water: [],
                landuse: [],
                rail: [],
                poi: []
            };
            source = 'empty';
        }

        // Build response
        const responseData = {
            tileId,
            bounds: {
                south: parseFloat(south),
                west: parseFloat(west),
                north: parseFloat(north),
                east: parseFloat(east)
            },
            tileOrigin,
            metersPerDegLng,
            generatedAt: now,
            expiresAt,
            source,
            dataVersion: 1,
            features,
            elevation: {
                mode: 'none',
                gridSize: 0,
                origin: { x: 0, z: 0 },
                stepM: 0,
                heights: []
            },
            stats: {
                buildings: features.buildings.length,
                roads: features.roads.length,
                water: features.water.length,
                landuse: features.landuse.length,
                rail: features.rail.length
            }
        };

        // Cache result (shorter TTL for empty tiles)
        const cacheTTL = source === 'empty' ? 5 * 60 * 1000 : CACHE_TTL;  // 5 min for empty, 24h for full
        cache.set(cacheKey, {
            data: responseData,
            timestamp: now,
            ttl: cacheTTL
        });

        // Clean old cache entries
        if (cache.size > 1000) {
            for (const [key, value] of cache) {
                if (now - value.timestamp > CACHE_TTL) {
                    cache.delete(key);
                }
            }
        }

        console.log(`OSM Tile: ${tileId} - ${features.buildings.length} buildings, ${features.roads.length} roads, ${features.water.length} water, ${features.landuse.length} landuse`);

        res.json(responseData);

    } catch (error) {
        console.error('OSM tile error:', error);
        res.status(500).json({
            error: 'Failed to fetch tile data',
            code: 'FETCH_ERROR',
            details: error.message
        });
    }
});

module.exports = router;
