/**
 * TOW Backend - Quests API Routes
 * CRUD operations for quest management
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { requireAdmin, optionalAdmin } = require('../middleware/auth');

// ============================================
// Quest Routes
// ============================================

/**
 * GET /api/quests - List all quests
 * Query params: status, author_id, is_public, limit, offset
 */
router.get('/', optionalAdmin, (req, res) => {
    try {
        const { status, author_id, is_public, limit = 50, offset = 0 } = req.query;

        let sql = 'SELECT * FROM quests WHERE deleted_at IS NULL';
        const params = [];

        if (status) {
            sql += ' AND status = ?';
            params.push(status);
        }

        if (author_id) {
            sql += ' AND author_id = ?';
            params.push(author_id);
        }

        if (is_public !== undefined) {
            sql += ' AND is_public = ?';
            params.push(is_public === 'true' || is_public === '1' ? 1 : 0);
        }

        sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const quests = db.prepare(sql).all(...params);

        // Parse JSON fields
        const parsed = quests.map(q => ({
            ...q,
            data: q.data ? JSON.parse(q.data) : null,
            world: q.world ? JSON.parse(q.world) : null,
            metadata: q.metadata ? JSON.parse(q.metadata) : null,
            tags: q.tags ? q.tags.split(',').filter(Boolean) : []
        }));

        res.json(parsed);
    } catch (error) {
        console.error('Error listing quests:', error);
        res.status(500).json({ error: 'Failed to list quests' });
    }
});

/**
 * GET /api/quests/:id - Get single quest
 */
router.get('/:id', optionalAdmin, (req, res) => {
    try {
        const quest = db.prepare('SELECT * FROM quests WHERE id = ? AND deleted_at IS NULL').get(req.params.id);

        if (!quest) {
            return res.status(404).json({ error: 'Quest not found' });
        }

        // Parse JSON fields
        const parsed = {
            ...quest,
            data: quest.data ? JSON.parse(quest.data) : null,
            world: quest.world ? JSON.parse(quest.world) : null,
            metadata: quest.metadata ? JSON.parse(quest.metadata) : null,
            tags: quest.tags ? quest.tags.split(',').filter(Boolean) : []
        };

        res.json(parsed);
    } catch (error) {
        console.error('Error getting quest:', error);
        res.status(500).json({ error: 'Failed to get quest' });
    }
});

/**
 * POST /api/quests - Create new quest
 */
router.post('/', optionalAdmin, (req, res) => {
    try {
        const {
            id,
            name,
            description,
            author_id,
            author_name,
            status = 'draft',
            data,
            world,
            metadata,
            tags,
            age_rating = 0,
            location_id,
            is_public = false
        } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Quest name is required' });
        }

        const questId = id || `quest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = Date.now();

        db.prepare(`
            INSERT INTO quests (id, name, description, author_id, author_name, status, version, data, world, metadata, tags, age_rating, location_id, is_public, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            questId,
            name,
            description || '',
            author_id || null,
            author_name || 'Anonymous',
            status,
            1,
            data ? JSON.stringify(data) : null,
            world ? JSON.stringify(world) : null,
            metadata ? JSON.stringify(metadata) : null,
            Array.isArray(tags) ? tags.join(',') : (tags || ''),
            age_rating,
            location_id || null,
            is_public ? 1 : 0,
            now,
            now
        );

        const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(questId);

        res.status(201).json({
            ...quest,
            data: quest.data ? JSON.parse(quest.data) : null,
            world: quest.world ? JSON.parse(quest.world) : null,
            metadata: quest.metadata ? JSON.parse(quest.metadata) : null,
            tags: quest.tags ? quest.tags.split(',').filter(Boolean) : []
        });
    } catch (error) {
        console.error('Error creating quest:', error);
        res.status(500).json({ error: 'Failed to create quest' });
    }
});

/**
 * PUT /api/quests/:id - Update quest
 */
