/**
 * TOW Backend - AI Routes
 * AI recommendations and actions
 */

const express = require('express');
const db = require('../models/db');
const { requireAdmin, optionalAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/ai/recommendations
 * List AI recommendations
 */
router.get('/recommendations', optionalAdmin, (req, res) => {
  const { status, category, limit = 20 } = req.query;

  let query = 'SELECT * FROM ai_recommendations WHERE 1=1';
  const params = [];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(parseInt(limit));

  const recommendations = db.prepare(query).all(...params);

  res.json(recommendations.map(r => ({
    ...r,
    action_data: r.action_data ? JSON.parse(r.action_data) : null
  })));
});

/**
 * GET /api/ai/recommendations/:id
 * Get single recommendation
 */
router.get('/recommendations/:id', optionalAdmin, (req, res) => {
  const rec = db.prepare('SELECT * FROM ai_recommendations WHERE id = ?').get(req.params.id);

  if (!rec) {
    return res.status(404).json({ error: 'Recommendation not found', code: 'NOT_FOUND' });
  }

  res.json({
    ...rec,
    action_data: rec.action_data ? JSON.parse(rec.action_data) : null
  });
});

/**
 * POST /api/ai/recommendations/:id/approve
 * Approve a recommendation
 */
router.post('/recommendations/:id/approve', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  const now = Date.now();

  const rec = db.prepare('SELECT * FROM ai_recommendations WHERE id = ?').get(id);

  if (!rec) {
    return res.status(404).json({ error: 'Recommendation not found', code: 'NOT_FOUND' });
  }

  if (rec.status !== 'pending' && rec.status !== 'reviewing') {
    return res.status(400).json({ error: 'Recommendation already processed', code: 'ALREADY_PROCESSED' });
  }

  db.prepare(`
    UPDATE ai_recommendations
    SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_reason = ?
    WHERE id = ?
  `).run(req.admin.id, now, reason || null, id);

  // Log AI action
  db.prepare(`
    INSERT INTO audit_log (id, type, admin_id, data, created_at)
    VALUES (?, 'ai_recommendation_approved', ?, ?, ?)
  `).run(
    `audit_${now}_${Math.random().toString(36).substr(2, 9)}`,
    req.admin.id,
    JSON.stringify({ recommendation_id: id, title: rec.title, category: rec.category }),
    now
  );

  // TODO: In production, execute the action_data if present

  res.json({
    success: true,
    recommendation_id: id,
    status: 'approved',
    approved_by: req.admin.id,
    approved_at: now
  });
});

/**
 * POST /api/ai/recommendations/:id/reject
 * Reject a recommendation
 */
router.post('/recommendations/:id/reject', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  const now = Date.now();

  const rec = db.prepare('SELECT * FROM ai_recommendations WHERE id = ?').get(id);

  if (!rec) {
    return res.status(404).json({ error: 'Recommendation not found', code: 'NOT_FOUND' });
  }

  if (rec.status !== 'pending' && rec.status !== 'reviewing') {
    return res.status(400).json({ error: 'Recommendation already processed', code: 'ALREADY_PROCESSED' });
  }

  db.prepare(`
    UPDATE ai_recommendations
    SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_reason = ?
    WHERE id = ?
  `).run(req.admin.id, now, reason || null, id);

  // Log AI action
  db.prepare(`
    INSERT INTO audit_log (id, type, admin_id, data, created_at)
    VALUES (?, 'ai_recommendation_rejected', ?, ?, ?)
  `).run(
    `audit_${now}_${Math.random().toString(36).substr(2, 9)}`,
    req.admin.id,
    JSON.stringify({ recommendation_id: id, title: rec.title, reason }),
    now
  );

  res.json({
    success: true,
    recommendation_id: id,
    status: 'rejected',
    rejected_by: req.admin.id,
    rejected_at: now
  });
});

/**
 * POST /api/ai/recommendations/:id/review
 * Mark recommendation as under review
 */
router.post('/recommendations/:id/review', requireAdmin, (req, res) => {
  const { id } = req.params;
  const now = Date.now();

  const rec = db.prepare('SELECT * FROM ai_recommendations WHERE id = ?').get(id);

  if (!rec) {
    return res.status(404).json({ error: 'Recommendation not found', code: 'NOT_FOUND' });
  }

  db.prepare(`
    UPDATE ai_recommendations SET status = 'reviewing' WHERE id = ?
  `).run(id);

  res.json({ success: true, recommendation_id: id, status: 'reviewing' });
});

/**
 * GET /api/ai/actions
 * Get AI action audit log
 */
router.get('/actions', requireAdmin, (req, res) => {
  const { limit = 50 } = req.query;

  const actions = db.prepare(`
    SELECT al.*, a.name as admin_name
    FROM audit_log al
    LEFT JOIN admins a ON al.admin_id = a.id
    WHERE al.type LIKE 'ai_%'
    ORDER BY al.created_at DESC
    LIMIT ?
  `).all(parseInt(limit));

  res.json(actions.map(a => ({
    ...a,
    data: JSON.parse(a.data),
    metadata: a.metadata ? JSON.parse(a.metadata) : null
  })));
});

module.exports = router;
