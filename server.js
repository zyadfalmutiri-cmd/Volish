const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Mount the existing Vercel-style API handlers
app.post('/api/turn', require('./api/turn'));
app.post('/api/analyze', require('./api/analyze'));
app.post('/api/plan', require('./api/plan'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Volish server running on port ${PORT}`);
});
