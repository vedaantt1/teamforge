import { createApp } from './app.js';
import express from 'express';
import { existsSync } from 'node:fs';
const { app } = createApp({ rateLimit: process.env.RATE_LIMIT !== 'off', dbPath: process.env.DB_PATH || './data.db', staticMw: existsSync('web/dist') ? express.static('web/dist') : null });
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening on ${port}`));
