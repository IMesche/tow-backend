/**
 * TOW Backend - Item Templates API
 *
 * CRUD operations for item templates.
 * Templates define the blueprint for items (stats, assets, restrictions, royalties).
 *
 * Endpoints:
 *   GET    /api/templates         - List all templates (with filters)
 *   GET    /api/templates/:id     - Get single template
 *   POST   /api/templates         - Create new template
 *   PUT    /api/templates/:id     - Update template
 *   DELETE /api/templates/:id     - Delete template (soft delete)
 *   POST   /api/templates/:id/publish - Publish draft template
 */

const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const db = require('../models/db');

// ============================================
// GET /api/templates
// List templates with optional filters
// ============================================
router.get('/', requireAuth, async (req, res, next) => {
    try {
        const { layer, category, status, search, limit = 100, offset = 0 } = req.query;

        let templates = await db.getTemplates();

        // Apply filters
        if (layer && layer !== 'all') {
            templates = templates.filter(t => t.layer === layer);
        }

        if (category && category !== 'all') {
            templates = templates.filter(t => t.category === category);
        }

        if (status) {
            templates = templates.filter(t => t.status === status);
        }

        if (search) {
            const searchLower = search.toLowerCase();
            templates = templates.filter(t =>
                t.name?.toLowerCase().includes(searchLower) ||
                t.id?.toLowerCase().includes(searchLower) ||
                t.description?.toLowerCase().includes(searchLower)
            );
        }

        // Sort by name
        templates.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        // Pagination
        const total = templates.length;
        templates = templates.slice(parseInt(offset), parseInt(offset) + parseInt(limit));

        res.json({
            templates,
            total,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (error) {
        next(error);
    }
});

// ============================================
// GET /api/templates/:id
// Get single template by ID
// ============================================
router.get('/:id', requireAuth, async (req, res, next) => {
    try {
        const template = await db.getTemplate(req.params.id);

        if (!template) {
            return res.status(404).json({
                error: 'Template not found',
                code: 'TEMPLATE_NOT_FOUND'
            });
        }

        res.json(template);
    } catch (error) {
        next(error);
    }
});

// ============================================
// POST /api/templates
// Create new template (requires admin or creator role)
// ============================================
router.post('/', requireAuth, requireRole(['admin', 'creator']), async (req, res, next) => {
    try {
        const templateData = req.body;

        // Validate required fields
        if (!templateData.id) {
            return res.status(400).json({
                error: 'Template ID is required',
                code: 'MISSING_ID'
            });
        }

        if (!templateData.name) {
            return res.status(400).json({
                error: 'Template name is required',
                code: 'MISSING_NAME'
            });
        }

        // Validate ID format (lowercase, alphanumeric, underscores)
        if (!/^[a-z0-9_]+$/.test(templateData.id)) {
            return res.status(400).json({
                error: 'Template ID must be lowercase with underscores only',
                code: 'INVALID_ID_FORMAT'
            });
        }

        // Check for duplicate ID
        const existing = await db.getTemplate(templateData.id);
        if (existing) {
            return res.status(409).json({
                error: 'Template ID already exists',
                code: 'DUPLICATE_ID'
            });
        }

        // Validate age rating
        if (templateData.ageRating !== undefined) {
            const validRatings = [0, 7, 12, 16, 18];
            if (!validRatings.includes(templateData.ageRating)) {
                return res.status(400).json({
                    error: 'Invalid age rating. Must be 0, 7, 12, 16, or 18',
                    code: 'INVALID_AGE_RATING'
                });
            }
        }

        // Set defaults and metadata
        const template = {
            ...templateData,
            status: templateData.status || 'draft',
            createdAt: Date.now(),
            createdBy: req.user.id,
            updatedAt: Date.now(),
            updatedBy: req.user.id,
            version: 1
        };

        await db.createTemplate(template);

        // Log audit event
        await db.logAudit({
            action: 'template.create',
            userId: req.user.id,
            targetId: template.id,
            details: { name: template.name, category: template.category }
        });

        res.status(201).json(template);
    } catch (error) {
        next(error);
    }
});

// ============================================
// PUT /api/templates/:id
// Update template (requires admin or creator role)
// ============================================
router.put('/:id', requireAuth, requireRole(['admin', 'creator']), async (req, res, next) => {
    try {
        const templateId = req.params.id;
        const updates = req.body;

        // Get existing template
        const existing = await db.getTemplate(templateId);
        if (!existing) {
            return res.status(404).json({
                error: 'Template not found',
                code: 'TEMPLATE_NOT_FOUND'
            });
        }

        // Don't allow changing ID
        if (updates.id && updates.id !== templateId) {
            return res.status(400).json({
                error: 'Cannot change template ID',
                code: 'CANNOT_CHANGE_ID'
            });
        }

        // Validate age rating if provided
        if (updates.ageRating !== undefined) {
            const validRatings = [0, 7, 12, 16, 18];
            if (!validRatings.includes(updates.ageRating)) {
                return res.status(400).json({
                    error: 'Invalid age rating. Must be 0, 7, 12, 16, or 18',
                    code: 'INVALID_AGE_RATING'
                });
            }
        }

        // Merge updates
        const template = {
            ...existing,
            ...updates,
            id: templateId, // Ensure ID doesn't change
            updatedAt: Date.now(),
            updatedBy: req.user.id,
            version: (existing.version || 0) + 1
        };

        await db.updateTemplate(templateId, template);

        // Log audit event
        await db.logAudit({
            action: 'template.update',
            userId: req.user.id,
            targetId: templateId,
            details: { changes: Object.keys(updates) }
        });

        res.json(template);
    } catch (error) {
        next(error);
    }
});

// ============================================
// DELETE /api/templates/:id
// Soft delete template (requires admin role)
// ============================================
router.delete('/:id', requireAuth, requireRole(['admin']), async (req, res, next) => {
    try {
        const templateId = req.params.id;

        const existing = await db.getTemplate(templateId);
        if (!existing) {
            return res.status(404).json({
                error: 'Template not found',
                code: 'TEMPLATE_NOT_FOUND'
            });
        }

        // Soft delete (mark as deleted)
        const template = {
            ...existing,
            status: 'deleted',
            deletedAt: Date.now(),
            deletedBy: req.user.id
        };

        await db.updateTemplate(templateId, template);

        // Log audit event
        await db.logAudit({
            action: 'template.delete',
            userId: req.user.id,
            targetId: templateId,
            details: { name: existing.name }
        });

        res.json({ success: true, message: 'Template deleted' });
    } catch (error) {
        next(error);
    }
});

// ============================================
// POST /api/templates/:id/publish
// Publish a draft template (requires admin role)
// ============================================
router.post('/:id/publish', requireAuth, requireRole(['admin']), async (req, res, next) => {
    try {
        const templateId = req.params.id;

        const existing = await db.getTemplate(templateId);
        if (!existing) {
            return res.status(404).json({
                error: 'Template not found',
                code: 'TEMPLATE_NOT_FOUND'
            });
        }

        if (existing.status === 'published') {
            return res.status(400).json({
                error: 'Template is already published',
                code: 'ALREADY_PUBLISHED'
            });
        }

        // Validate template has required fields for publishing
        if (!existing.name || !existing.category || !existing.layer) {
            return res.status(400).json({
                error: 'Template must have name, category, and layer to be published',
                code: 'INCOMPLETE_TEMPLATE'
            });
        }

        // Publish
        const template = {
            ...existing,
            status: 'published',
            publishedAt: Date.now(),
            publishedBy: req.user.id
        };

        await db.updateTemplate(templateId, template);

        // Log audit event
        await db.logAudit({
            action: 'template.publish',
            userId: req.user.id,
            targetId: templateId,
            details: { name: existing.name }
        });

        res.json(template);
    } catch (error) {
        next(error);
    }
});

// ============================================
// GET /api/templates/:id/instances
// Get instances of a template (items minted from it)
// ============================================
router.get('/:id/instances', requireAuth, async (req, res, next) => {
    try {
        const templateId = req.params.id;
        const { limit = 50, offset = 0 } = req.query;

        const template = await db.getTemplate(templateId);
        if (!template) {
            return res.status(404).json({
                error: 'Template not found',
                code: 'TEMPLATE_NOT_FOUND'
            });
        }

        // Get items with this templateId
        const instances = await db.getItemsByTemplate(templateId);

        const total = instances.length;
        const paginated = instances.slice(parseInt(offset), parseInt(offset) + parseInt(limit));

        res.json({
            templateId,
            instances: paginated,
            total,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (error) {
        next(error);
    }
});

// ============================================
// GET /api/templates/stats
// Get template statistics
// ============================================
router.get('/stats/summary', requireAuth, async (req, res, next) => {
    try {
        const templates = await db.getTemplates();

        const stats = {
            total: templates.length,
            byStatus: {},
            byLayer: {},
            byCategory: {},
            byAgeRating: {}
        };

        templates.forEach(t => {
            // By status
            const status = t.status || 'draft';
            stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;

            // By layer
            if (t.layer) {
                stats.byLayer[t.layer] = (stats.byLayer[t.layer] || 0) + 1;
            }

            // By category
            if (t.category) {
                stats.byCategory[t.category] = (stats.byCategory[t.category] || 0) + 1;
            }

            // By age rating
            const ageRating = t.ageRating || 0;
            stats.byAgeRating[ageRating] = (stats.byAgeRating[ageRating] || 0) + 1;
        });

        res.json(stats);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
