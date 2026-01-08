/**
 * TOW Backend - Locations Routes
 */

const express = require('express');
const db = require('../models/db');
const { requireAdmin, optionalAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/locations
 * List locations
 */
router.get('/', optionalAdmin, (req, res) => {
  const { type, parent_id } = req.query;

  let query = 'SELECT * FROM locations WHERE is_active = 1';
  const params = [];

  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }

  if (parent_id) {
    query += ' AND parent_id = ?';
    params.push(parent_id);
  }

  query += ' ORDER BY type, name';

  const locations = db.prepare(query).all(...params);

  res.json(locations.map(l => ({
    ...l,
    policies: l.policies ? JSON.parse(l.policies) : [],
    geofence: l.geofence ? JSON.parse(l.geofence) : null
  })));
});

/**
 * GET /api/locations/:id
 * Get single location
 */
router.get('/:id', optionalAdmin, (req, res) => {
  const location = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id);

  if (!location) {
    return res.status(404).json({ error: 'Location not found', code: 'NOT_FOUND' });
  }

  // Get child locations
  const children = db.prepare('SELECT * FROM locations WHERE parent_id = ? AND is_active = 1').all(req.params.id);

  // Get applied policies with details
  const policyIds = location.policies ? JSON.parse(location.policies) : [];
  const policies = policyIds.length > 0
    ? db.prepare(`SELECT id, name, type, scope FROM policies WHERE id IN (${policyIds.map(() => '?').join(',')}) AND is_active = 1`).all(...policyIds)
    : [];

  res.json({
    ...location,
    policies: policies,
    geofence: location.geofence ? JSON.parse(location.geofence) : null,
    children: children.map(c => ({
      ...c,
      policies: c.policies ? JSON.parse(c.policies) : []
    }))
  });
});

/**
 * POST /api/locations
 * Create new location
 */
router.post('/', requireAdmin, (req, res) => {
  const { id, name, type, parent_id, policies, geofence } = req.body;

  if (!name || !type) {
    return res.status(400).json({ error: 'Name and type required', code: 'MISSING_FIELDS' });
  }

  const now = Date.now();
  const locationId = id || `loc_${type}_${now}`;

  try {
    db.prepare(`
      INSERT INTO locations (id, name, type, parent_id, policies, geofence, created_at, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      locationId, name, type, parent_id || null,
      policies ? JSON.stringify(policies) : '[]',
      geofence ? JSON.stringify(geofence) : null,
      now
    );

    // Audit log
    db.prepare(`
      INSERT INTO audit_log (id, type, admin_id, data, created_at)
      VALUES (?, 'location_created', ?, ?, ?)
    `).run(
      `audit_${now}_${Math.random().toString(36).substr(2, 9)}`,
      req.admin.id,
      JSON.stringify({ location_id: locationId, name, type }),
      now
    );

    const created = db.prepare('SELECT * FROM locations WHERE id = ?').get(locationId);
    res.status(201).json({
      ...created,
      policies: created.policies ? JSON.parse(created.policies) : [],
      geofence: created.geofence ? JSON.parse(created.geofence) : null
    });

  } catch (err) {
    console.error('Error creating location:', err);
    res.status(500).json({ error: 'Failed to create location', code: 'CREATE_FAILED' });
  }
});

/**
 * PUT /api/locations/:id
 * Update location
 */
router.put('/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { name, policies, geofence, active_quests, active_users, venues } = req.body;

  const existing = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);

  if (!existing) {
    return res.status(404).json({ error: 'Location not found', code: 'NOT_FOUND' });
  }

  const now = Date.now();

  const updates = [];
  const params = [];

  if (name !== undefined) {
    updates.push('name = ?');
    params.push(name);
  }
  if (policies !== undefined) {
    updates.push('policies = ?');
    params.push(JSON.stringify(policies));
  }
  if (geofence !== undefined) {
    updates.push('geofence = ?');
    params.push(JSON.stringify(geofence));
  }
  if (active_quests !== undefined) {
    updates.push('active_quests = ?');
    params.push(active_quests);
  }
  if (active_users !== undefined) {
    updates.push('active_users = ?');
    params.push(active_users);
  }
  if (venues !== undefined) {
    updates.push('venues = ?');
    params.push(venues);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No updates provided', code: 'NO_UPDATES' });
  }

  params.push(id);

  db.prepare(`UPDATE locations SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  // Audit log
  db.prepare(`
    INSERT INTO audit_log (id, type, admin_id, data, created_at)
    VALUES (?, 'location_updated', ?, ?, ?)
  `).run(
    `audit_${now}_${Math.random().toString(36).substr(2, 9)}`,
    req.admin.id,
    JSON.stringify({ location_id: id, updates: req.body }),
    now
  );

  const updated = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
  res.json({
    ...updated,
    policies: updated.policies ? JSON.parse(updated.policies) : [],
    geofence: updated.geofence ? JSON.parse(updated.geofence) : null
  });
});

/**
 * DELETE /api/locations/:id
 * Deactivate location
 */
router.delete('/:id', requireAdmin, (req, res) => {
  const { id } = req.params;

  const existing = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);

  if (!existing) {
    return res.status(404).json({ error: 'Location not found', code: 'NOT_FOUND' });
  }

  const now = Date.now();

  db.prepare('UPDATE locations SET is_active = 0 WHERE id = ?').run(id);

  // Audit log
  db.prepare(`
    INSERT INTO audit_log (id, type, admin_id, data, created_at)
    VALUES (?, 'location_deleted', ?, ?, ?)
  `).run(
    `audit_${now}_${Math.random().toString(36).substr(2, 9)}`,
    req.admin.id,
    JSON.stringify({ location_id: id, name: existing.name }),
    now
  );

  res.json({ success: true, message: 'Location deactivated' });
});

module.exports = router;
