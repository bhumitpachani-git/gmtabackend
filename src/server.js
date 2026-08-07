require('dotenv').config();
const express = require('express');
const cors = require('cors');
const analyzeRouter = require('./routes/analyze');
const leadsRouter = require('./routes/leads');
const growRouter = require('./routes/grow');
const pipelineRouter = require('./routes/pipeline');
const companySearchRouter = require('./routes/companySearch');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/', analyzeRouter);
app.use('/', leadsRouter);
app.use('/', growRouter);
app.use('/', pipelineRouter);
app.use('/', companySearchRouter);

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