router.put('/:id', optionalAdmin, (req, res) => {
    try {
        const existing = db.prepare('SELECT * FROM quests WHERE id = ? AND deleted_at IS NULL').get(req.params.id);

        if (!existing) {
            return res.status(404).json({ error: 'Quest not found' });
        }

        const {
            name,
            description,
            status,
            data,
            world,
            metadata,
            tags,
            age_rating,
            location_id,
            is_public
        } = req.body;

        const updates = [];
        const params = [];

        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (description !== undefined) { updates.push('description = ?'); params.push(description); }
        if (status !== undefined) { updates.push('status = ?'); params.push(status); }
        if (data !== undefined) { updates.push('data = ?'); params.push(JSON.stringify(data)); }
        if (world !== undefined) { updates.push('world = ?'); params.push(JSON.stringify(world)); }
        if (metadata !== undefined) { updates.push('metadata = ?'); params.push(JSON.stringify(metadata)); }
        if (tags !== undefined) { updates.push('tags = ?'); params.push(Array.isArray(tags) ? tags.join(',') : tags); }
        if (age_rating !== undefined) { updates.push('age_rating = ?'); params.push(age_rating); }
        if (location_id !== undefined) { updates.push('location_id = ?'); params.push(location_id); }
        if (is_public !== undefined) { updates.push('is_public = ?'); params.push(is_public ? 1 : 0); }

        // Always update version and timestamp
        updates.push('version = version + 1');
        updates.push('updated_at = ?');
        params.push(Date.now());

        params.push(req.params.id);

        db.prepare(`UPDATE quests SET ${updates.join(', ')} WHERE id = ?`).run(...params);

        const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(req.params.id);

        res.json({
            ...quest,
            data: quest.data ? JSON.parse(quest.data) : null,
            world: quest.world ? JSON.parse(quest.world) : null,
            metadata: quest.metadata ? JSON.parse(quest.metadata) : null,
            tags: quest.tags ? quest.tags.split(',').filter(Boolean) : []
        });
    } catch (error) {
        console.error('Error updating quest:', error);
        res.status(500).json({ error: 'Failed to update quest' });
    }
});

/**
 * DELETE /api/quests/:id - Soft delete quest
 */
router.delete('/:id', optionalAdmin, (req, res) => {
    try {
        const existing = db.prepare('SELECT * FROM quests WHERE id = ? AND deleted_at IS NULL').get(req.params.id);

        if (!existing) {
            return res.status(404).json({ error: 'Quest not found' });
        }

        db.prepare('UPDATE quests SET deleted_at = ? WHERE id = ?').run(Date.now(), req.params.id);

        res.json({ success: true, message: 'Quest deleted' });
    } catch (error) {
        console.error('Error deleting quest:', error);
        res.status(500).json({ error: 'Failed to delete quest' });
    }
});

/**
 * POST /api/quests/:id/publish - Publish quest
 */
router.post('/:id/publish', optionalAdmin, (req, res) => {
    try {
        const existing = db.prepare('SELECT * FROM quests WHERE id = ? AND deleted_at IS NULL').get(req.params.id);

        if (!existing) {
            return res.status(404).json({ error: 'Quest not found' });
        }

        db.prepare(`
            UPDATE quests SET status = 'published', is_public = 1, published_at = ?, updated_at = ? WHERE id = ?
        `).run(Date.now(), Date.now(), req.params.id);

        const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(req.params.id);

        res.json({
            ...quest,
            data: quest.data ? JSON.parse(quest.data) : null,
            world: quest.world ? JSON.parse(quest.world) : null,
            metadata: quest.metadata ? JSON.parse(quest.metadata) : null,
            tags: quest.tags ? quest.tags.split(',').filter(Boolean) : []
        });
    } catch (error) {
        console.error('Error publishing quest:', error);
        res.status(500).json({ error: 'Failed to publish quest' });
    }
});

/**
 * POST /api/quests/:id/duplicate - Duplicate quest
 */
router.post('/:id/duplicate', optionalAdmin, (req, res) => {
    try {
        const existing = db.prepare('SELECT * FROM quests WHERE id = ? AND deleted_at IS NULL').get(req.params.id);

        if (!existing) {
            return res.status(404).json({ error: 'Quest not found' });
        }

        const newId = `quest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = Date.now();
        const { new_name } = req.body;

        db.prepare(`
            INSERT INTO quests (id, name, description, author_id, author_name, status, version, data, world, metadata, tags, age_rating, location_id, is_public, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            newId,
            new_name || `${existing.name} (Copy)`,
            existing.description,
            existing.author_id,
            existing.author_name,
            'draft',
            1,
            existing.data,
            existing.world,
            existing.metadata,
            existing.tags,
            existing.age_rating,
            existing.location_id,
            0,
            now,
            now
        );

        const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(newId);

        res.status(201).json({
            ...quest,
            data: quest.data ? JSON.parse(quest.data) : null,
            world: quest.world ? JSON.parse(quest.world) : null,
            metadata: quest.metadata ? JSON.parse(quest.metadata) : null,
            tags: quest.tags ? quest.tags.split(',').filter(Boolean) : []
        });
    } catch (error) {
        console.error('Error duplicating quest:', error);
        res.status(500).json({ error: 'Failed to duplicate quest' });
    }
});

module.exports = router;
