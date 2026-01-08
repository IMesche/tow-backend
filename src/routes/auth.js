/**
 * TOW Backend - Auth Routes
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../models/db');
const { generateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/auth/login
 * Admin login
 */
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required', code: 'MISSING_FIELDS' });
  }

  const admin = db.prepare('SELECT * FROM admins WHERE email = ? AND is_active = 1').get(email);

  if (!admin) {
    return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
  }

  const validPassword = bcrypt.compareSync(password, admin.password_hash);
  if (!validPassword) {
    return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
  }

  // Update last login
  db.prepare('UPDATE admins SET last_login = ? WHERE id = ?').run(Date.now(), admin.id);

  const token = generateToken(admin);

  res.json({
    token,
    admin: {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      permissions: JSON.parse(admin.permissions || '[]')
    }
  });
});

/**
 * GET /api/auth/me
 * Get current admin info
 */
router.get('/me', requireAdmin, (req, res) => {
  const admin = db.prepare('SELECT id, email, name, role, permissions, created_at, last_login FROM admins WHERE id = ?').get(req.admin.id);

  if (!admin) {
    return res.status(404).json({ error: 'Admin not found', code: 'NOT_FOUND' });
  }

  res.json({
    ...admin,
    permissions: JSON.parse(admin.permissions || '[]')
  });
});

/**
 * POST /api/auth/logout
 * Logout (client-side token removal, but log it)
 */
router.post('/logout', requireAdmin, (req, res) => {
  // Log the logout
  db.prepare(`
    INSERT INTO audit_log (id, type, admin_id, data, created_at)
    VALUES (?, 'logout', ?, ?, ?)
  `).run(
    `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    req.admin.id,
    JSON.stringify({ timestamp: Date.now() }),
    Date.now()
  );

  res.json({ success: true });
});

module.exports = router;
