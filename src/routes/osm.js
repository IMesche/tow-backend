/**
 * TOW Backend - OSM Proxy Routes
 * Proxies OpenStreetMap Overpass API with caching and rate limiting
 * Now with elevation support from Malta 1m DTM
 */

const express = require('express');
const router = express.Router();

// ============================================
// Elevation System - Malta 1m DTM via WCS
// ============================================

// Malta WCS endpoint
const MALTA_WCS_URL = 'https://malta.coverage.wetransform.eu/dtm_1m_2018/ows';
const MALTA_COVERAGE_ID = 'dtm_1m_2018';

// Malta bounds in WGS84 (approximate)
const MALTA_BOUNDS = {
    south: 35.78,
    north: 36.10,
    west: 14.13,
    east: 14.62
};

// UTM Zone 33N parameters
const UTM_ZONE_33N = {
    falseEasting: 500000,
    falseNorthing: 0,
    scaleFactor: 0.9996,
    centralMeridian: 15  // degrees
};

/**
 * Convert WGS84 (lat/lng) to UTM Zone 33N
 */
function wgs84ToUtm33N(lat, lng) {
    const a = 6378137;  // WGS84 semi-major axis
    const f = 1 / 298.257223563;  // WGS84 flattening
    const k0 = UTM_ZONE_33N.scaleFactor;
    const lon0 = UTM_ZONE_33N.centralMeridian * Math.PI / 180;

    const e2 = 2 * f - f * f;  // First eccentricity squared
    const e4 = e2 * e2;
    const e6 = e4 * e2;

    const phi = lat * Math.PI / 180;
    const lambda = lng * Math.PI / 180;

    const N = a / Math.sqrt(1 - e2 * Math.sin(phi) * Math.sin(phi));
    const T = Math.tan(phi) * Math.tan(phi);
    const C = (e2 / (1 - e2)) * Math.cos(phi) * Math.cos(phi);
    const A = Math.cos(phi) * (lambda - lon0);

    const M = a * (
        (1 - e2/4 - 3*e4/64 - 5*e6/256) * phi -
        (3*e2/8 + 3*e4/32 + 45*e6/1024) * Math.sin(2*phi) +
        (15*e4/256 + 45*e6/1024) * Math.sin(4*phi) -
        (35*e6/3072) * Math.sin(6*phi)
    );

    const easting = UTM_ZONE_33N.falseEasting + k0 * N * (
        A + (1 - T + C) * A*A*A / 6 +
        (5 - 18*T + T*T + 72*C - 58*(e2/(1-e2))) * A*A*A*A*A / 120
    );

    const northing = UTM_ZONE_33N.falseNorthing + k0 * (
        M + N * Math.tan(phi) * (
            A*A / 2 +
            (5 - T + 9*C + 4*C*C) * A*A*A*A / 24 +
            (61 - 58*T + T*T + 600*C - 330*(e2/(1-e2))) * A*A*A*A*A*A / 720
        )
    );

    return { easting, northing };
}

/**
 * Check if point is within Malta bounds
 */
function isInMalta(lat, lng) {
    return lat >= MALTA_BOUNDS.south && lat <= MALTA_BOUNDS.north &&
           lng >= MALTA_BOUNDS.west && lng <= MALTA_BOUNDS.east;
}

/**
 * Fetch elevation grid from Malta WCS for a tile
 * Returns 11x11 grid of heights for 200m tile
 */
