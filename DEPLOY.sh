#!/bin/bash

echo "🚀 Multi-SaaS Full Deployment Script"
echo "===================================="

# Step 1: Authenticate with GitHub
echo ""
echo "Step 1: Authenticating with GitHub..."
gh auth login -h github.com

# Step 2: Create GitHub repository
echo ""
echo "Step 2: Creating GitHub repository..."
REPO_NAME="multi-saas-production"
gh repo create $REPO_NAME --public --description "13 Microservices Multi-SaaS Platform" || echo "Repo might already exist"

# Step 3: Add remote and push
echo ""
echo "Step 3: Pushing code to GitHub..."
git remote add origin https://github.com/$(gh api user -q .login)/$REPO_NAME.git 2>/dev/null || git remote set-url origin https://github.com/$(gh api user -q .login)/$REPO_NAME.git
git branch -M main
git push -u origin main

# Step 4: Get repo URL
REPO_URL="https://github.com/$(gh api user -q .login)/$REPO_NAME"
echo ""
echo "✅ Repository created: $REPO_URL"

# Step 5: Configure Railway
echo ""
echo "Step 5: Configuring Railway..."
echo "Go to: https://railway.app/project/b8a72470-81f3-453f-b304-ddcb9e9b7c72/settings"
echo "Connect GitHub: $REPO_URL"

# Step 6: Configure Vercel
echo ""
echo "Step 6: Configuring Vercel..."
echo "Go to: https://vercel.com/dashboard/prj_vJRwUttRH7jjyg4k7mQPg1dNsjYp/settings"
echo "Connect GitHub: $REPO_URL (root: frontend/)"

# Step 7: Setup environment variables
echo ""
echo "Step 7: Setting up environment variables..."
echo "Add to Railway (multi-saas-production):"
echo "  SUPABASE_URL=<your-supabase-url>"
echo "  SUPABASE_SERVICE_KEY=<your-service-key>"
echo "  NODE_ENV=production"
echo ""
echo "Add to Vercel (multi-saas-frontend):"
echo "  NEXT_PUBLIC_API_BASE_URL=<your-railway-url>"
echo "  NEXT_PUBLIC_SUPABASE_URL=<your-supabase-url>"
echo "  NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>"

# Step 8: Supabase setup
echo ""
echo "Step 8: Setting up Supabase..."
echo "1. Go to supabase.com and create a new project"
echo "2. Run the SQL schema:"
echo "   cat supabase-schema.sql | psql <your-connection-string>"
echo "3. Copy your credentials"

echo ""
echo "✅ Deployment configuration complete!"
echo ""
echo "Monitor deployments:"
echo "  Railway: https://railway.app/dashboard"
echo "  Vercel: https://vercel.com/dashboard"
