/**
 * TOW Backend - Seed Data
 * Populates database with realistic mock data for development
 */

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'tow.db');
const db = new Database(dbPath);

console.log('Seeding TOW database...');

const now = Date.now();
const day = 86400000;
const hour = 3600000;

// ============================================
// Helper Functions
// ============================================
function genId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================
// Seed Admin Users
// ============================================
console.log('Creating admin users...');

const adminPassword = bcrypt.hashSync('admin123', 10);

const admins = [
  {
    id: 'admin_super',
    email: 'admin@tow.game',
    password_hash: adminPassword,
    name: 'Super Admin',
    role: 'super_admin',
    permissions: JSON.stringify(['*']),
    created_at: now - day * 90
  },
  {
    id: 'admin_ops',
    email: 'ops@tow.game',
    password_hash: adminPassword,
    name: 'Operations',
    role: 'admin',
    permissions: JSON.stringify(['economy', 'users', 'content']),
    created_at: now - day * 60
  },
  {
    id: 'admin_viewer',
    email: 'viewer@tow.game',
    password_hash: adminPassword,
    name: 'Viewer',
    role: 'viewer',
    permissions: JSON.stringify(['read']),
    created_at: now - day * 30
  }
];

const insertAdmin = db.prepare(`
  INSERT OR REPLACE INTO admins (id, email, password_hash, name, role, permissions, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

for (const admin of admins) {
  insertAdmin.run(admin.id, admin.email, admin.password_hash, admin.name, admin.role, admin.permissions, admin.created_at);
}

// ============================================
// Seed Default Policies
// ============================================
console.log('Creating default policies...');

const policies = [
  {
    id: 'policy_fee_platform',
    type: 'fee',
    name: 'Platform Fee Policy',
    version: '1.0.0',
    scope: 'global',
    scope_value: null,
    rules: JSON.stringify({
      platformFeePct: 5,
      minFee: 1,
      maxFee: 1000
    }),
    effective_from: now - day * 90,
    created_by: 'admin_super',
    created_at: now - day * 90,
    reason: 'Initial platform fee policy'
  },
  {
    id: 'policy_royalty_creator',
    type: 'royalty',
    name: 'Creator Royalty Policy',
    version: '1.0.0',
    scope: 'global',
    scope_value: null,
    rules: JSON.stringify({
      defaultRoyaltyPct: 5,
      maxRoyaltyPct: 15,
      royaltyDecayDepth: 3
    }),
    effective_from: now - day * 90,
    created_by: 'admin_super',
    created_at: now - day * 90,
    reason: 'Initial creator royalty policy'
  },
  {
    id: 'policy_escrow_default',
    type: 'escrow',
    name: 'Escrow Policy',
    version: '1.0.0',
    scope: 'global',
    scope_value: null,
    rules: JSON.stringify({
      defaultTimeoutHours: 24,
      maxTimeoutHours: 168,
      autoReleaseEnabled: true
    }),
    effective_from: now - day * 90,
    created_by: 'admin_super',
    created_at: now - day * 90,
    reason: 'Initial escrow policy'
  },
  {
    id: 'policy_trust_levels',
    type: 'trust',
    name: 'Trust Level Policy',
    version: '1.0.0',
    scope: 'global',
    scope_value: null,
    rules: JSON.stringify({
      levels: {
        new: { minScore: 0, minTrades: 0, minAgeDays: 0, tradeLimit: 100 },
        trusted: { minScore: 60, minTrades: 5, minAgeDays: 7, tradeLimit: 1000 },
        verified: { minScore: 80, minTrades: 20, minAgeDays: 30, tradeLimit: 10000 },
        elite: { minScore: 95, minTrades: 100, minAgeDays: 90, tradeLimit: -1 }
      }
    }),
    effective_from: now - day * 90,
    created_by: 'admin_super',
    created_at: now - day * 90,
    reason: 'Initial trust level policy'
  },
  // Regional override example
  {
    id: 'policy_fee_uk',
    type: 'fee',
    name: 'UK Fee Policy',
    version: '1.0.0',
    scope: 'country',
    scope_value: 'UK',
    rules: JSON.stringify({
      platformFeePct: 6,
      minFee: 1,
      maxFee: 1000
    }),
    effective_from: now - day * 30,
    created_by: 'admin_super',
    created_at: now - day * 30,
    reason: 'VAT compliance adjustment for UK'
  }
];

const insertPolicy = db.prepare(`
  INSERT OR REPLACE INTO policies (id, type, name, version, scope, scope_value, rules, effective_from, created_by, created_at, reason, is_active)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
`);

for (const policy of policies) {
  insertPolicy.run(
    policy.id, policy.type, policy.name, policy.version, policy.scope,
    policy.scope_value, policy.rules, policy.effective_from, policy.created_by,
    policy.created_at, policy.reason
  );
}

// ============================================
// Seed Game Users (Players & NPCs)
// ============================================
console.log('Creating game users...');

const users = [
  // Real player
  {
    id: 'player',
    username: 'player',
    display_name: 'Player',
    trust_level: 'trusted',
    seller_score: 75,
    buyer_score: 80,
    total_trades: 12,
    completed_trades: 11,
    wallet_balance: 5000,
    created_at: now - day * 45,
    is_npc: 0
  },
  // NPC Traders
  {
    id: 'c_alex',
    username: 'alex_trader',
    display_name: 'Alex',
    trust_level: 'verified',
    seller_score: 92,
    buyer_score: 88,
    total_trades: 47,
    completed_trades: 46,
    wallet_balance: 15000,
    created_at: now - day * 90,
    is_npc: 1,
    npc_config: JSON.stringify({
      buyInterests: ['weapon', 'armour'],
      sellInventory: ['consumable', 'material'],
      priceStrategy: 'fair',
      haggleChance: 0.3
    })
  },
  {
    id: 'c_maya',
    username: 'maya_collector',
    display_name: 'Maya',
    trust_level: 'elite',
    seller_score: 98,
    buyer_score: 96,
    total_trades: 156,
    completed_trades: 155,
    wallet_balance: 50000,
    created_at: now - day * 180,
    is_npc: 1,
    npc_config: JSON.stringify({
      buyInterests: ['rare', 'legendary'],
      sellInventory: ['common', 'uncommon'],
      priceStrategy: 'premium',
      haggleChance: 0.1
    })
  },
  {
    id: 'c_merchant',
    username: 'marcus_merchant',
    display_name: 'Marcus the Merchant',
    trust_level: 'elite',
    seller_score: 95,
    buyer_score: 90,
    total_trades: 234,
    completed_trades: 230,
    wallet_balance: 100000,
    created_at: now - day * 365,
    is_npc: 1,
    npc_config: JSON.stringify({
      buyInterests: ['*'],
      sellInventory: ['*'],
      priceStrategy: 'cheap',
      haggleChance: 0.5
    })
  },
  {
    id: 'c_eve',
    username: 'eve_enchanter',
    display_name: 'Eve',
    trust_level: 'verified',
    seller_score: 85,
    buyer_score: 82,
    total_trades: 28,
    completed_trades: 27,
    disputed_trades: 1,
    wallet_balance: 8000,
    created_at: now - day * 60,
    is_npc: 1
  },
  {
    id: 'c_frank',
    username: 'frank_finder',
    display_name: 'Frank',
    trust_level: 'trusted',
    seller_score: 72,
    buyer_score: 78,
    total_trades: 15,
    completed_trades: 14,
    wallet_balance: 3000,
    created_at: now - day * 30,
    is_npc: 1
  }
];

const insertUser = db.prepare(`
  INSERT OR REPLACE INTO users (id, username, display_name, trust_level, seller_score, buyer_score, total_trades, completed_trades, disputed_trades, wallet_balance, created_at, is_npc, npc_config)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const user of users) {
  insertUser.run(
    user.id, user.username, user.display_name, user.trust_level,
    user.seller_score, user.buyer_score, user.total_trades,
    user.completed_trades, user.disputed_trades || 0, user.wallet_balance,
    user.created_at, user.is_npc, user.npc_config || null
  );
}

