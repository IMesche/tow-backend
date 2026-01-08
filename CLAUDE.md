# TOW Backend

## Deployment

**Auto-deploy:** Push to GitHub → Render auto-deploys

```bash
cd /home/ingo/TOW/tow-web-full/tools/TOW_backend
git add -A && git commit -m "message" && git push
```

**Live URL:** https://tow-backend-ucyu.onrender.com

**GitHub:** https://github.com/IMesche/tow-backend

**GitHub Token:** (stored locally, not in repo)

**Render Dashboard:** https://dashboard.render.com

## Tech Stack

- Node.js + Express
- SQLite (better-sqlite3)
- JWT authentication

## API Endpoints

- `/api/auth/*` - Authentication
- `/api/economy/*` - Economy metrics
- `/api/alerts/*` - Alert system
- `/api/ai/*` - AI recommendations
- `/api/escrows/*` - Escrow management
- `/api/users/*` - User management
- `/api/policies/*` - Policy management
- `/api/locations/*` - Location management
- `/api/templates/*` - Item templates
- `/api/audit/*` - Audit logs
- `/api/metrics/*` - Metrics

## Local Development

```bash
npm install
npm run init-db
npm run seed
npm start
```

Runs on http://localhost:3500

## Note

Free Render tier spins down after inactivity - first request after idle takes ~50s.
