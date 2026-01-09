/**
 * TOW Backend API Server
 * Serves both Admin and Phone apps
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

// Import routes
const authRoutes = require('./routes/auth');
const policyRoutes = require('./routes/policies');
const economyRoutes = require('./routes/economy');
const usersRoutes = require('./routes/users');
const escrowRoutes = require('./routes/escrows');
const alertsRoutes = require('./routes/alerts');
const aiRoutes = require('./routes/ai');
const locationsRoutes = require('./routes/locations');
const auditRoutes = require('./routes/audit');
const metricsRoutes = require('./routes/metrics');
const templatesRoutes = require('./routes/templates');
const questsRoutes = require('./routes/quests');
const osmRoutes = require('./routes/osm');

const app = express();
const PORT = process.env.PORT || 3500;

// ============================================
// Middleware
// ============================================
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:8080', 'https://www.vrtron.com', 'https://vrtron.com'],
  credentials: true
}));

app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ============================================
// Health Check
// ============================================
const healthResponse = (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    version: '1.0.0',
    services: {
      database: 'connected',
      api: 'running'
    }
  });
};
app.get('/health', healthResponse);
app.get('/api/health', healthResponse);

// ============================================
// API Routes
// ============================================
app.use('/api/auth', authRoutes);
app.use('/api/policies', policyRoutes);
app.use('/api/economy', economyRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/escrows', escrowRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/locations', locationsRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/templates', templatesRoutes);
app.use('/api/item-templates', templatesRoutes);  // Alias for admin client
app.use('/api/quests', questsRoutes);
app.use('/api/osm', osmRoutes);

// ============================================
// Error Handler
// ============================================
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    code: err.code || 'INTERNAL_ERROR'
  });
});

// ============================================
// 404 Handler
// ============================================
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    code: 'NOT_FOUND'
  });
});

// ============================================
// Start Server
// ============================================
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║         TOW Backend API Server           ║
╠══════════════════════════════════════════╣
║  Status:  Running                        ║
║  Port:    ${PORT}                           ║
║  Time:    ${new Date().toISOString()}     ║
╚══════════════════════════════════════════╝
  `);
  console.log('Available endpoints:');
  console.log('  GET  /health');
  console.log('  POST /api/auth/login');
  console.log('  GET  /api/policies');
  console.log('  GET  /api/economy/metrics');
  console.log('  GET  /api/users');
  console.log('  GET  /api/escrows');
  console.log('  GET  /api/alerts');
  console.log('  GET  /api/ai/recommendations');
  console.log('  GET  /api/locations');
  console.log('  GET  /api/audit');
  console.log('  GET  /api/metrics/daily');
  console.log('  GET  /api/templates');
  console.log('  POST /api/templates');
  console.log('');
});

module.exports = app;