// ============================================
// Seed Locations
// ============================================
console.log('Creating locations...');

const locations = [
  {
    id: 'loc_malta',
    name: 'Malta',
    type: 'country',
    parent_id: null,
    active_quests: 12,
    active_users: 234,
    venues: 8,
    policies: JSON.stringify(['policy_fee_platform']),
    created_at: now - day * 90
  },
  {
    id: 'loc_uk',
    name: 'United Kingdom',
    type: 'country',
    parent_id: null,
    active_quests: 45,
    active_users: 1023,
    venues: 34,
    policies: JSON.stringify(['policy_fee_platform', 'policy_fee_uk']),
    created_at: now - day * 90
  },
  {
    id: 'loc_london',
    name: 'London',
    type: 'city',
    parent_id: 'loc_uk',
    active_quests: 32,
    active_users: 567,
    venues: 18,
    policies: JSON.stringify(['policy_fee_platform', 'policy_fee_uk']),
    created_at: now - day * 60
  },
  {
    id: 'loc_us',
    name: 'United States',
    type: 'country',
    parent_id: null,
    active_quests: 38,
    active_users: 892,
    venues: 28,
    policies: JSON.stringify(['policy_fee_platform']),
    created_at: now - day * 90
  },
  {
    id: 'loc_nyc',
    name: 'New York City',
    type: 'city',
    parent_id: 'loc_us',
    active_quests: 25,
    active_users: 456,
    venues: 15,
    policies: JSON.stringify(['policy_fee_platform']),
    created_at: now - day * 45
  }
];