async function fetchMaltaElevation(south, west, north, east) {
    // Check if tile is in Malta
    const centreL = (parseFloat(south) + parseFloat(north)) / 2;
    const centreN = (parseFloat(west) + parseFloat(east)) / 2;

    if (!isInMalta(centreL, centreN)) {
        return null;  // Outside Malta, no elevation data
    }

    try {
        // Convert corners to UTM
        const sw = wgs84ToUtm33N(parseFloat(south), parseFloat(west));
        const ne = wgs84ToUtm33N(parseFloat(north), parseFloat(east));

        // WCS GetCoverage request for small subset
        const wcsUrl = `${MALTA_WCS_URL}?` +
            `SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage` +
            `&COVERAGEID=${MALTA_COVERAGE_ID}` +
            `&FORMAT=image/tiff` +
            `&SUBSET=E(${Math.floor(sw.easting)},${Math.ceil(ne.easting)})` +
            `&SUBSET=N(${Math.floor(sw.northing)},${Math.ceil(ne.northing)})`;

        console.log(`Elevation: Fetching Malta DTM for tile`);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);  // 10s timeout

        const response = await fetch(wcsUrl, { signal: controller.signal });
        clearTimeout(timeout);

        if (!response.ok) {
            console.log(`Elevation: WCS returned ${response.status}`);
            return null;
        }

        // Read response as buffer
        const buffer = await response.arrayBuffer();
        const data = new Uint8Array(buffer);

        // Parse simple TIFF to extract elevation values
        const elevations = parseTiffElevation(data);

        if (!elevations) {
            return null;
        }

        // Resample to 11x11 grid for 200m tile (~18m spacing)
        const grid = resampleToGrid(elevations, 11);

        return {
            mode: 'grid',
            gridSize: 11,
            stepM: 20,  // 200m / 10 = 20m between samples
            heights: grid
        };

    } catch (error) {
        console.log(`Elevation: Error fetching Malta DTM: ${error.message}`);
        return null;
    }
}

/**
 * Parse TIFF elevation data (handles stripped TIFFs from Malta WCS)
 * Malta DTM uses multiple strips with 6 rows each
 */
function parseTiffElevation(data) {
    if (data.length < 100) return null;

    // Check TIFF magic (little-endian)
    if (data[0] !== 0x49 || data[1] !== 0x49) {
        return null;
    }

    // Helper to read 16-bit and 32-bit values
    const readU16 = (offset) => data[offset] | (data[offset + 1] << 8);
    const readU32 = (offset) => data[offset] | (data[offset + 1] << 8) |
                                (data[offset + 2] << 16) | (data[offset + 3] << 24);

    // Read IFD offset
    const ifdOffset = readU32(4);
    const numEntries = readU16(ifdOffset);

    let width = 0, height = 0;
    let rowsPerStrip = 0;
    let stripOffsetsPtr = 0, stripOffsetsCount = 0;

    // Parse IFD entries
    for (let i = 0; i < numEntries; i++) {
        const off = ifdOffset + 2 + (i * 12);
        const tag = readU16(off);
        const type = readU16(off + 2);
        const count = readU32(off + 4);
        const valueOrPtr = readU32(off + 8);

        if (tag === 256) width = valueOrPtr;          // ImageWidth
        if (tag === 257) height = valueOrPtr;         // ImageLength
        if (tag === 278) rowsPerStrip = valueOrPtr;   // RowsPerStrip
        if (tag === 273) {                            // StripOffsets
            stripOffsetsCount = count;
            // If count > 1, value is pointer to array; otherwise it's the value
            stripOffsetsPtr = (count > 1) ? valueOrPtr : off + 8;
        }
    }

    if (width === 0 || height === 0 || stripOffsetsCount === 0) {
        return null;
    }

    // Default rowsPerStrip to full height if not specified
    if (rowsPerStrip === 0) rowsPerStrip = height;

    // Read all strip offsets
    const stripOffsets = [];
    for (let i = 0; i < stripOffsetsCount; i++) {
        const offset = readU32(stripOffsetsPtr + i * 4);
        stripOffsets.push(offset);
    }

    // Build pixel array from strips
    const pixels = [];
    let currentRow = 0;

    for (let s = 0; s < stripOffsets.length && currentRow < height; s++) {
        const stripStart = stripOffsets[s];
        const rowsInStrip = Math.min(rowsPerStrip, height - currentRow);

        for (let r = 0; r < rowsInStrip; r++) {
            const row = [];
            for (let x = 0; x < width; x++) {
                const idx = stripStart + (r * width) + x;
                row.push(data[idx] || 0);
            }
            pixels.push(row);
            currentRow++;
        }
    }

    return { width, height, pixels };
}

/**
 * Resample elevation grid to target size using bilinear interpolation
 * NOTE: TIFF stores rows top-to-bottom (north-to-south), but tile grid
 * expects row 0 = south, row N = north. So we flip the Y axis.
 */
