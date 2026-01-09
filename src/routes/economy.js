/**
 * TOW Backend - Economy Routes
 * Metrics, trades, market stats
 */

const express = require('express');
const db = require('../models/db');
const { requireAdmin, optionalAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/economy/metrics
 * Get current economy metrics (live)
 */
router.get('/metrics', optionalAdmin, (req, res) => {
  const now = Date.now();
  const day = 86400000;

  // Active users (users with trades in last 24h)
  const activeUsers = db.prepare(`
    SELECT COUNT(DISTINCT seller_id) + COUNT(DISTINCT buyer_id) as count
    FROM trades WHERE initiated_at > ?
  `).get(now - day);

  // Trades per hour (last hour)
  const tradesLastHour = db.prepare(`
    SELECT COUNT(*) as count FROM trades WHERE initiated_at > ?
  `).get(now - 3600000);

  // 24h volume
  const volume24h = db.prepare(`
    SELECT COALESCE(SUM(price), 0) as total FROM sales_history WHERE sold_at > ?
  `).get(now - day);

  // Platform revenue (5% of volume)
  const revenue24h = db.prepare(`
    SELECT COALESCE(SUM(platform_fee), 0) as total FROM sales_history WHERE sold_at > ?
  `).get(now - day);

  // Active listings
  const activeListings = db.prepare(`
    SELECT COUNT(*) as count FROM listings WHERE status = 'active'
  `).get();

  // Active escrows by state
  const escrowStats = db.prepare(`
    SELECT state, COUNT(*) as count FROM escrows GROUP BY state
  `).all();

  const escrowCounts = escrowStats.reduce((acc, row) => {
    acc[row.state] = row.count;
    return acc;
  }, {});

  // Failed settlements (last 24h)
  const failedSettlements = db.prepare(`
    SELECT COUNT(*) as count FROM trades WHERE status = 'failed' AND failed_at > ?
  `).get(now - day);

  res.json({
    activeUsers: activeUsers.count || 0,
    tradesPerHour: tradesLastHour.count || 0,
    totalVolume24h: volume24h.total || 0,
    avgTradeValue: volume24h.total && tradesLastHour.count ? Math.round(volume24h.total / tradesLastHour.count) : 0,
    platformRevenue24h: revenue24h.total || 0,
    activeListings: activeListings.count || 0,
    activeAuctions: 0, // TODO: implement auctions
    pendingEscrows: (escrowCounts.pending || 0) + (escrowCounts.funded || 0) + (escrowCounts.settling || 0),
    disputedEscrows: escrowCounts.disputed || 0,
    failedSettlements24h: failedSettlements.count || 0,
    timestamp: now
  });
});

/**
 * GET /api/economy/top-templates
 * Get top templates by sales volume
 */
router.get('/top-templates', optionalAdmin, (req, res) => {
  const { limit = 10, days = 30 } = req.query;
  const now = Date.now();
  const cutoff = now - (parseInt(days) * 86400000);

  const templates = db.prepare(`
    SELECT
      template_id,
      COUNT(*) as sales_count,
      SUM(price) as total_volume,
      AVG(price) as avg_price,
      MAX(sold_at) as last_sale
    FROM sales_history
    WHERE sold_at > ?
    GROUP BY template_id
    ORDER BY total_volume DESC
    LIMIT ?
  `).all(cutoff, parseInt(limit));

  res.json(templates);
});

/**
 * GET /api/economy/sales
 * Get sales history
 */
router.get('/sales', optionalAdmin, (req, res) => {
  const { template_id, seller_id, buyer_id, limit = 50, offset = 0, days = 30 } = req.query;
  const now = Date.now();

  let query = 'SELECT * FROM sales_history WHERE sold_at > ?';
  const params = [now - (parseInt(days) * 86400000)];

  if (template_id) {
    query += ' AND template_id = ?';
    params.push(template_id);
  }

  if (seller_id) {
    query += ' AND seller_id = ?';
    params.push(seller_id);
  }

  if (buyer_id) {
    query += ' AND buyer_id = ?';
    params.push(buyer_id);
  }

  query += ' ORDER BY sold_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const sales = db.prepare(query).all(...params);
  res.json(sales);
});

/**
 * GET /api/economy/market-stats/:templateId
 * Get market stats for a template
 */
router.get('/market-stats/:templateId', optionalAdmin, (req, res) => {
  const { templateId } = req.params;

  // Get cached stats
  let stats = db.prepare('SELECT * FROM market_stats WHERE template_id = ?').get(templateId);

  // If no cached stats, compute them
  if (!stats) {
    const now = Date.now();
    const day = 86400000;

    const sales = db.prepare(`
      SELECT price FROM sales_history WHERE template_id = ? ORDER BY sold_at DESC
    `).all(templateId);

    const sales7d = db.prepare(`
      SELECT price FROM sales_history WHERE template_id = ? AND sold_at > ? ORDER BY sold_at DESC
    `).all(templateId, now - 7 * day);

    const sales30d = db.prepare(`
      SELECT price FROM sales_history WHERE template_id = ? AND sold_at > ? ORDER BY sold_at DESC
    `).all(templateId, now - 30 * day);

    const activeListings = db.prepare(`
      SELECT MIN(price) as floor FROM listings WHERE template_id = ? AND status = 'active'
    `).get(templateId);

    const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b.price, 0) / arr.length) : null;

    stats = {
      template_id: templateId,
      floor_price: activeListings?.floor || null,
      last_sale_price: sales[0]?.price || null,
      avg_price_7d: avg(sales7d),
      avg_price_30d: avg(sales30d),
      total_sales: sales.length,
      total_volume: sales.reduce((a, s) => a + s.price, 0),
      active_listings: 0, // Would count from listings table
      updated_at: now
    };

    // Cache it
    db.prepare(`
      INSERT OR REPLACE INTO market_stats (template_id, floor_price, last_sale_price, avg_price_7d, avg_price_30d, total_sales, total_volume, active_listings, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      templateId, stats.floor_price, stats.last_sale_price, stats.avg_price_7d,
      stats.avg_price_30d, stats.total_sales, stats.total_volume, stats.active_listings, stats.updated_at
    );
  }

  res.json(stats);
});

/**
 * GET /api/economy/trades
 * Get trade records
 */
router.get('/trades', requireAdmin, (req, res) => {
  const { status, seller_id, buyer_id, limit = 50 } = req.query;

  let query = 'SELECT * FROM trades WHERE 1=1';
  const params = [];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  if (seller_id) {
    query += ' AND seller_id = ?';
    params.push(seller_id);
  }

  if (buyer_id) {
    query += ' AND buyer_id = ?';
    params.push(buyer_id);
  }

  query += ' ORDER BY initiated_at DESC LIMIT ?';
  params.push(parseInt(limit));

  const trades = db.prepare(query).all(...params);

  res.json(trades.map(t => ({
    ...t,
    status_history: t.status_history ? JSON.parse(t.status_history) : []
  })));
});

/**
 * POST /api/economy/emergency/:action
 * Emergency economy controls
 */
router.post('/emergency/:action', requireAdmin, (req, res) => {
  const { action } = req.params;
  const { reason } = req.body;
  const now = Date.now();

  const validActions = ['pause_trading', 'resume_trading', 'freeze_escrows', 'unfreeze_escrows'];

  if (!validActions.includes(action)) {
    return res.status(400).json({ error: 'Invalid emergency action', code: 'INVALID_ACTION' });
  }

  // Log emergency action
  db.prepare(`
    INSERT INTO audit_log (id, type, admin_id, data, metadata, created_at)
    VALUES (?, 'emergency_action', ?, ?, ?, ?)
  `).run(
    `audit_${now}_${Math.random().toString(36).substr(2, 9)}`,
    req.admin.id,
    JSON.stringify({ action, reason }),
    JSON.stringify({ severity: 'critical' }),
    now
  );

  // Create alert
  db.prepare(`
    INSERT INTO alerts (id, type, category, message, details, created_at)
    VALUES (?, 'warning', 'system', ?, ?, ?)
  `).run(
    `alert_${now}_${Math.random().toString(36).substr(2, 9)}`,
    `Emergency action: ${action.replace(/_/g, ' ')}`,
    JSON.stringify({ action, reason, triggered_by: req.admin.id }),
    now
  );

  // In production, this would trigger actual system changes
  // For now, we just log it

  res.json({
    success: true,
    action,
    message: `Emergency action ${action} triggered`,
    logged_at: now
  });
});

module.exports = router;
