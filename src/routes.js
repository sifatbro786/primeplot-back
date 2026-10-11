import { Router } from 'express';
import healthRoutes from '#modules/health/health.routes.js';

/** /api/v1 — every module mounts here. */
const api = Router();

api.use('/health', healthRoutes);

export default api;
