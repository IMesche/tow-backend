/**
 * TOW Backend - Metrics Routes
 * Daily aggregated metrics
 */

const express = require('express');
const db = require('../models/db');
const { requireAdmin, optionalAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/metrics/daily
 * Get daily metrics
 */
router.get('/daily', optionalAdmin, (req, res) => {
  const { days = 7 } = req.query;

  const metrics = db.prepare(`
    SELECT * FROM economy_metrics
    ORDER BY date DESC
    LIMIT ?
  `).all(parseInt(days));

  res.json(metrics.reverse());
});

/**
 * GET /api/metrics/range
 * Get metrics for date range
 */
router.get('/range', optionalAdmin, (req, res) => {
  const { start_date, end_date } = req.query;

  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start_date and end_date required', code: 'MISSING_DATES' });
  }

  const metrics = db.prepare(`
    SELECT * FROM economy_metrics
    WHERE date >= ? AND date <= ?
    ORDER BY date ASC
  `).all(start_date, end_date);

  res.json(metrics);
});

/**
 * GET /api/metrics/summary
 * Get summary metrics for a period
 */
router.get('/summary', optionalAdmin, (req, res) => {
  const { days = 7 } = req.query;

  const metrics = db.prepare(`
    SELECT * FROM economy_metrics
    ORDER BY date DESC
    LIMIT ?
  `).all(parseInt(days));

  if (metrics.length === 0) {
    return res.json({
      period_days: parseInt(days),
      total_trades: 0,
      total_volume: 0,
      total_revenue: 0,
      avg_daily_trades: 0,
      avg_daily_volume: 0,
      total_new_users: 0
    });
  }

  const summary = metrics.reduce((acc, m) => {
    acc.total_trades += m.total_trades;
    acc.total_volume += m.total_volume;
    acc.total_revenue += m.platform_revenue;
    acc.total_new_users += m.new_users;
    return acc;
  }, { total_trades: 0, total_volume: 0, total_revenue: 0, total_new_users: 0 });

  res.json({
    period_days: metrics.length,
    ...summary,
    avg_daily_trades: Math.round(summary.total_trades / metrics.length),
    avg_daily_volume: Math.round(summary.total_volume / metrics.length),
    avg_daily_revenue: Math.round(summary.total_revenue / metrics.length)
  });
});

/**
 * POST /api/metrics/compute
 * Compute metrics for a date (admin only)
 */
router.post('/compute', requireAdmin, (req, res) => {
  const { date } = req.body;
  const targetDate = date || new Date().toISOString().split('T')[0];
  const now = Date.now();

  const dayStart = new Date(targetDate).getTime();
  const dayEnd = dayStart + 86400000;

  // Compute from sales history
  const salesStats = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(price), 0) as volume, COALESCE(SUM(platform_fee), 0) as revenue
    FROM sales_history
    WHERE sold_at >= ? AND sold_at < ?
  `).get(dayStart, dayEnd);

  // Active users (unique traders)
  const activeUsers = db.prepare(`
    SELECT COUNT(DISTINCT user_id) as count
    FROM (
      SELECT seller_id as user_id FROM trades WHERE initiated_at >= ? AND initiated_at < ?
      UNION
      SELECT buyer_id as user_id FROM trades WHERE initiated_at >= ? AND initiated_at < ?
    )
  `).get(dayStart, dayEnd, dayStart, dayEnd);

  // New users
  const newUsers = db.prepare(`
    SELECT COUNT(*) as count FROM users WHERE created_at >= ? AND created_at < ?
  `).get(dayStart, dayEnd);

  // Active escrows
  const escrowStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN state = 'disputed' THEN 1 ELSE 0 END) as disputed
    FROM escrows
    WHERE created_at < ? AND (completed_at IS NULL OR completed_at >= ?)
  `).get(dayEnd, dayStart);

  // Failed settlements
  const failedSettlements = db.prepare(`
    SELECT COUNT(*) as count FROM trades WHERE status = 'failed' AND failed_at >= ? AND failed_at < ?
  `).get(dayStart, dayEnd);

  // Active listings
  const activeListings = db.prepare(`
    SELECT COUNT(*) as count FROM listings WHERE status = 'active'
  `).get();

  // Insert/update metrics
  db.prepare(`
    INSERT OR REPLACE INTO economy_metrics
    (date, total_trades, total_volume, platform_revenue, active_users, new_users, active_listings, active_escrows, disputed_escrows, failed_settlements, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    targetDate,
    salesStats.count || 0,
    salesStats.volume || 0,
    salesStats.revenue || 0,
    activeUsers.count || 0,
    newUsers.count || 0,
    activeListings.count || 0,
    escrowStats.total || 0,
    escrowStats.disputed || 0,
    failedSettlements.count || 0,
    now
  );

  const metrics = db.prepare('SELECT * FROM economy_metrics WHERE date = ?').get(targetDate);

  res.json({
    success: true,
    date: targetDate,
    metrics
  });
});

module.exports = router;