function resampleToGrid(elevData, targetSize) {
    const { width, height, pixels } = elevData;
    const grid = [];

    for (let ty = 0; ty < targetSize; ty++) {
        for (let tx = 0; tx < targetSize; tx++) {
            // Map target coords to source coords
            // X: left to right (same direction)
            const sx = (tx / (targetSize - 1)) * (width - 1);
            // Y: FLIP! ty=0 (south in tile) should read from bottom of TIFF (height-1)
            //         ty=max (north in tile) should read from top of TIFF (0)
            const sy = (1 - ty / (targetSize - 1)) * (height - 1);

            // Bilinear interpolation
            const x0 = Math.floor(sx);
            const y0 = Math.floor(sy);
            const x1 = Math.min(x0 + 1, width - 1);
            const y1 = Math.min(y0 + 1, height - 1);

            const fx = sx - x0;
            const fy = sy - y0;

            const v00 = pixels[y0]?.[x0] || 0;
            const v01 = pixels[y0]?.[x1] || 0;
            const v10 = pixels[y1]?.[x0] || 0;
            const v11 = pixels[y1]?.[x1] || 0;

            const v = (1-fx)*(1-fy)*v00 + fx*(1-fy)*v01 +
                      (1-fx)*fy*v10 + fx*fy*v11;

            grid.push(Math.round(v * 10) / 10);  // Round to 0.1m
        }
    }

    return grid;
}

// Elevation cache (separate from OSM cache)
const elevationCache = new Map();
const ELEVATION_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;  // 7 days

// In-memory cache (for Render free tier - no Redis)
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;  // 24 hours

// Rate limiting per session
const rateLimits = new Map();
const RATE_LIMIT = 60;  // requests per minute (increased for tile loading)
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

// Cache version - increment to invalidate old cached tiles
const TILE_CACHE_VERSION = 4;  // v4: Fixed Y-axis flip in elevation resampling (tile boundaries now align)

/**
 * Get tile ID from bbox (for caching)
 */
