# 🚀 Multi-SaaS Production Platform

**13 Microservices. One Deploy. Zero Downtime.**

A production-ready multi-tenant SaaS platform with 13+ microservices deployed on Railway, Vercel, and Supabase.

## 📊 Architecture

```
Frontend (Vercel)
    ↓
API Gateway (Railway Port 3000)
    ↓
13 Microservices (Railway)
    ├─ Accounting (3001)
    ├─ CRM (3002)
    ├─ Inventory (3003)
    ├─ Chatbot (3004)
    ├─ Video (3005)
    ├─ Scheduler (3006)
    ├─ HR (3007)
    ├─ Social Media (3008)
    ├─ WebSocket (3009)
    ├─ Analytics (3010)
    ├─ Integration (3011)
    ├─ Worker
    └─ More...
    ↓
Supabase (Multi-tenant Database)
```

## 🚀 Quick Start

### 1. Setup Environment
```bash
cp .env.example .env
# Edit .env with your Supabase credentials
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Run Locally
```bash
docker-compose up -d
```

### 4. Deploy to Production
```bash
npm run deploy
```

## 📦 Services Overview

| Service | Port | Type | Purpose |
|---------|------|------|---------|
| api-gateway | 3000 | Public | Router & reverse proxy |
| accounting-service | 3001 | Internal | Invoices, expenses, reports |
| crm-service | 3002 | Internal | Contacts, deals, pipelines |
| inventory-service | 3003 | Internal | Items, stock, tracking |
| chatbot-service | 3004 | Internal | AI chat, support |
| video-service | 3005 | Internal | Video conferencing, WebRTC |
| scheduler-service | 3006 | Internal | Appointments, calendars |
| hr-service | 3007 | Internal | Payroll, benefits, employees |
| social-media-service | 3008 | Internal | Social scheduling |
| websocket-service | 3009 | Internal | Real-time updates |
| analytics-service | 3010 | Internal | Metrics, reporting |
| integration-service | 3011 | Internal | 3rd party APIs, webhooks |
| worker | none | Internal | Async jobs, queues, cron |

## 🗄️ Database Schema

All data is stored in Supabase with multi-tenant isolation via `tenant_id`:

- **Public Schema**: Tenants, Users
- **Accounting**: Invoices, Expenses
- **CRM**: Contacts, Deals
- **Inventory**: Items, Stock
- More schemas per service

## 🔐 Security

- ✅ Row-Level Security (RLS) on all tables
- ✅ Multi-tenant isolation by tenant_id
- ✅ JWT authentication
- ✅ HTTPS/SSL on all endpoints
- ✅ Helmet.js for HTTP headers
- ✅ CORS protection

## 📈 Monitoring

- **Railway Dashboard**: CPU, memory, logs
- **Sentry**: Error tracking
- **Supabase**: Database performance
- **Vercel**: Frontend metrics

## 💰 Cost

- **Supabase**: FREE ($0-25/mo)
- **Railway**: $5-20/mo (all 13 services)
- **Vercel**: FREE ($0-20/mo)
- **Total**: $5-20/mo

## 🚢 Deployment

### GitHub Actions
Automatically deploys on `git push main`:
1. Run tests
2. Build all services
3. Deploy to Railway (backend)
4. Deploy to Vercel (frontend)

### Manual Deploy
```bash
railway deploy
vercel deploy --prod
```

## 📡 API Usage

```bash
# Get invoices
curl https://api.get-ly.com/api/accounting/invoices \
  -H "x-tenant-id: accounting"

# Get contacts
curl https://api.get-ly.com/api/crm/contacts \
  -H "x-tenant-id: crm"

# Service health
curl https://api.get-ly.com/health
curl https://api.get-ly.com/status
```

## 🛠️ Development

### Local Testing
```bash
# Start local services
docker-compose up

# Test API Gateway
curl http://localhost:3000/health

# Test accounting service
curl http://localhost:3001/invoices \
  -H "x-tenant-id: accounting"
```

### Adding New Services
1. Create `backend/services/[service-name]`
2. Add `server.js` and `package.json`
3. Create Dockerfile
4. Update `.github/workflows/deploy.yml`
5. Push to main

## 📚 Documentation

- [Architecture Guide](./docs/ARCHITECTURE.md)
- [API Reference](./docs/API.md)
- [Deployment Guide](./docs/DEPLOYMENT.md)

## 🤝 Contributing

1. Create feature branch: `git checkout -b feature/feature-name`
2. Commit: `git commit -m "feat: description"`
3. Push: `git push origin feature/feature-name`
4. Create Pull Request

## 📝 License

MIT

---

**Built with ❤️ using Node.js, Next.js, Supabase, and Railway**
