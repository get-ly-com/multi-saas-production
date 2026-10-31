require('dotenv').config();
const express = require('express');
const httpProxy = require('express-http-proxy');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Tenant ID extraction middleware
app.use((req, res, next) => {
  req.tenantId = req.headers['x-tenant-id'] || 'default';
  next();
});

// Service routing - internal services
const serviceRoutes = [
  { path: '/api/accounting', service: 'accounting-service', port: 3001 },
  { path: '/api/crm', service: 'crm-service', port: 3002 },
  { path: '/api/inventory', service: 'inventory-service', port: 3003 },
  { path: '/api/chatbot', service: 'chatbot-service', port: 3004 },
  { path: '/api/video', service: 'video-service', port: 3005 },
  { path: '/api/scheduler', service: 'scheduler-service', port: 3006 },
  { path: '/api/hr', service: 'hr-service', port: 3007 },
  { path: '/api/social-media', service: 'social-media-service', port: 3008 },
  { path: '/api/analytics', service: 'analytics-service', port: 3010 },
  { path: '/api/integration', service: 'integration-service', port: 3011 },
];

// Setup proxies
serviceRoutes.forEach(({ path, service, port }) => {
  const serviceUrl = process.env.NODE_ENV === 'production'
    ? `http://${service}:${port}`
    : `http://localhost:${port}`;

  app.use(path, httpProxy(serviceUrl, {
    proxyReqPathResolver: (req) => req.url,
    proxyErrorHandler: (err, res, next) => {
      console.error(`[ERROR] ${service}: ${err.message}`);
      res.status(503).json({ error: `${service} unavailable` });
    }
  }));
});

// WebSocket proxy (if needed)
app.use('/ws', httpProxy('http://websocket-service:3009', {
  ws: true
}));

// Health checks
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: 13
  });
});

// Service status endpoint
app.get('/status', async (req, res) => {
  const statuses = {};

  for (const { service, port } of serviceRoutes) {
    try {
      const response = await fetch(
        `http://${process.env.NODE_ENV === 'production' ? service : 'localhost'}:${port}/health`,
        { timeout: 2000 }
      );
      statuses[service] = response.ok ? 'up' : 'down';
    } catch {
      statuses[service] = 'down';
    }
  }

  res.json(statuses);
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    method: req.method
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 API Gateway running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Proxying to 13 microservices`);
});

module.exports = app;
