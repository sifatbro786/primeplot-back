// Runs before every test file — BEFORE app modules import #config/env.js.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
// Real URI is injected by tests/helpers/db.js (mongoose.connect); env only needs a valid shape.
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:1/primeplot-test';
process.env.AUTH_SECRET = 'test-secret-test-secret-test-secret-0123456789';
process.env.CLIENT_URL = 'http://localhost:3000';
process.env.JOBS_ENABLED = 'false';
process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'pp-uploads-'));
process.env.PUBLIC_MEDIA_BASE_URL = 'http://localhost:5030/uploads';
