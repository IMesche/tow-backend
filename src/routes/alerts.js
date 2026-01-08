/**
 * TOW Backend - Alerts Routes
 */

const express = require('express');
const db = require('../models/db');
const { requireAdmin, optionalAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/alerts
 * List alerts
 */
router.get('/', optionalAdmin, (req, res) => {
  const { category, acknowledged, limit = 50 } = req.query;

  let query = 'SELECT * FROM alerts WHERE 1=1';
  const params = [];

  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }

  if (acknowledged !== undefined) {
    query += ' AND acknowledged = ?';
    params.push(acknowledged === 'true' ? 1 : 0);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(parseInt(limit));

  const alerts = db.prepare(query).all(...params);

  res.json(alerts.map(a => ({
    ...a,
    details: a.details ? JSON.parse(a.details) : null
  })));
});

/**
 * POST /api/alerts/:id/acknowledge
 * Acknowledge an alert
 */
router.post('/:id/acknowledge', requireAdmin, (req, res) => {
  const { id } = req.params;
  const now = Date.now();

  const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);

  if (!alert) {
    return res.status(404).json({ error: 'Alert not found', code: 'NOT_FOUND' });
  }

  db.prepare(`
    UPDATE alerts SET acknowledged = 1, acknowledged_by = ?, acknowledged_at = ? WHERE id = ?
  `).run(req.admin.id, now, id);

  // Audit log
  db.prepare(`
    INSERT INTO audit_log (id, type, admin_id, data, created_at)
    VALUES (?, 'alert_acknowledged', ?, ?, ?)
  `).run(
    `audit_${now}_${Math.random().toString(36).substr(2, 9)}`,
    req.admin.id,
    JSON.stringify({ alert_id: id }),
    now
  );

  res.json({ success: true, alert_id: id });
});

/**
 * POST /api/alerts/acknowledge-all
 * Acknowledge all pending alerts
 */
router.post('/acknowledge-all', requireAdmin, (req, res) => {
  const now = Date.now();

  const pending = db.prepare('SELECT id FROM alerts WHERE acknowledged = 0').all();

  db.prepare(`
    UPDATE alerts SET acknowledged = 1, acknowledged_by = ?, acknowledged_at = ? WHERE acknowledged = 0
  `).run(req.admin.id, now);

  // Audit log
  db.prepare(`
    INSERT INTO audit_log (id, type, admin_id, data, created_at)
    VALUES (?, 'alerts_bulk_acknowledged', ?, ?, ?)
  `).run(
    `audit_${now}_${Math.random().toString(36).substr(2, 9)}`,
    req.admin.id,
    JSON.stringify({ count: pending.length }),
    now
  );

  res.json({ success: true, acknowledged_count: pending.length });
});

/**
 * POST /api/alerts
 * Create a new alert (for system/API use)
 */
router.post('/', requireAdmin, (req, res) => {
  const { type, category, message, details } = req.body;

  if (!type || !category || !message) {
    return res.status(400).json({ error: 'Missing required fields', code: 'MISSING_FIELDS' });
  }

  const now = Date.now();
  const id = `alert_${now}_${Math.random().toString(36).substr(2, 9)}`;

  db.prepare(`
    INSERT INTO alerts (id, type, category, message, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, type, category, message, details ? JSON.stringify(details) : null, now);

  res.status(201).json({ id, type, category, message, created_at: now });
});

module.exports = router;
