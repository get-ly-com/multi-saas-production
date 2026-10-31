# 🚀 Multi-SaaS Deployment Guide

Complete step-by-step guide to deploy your 13-microservice platform.

## Prerequisites

- GitHub account (https://github.com)
- Supabase account (https://supabase.com)
- Railway account (already created: `multi-saas-production`)
- Vercel account (already created: `multi-saas-frontend`)
- `gh` CLI installed (`brew install gh` on Mac, `choco install gh` on Windows)

## Phase 1: GitHub Setup (5 min)

### 1.1 Authenticate GitHub CLI

```bash
gh auth login
# Follow prompts:
# - Select: GitHub.com
# - Select: HTTPS
# - Authenticate: Paste your GitHub token or login
```

Get your token: https://github.com/settings/tokens/new (create "public_repo" scope)

### 1.2 Create Repository

```bash
cd /path/to/multi-saas
gh repo create multi-saas-production --public --description "13 Microservices Multi-SaaS Platform"
```

### 1.3 Push Code

```bash
git remote add origin https://github.com/YOUR_USERNAME/multi-saas-production.git
git branch -M main
git push -u origin main
```

**Result:** Code is now on GitHub at `https://github.com/YOUR_USERNAME/multi-saas-production`

---

## Phase 2: Supabase Setup (10 min)

### 2.1 Create Supabase Project

1. Go to https://supabase.com
2. Click "New Project"
3. Select your organization
4. Project name: `multi-saas-prod`
5. Database password: Generate strong password
6. Region: `us-east-1`
7. Click "Create new project" (wait 2-3 min for deployment)

### 2.2 Run Database Schema

1. Go to Supabase Dashboard → SQL Editor
2. Click "New query"
3. Copy-paste entire contents of `supabase-schema.sql`
4. Click "Run" (or Cmd+Enter)
5. Wait for ✅ "Success"

### 2.3 Get Credentials

In Supabase Dashboard:

1. **Settings → API**
   - Copy: `Project URL` → `SUPABASE_URL`
   - Copy: `service_role key` → `SUPABASE_SERVICE_KEY`
   - Copy: `anon public key` → `SUPABASE_ANON_KEY`

2. Create `.env.production` in project root:

```bash
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyxxxxx
SUPABASE_ANON_KEY=eyxxxxx
JWT_SECRET=xxxxx
NODE_ENV=production
```

---

## Phase 3: Railway Configuration (10 min)

### 3.1 Connect GitHub to Railway

1. Go to https://railway.app/dashboard
2. Click on `multi-saas-production` project
3. Click "Settings" → "Integrations"
4. Click "Connect GitHub"
5. Authorize Railway with GitHub
6. Select repo: `YOUR_USERNAME/multi-saas-production`

### 3.2 Configure Environment Variables

For each service, set variables:

```bash
# Go to: Railway Dashboard → multi-saas-production → Variables

# Global variables (all services inherit):
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyxxxxx
NODE_ENV=production
LOG_LEVEL=info

# Service-specific ports are auto-configured
```

### 3.3 Configure Services

Railway will auto-detect services. Configure each:

1. **api-gateway**
   - Port: 3000
   - Root Directory: `backend/services/api-gateway`
   - Build: `npm install`
   - Start: `npm start`

2. **accounting-service**
   - Port: 3001
   - Root: `backend/services/accounting-service`

(Repeat for all 13 services)

### 3.4 Enable Auto-Deploy

1. Railway → multi-saas-production → Settings → Builds
2. Toggle: "Auto Deploy" → ON
3. Trigger: "On push to main branch"

**Result:** Every `git push main` triggers deployment!

---

## Phase 4: Vercel Configuration (10 min)

### 4.1 Connect GitHub to Vercel

1. Go to https://vercel.com/dashboard
2. Click on `multi-saas-frontend` project
3. Click "Settings" → "Git"
4. Click "Connect Git"
5. Select repo: `YOUR_USERNAME/multi-saas-production`

### 4.2 Configure Root Directory

1. Vercel → multi-saas-frontend → Settings
2. Root Directory: `frontend`
3. Build Command: `npm run build`
4. Install Command: `npm install`
5. Development Command: `npm run dev`

### 4.3 Set Environment Variables

Vercel Dashboard → Settings → Environment Variables:

```bash
NEXT_PUBLIC_API_BASE_URL=https://api.YOUR_RAILWAY_URL.railway.app
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyxxxxx
```

Get Railway API Gateway URL:
- Railway → multi-saas-production → api-gateway → Copy deployment URL

### 4.4 Enable Auto-Deploy

1. Vercel → multi-saas-frontend → Settings → Deployments
2. Auto-deploy: "On every push to main"

**Result:** Every `git push main` deploys frontend!

---

## Phase 5: DNS Configuration (15 min)

### 5.1 Get Deployment URLs

**Railway (API Gateway):**
- Railway Dashboard → multi-saas-production → api-gateway
- Copy the public URL (e.g., `api-xxxxx.railway.app`)

**Vercel (Frontend):**
- Vercel Dashboard → multi-saas-frontend → Domains
- Copy the Vercel URL

### 5.2 Update DNS Records

At your domain registrar (Namecheap, GoDaddy, etc.):

#### For get-ly.com (example):

**A Record (Frontend):**
- Name: `@` (or your domain)
- Type: `A`
- Value: Vercel IP (get from Vercel dashboard)
- TTL: 3600

**CNAME Record (API):**
- Name: `api`
- Type: `CNAME`
- Value: `api-xxxxx.railway.app`
- TTL: 3600

**Wait 15-30 minutes** for DNS propagation.

### 5.3 Verify DNS

```bash
nslookup get-ly.com
nslookup api.get-ly.com
```

---

## Phase 6: Testing (10 min)

### 6.1 Test Frontend

```bash
curl https://get-ly.com
# Should return your Next.js app
```

### 6.2 Test API Gateway

```bash
curl https://api.get-ly.com/health
# Expected: { "status": "ok", "services": 13 }
```

### 6.3 Test Individual Services

```bash
# Accounting Service
curl https://api.get-ly.com/api/accounting/invoices \
  -H "x-tenant-id: accounting"

# CRM Service
curl https://api.get-ly.com/api/crm/contacts \
  -H "x-tenant-id: crm"

# Status of all services
curl https://api.get-ly.com/status
```

---

## Phase 7: Monitoring & Next Steps

### 7.1 Monitor Deployments

- **Railway:** https://railway.app/dashboard → Logs, Metrics
- **Vercel:** https://vercel.com/dashboard → Deployments, Analytics
- **Supabase:** https://supabase.com → Database, Logs

### 7.2 Setup Monitoring (Optional)

Add error tracking:
```bash
# Install Sentry
npm install @sentry/node

# Add to services (see backend/services/accounting-service/server.js)
```

### 7.3 Scale Services (When Needed)

**Railway:**
- Click service → Settings → Resources
- Increase CPU/Memory or replicas

**Vercel:**
- Switch to Pro plan for faster builds

**Supabase:**
- Upgrade to Pro ($25/mo) when exceeding 500MB

---

## ✅ Success Checklist

- [ ] Code pushed to GitHub
- [ ] Supabase project created with schema
- [ ] Railway project connected to GitHub
- [ ] Vercel project connected to GitHub
- [ ] Environment variables set (Railway & Vercel)
- [ ] DNS records configured
- [ ] Frontend loads at your domain
- [ ] API Gateway responds to `/health`
- [ ] Individual services responding
- [ ] Auto-deploy working (test with git push)

---

## 🚨 Troubleshooting

### "Railway deployment failing"
→ Check logs: Railway → multi-saas-production → Logs
→ Verify environment variables are set
→ Check service build command

### "Vercel build failing"
→ Vercel → multi-saas-frontend → Deployments → Logs
→ Verify root directory is `frontend`
→ Check Next.js build command

### "API returning 503"
→ Service might be starting up, wait 30 seconds
→ Check Railway service logs
→ Verify SUPABASE_URL and keys are correct

### "DNS not resolving"
→ Wait 30 minutes for propagation
→ Verify DNS records in registrar
→ Use: `nslookup your-domain.com`

---

## 📞 Support

- **Railway Docs:** https://docs.railway.app
- **Vercel Docs:** https://vercel.com/docs
- **Supabase Docs:** https://supabase.com/docs
- **Next.js Docs:** https://nextjs.org/docs

---

**Estimated Total Time: 1 hour**

After completion, you'll have:
- ✅ 13 microservices running on Railway
- ✅ Next.js frontend on Vercel
- ✅ Multi-tenant database on Supabase
- ✅ Auto-deployment on every git push
- ✅ Production-ready infrastructure
- ✅ $5-20/month total cost
