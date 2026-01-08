/**
 * TOW Backend - Audit Log Routes
 */

const express = require('express');
const db = require('../models/db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/audit
 * Get audit log entries
 */
router.get('/', requireAdmin, (req, res) => {
  const { type, admin_id, user_id, limit = 100, offset = 0, start_date, end_date } = req.query;

  let query = `
    SELECT al.*, a.name as admin_name, u.display_name as user_name
    FROM audit_log al
    LEFT JOIN admins a ON al.admin_id = a.id
    LEFT JOIN users u ON al.user_id = u.id
    WHERE 1=1
  `;
  const params = [];

  if (type) {
    query += ' AND al.type = ?';
    params.push(type);
  }

  if (admin_id) {
    query += ' AND al.admin_id = ?';
    params.push(admin_id);
  }

  if (user_id) {
    query += ' AND al.user_id = ?';
    params.push(user_id);
  }

  if (start_date) {
    query += ' AND al.created_at >= ?';
    params.push(new Date(start_date).getTime());
  }

  if (end_date) {
    query += ' AND al.created_at <= ?';
    params.push(new Date(end_date).getTime());
  }

  query += ' ORDER BY al.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const logs = db.prepare(query).all(...params);

  res.json(logs.map(l => ({
    ...l,
    data: JSON.parse(l.data),
    metadata: l.metadata ? JSON.parse(l.metadata) : null
  })));
});

/**
 * GET /api/audit/types
 * Get list of audit log types
 */
router.get('/types', requireAdmin, (req, res) => {
  const types = db.prepare('SELECT DISTINCT type FROM audit_log ORDER BY type').all();
  res.json(types.map(t => t.type));
});

/**
 * GET /api/audit/search
 * Search audit logs
 */
router.get('/search', requireAdmin, (req, res) => {
  const { q, limit = 50 } = req.query;

  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters', code: 'QUERY_TOO_SHORT' });
  }

  const logs = db.prepare(`
    SELECT al.*, a.name as admin_name
    FROM audit_log al
    LEFT JOIN admins a ON al.admin_id = a.id
    WHERE al.data LIKE ? OR al.type LIKE ?
    ORDER BY al.created_at DESC
    LIMIT ?
  `).all(`%${q}%`, `%${q}%`, parseInt(limit));

  res.json(logs.map(l => ({
    ...l,
    data: JSON.parse(l.data),
    metadata: l.metadata ? JSON.parse(l.metadata) : null
  })));
});

/**
 * GET /api/audit/entity/:entityType/:entityId
 * Get audit logs for a specific entity
 */
router.get('/entity/:entityType/:entityId', requireAdmin, (req, res) => {
  const { entityType, entityId } = req.params;
  const { limit = 50 } = req.query;

  // Search in JSON data for entity references
  const searchPattern = `%"${entityType}_id":"${entityId}"%`;

  const logs = db.prepare(`
    SELECT al.*, a.name as admin_name
    FROM audit_log al
    LEFT JOIN admins a ON al.admin_id = a.id
    WHERE al.data LIKE ?
    ORDER BY al.created_at DESC
    LIMIT ?
  `).all(searchPattern, parseInt(limit));

  res.json(logs.map(l => ({
    ...l,
    data: JSON.parse(l.data),
    metadata: l.metadata ? JSON.parse(l.metadata) : null
  })));
});

/**
 * POST /api/audit
 * Create audit log entry (internal use)
 */
router.post('/', requireAdmin, (req, res) => {
  const { type, user_id, data, metadata } = req.body;

  if (!type || !data) {
    return res.status(400).json({ error: 'Type and data required', code: 'MISSING_FIELDS' });
  }

  const now = Date.now();
  const id = `audit_${now}_${Math.random().toString(36).substr(2, 9)}`;

  db.prepare(`
    INSERT INTO audit_log (id, type, admin_id, user_id, data, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, type, req.admin.id, user_id || null,
    JSON.stringify(data), metadata ? JSON.stringify(metadata) : null, now
  );

  res.status(201).json({ id, type, created_at: now });
});

/**
 * GET /api/audit/export
 * Export audit logs as JSON
 */
router.get('/export', requireAdmin, (req, res) => {
  const { start_date, end_date, type } = req.query;

  let query = 'SELECT * FROM audit_log WHERE 1=1';
  const params = [];

  if (start_date) {
    query += ' AND created_at >= ?';
    params.push(new Date(start_date).getTime());
  }

  if (end_date) {
    query += ' AND created_at <= ?';
    params.push(new Date(end_date).getTime());
  }

  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }

  query += ' ORDER BY created_at DESC';

  const logs = db.prepare(query).all(...params);

  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().split('T')[0]}.json"`);
  res.json({
    exported_at: new Date().toISOString(),
    exported_by: req.admin.id,
    filters: { start_date, end_date, type },
    count: logs.length,
    logs: logs.map(l => ({
      ...l,
      data: JSON.parse(l.data),
      metadata: l.metadata ? JSON.parse(l.metadata) : null
    }))
  });
});

module.exports = router;