const insertLocation = db.prepare(`
  INSERT OR REPLACE INTO locations (id, name, type, parent_id, active_quests, active_users, venues, policies, created_at, is_active)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
`);

for (const loc of locations) {
  insertLocation.run(
    loc.id, loc.name, loc.type, loc.parent_id, loc.active_quests,
    loc.active_users, loc.venues, loc.policies, loc.created_at
  );
}

// ============================================
// Seed Sample Trades (needed for escrows FK)
// ============================================
console.log('Creating sample trades...');

const trades = [
  {
    id: 'trade_001',
    trade_type: 'listing',
    seller_id: 'player',
    buyer_id: 'c_alex',
    item_id: 'i_flame_sword_123',
    item_name: 'Flame Sword +3',
    price: 750,
    status: 'funded',
    initiated_at: now - hour * 3
  },
  {
    id: 'trade_002',
    trade_type: 'listing',
    seller_id: 'c_maya',
    buyer_id: 'player',
    item_id: 'i_vip_pass_456',
    item_name: 'VIP Pass (Monthly)',
    price: 500,
    status: 'settling',
    initiated_at: now - hour * 6
  },
  {
    id: 'trade_003',
    trade_type: 'listing',
    seller_id: 'c_eve',
    buyer_id: 'c_frank',
    item_id: 'i_mystic_orb_789',
    item_name: 'Mystic Orb',
    price: 1200,
    status: 'disputed',
    initiated_at: now - day
  },
  {
    id: 'trade_004',
    trade_type: 'listing',
    seller_id: 'c_merchant',
    buyer_id: 'c_alex',
    item_id: 'i_map_fragment_101',
    item_name: 'Ancient Map Fragment',
    price: 250,
    status: 'escrow_pending',
    initiated_at: now - hour
  }
];

