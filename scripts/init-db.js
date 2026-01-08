/**
 * TOW Backend - Database Initialization
 * Creates all tables with proper schema
 */

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'tow.db');
const db = new Database(dbPath);

console.log('Initializing TOW database...');

// Enable foreign keys
db.pragma('foreign_keys = ON');

// ============================================
// Admin Users Table
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'operator',  -- 'super_admin', 'admin', 'operator', 'viewer'
    permissions TEXT DEFAULT '[]', -- JSON array of specific permissions
    created_at INTEGER NOT NULL,
    last_login INTEGER,
    is_active INTEGER DEFAULT 1
  )
`);

// ============================================
// Policies Table (Versioned)
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS policies (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,           -- 'fee', 'escrow', 'royalty', 'trust', etc.
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    scope TEXT NOT NULL,          -- 'global', 'region', 'country', 'city', 'venue', 'quest'
    scope_value TEXT,             -- e.g., 'UK', 'Malta', specific venue ID
    rules TEXT NOT NULL,          -- JSON object with policy rules
    effective_from INTEGER NOT NULL,
    effective_until INTEGER,      -- NULL means currently active
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    reason TEXT,
    is_active INTEGER DEFAULT 1,
    FOREIGN KEY (created_by) REFERENCES admins(id)
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_policies_type ON policies(type)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_policies_scope ON policies(scope, scope_value)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_policies_active ON policies(is_active)`);

// ============================================
// Policy History (Audit Trail)
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS policy_history (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL,
    action TEXT NOT NULL,         -- 'created', 'updated', 'deactivated'
    old_version TEXT,
    new_version TEXT,
    old_rules TEXT,               -- JSON
    new_rules TEXT,               -- JSON
    changed_by TEXT NOT NULL,
    changed_at INTEGER NOT NULL,
    reason TEXT,
    FOREIGN KEY (policy_id) REFERENCES policies(id),
    FOREIGN KEY (changed_by) REFERENCES admins(id)
  )
`);

// ============================================
// Game Users Table
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT,
    email TEXT,
    trust_level TEXT DEFAULT 'new',  -- 'new', 'trusted', 'verified', 'elite'
    seller_score INTEGER DEFAULT 50,
    buyer_score INTEGER DEFAULT 50,
    total_trades INTEGER DEFAULT 0,
    completed_trades INTEGER DEFAULT 0,
    cancelled_trades INTEGER DEFAULT 0,
    disputed_trades INTEGER DEFAULT 0,
    positive_reviews INTEGER DEFAULT 0,
    neutral_reviews INTEGER DEFAULT 0,
    negative_reviews INTEGER DEFAULT 0,
    fraud_flags INTEGER DEFAULT 0,
    wallet_balance INTEGER DEFAULT 0,
    first_trade_at INTEGER,
    last_trade_at INTEGER,
    created_at INTEGER NOT NULL,
    is_npc INTEGER DEFAULT 0,
    npc_config TEXT               -- JSON for NPC trader behavior
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_users_trust ON users(trust_level)`);

// ============================================
// Reputation Events
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS reputation_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,     -- 'trade_completed', 'trade_cancelled', 'dispute_filed', 'dispute_resolved'
    role TEXT,                    -- 'seller', 'buyer'
    trade_id TEXT,
    details TEXT,                 -- JSON
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_rep_events_user ON reputation_events(user_id)`);

// ============================================
// Reviews
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    trade_id TEXT NOT NULL,
    reviewer_id TEXT NOT NULL,
    reviewee_id TEXT NOT NULL,
    rating TEXT NOT NULL,         -- 'positive', 'neutral', 'negative'
    comment TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (reviewer_id) REFERENCES users(id),
    FOREIGN KEY (reviewee_id) REFERENCES users(id)
  )
`);

