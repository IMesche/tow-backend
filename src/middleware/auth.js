/**
 * TOW Backend - Authentication Middleware
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'tow-dev-secret-change-in-production';

/**
 * Verify JWT token for admin routes
 */
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided', code: 'NO_TOKEN' });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
  }
}

/**
 * Optional auth - attach admin if token present but don't require
 */
function optionalAdmin(req, res, next) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      req.admin = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      // Token invalid but not required
    }
  }

  next();
}

/**
 * Check if admin has specific permission
 */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.admin) {
      return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    }

    const perms = req.admin.permissions || [];

    if (perms.includes('*') || perms.includes(permission)) {
      return next();
    }

    return res.status(403).json({ error: 'Permission denied', code: 'FORBIDDEN' });
  };
}

/**
 * Generate JWT token
 */
function generateToken(admin) {
  return jwt.sign(
    {
      id: admin.id,
      email: admin.email,
      role: admin.role,
      permissions: JSON.parse(admin.permissions || '[]')
    },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

module.exports = {
  requireAdmin,
  optionalAdmin,
  requirePermission,
  generateToken,
  JWT_SECRET
};