const insertTrade = db.prepare(`
  INSERT OR REPLACE INTO trades (id, trade_type, seller_id, buyer_id, item_id, item_name, price, status, initiated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const trade of trades) {
  insertTrade.run(
    trade.id, trade.trade_type, trade.seller_id, trade.buyer_id,
    trade.item_id, trade.item_name, trade.price, trade.status, trade.initiated_at
  );
}

// ============================================
// Seed Sample Escrows
// ============================================
console.log('Creating sample escrows...');

const escrows = [
  {
    id: 'escrow_001',
    trade_id: 'trade_001',
    seller_id: 'player',
    buyer_id: 'c_alex',
    item_id: 'i_flame_sword_123',
    item_name: 'Flame Sword +3',
    amount: 750,
    state: 'funded',
    created_at: now - hour * 3,
    expires_at: now + hour * 21
  },
  {
    id: 'escrow_002',
    trade_id: 'trade_002',
    seller_id: 'c_maya',
    buyer_id: 'player',
    item_id: 'i_vip_pass_456',
    item_name: 'VIP Pass (Monthly)',
    amount: 500,
    state: 'settling',
    created_at: now - hour * 6,
    expires_at: now + hour * 18
  },
  {
    id: 'escrow_003',
    trade_id: 'trade_003',
    seller_id: 'c_eve',
    buyer_id: 'c_frank',
    item_id: 'i_mystic_orb_789',
    item_name: 'Mystic Orb',
    amount: 1200,
    state: 'disputed',
    dispute_reason: 'Item not as described',
    dispute_filed_by: 'c_frank',
    created_at: now - day,
    expires_at: now + day
  },
  {
    id: 'escrow_004',
    trade_id: 'trade_004',
    seller_id: 'c_merchant',
    buyer_id: 'c_alex',
    item_id: 'i_map_fragment_101',
    item_name: 'Ancient Map Fragment',
    amount: 250,
    state: 'pending',
    created_at: now - hour,
    expires_at: now + hour * 23
  }
];

const insertEscrow = db.prepare(`
  INSERT OR REPLACE INTO escrows (id, trade_id, seller_id, buyer_id, item_id, item_name, amount, state, dispute_reason, dispute_filed_by, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const esc of escrows) {
  insertEscrow.run(
    esc.id, esc.trade_id, esc.seller_id, esc.buyer_id, esc.item_id,
    esc.item_name, esc.amount, esc.state, esc.dispute_reason || null,
    esc.dispute_filed_by || null, esc.created_at, esc.expires_at
  );
}

// ============================================
// Seed Alerts
// ============================================
console.log('Creating alerts...');

const alerts = [
  {
    id: genId('alert'),
    type: 'warning',
    category: 'economy',
    message: 'Escrow timeout rate elevated (3.2%)',
    created_at: now - hour * 0.5
  },
  {
    id: genId('alert'),
    type: 'info',
    category: 'content',
    message: 'New quest published: "Harbor Mystery"',
    created_at: now - hour * 2
  },
  {
    id: genId('alert'),
    type: 'warning',
    category: 'market',
    message: 'Floor price drop detected: Flame Sword (-15%)',
    created_at: now - hour * 4
  },
  {
    id: genId('alert'),
    type: 'success',
    category: 'system',
    message: 'Daily backup completed successfully',
    created_at: now - hour * 8,
    acknowledged: 1
  },
  {
    id: genId('alert'),
    type: 'info',
    category: 'ai',
    message: 'AI recommendation: Adjust escrow timeout',
    created_at: now - hour * 12
  }
];

const insertAlert = db.prepare(`
  INSERT INTO alerts (id, type, category, message, created_at, acknowledged)
  VALUES (?, ?, ?, ?, ?, ?)
`);

for (const alert of alerts) {
  insertAlert.run(alert.id, alert.type, alert.category, alert.message, alert.created_at, alert.acknowledged || 0);
}

// ============================================
// Seed AI Recommendations
// ============================================
console.log('Creating AI recommendations...');

const recommendations = [
  {
    id: genId('rec'),
    title: 'Adjust escrow timeout',
    description: 'Increase timeout from 24h to 26h based on settlement patterns',
    impact: 'Estimated 12% reduction in timeout failures',
    confidence: 0.87,
    category: 'economy',
    status: 'pending',
    created_at: now - hour * 4
  },
  {
    id: genId('rec'),
    title: 'Enable listing cooldown',
    description: 'Suspected price manipulation on "Ancient Shield" - recommend 1h cooldown',
    impact: 'Prevent wash trading, stabilise floor price',
    confidence: 0.72,
    category: 'market',
    status: 'pending',
    created_at: now - hour * 8
  },
  {
    id: genId('rec'),
    title: 'Increase trust threshold',
    description: 'Raise "trusted" level requirement from 5 to 8 trades',
    impact: 'Reduce new account fraud by estimated 8%',
    confidence: 0.65,
    category: 'trust',
    status: 'reviewing',
    created_at: now - day
  }
];

const insertRec = db.prepare(`
  INSERT INTO ai_recommendations (id, title, description, impact, confidence, category, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const rec of recommendations) {
  insertRec.run(rec.id, rec.title, rec.description, rec.impact, rec.confidence, rec.category, rec.status, rec.created_at);
}

// ============================================
// Seed Historical Sales Data (30 days)
// ============================================
console.log('Creating sales history...');

const templates = [
  { id: 'it_flame_sword', name: 'Flame Sword', basePrice: 600 },
  { id: 'it_ice_shield', name: 'Ice Shield', basePrice: 450 },
  { id: 'it_healing_potion', name: 'Healing Potion', basePrice: 25 },
  { id: 'it_ancient_map', name: 'Ancient Map Fragment', basePrice: 200 },
  { id: 'it_vip_pass', name: 'VIP Pass', basePrice: 500 }
];

const userIds = ['player', 'c_alex', 'c_maya', 'c_merchant', 'c_eve', 'c_frank'];

const insertSale = db.prepare(`
  INSERT INTO sales_history (id, trade_id, template_id, item_id, seller_id, buyer_id, price, final_price, platform_fee, sale_type, sold_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (let d = 30; d >= 0; d--) {
  const salesPerDay = 3 + Math.floor(Math.random() * 5);
  for (let s = 0; s < salesPerDay; s++) {
    const template = templates[Math.floor(Math.random() * templates.length)];
    const price = Math.round(template.basePrice * (0.8 + Math.random() * 0.4));
    const fee = Math.round(price * 0.05);
    const seller = userIds[Math.floor(Math.random() * userIds.length)];
    let buyer = userIds[Math.floor(Math.random() * userIds.length)];
    while (buyer === seller) {
      buyer = userIds[Math.floor(Math.random() * userIds.length)];
    }

    const soldAt = now - (d * day) + Math.floor(Math.random() * day);
    const saleId = genId('sale');
    const itemId = `i_${template.id}_${Math.random().toString(36).substr(2, 6)}`;

    // Use NULL for trade_id in historical seed data
    insertSale.run(saleId, null, template.id, itemId, seller, buyer, price, price - fee, fee, 'listing', soldAt);
  }
}

// ============================================
// Seed Economy Metrics (30 days)
// ============================================
console.log('Creating economy metrics...');

const insertMetrics = db.prepare(`
  INSERT OR REPLACE INTO economy_metrics (date, total_trades, total_volume, platform_revenue, active_users, new_users, active_listings, active_escrows, disputed_escrows, failed_settlements, computed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (let d = 30; d >= 0; d--) {
  const date = new Date(now - d * day).toISOString().split('T')[0];
  const trades = 80 + Math.floor(Math.random() * 40);
  const volume = 10000 + Math.floor(Math.random() * 5000);
  const revenue = Math.round(volume * 0.05);
  const activeUsers = 200 + Math.floor(Math.random() * 100);
  const newUsers = 10 + Math.floor(Math.random() * 20);

  insertMetrics.run(date, trades, volume, revenue, activeUsers, newUsers, 150, 25, 2, 1, now);
}

// ============================================
// Seed Creators
// ============================================
console.log('Creating creators...');

const creators = [
  {
    id: 'creator_system',
    user_id: null,
    name: 'TOW Official',
    avatar: '🎮',
    is_verified: 1,
    total_items_created: 500,
    total_sales_volume: 250000,
    total_royalties_earned: 12500,
    default_royalty_pct: 5,
    created_at: now - day * 365
  },
  {
    id: 'creator_maya',
    user_id: 'c_maya',
    name: 'Maya Collections',
    avatar: '🎨',
    is_verified: 1,
    total_items_created: 45,
    total_sales_volume: 35000,
    total_royalties_earned: 1750,
    default_royalty_pct: 5,
    created_at: now - day * 120
  }
];

const insertCreator = db.prepare(`
  INSERT OR REPLACE INTO creators (id, user_id, name, avatar, is_verified, total_items_created, total_sales_volume, total_royalties_earned, default_royalty_pct, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const creator of creators) {
  insertCreator.run(
    creator.id, creator.user_id, creator.name, creator.avatar, creator.is_verified,
    creator.total_items_created, creator.total_sales_volume, creator.total_royalties_earned,
    creator.default_royalty_pct, creator.created_at
  );
}

console.log('Database seeded successfully!');
db.close();
