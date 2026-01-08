/**
 * TOW Backend - Escrow Routes
 * Escrow management and dispute resolution
 */

const express = require('express');
const db = require('../models/db');
const { requireAdmin, optionalAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/escrows
 * List escrows with optional filters
 */
router.get('/', optionalAdmin, (req, res) => {
  const { state, seller_id, buyer_id, limit = 50 } = req.query;

  let query = 'SELECT * FROM escrows WHERE 1=1';
  const params = [];

  if (state) {
    query += ' AND state = ?';
    params.push(state);
  }

  if (seller_id) {
    query += ' AND seller_id = ?';
    params.push(seller_id);
  }

  if (buyer_id) {
    query += ' AND buyer_id = ?';
    params.push(buyer_id);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(parseInt(limit));

  const escrows = db.prepare(query).all(...params);

  res.json(escrows.map(e => ({
    ...e,
    settlement_steps: e.settlement_steps ? JSON.parse(e.settlement_steps) : null
  })));
});

/**
 * GET /api/escrows/:id
 * Get single escrow
 */
router.get('/:id', optionalAdmin, (req, res) => {
  const escrow = db.prepare('SELECT * FROM escrows WHERE id = ?').get(req.params.id);

  if (!escrow) {
    return res.status(404).json({ error: 'Escrow not found', code: 'NOT_FOUND' });
  }

  // Get related trade
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(escrow.trade_id);

  // Get seller and buyer info
  const seller = db.prepare('SELECT id, display_name, trust_level, seller_score FROM users WHERE id = ?').get(escrow.seller_id);
  const buyer = db.prepare('SELECT id, display_name, trust_level, buyer_score FROM users WHERE id = ?').get(escrow.buyer_id);

  res.json({
    ...escrow,
    settlement_steps: escrow.settlement_steps ? JSON.parse(escrow.settlement_steps) : null,
    trade,
    seller,
    buyer
  });
});

/**
 * GET /api/escrows/disputes
 * Get all disputed escrows
 */
router.get('/state/disputed', requireAdmin, (req, res) => {
  const disputes = db.prepare(`
    SELECT e.*,
           s.display_name as seller_name, s.trust_level as seller_trust,
           b.display_name as buyer_name, b.trust_level as buyer_trust
    FROM escrows e
    LEFT JOIN users s ON e.seller_id = s.id
    LEFT JOIN users b ON e.buyer_id = b.id
    WHERE e.state = 'disputed'
    ORDER BY e.created_at ASC
  `).all();

  res.json(disputes);
});

/**
 * POST /api/escrows/:id/resolve
 * Resolve a disputed escrow
 */
router.post('/:id/resolve', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { resolution, reason } = req.body;

  const validResolutions = ['seller_wins', 'buyer_wins', 'split'];
  if (!validResolutions.includes(resolution)) {
    return res.status(400).json({ error: 'Invalid resolution', code: 'INVALID_RESOLUTION' });
  }

  const escrow = db.prepare('SELECT * FROM escrows WHERE id = ?').get(id);

  if (!escrow) {
    return res.status(404).json({ error: 'Escrow not found', code: 'NOT_FOUND' });
  }

  if (escrow.state !== 'disputed') {
    return res.status(400).json({ error: 'Escrow is not in disputed state', code: 'NOT_DISPUTED' });
  }

  const now = Date.now();

  // Update escrow
  db.prepare(`
    UPDATE escrows
    SET state = 'completed', dispute_resolved_by = ?, dispute_resolution = ?, completed_at = ?
    WHERE id = ?
  `).run(req.admin.id, resolution, now, id);

  // Update related trade
  db.prepare(`
    UPDATE trades SET status = 'completed', completed_at = ? WHERE id = ?
  `).run(now, escrow.trade_id);

  // Update user reputation based on resolution
  if (resolution === 'seller_wins') {
    db.prepare('UPDATE users SET disputed_trades = disputed_trades + 1 WHERE id = ?').run(escrow.buyer_id);
  } else if (resolution === 'buyer_wins') {
    db.prepare('UPDATE users SET disputed_trades = disputed_trades + 1 WHERE id = ?').run(escrow.seller_id);
  }

  // Log reputation event for both parties
  const eventId1 = `rep_${now}_${Math.random().toString(36).substr(2, 9)}`;
  const eventId2 = `rep_${now}_${Math.random().toString(36).substr(2, 9)}`;

  db.prepare(`
    INSERT INTO reputation_events (id, user_id, event_type, trade_id, details, created_at)
    VALUES (?, ?, 'dispute_resolved', ?, ?, ?)
  `).run(eventId1, escrow.seller_id, escrow.trade_id, JSON.stringify({ resolution, role: 'seller' }), now);

  db.prepare(`
    INSERT INTO reputation_events (id, user_id, event_type, trade_id, details, created_at)
    VALUES (?, ?, 'dispute_resolved', ?, ?, ?)
  `).run(eventId2, escrow.buyer_id, escrow.trade_id, JSON.stringify({ resolution, role: 'buyer' }), now);

  // Audit log
  db.prepare(`
    INSERT INTO audit_log (id, type, admin_id, data, created_at)
    VALUES (?, 'dispute_resolved', ?, ?, ?)
  `).run(
    `audit_${now}_${Math.random().toString(36).substr(2, 9)}`,
    req.admin.id,
    JSON.stringify({ escrow_id: id, resolution, reason }),
    now
  );

  // Create alert
  db.prepare(`
    INSERT INTO alerts (id, type, category, message, details, created_at, acknowledged)
    VALUES (?, 'info', 'economy', ?, ?, ?, 1)
  `).run(
    `alert_${now}_${Math.random().toString(36).substr(2, 9)}`,
    `Dispute resolved: ${resolution.replace('_', ' ')} for escrow ${id.slice(-8)}`,
    JSON.stringify({ escrow_id: id, resolution, resolved_by: req.admin.id }),
    now
  );

  res.json({
    success: true,
    escrow_id: id,
    resolution,
    resolved_by: req.admin.id,
    resolved_at: now
  });
});

/**
 * POST /api/escrows/:id/extend
 * Extend escrow timeout
 */
router.post('/:id/extend', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { hours, reason } = req.body;

  if (!hours || hours < 1 || hours > 168) {
    return res.status(400).json({ error: 'Hours must be between 1 and 168', code: 'INVALID_HOURS' });
  }

  const escrow = db.prepare('SELECT * FROM escrows WHERE id = ?').get(id);

  if (!escrow) {
    return res.status(404).json({ error: 'Escrow not found', code: 'NOT_FOUND' });
  }

  const now = Date.now();
  const newExpiry = escrow.expires_at + (hours * 3600000);

  db.prepare('UPDATE escrows SET expires_at = ? WHERE id = ?').run(newExpiry, id);

  // Audit log
  db.prepare(`
    INSERT INTO audit_log (id, type, admin_id, data, created_at)
    VALUES (?, 'escrow_extended', ?, ?, ?)
  `).run(
    `audit_${now}_${Math.random().toString(36).substr(2, 9)}`,
    req.admin.id,
    JSON.stringify({ escrow_id: id, hours_added: hours, new_expiry: newExpiry, reason }),
    now
  );

  res.json({
    success: true,
    escrow_id: id,
    old_expiry: escrow.expires_at,
    new_expiry: newExpiry
  });
});

module.exports = router;
