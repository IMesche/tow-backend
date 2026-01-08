/**
 * TOW Backend - Users Routes
 * User management, reputation, trust levels
 */

const express = require('express');
const db = require('../models/db');
const { requireAdmin, optionalAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/users
 * List users with optional filters
 */
router.get('/', optionalAdmin, (req, res) => {
  const { trust_level, is_npc, search, limit = 50, offset = 0 } = req.query;

  let query = 'SELECT * FROM users WHERE 1=1';
  const params = [];

  if (trust_level) {
    query += ' AND trust_level = ?';
    params.push(trust_level);
  }

  if (is_npc !== undefined) {
    query += ' AND is_npc = ?';
    params.push(is_npc === 'true' ? 1 : 0);
  }

  if (search) {
    query += ' AND (username LIKE ? OR display_name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const users = db.prepare(query).all(...params);

  res.json(users.map(u => ({
    ...u,
    npc_config: u.npc_config ? JSON.parse(u.npc_config) : null
  })));
});

/**
 * GET /api/users/:id
 * Get single user
 */
router.get('/:id', optionalAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);

  if (!user) {
    return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });
  }

  res.json({
    ...user,
    npc_config: user.npc_config ? JSON.parse(user.npc_config) : null
  });
});

/**
 * GET /api/users/:id/reputation
 * Get user reputation details
 */
router.get('/:id/reputation', optionalAdmin, (req, res) => {
  const user = db.prepare(`
    SELECT id, username, display_name, trust_level, seller_score, buyer_score,
           total_trades, completed_trades, cancelled_trades, disputed_trades,
           positive_reviews, neutral_reviews, negative_reviews, fraud_flags,
           first_trade_at, last_trade_at, created_at
    FROM users WHERE id = ?
  `).get(req.params.id);

  if (!user) {
    return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });
  }

  // Get recent reputation events
  const events = db.prepare(`
    SELECT * FROM reputation_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(req.params.id);

  // Get recent reviews
  const reviews = db.prepare(`
    SELECT r.*, u.display_name as reviewer_name
    FROM reviews r
    LEFT JOIN users u ON r.reviewer_id = u.id
    WHERE r.reviewee_id = ?
    ORDER BY r.created_at DESC LIMIT 10
  `).all(req.params.id);

  res.json({
    ...user,
    events: events.map(e => ({ ...e, details: e.details ? JSON.parse(e.details) : null })),
    reviews
  });
});

/**
 * PUT /api/users/:id/trust-level
 * Manually adjust user trust level (admin only)
 */
router.put('/:id/trust-level', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { trust_level, reason } = req.body;

  const validLevels = ['new', 'trusted', 'verified', 'elite'];
  if (!validLevels.includes(trust_level)) {
    return res.status(400).json({ error: 'Invalid trust level', code: 'INVALID_LEVEL' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) {
    return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });
  }

  const now = Date.now();

  db.prepare('UPDATE users SET trust_level = ? WHERE id = ?').run(trust_level, id);

  // Log event
  db.prepare(`
    INSERT INTO reputation_events (id, user_id, event_type, details, created_at)
    VALUES (?, ?, 'trust_level_changed', ?, ?)
  `).run(
    `rep_${now}_${Math.random().toString(36).substr(2, 9)}`,
    id,
    JSON.stringify({ old_level: user.trust_level, new_level: trust_level, reason, changed_by: req.admin.id }),
    now
  );

  // Audit log
  db.prepare(`
    INSERT INTO audit_log (id, type, admin_id, user_id, data, created_at)
    VALUES (?, 'user_trust_changed', ?, ?, ?, ?)
  `).run(
    `audit_${now}_${Math.random().toString(36).substr(2, 9)}`,
    req.admin.id,
    id,
    JSON.stringify({ old_level: user.trust_level, new_level: trust_level, reason }),
    now
  );

  res.json({ success: true, user_id: id, trust_level });
});

/**
 * POST /api/users/:id/warning
 * Add warning to user
 */
router.post('/:id/warning', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { type, message } = req.body;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) {
    return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });
  }

  const now = Date.now();

  // Log reputation event
  db.prepare(`
    INSERT INTO reputation_events (id, user_id, event_type, details, created_at)
    VALUES (?, ?, 'warning_issued', ?, ?)
  `).run(
    `rep_${now}_${Math.random().toString(36).substr(2, 9)}`,
    id,
    JSON.stringify({ type, message, issued_by: req.admin.id }),
    now
  );

  // Audit log
  db.prepare(`
    INSERT INTO audit_log (id, type, admin_id, user_id, data, created_at)
    VALUES (?, 'user_warning', ?, ?, ?, ?)
  `).run(
    `audit_${now}_${Math.random().toString(36).substr(2, 9)}`,
    req.admin.id,
    id,
    JSON.stringify({ type, message }),
    now
  );

  res.json({ success: true, user_id: id, warning: { type, message } });
});

/**
 * POST /api/users/:id/fraud-flag
 * Add fraud flag to user
 */
router.post('/:id/fraud-flag', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) {
    return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });
  }

  const now = Date.now();

  db.prepare('UPDATE users SET fraud_flags = fraud_flags + 1 WHERE id = ?').run(id);

  // Log event
  db.prepare(`
    INSERT INTO reputation_events (id, user_id, event_type, details, created_at)
    VALUES (?, ?, 'fraud_flag_added', ?, ?)
  `).run(
    `rep_${now}_${Math.random().toString(36).substr(2, 9)}`,
    id,
    JSON.stringify({ reason, flagged_by: req.admin.id }),
    now
  );

  // Audit log
  db.prepare(`
    INSERT INTO audit_log (id, type, admin_id, user_id, data, created_at)
    VALUES (?, 'user_fraud_flag', ?, ?, ?, ?)
  `).run(
    `audit_${now}_${Math.random().toString(36).substr(2, 9)}`,
    req.admin.id,
    id,
    JSON.stringify({ reason }),
    now
  );

  res.json({ success: true, user_id: id, fraud_flags: user.fraud_flags + 1 });
});

module.exports = router;
