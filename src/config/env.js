import { z } from 'zod';

// Node ≥ 24 loads .env natively — no dotenv. In production (PM2/VPS) real env vars win;
// a missing .env file is not an error. Tests never read .env (no real SMTP/DB by accident).
if (process.env.NODE_ENV !== 'test') {
  try {
    process.loadEnvFile();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// z.coerce.boolean() treats the string "false" as true — parse explicitly.
const bool = (def) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .default(def ? 'true' : 'false')
    .transform((v) => ['true', '1', 'yes'].includes(v));

const optionalStr = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional();

const csv = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5030),
  APP_NAME: z.string().default('PrimePlot'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Hops of trusted reverse proxies (Nginx = 1). Needed for correct client IP in rate limiting.
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),

  // Frontend origin(s) allowed by CORS (comma-separated). Browser traffic normally arrives
  // via the Next.js /api rewrite, so CORS mainly matters for Socket.IO and direct calls.
  CLIENT_URL: z.url().default('http://localhost:3000'),
  CORS_ORIGINS: csv.optional(),

  MONGODB_URI: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\//, 'MONGODB_URI must start with mongodb:// or mongodb+srv://'),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  // Single-tenant: which organization this deployment serves (slug). Empty = the only org in the DB.
  ORG_SLUG: optionalStr,
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().min(1).max(60).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  REFRESH_REMEMBER_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  // Hard cap on a login session no matter how often it is refreshed.
  SESSION_ABSOLUTE_TTL_DAYS: z.coerce.number().int().min(1).max(180).default(60),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(30).default(365),

  // Email (Nodemailer). Optional at boot; the email service reports disabled if missing.
  SMTP_HOST: optionalStr,
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_SECURE: bool(false),
  SMTP_USER: optionalStr,
  SMTP_PASS: optionalStr,
  SMTP_FROM: optionalStr,

  // Storage
  STORAGE_DRIVER: z.enum(['local']).default('local'),
  UPLOAD_DIR: z.string().default('uploads'),
  PUBLIC_MEDIA_BASE_URL: optionalStr,
  MEDIA_MAX_IMAGE_MB: z.coerce.number().positive().max(50).default(15),
  MEDIA_MAX_DOC_MB: z.coerce.number().positive().max(50).default(10),

  // Ops
  CRON_SECRET: optionalStr,
  JOBS_ENABLED: bool(true),
  JOB_TICK_MS: z.coerce.number().int().min(1000).default(30_000),
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),

  // SSLCommerz — feature disabled until both keys are present.
  SSLCZ_STORE_ID: optionalStr,
  SSLCZ_STORE_PASS: optionalStr,
  SSLCZ_IS_LIVE: bool(false),

  // SMS — `log` driver writes messages to the log instead of sending.
  SMS_DRIVER: z.enum(['log', 'bulksmsbd', 'sslwireless']).default('log'),
  SMS_API_KEY: optionalStr,
  SMS_SENDER_ID: optionalStr,
  SMS_API_USER: optionalStr,
  SMS_API_PASS: optionalStr,
});

// `KEY=` (empty) in .env means "not set" — let defaults/optional apply instead of failing
// (e.g. an empty SMTP_PORT would otherwise coerce to 0).
const raw = Object.fromEntries(
  Object.entries(process.env).map(([k, v]) => [k, v === '' ? undefined : v]),
);

const parsed = schema.safeParse(raw);

if (!parsed.success) {
  // Logger depends on env, so plain console here. Never print values — only keys.
  const lines = parsed.error.issues.map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`);
  console.error(`\n✖ Invalid environment configuration:\n${lines.join('\n')}\n`);
  console.error('  See .env.example for the required variables.\n');
  process.exit(1);
}

const e = parsed.data;

export const env = Object.freeze({
  ...e,
  isProd: e.NODE_ENV === 'production',
  isDev: e.NODE_ENV === 'development',
  isTest: e.NODE_ENV === 'test',
  corsOrigins: e.CORS_ORIGINS?.length ? e.CORS_ORIGINS : [e.CLIENT_URL],
  mediaBaseUrl: (e.PUBLIC_MEDIA_BASE_URL ?? `http://localhost:${e.PORT}/uploads`).replace(
    /\/+$/,
    '',
  ),
  features: Object.freeze({
    email: Boolean(e.SMTP_HOST && e.SMTP_USER && e.SMTP_PASS),
    sslcommerz: Boolean(e.SSLCZ_STORE_ID && e.SSLCZ_STORE_PASS),
    sms: e.SMS_DRIVER !== 'log',
  }),
});
