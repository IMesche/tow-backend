/**
 * TOW Backend - Policy Routes
 * CRUD for versioned policies with location-based overrides
 */

const express = require('express');
const db = require('../models/db');
const { requireAdmin, optionalAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/policies
 * List all active policies
 */
router.get('/', optionalAdmin, (req, res) => {
  const { type, scope, scope_value } = req.query;

  let query = 'SELECT * FROM policies WHERE is_active = 1';
  const params = [];

  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }

  if (scope) {
    query += ' AND scope = ?';
    params.push(scope);
  }

  if (scope_value) {
    query += ' AND scope_value = ?';
    params.push(scope_value);
  }

  query += ' ORDER BY type, scope';

  const policies = db.prepare(query).all(...params);

  // Parse JSON rules
  const result = policies.map(p => ({
    ...p,
    rules: JSON.parse(p.rules)
  }));

  res.json(result);
});

/**
 * GET /api/policies/resolve/:type
 * Resolve effective policy for a type and location context
 * Query params: region, country, city, venue_id, quest_id
 * NOTE: Must be defined BEFORE /:id to avoid route conflict
 */
router.get('/resolve/:type', optionalAdmin, (req, res) => {
  const { type } = req.params;
  const { region, country, city, venue_id, quest_id } = req.query;

  // Get all active policies of this type
  const policies = db.prepare(`
    SELECT * FROM policies
    WHERE type = ? AND is_active = 1 AND effective_from <= ?
    ORDER BY
      CASE scope
        WHEN 'quest' THEN 6
        WHEN 'venue' THEN 5
        WHEN 'city' THEN 4
        WHEN 'country' THEN 3
        WHEN 'region' THEN 2
        WHEN 'global' THEN 1
        ELSE 0
      END DESC
  `).all(type, Date.now());

  // Find most specific matching policy
  for (const policy of policies) {
    let matches = false;

    switch (policy.scope) {
      case 'global':
        matches = true;
        break;
      case 'region':
        matches = policy.scope_value === region;
        break;
      case 'country':
        matches = policy.scope_value === country;
        break;
      case 'city':
        matches = policy.scope_value === city;
        break;
      case 'venue':
        matches = policy.scope_value === venue_id;
        break;
      case 'quest':
        matches = policy.scope_value === quest_id;
        break;
    }

    if (matches) {
      return res.json({
        ...policy,
        rules: JSON.parse(policy.rules),
        resolved_for: { region, country, city, venue_id, quest_id }
      });
    }
  }

  res.status(404).json({ error: 'No policy found for this context', code: 'NO_POLICY' });
});

/**
 * GET /api/policies/:id
 * Get single policy by ID
 */
router.get('/:id', optionalAdmin, (req, res) => {
  const policy = db.prepare('SELECT * FROM policies WHERE id = ?').get(req.params.id);

  if (!policy) {
    return res.status(404).json({ error: 'Policy not found', code: 'NOT_FOUND' });
  }

  res.json({
    ...policy,
    rules: JSON.parse(policy.rules)
  });
});

/**
 * POST /api/policies
 * Create new policy (admin only)
 */