// ============================================
// Trades (Canonical Record)
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    trade_type TEXT NOT NULL,     -- 'listing', 'auction', 'p2p', 'buy_order'
    listing_id TEXT,
    auction_id TEXT,
    buy_order_id TEXT,
    escrow_id TEXT,
    seller_id TEXT NOT NULL,
    buyer_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    item_name TEXT,
    template_id TEXT,
    price INTEGER NOT NULL,
    platform_fee INTEGER DEFAULT 0,
    creator_royalty INTEGER DEFAULT 0,
    status TEXT DEFAULT 'initiated', -- 'initiated', 'escrow_pending', 'funded', 'settling', 'completed', 'failed', 'expired', 'disputed'
    initiated_at INTEGER NOT NULL,
    funded_at INTEGER,
    settled_at INTEGER,
    completed_at INTEGER,
    failed_at INTEGER,
    failure_reason TEXT,
    status_history TEXT,          -- JSON array
    FOREIGN KEY (seller_id) REFERENCES users(id),
    FOREIGN KEY (buyer_id) REFERENCES users(id)
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_seller ON trades(seller_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_buyer ON trades(buyer_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)`);

// ============================================
// Escrows
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS escrows (
    id TEXT PRIMARY KEY,
    trade_id TEXT NOT NULL,
    seller_id TEXT NOT NULL,
    buyer_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    item_name TEXT,
    amount INTEGER NOT NULL,
    state TEXT DEFAULT 'pending', -- 'pending', 'funded', 'settling', 'completed', 'failed', 'expired', 'disputed'
    dispute_reason TEXT,
    dispute_filed_by TEXT,
    dispute_resolved_by TEXT,
    dispute_resolution TEXT,      -- 'seller_wins', 'buyer_wins', 'split'
    created_at INTEGER NOT NULL,
    funded_at INTEGER,
    expires_at INTEGER NOT NULL,
    completed_at INTEGER,
    settlement_id TEXT,
    settlement_steps TEXT,        -- JSON for idempotency
    FOREIGN KEY (trade_id) REFERENCES trades(id),
    FOREIGN KEY (seller_id) REFERENCES users(id),
    FOREIGN KEY (buyer_id) REFERENCES users(id)
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_escrows_state ON escrows(state)`);

// ============================================
// Item Locks (for Escrow)
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS item_locks (
    item_id TEXT PRIMARY KEY,
    escrow_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    locked_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (escrow_id) REFERENCES escrows(id),
    FOREIGN KEY (owner_id) REFERENCES users(id)
  )
`);

// ============================================
// Market Listings
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    seller_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    item_name TEXT,
    template_id TEXT,
    price INTEGER NOT NULL,
    status TEXT DEFAULT 'active', -- 'active', 'sold', 'cancelled', 'expired'
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    sold_at INTEGER,
    FOREIGN KEY (seller_id) REFERENCES users(id)
  )
`);

// ============================================
// Sales History
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS sales_history (
    id TEXT PRIMARY KEY,
    trade_id TEXT,                 -- Optional for historical/seed data
    template_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    seller_id TEXT NOT NULL,
    buyer_id TEXT NOT NULL,
    price INTEGER NOT NULL,
    final_price INTEGER NOT NULL,  -- After fees
    platform_fee INTEGER DEFAULT 0,
    creator_royalty INTEGER DEFAULT 0,
    sale_type TEXT NOT NULL,       -- 'listing', 'auction', 'buy_order'
    sold_at INTEGER NOT NULL
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_template ON sales_history(template_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_date ON sales_history(sold_at)`);

// ============================================
// Market Stats (Cached)
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS market_stats (
    template_id TEXT PRIMARY KEY,
    floor_price INTEGER,
    last_sale_price INTEGER,
    avg_price_7d INTEGER,
    avg_price_30d INTEGER,
    total_sales INTEGER DEFAULT 0,
    total_volume INTEGER DEFAULT 0,
    active_listings INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL
  )
`);

// ============================================
// Locations
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS locations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,           -- 'region', 'country', 'city', 'venue'
    parent_id TEXT,               -- Hierarchical
    active_quests INTEGER DEFAULT 0,
    active_users INTEGER DEFAULT 0,
    venues INTEGER DEFAULT 0,
    policies TEXT,                -- JSON array of applied policy IDs
    geofence TEXT,                -- JSON geofence config
    created_at INTEGER NOT NULL,
    is_active INTEGER DEFAULT 1,
    FOREIGN KEY (parent_id) REFERENCES locations(id)
  )
