require('dotenv').config();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3007;

app.use(express.json());
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'hr-service' }));

app.get('/employees', (req, res) => res.json([]));
app.post('/employees', (req, res) => res.status(201).json({ id: '1', ...req.body }));
app.get('/payroll', (req, res) => res.json({ employees: 0, totalPayroll: 0 }));

app.listen(PORT, () => console.log(`👔 HR Service on ${PORT}`));