router.post('/', requireAdmin, (req, res) => {
  const { id, type, name, scope, scope_value, rules, reason } = req.body;

  if (!id || !type || !name || !scope || !rules) {
    return res.status(400).json({ error: 'Missing required fields', code: 'MISSING_FIELDS' });
  }

  const now = Date.now();
  const policyId = id || `policy_${type}_${now}`;
  const version = '1.0.0';

  try {
    db.prepare(`
      INSERT INTO policies (id, type, name, version, scope, scope_value, rules, effective_from, created_by, created_at, reason, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      policyId, type, name, version, scope, scope_value || null,
      JSON.stringify(rules), now, req.admin.id, now, reason
    );

    // Log to policy history
    db.prepare(`
      INSERT INTO policy_history (id, policy_id, action, new_version, new_rules, changed_by, changed_at, reason)
      VALUES (?, ?, 'created', ?, ?, ?, ?, ?)
    `).run(
      `ph_${now}_${Math.random().toString(36).substr(2, 9)}`,
      policyId, version, JSON.stringify(rules), req.admin.id, now, reason
    );

    // Audit log
    db.prepare(`
      INSERT INTO audit_log (id, type, admin_id, data, created_at)
      VALUES (?, 'policy_created', ?, ?, ?)
    `).run(
      `audit_${now}_${Math.random().toString(36).substr(2, 9)}`,
      req.admin.id,
      JSON.stringify({ policyId, type, scope, reason }),
      now
    );

    const created = db.prepare('SELECT * FROM policies WHERE id = ?').get(policyId);
    res.status(201).json({
      ...created,
      rules: JSON.parse(created.rules)
    });

  } catch (err) {
    console.error('Error creating policy:', err);
    res.status(500).json({ error: 'Failed to create policy', code: 'CREATE_FAILED' });
  }
});

/**
 * PUT /api/policies/:id
 * Update policy (creates new version)
 */
router.put('/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { rules, reason } = req.body;

  const existing = db.prepare('SELECT * FROM policies WHERE id = ?').get(id);

  if (!existing) {
    return res.status(404).json({ error: 'Policy not found', code: 'NOT_FOUND' });
  }

  const now = Date.now();

  // Increment version
  const [major, minor, patch] = existing.version.split('.').map(Number);
  const newVersion = `${major}.${minor}.${patch + 1}`;

  try {
    db.prepare(`
      UPDATE policies
      SET rules = ?, version = ?, effective_from = ?, reason = ?
      WHERE id = ?
    `).run(JSON.stringify(rules), newVersion, now, reason, id);

    // Log to policy history
    db.prepare(`
      INSERT INTO policy_history (id, policy_id, action, old_version, new_version, old_rules, new_rules, changed_by, changed_at, reason)
      VALUES (?, ?, 'updated', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `ph_${now}_${Math.random().toString(36).substr(2, 9)}`,
      id, existing.version, newVersion, existing.rules, JSON.stringify(rules),
      req.admin.id, now, reason
    );

    // Audit log
    db.prepare(`
      INSERT INTO audit_log (id, type, admin_id, data, created_at)
      VALUES (?, 'policy_updated', ?, ?, ?)
    `).run(
      `audit_${now}_${Math.random().toString(36).substr(2, 9)}`,
      req.admin.id,
      JSON.stringify({ policyId: id, oldVersion: existing.version, newVersion, reason }),
      now
    );

    const updated = db.prepare('SELECT * FROM policies WHERE id = ?').get(id);
    res.json({
      ...updated,
      rules: JSON.parse(updated.rules)
    });

  } catch (err) {
    console.error('Error updating policy:', err);
    res.status(500).json({ error: 'Failed to update policy', code: 'UPDATE_FAILED' });
  }
});

/**
 * DELETE /api/policies/:id
 * Deactivate policy (soft delete)
 */
router.delete('/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  const existing = db.prepare('SELECT * FROM policies WHERE id = ?').get(id);

  if (!existing) {
    return res.status(404).json({ error: 'Policy not found', code: 'NOT_FOUND' });
  }

  const now = Date.now();

  db.prepare('UPDATE policies SET is_active = 0, effective_until = ? WHERE id = ?').run(now, id);

  // Log
  db.prepare(`
    INSERT INTO policy_history (id, policy_id, action, old_version, changed_by, changed_at, reason)
    VALUES (?, ?, 'deactivated', ?, ?, ?, ?)
  `).run(
    `ph_${now}_${Math.random().toString(36).substr(2, 9)}`,
    id, existing.version, req.admin.id, now, reason || 'Deactivated'
  );

  // Audit
  db.prepare(`
    INSERT INTO audit_log (id, type, admin_id, data, created_at)
    VALUES (?, 'policy_deleted', ?, ?, ?)
  `).run(
    `audit_${now}_${Math.random().toString(36).substr(2, 9)}`,
    req.admin.id,
    JSON.stringify({ policyId: id, reason }),
    now
  );

  res.json({ success: true, message: 'Policy deactivated' });
});

/**
 * GET /api/policies/:id/history
 * Get policy change history
 */
router.get('/:id/history', requireAdmin, (req, res) => {
  const history = db.prepare(`
    SELECT ph.*, a.name as changed_by_name
    FROM policy_history ph
    LEFT JOIN admins a ON ph.changed_by = a.id
    WHERE ph.policy_id = ?
    ORDER BY ph.changed_at DESC
  `).all(req.params.id);

  res.json(history.map(h => ({
    ...h,
    old_rules: h.old_rules ? JSON.parse(h.old_rules) : null,
    new_rules: h.new_rules ? JSON.parse(h.new_rules) : null
  })));
});

module.exports = router;