`);

// ============================================
// Alerts
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,           -- 'warning', 'error', 'info', 'success'
    category TEXT NOT NULL,       -- 'economy', 'market', 'system', 'content', 'ai'
    message TEXT NOT NULL,
    details TEXT,                 -- JSON
    created_at INTEGER NOT NULL,
    acknowledged INTEGER DEFAULT 0,
    acknowledged_by TEXT,
    acknowledged_at INTEGER,
    FOREIGN KEY (acknowledged_by) REFERENCES admins(id)
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_alerts_ack ON alerts(acknowledged)`);

// ============================================
// AI Recommendations
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_recommendations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    impact TEXT,
    confidence REAL NOT NULL,
    category TEXT NOT NULL,       -- 'economy', 'market', 'trust', 'system'
    status TEXT DEFAULT 'pending', -- 'pending', 'reviewing', 'approved', 'rejected'
    action_data TEXT,             -- JSON - what to do if approved
    created_at INTEGER NOT NULL,
    reviewed_by TEXT,
    reviewed_at INTEGER,
    review_reason TEXT,
    FOREIGN KEY (reviewed_by) REFERENCES admins(id)
  )
`);

// ============================================
// Audit Log
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    admin_id TEXT,
    user_id TEXT,
    data TEXT NOT NULL,           -- JSON
    metadata TEXT,                -- JSON
    created_at INTEGER NOT NULL
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_log(type)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_admin ON audit_log(admin_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_date ON audit_log(created_at)`);

// ============================================
// Economy Metrics (Daily Aggregates)
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS economy_metrics (
    date TEXT PRIMARY KEY,        -- YYYY-MM-DD
    total_trades INTEGER DEFAULT 0,
    total_volume INTEGER DEFAULT 0,
    platform_revenue INTEGER DEFAULT 0,
    active_users INTEGER DEFAULT 0,
    new_users INTEGER DEFAULT 0,
    active_listings INTEGER DEFAULT 0,
    active_escrows INTEGER DEFAULT 0,
    disputed_escrows INTEGER DEFAULT 0,
    failed_settlements INTEGER DEFAULT 0,
    computed_at INTEGER NOT NULL
  )
`);

// ============================================
// Creators
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS creators (
    id TEXT PRIMARY KEY,
    user_id TEXT,                 -- Link to user if player-creator
    name TEXT NOT NULL,
    avatar TEXT,
    is_verified INTEGER DEFAULT 0,
    total_items_created INTEGER DEFAULT 0,
    total_sales_volume INTEGER DEFAULT 0,
    total_royalties_earned INTEGER DEFAULT 0,
    default_royalty_pct REAL DEFAULT 5.0,
    royalty_wallet_id TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// ============================================
// Entitlements
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS entitlements (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    item_id TEXT,
    type TEXT NOT NULL,           -- 'access', 'usage', 'ownership'
    scope TEXT NOT NULL,          -- 'app:portal', 'location:vip_area', etc.
    granted_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER,
    max_uses INTEGER DEFAULT -1,  -- -1 = unlimited
    uses_remaining INTEGER DEFAULT -1,
    offline_valid_until INTEGER,
    last_verified_at INTEGER,
    status TEXT DEFAULT 'active', -- 'active', 'expired', 'revoked', 'exhausted'
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_entitlements_user ON entitlements(user_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_entitlements_scope ON entitlements(scope)`);

// ============================================
// Economy Events (Telemetry)
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS economy_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,           -- 'mint', 'burn', 'transfer', 'list', 'delist', 'sale', 'royalty', 'dispute'
    data TEXT NOT NULL,           -- JSON
    created_at INTEGER NOT NULL
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_econ_events_type ON economy_events(type)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_econ_events_date ON economy_events(created_at)`);

console.log('Database initialized successfully!');
console.log(`Database location: ${dbPath}`);

db.close();
