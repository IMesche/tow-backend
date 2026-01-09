/**
 * TOW Backend - Database Connection & Models
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', '..', 'data', 'tow.db');

// Ensure data directory exists
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const sqlite = new Database(dbPath);

// Enable foreign keys
sqlite.pragma('foreign_keys = ON');

// ============================================
// Schema Initialization
// ============================================

// Create templates table if not exists
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        layer TEXT,
        category TEXT,
        tier INTEGER DEFAULT 1,
        data JSON,
        status TEXT DEFAULT 'draft',
        age_rating INTEGER DEFAULT 0,
        created_at INTEGER,
        created_by TEXT,
        updated_at INTEGER,
        updated_by TEXT,
        published_at INTEGER,
        published_by TEXT,
        deleted_at INTEGER,
        deleted_by TEXT,
        version INTEGER DEFAULT 1
    )
`);

// Create items table if not exists
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        template_id TEXT,
        owner_id TEXT,
        data JSON,
        created_at INTEGER,
        source_type TEXT,
        source_id TEXT,
        FOREIGN KEY (template_id) REFERENCES templates(id)
    )
`);

// Create audit_log table if not exists
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        action TEXT,
        admin_id TEXT,
        user_id TEXT,
        target_id TEXT,
        data JSON,
        details JSON,
        metadata JSON,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    )
`);

// Create users table
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT,
        display_name TEXT,
        email TEXT,
        trust_level TEXT DEFAULT 'new',
        seller_score INTEGER DEFAULT 0,
        buyer_score INTEGER DEFAULT 0,
        total_trades INTEGER DEFAULT 0,
        completed_trades INTEGER DEFAULT 0,
        cancelled_trades INTEGER DEFAULT 0,
        disputed_trades INTEGER DEFAULT 0,
        positive_reviews INTEGER DEFAULT 0,
        neutral_reviews INTEGER DEFAULT 0,
        negative_reviews INTEGER DEFAULT 0,
        fraud_flags INTEGER DEFAULT 0,
        is_npc INTEGER DEFAULT 0,
        npc_config JSON,
        first_trade_at INTEGER,
        last_trade_at INTEGER,
        created_at INTEGER
    )
`);

// Create trades table
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        seller_id TEXT,
        buyer_id TEXT,
        item_id TEXT,
        template_id TEXT,
        price INTEGER,
        status TEXT DEFAULT 'pending',
        status_history JSON,
        initiated_at INTEGER,
        completed_at INTEGER,
        failed_at INTEGER,
        FOREIGN KEY (seller_id) REFERENCES users(id),
        FOREIGN KEY (buyer_id) REFERENCES users(id)
    )
`);

// Create sales_history table
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sales_history (
        id TEXT PRIMARY KEY,
        trade_id TEXT,
        template_id TEXT,
        seller_id TEXT,
        buyer_id TEXT,
        price INTEGER,
        platform_fee INTEGER,
        sold_at INTEGER,
        FOREIGN KEY (trade_id) REFERENCES trades(id)
    )
`);

// Create listings table
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY,
        item_id TEXT,
        template_id TEXT,
        seller_id TEXT,
        price INTEGER,
        status TEXT DEFAULT 'active',
        created_at INTEGER,
        expires_at INTEGER,
        FOREIGN KEY (seller_id) REFERENCES users(id)
    )
`);

// Create escrows table
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS escrows (
        id TEXT PRIMARY KEY,
        trade_id TEXT,
        seller_id TEXT,
        buyer_id TEXT,
        amount INTEGER,
        state TEXT DEFAULT 'pending',
        settlement_steps JSON,
        dispute_reason TEXT,
        dispute_resolved_by TEXT,
        dispute_resolution TEXT,
        created_at INTEGER,
        expires_at INTEGER,
        completed_at INTEGER,
        FOREIGN KEY (trade_id) REFERENCES trades(id)
    )
`);

// Create market_stats table
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS market_stats (
        template_id TEXT PRIMARY KEY,
        floor_price INTEGER,
        last_sale_price INTEGER,
        avg_price_7d INTEGER,
        avg_price_30d INTEGER,
        total_sales INTEGER DEFAULT 0,
        total_volume INTEGER DEFAULT 0,
        active_listings INTEGER DEFAULT 0,
        updated_at INTEGER
    )
`);

// Create alerts table
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        category TEXT,
        message TEXT,
        details JSON,
        acknowledged INTEGER DEFAULT 0,
        acknowledged_by TEXT,
        acknowledged_at INTEGER,
        created_at INTEGER
    )
`);

// Create ai_recommendations table
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ai_recommendations (
        id TEXT PRIMARY KEY,
        title TEXT,
        category TEXT,
        description TEXT,
        action_data JSON,
        confidence REAL,
        status TEXT DEFAULT 'pending',
        reviewed_by TEXT,
        reviewed_at INTEGER,
        review_reason TEXT,
        created_at INTEGER
    )
`);

// Create reputation_events table
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS reputation_events (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        event_type TEXT,
        trade_id TEXT,
        details JSON,
        created_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
`);

// Create reviews table
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        trade_id TEXT,
        reviewer_id TEXT,
        reviewee_id TEXT,
        rating INTEGER,
        comment TEXT,
        created_at INTEGER,
        FOREIGN KEY (reviewer_id) REFERENCES users(id),
        FOREIGN KEY (reviewee_id) REFERENCES users(id)
    )
`);

// Create policies table
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS policies (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        version TEXT DEFAULT '1.0.0',
        scope TEXT DEFAULT 'global',
        scope_value TEXT,
        rules JSON,
        effective_from INTEGER,
        effective_until INTEGER,
        created_by TEXT,
        created_at INTEGER,
        reason TEXT,
        is_active INTEGER DEFAULT 1
    )
`);

// Create policy_history table
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS policy_history (
        id TEXT PRIMARY KEY,
        policy_id TEXT,
        action TEXT,
        old_version TEXT,
        new_version TEXT,
        old_rules JSON,
        new_rules JSON,
        changed_by TEXT,
        changed_at INTEGER,
        reason TEXT,
        FOREIGN KEY (policy_id) REFERENCES policies(id)
    )
`);

// Create locations table
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS locations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT,
        parent_id TEXT,
        policies JSON,
        geofence JSON,
        active_quests INTEGER DEFAULT 0,
        active_users INTEGER DEFAULT 0,
        venues INTEGER DEFAULT 0,
        created_at INTEGER,
        is_active INTEGER DEFAULT 1,
        FOREIGN KEY (parent_id) REFERENCES locations(id)
    )
`);

// Create economy_metrics table
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS economy_metrics (
        date TEXT PRIMARY KEY,
        total_trades INTEGER DEFAULT 0,
        total_volume INTEGER DEFAULT 0,
        platform_revenue INTEGER DEFAULT 0,
        active_users INTEGER DEFAULT 0,
        new_users INTEGER DEFAULT 0,
        active_listings INTEGER DEFAULT 0,
        active_escrows INTEGER DEFAULT 0,
        disputed_escrows INTEGER DEFAULT 0,
        failed_settlements INTEGER DEFAULT 0,
        computed_at INTEGER
    )
`);

// Create admins table if not exists
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS admins (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        permissions TEXT DEFAULT '[]',
        is_active INTEGER DEFAULT 1,
        created_at INTEGER,
        last_login INTEGER
    )
`);

// Seed default admin if none exists
const adminCount = sqlite.prepare('SELECT COUNT(*) as count FROM admins').get();
if (adminCount.count === 0) {
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('admin123', 10);
    sqlite.prepare(`
        INSERT INTO admins (id, email, password_hash, name, role, permissions, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('admin_001', 'admin@tow.game', hash, 'Admin', 'admin', '["*"]', 1, Date.now());
    console.log('Created default admin: admin@tow.game / admin123');
}

console.log('Database connected:', dbPath);

// ============================================
// Database Helper Functions
// ============================================

const db = {
    // Raw SQLite access
    sqlite,

    // Expose prepare for direct queries
    prepare: (sql) => sqlite.prepare(sql),

    // ==================== TEMPLATES ====================

    /**
     * Get all templates
     */
    async getTemplates() {
        const rows = sqlite.prepare(`
            SELECT * FROM templates WHERE deleted_at IS NULL ORDER BY name
        `).all();

        return rows.map(row => this._rowToTemplate(row));
    },

    /**
     * Get single template by ID
     */
    async getTemplate(id) {
        const row = sqlite.prepare(`
            SELECT * FROM templates WHERE id = ? AND deleted_at IS NULL
        `).get(id);

        return row ? this._rowToTemplate(row) : null;
    },

    /**
     * Create new template
     */
    async createTemplate(template) {
        const stmt = sqlite.prepare(`
            INSERT INTO templates (
                id, name, description, layer, category, tier, data, status,
                age_rating, created_at, created_by, updated_at, updated_by, version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
            template.id,
            template.name,
            template.description || null,
            template.layer || 'game',
            template.category || 'collectible',
            template.tier || 1,
            JSON.stringify(this._templateToData(template)),
            template.status || 'draft',
            template.ageRating || 0,
            template.createdAt || Date.now(),
            template.createdBy || null,
            template.updatedAt || Date.now(),
            template.updatedBy || null,
            template.version || 1
        );

        return template;
    },

    /**
     * Update template
     */
    async updateTemplate(id, template) {
        const stmt = sqlite.prepare(`
            UPDATE templates SET
                name = ?,
                description = ?,
                layer = ?,
                category = ?,
                tier = ?,
                data = ?,
                status = ?,
                age_rating = ?,
                updated_at = ?,
                updated_by = ?,
                published_at = ?,
                published_by = ?,
                deleted_at = ?,
                deleted_by = ?,
                version = ?
            WHERE id = ?
        `);

        stmt.run(
            template.name,
            template.description || null,
            template.layer || 'game',
            template.category || 'collectible',
            template.tier || 1,
            JSON.stringify(this._templateToData(template)),
            template.status || 'draft',
            template.ageRating || 0,
            template.updatedAt || Date.now(),
            template.updatedBy || null,
            template.publishedAt || null,
            template.publishedBy || null,
            template.deletedAt || null,
            template.deletedBy || null,
            template.version || 1,
            id
        );

        return template;
    },

    /**
     * Convert DB row to template object
     */
    _rowToTemplate(row) {
        const data = row.data ? JSON.parse(row.data) : {};
        return {
            id: row.id,
            name: row.name,
            description: row.description,
            layer: row.layer,
            category: row.category,
            tier: row.tier,
            status: row.status,
            ageRating: row.age_rating,
            createdAt: row.created_at,
            createdBy: row.created_by,
            updatedAt: row.updated_at,
            updatedBy: row.updated_by,
            publishedAt: row.published_at,
            publishedBy: row.published_by,
            version: row.version,
            ...data  // Spread additional data (baseStats, assets, etc.)
        };
    },

    /**
     * Extract extra fields for JSON data column
     */
    _templateToData(template) {
        const { id, name, description, layer, category, tier, status, ageRating,
                createdAt, createdBy, updatedAt, updatedBy, publishedAt, publishedBy,
                deletedAt, deletedBy, version, ...data } = template;
        return data;
    },

    // ==================== ITEMS ====================

    /**
     * Get items by template ID
     */
    async getItemsByTemplate(templateId) {
        const rows = sqlite.prepare(`
            SELECT * FROM items WHERE template_id = ? ORDER BY created_at DESC
        `).all(templateId);

        return rows.map(row => ({
            id: row.id,
            templateId: row.template_id,
            ownerId: row.owner_id,
            createdAt: row.created_at,
            sourceType: row.source_type,
            sourceId: row.source_id,
            ...(row.data ? JSON.parse(row.data) : {})
        }));
    },

    // ==================== AUDIT ====================

    /**
     * Log audit event
     */
    async logAudit({ action, userId, targetId, details }) {
        const stmt = sqlite.prepare(`
            INSERT INTO audit_log (action, user_id, target_id, details, created_at)
            VALUES (?, ?, ?, ?, ?)
        `);

        stmt.run(
            action,
            userId || null,
            targetId || null,
            details ? JSON.stringify(details) : null,
            Date.now()
        );
    },

    /**
     * Get audit log
     */
    async getAuditLog({ limit = 100, offset = 0, action, userId, targetId } = {}) {
        let sql = 'SELECT * FROM audit_log WHERE 1=1';
        const params = [];

        if (action) {
            sql += ' AND action = ?';
            params.push(action);
        }
        if (userId) {
            sql += ' AND user_id = ?';
            params.push(userId);
        }
        if (targetId) {
            sql += ' AND target_id = ?';
            params.push(targetId);
        }

        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const rows = sqlite.prepare(sql).all(...params);

        return rows.map(row => ({
            id: row.id,
            action: row.action,
            userId: row.user_id,
            targetId: row.target_id,
            details: row.details ? JSON.parse(row.details) : null,
            createdAt: row.created_at
        }));
    }
};

console.log('Database models initialized');

module.exports = db;