function getTileId(south, west, north, east) {
    // Use bbox centre rounded to tile grid
    const centreLat = (parseFloat(south) + parseFloat(north)) / 2;
    const centreLng = (parseFloat(west) + parseFloat(east)) / 2;
    return `v${TILE_CACHE_VERSION}_tile_${centreLat.toFixed(4)}_${centreLng.toFixed(4)}`;
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

        // Fetch elevation data (with caching)
        const elevCacheKey = `elev:${tileId}`;
        let elevation = elevationCache.get(elevCacheKey);

        if (!elevation || (now - elevation.timestamp > ELEVATION_CACHE_TTL)) {
            const elevData = await fetchMaltaElevation(south, west, north, east);

            if (elevData) {
                elevation = {
                    ...elevData,
                    origin: { x: 0, z: 0 },
                    timestamp: now
                };
                elevationCache.set(elevCacheKey, elevation);
                console.log(`Elevation: Cached ${tileId} (${elevData.heights.length} samples)`);
            } else {
                // No elevation data available (outside Malta or error)
                elevation = {
                    mode: 'none',
                    gridSize: 0,
                    origin: { x: 0, z: 0 },
                    stepM: 0,
                    heights: [],
                    timestamp: now
                };
                // Cache negative result for 1 hour to avoid repeated failures
                elevation.shortTTL = true;
                elevationCache.set(elevCacheKey, elevation);
            }
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
                mode: elevation.mode,
                gridSize: elevation.gridSize || 0,
                origin: elevation.origin || { x: 0, z: 0 },
                stepM: elevation.stepM || 0,
                heights: elevation.heights || []
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

/**
 * GET /api/osm/elevation/coarse
 * Returns a large, low-resolution elevation grid for the entire play area
 * Used to seed HeightPyramid coarse levels on startup
 *
 * Query params:
 *   lat, lng - Center point
 *   radiusKm - Radius in km (default 2.5 = 5km total coverage)
 *   gridSize - Grid resolution (default 128)
 *
 * Response:
 * {
 *   gridSize: number,
 *   bounds: { south, west, north, east },
 *   worldBounds: { minX, maxX, minZ, maxZ },  // in metres from center
 *   stepM: number,  // metres per sample
 *   heights: number[]  // flat array, row-major (south to north)
 * }
 */
router.get('/elevation/coarse', async (req, res) => {
    try {
        const lat = parseFloat(req.query.lat);
        const lng = parseFloat(req.query.lng);
        const radiusKm = parseFloat(req.query.radiusKm) || 2.5;
        const gridSize = parseInt(req.query.gridSize) || 128;

        if (isNaN(lat) || isNaN(lng)) {
            return res.status(400).json({
                error: 'Missing required parameters: lat, lng',
                code: 'MISSING_PARAMS'
            });
        }

        // Check if center is in Malta
        if (!isInMalta(lat, lng)) {
            return res.status(400).json({
                error: 'Location outside Malta coverage',
                code: 'OUTSIDE_COVERAGE'
            });
        }

        // Calculate bounds
        const latDelta = radiusKm / 111.32;  // ~111km per degree latitude
        const lngDelta = radiusKm / (111.32 * Math.cos(lat * Math.PI / 180));

        const south = lat - latDelta;
        const north = lat + latDelta;
        const west = lng - lngDelta;
        const east = lng + lngDelta;

        // Check cache
        const cacheKey = `coarse:${lat.toFixed(4)}_${lng.toFixed(4)}_${radiusKm}_${gridSize}`;
        const cached = elevationCache.get(cacheKey);
        const now = Date.now();

        if (cached && now - cached.timestamp < ELEVATION_CACHE_TTL) {
            console.log(`Coarse elevation: returning cached data for ${cacheKey}`);
            return res.json(cached.data);
        }

        console.log(`Coarse elevation: Fetching ${gridSize}x${gridSize} grid, ${radiusKm*2}km coverage around ${lat.toFixed(4)}, ${lng.toFixed(4)}`);

        // Convert corners to UTM
        const sw = wgs84ToUtm33N(south, west);
        const ne = wgs84ToUtm33N(north, east);

        // WCS GetCoverage request
        const wcsUrl = `${MALTA_WCS_URL}?` +
            `SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage` +
            `&COVERAGEID=${MALTA_COVERAGE_ID}` +
            `&FORMAT=image/tiff` +
            `&SUBSET=E(${Math.floor(sw.easting)},${Math.ceil(ne.easting)})` +
            `&SUBSET=N(${Math.floor(sw.northing)},${Math.ceil(ne.northing)})`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);  // 30s timeout for large area

        const response = await fetch(wcsUrl, { signal: controller.signal });
        clearTimeout(timeout);

        if (!response.ok) {
            console.log(`Coarse elevation: WCS returned ${response.status}`);
            return res.status(502).json({
                error: 'Elevation service unavailable',
                code: 'WCS_ERROR'
            });
        }

        const buffer = await response.arrayBuffer();
        const data = new Uint8Array(buffer);

        // Parse TIFF
        const elevations = parseTiffElevation(data);
        if (!elevations) {
            return res.status(502).json({
                error: 'Failed to parse elevation data',
                code: 'PARSE_ERROR'
            });
        }

        // Resample to requested grid size
        const grid = resampleToGrid(elevations, gridSize);

        // Calculate world bounds in metres from center
        const radiusM = radiusKm * 1000;
        const stepM = (radiusM * 2) / (gridSize - 1);

        const responseData = {
            gridSize,
            bounds: { south, west, north, east },
            worldBounds: {
                minX: -radiusM,
                maxX: radiusM,
                minZ: -radiusM,
                maxZ: radiusM
            },
            stepM,
            heights: grid
        };

        // Cache the result
        elevationCache.set(cacheKey, {
            data: responseData,
            timestamp: now
        });

        console.log(`Coarse elevation: Cached ${gridSize}x${gridSize} grid (${grid.length} samples)`);

        res.json(responseData);

    } catch (error) {
        console.error('Coarse elevation error:', error);
        res.status(500).json({
            error: 'Failed to fetch coarse elevation',
            code: 'FETCH_ERROR',
            details: error.message
        });
    }
});

module.exports = router;
