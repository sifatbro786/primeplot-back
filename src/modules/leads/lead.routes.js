import { Router } from 'express';
import { z } from 'zod';
import { P } from '#shared/auth/permissions.js';
import { ForbiddenError } from '#shared/errors/AppError.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { created, noContent, ok } from '#shared/utils/response.js';
import { cursorQuery } from '#shared/utils/pagination.js';
import { authenticate, authorize } from '#modules/auth/auth.middleware.js';
import { auditContext } from '#modules/audit/audit.service.js';
import { listActiveStaffWith } from '#modules/users/user.service.js';
import { LEAD_TYPES } from './lead.model.js';
import * as leads from './lead.service.js';
import * as followups from './followup.service.js';
import * as pipeline from './pipeline.service.js';
import {
  zActivityCreate,
  zAssign,
  zBoardQuery,
  zBulkAssign,
  zLeadCreate,
  zLeadFilters,
  zLeadList,
  zLeadMove,
  zLeadPatch,
  zMerge,
  zSettingsPatch,
  zStageCards,
  zStagesReplace,
  zTaskCreate,
  zTaskList,
  zTaskPatch,
} from './lead.validation.js';

/**
 * /api/v1/leads — CRM (B3). Executives (leads:read_own) see only their own leads; managers
 * (leads:read_all) see everything. Static paths are declared before /:id.
 */
const router = Router();
router.use(authenticate);

const anyRead = (req, res, next) => {
  if (req.user.permissions.has(P.LEADS_READ_OWN) || req.user.permissions.has(P.LEADS_READ_ALL))
    return next();
  throw new ForbiddenError();
};
const byId = { params: { id: zid } };

// ── Lists & board ───────────────────────────────────────────────────────────────

router.get('/', anyRead, validate({ query: zLeadList }), async (req, res) => {
  const { items, meta } = await leads.listLeads(req.orgId, req.user, req.valid.query);
  ok(res, items, { meta });
});

router.post('/', authorize(P.LEADS_WRITE), validate({ body: zLeadCreate }), async (req, res) => {
  created(
    res,
    await leads.createLead({
      orgId: req.orgId,
      user: req.user,
      input: req.valid.body,
      ctx: auditContext(req),
    }),
  );
});

router.get('/board', anyRead, validate({ query: zBoardQuery }), async (req, res) => {
  ok(res, await leads.getBoard(req.orgId, req.user, req.valid.query));
});

router.get(
  '/board/stages/:stageId',
  anyRead,
  validate({ params: { stageId: zid }, query: zStageCards }),
  async (req, res) => {
    const { items, meta } = await leads.listStageCards(
      req.orgId,
      req.user,
      req.valid.params.stageId,
      req.valid.query,
    );
    ok(res, items, { meta });
  },
);

router.get(
  '/export',
  authorize(P.LEADS_READ_ALL),
  validate({ query: zLeadFilters }),
  async (req, res) => {
    const csv = await leads.exportLeadsCsv(req.orgId, req.user, req.valid.query, auditContext(req));
    const day = new Date(Date.now() + 6 * 3_600_000).toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${day}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(csv);
  },
);

/** People a lead or task can be given to (active staff who can own leads). */
router.get('/assignees', anyRead, async (req, res) => {
  ok(res, await listActiveStaffWith(req.orgId, P.LEADS_READ_OWN));
});

router.post(
  '/assign',
  authorize(P.LEADS_ASSIGN),
  validate({ body: zBulkAssign }),
  async (req, res) => {
    ok(
      res,
      await leads.bulkAssign({
        orgId: req.orgId,
        user: req.user,
        ...req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

// ── Pipeline & settings ─────────────────────────────────────────────────────────

router.get(
  '/stages',
  anyRead,
  validate({ query: { type: z.enum(LEAD_TYPES).default('buyer') } }),
  async (req, res) => {
    const { type } = req.valid.query;
    // Totals across all owners only for people who can see all leads.
    if (req.user.permissions.has(P.LEADS_READ_ALL))
      return ok(res, await pipeline.listStagesWithCounts(req.orgId, type));
    ok(
      res,
      (await pipeline.getStages(req.orgId, type)).map((s) => pipeline.toStage(s)),
    );
  },
);

router.put(
  '/stages',
  authorize(P.PIPELINE_MANAGE),
  validate({ body: zStagesReplace }),
  async (req, res) => {
    ok(
      res,
      await pipeline.replaceStages({ orgId: req.orgId, ...req.valid.body, ctx: auditContext(req) }),
    );
  },
);

router.get('/settings', authorize(P.PIPELINE_MANAGE), async (req, res) => {
  ok(res, pipeline.toSettings(await pipeline.getSettings(req.orgId)));
});

router.patch(
  '/settings',
  authorize(P.PIPELINE_MANAGE),
  validate({ body: zSettingsPatch }),
  async (req, res) => {
    ok(
      res,
      await pipeline.updateSettings({
        orgId: req.orgId,
        patch: req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

// ── Tasks (cross-lead) ──────────────────────────────────────────────────────────

router.get('/tasks', anyRead, validate({ query: zTaskList }), async (req, res) => {
  const { items, meta } = await followups.listTasks(req.orgId, req.user, req.valid.query);
  ok(res, items, { meta });
});

router.get('/tasks/counts', anyRead, async (req, res) => {
  ok(res, await followups.taskCounts(req.orgId, req.user));
});

router.patch(
  '/tasks/:taskId',
  authorize(P.LEADS_WRITE),
  validate({ params: { taskId: zid }, body: zTaskPatch }),
  async (req, res) => {
    ok(
      res,
      await followups.updateTask({
        orgId: req.orgId,
        user: req.user,
        taskId: req.valid.params.taskId,
        patch: req.valid.body,
      }),
    );
  },
);

// ── One lead ────────────────────────────────────────────────────────────────────

router.get('/:id', anyRead, validate(byId), async (req, res) => {
  ok(res, await leads.getLeadDetail(req.orgId, req.user, req.valid.params.id));
});

router.patch(
  '/:id',
  authorize(P.LEADS_WRITE),
  validate({ ...byId, body: zLeadPatch }),
  async (req, res) => {
    ok(
      res,
      await leads.updateLead({
        orgId: req.orgId,
        user: req.user,
        id: req.valid.params.id,
        patch: req.valid.body,
      }),
    );
  },
);

router.delete(
  '/:id',
  authorize(P.LEADS_ASSIGN, P.LEADS_WRITE),
  validate(byId),
  async (req, res) => {
    await leads.deleteLead({
      orgId: req.orgId,
      user: req.user,
      id: req.valid.params.id,
      ctx: auditContext(req),
    });
    noContent(res);
  },
);

router.post(
  '/:id/move',
  authorize(P.LEADS_WRITE),
  validate({ ...byId, body: zLeadMove }),
  async (req, res) => {
    ok(
      res,
      await leads.moveLead({
        orgId: req.orgId,
        user: req.user,
        id: req.valid.params.id,
        move: req.valid.body,
      }),
    );
  },
);

router.post(
  '/:id/assign',
  authorize(P.LEADS_ASSIGN),
  validate({ ...byId, body: zAssign }),
  async (req, res) => {
    ok(
      res,
      await leads.assignLead({
        orgId: req.orgId,
        user: req.user,
        id: req.valid.params.id,
        ...req.valid.body,
        ctx: auditContext(req),
      }),
    );
  },
);

router.post(
  '/:id/merge',
  authorize(P.LEADS_ASSIGN, P.LEADS_WRITE),
  validate({ ...byId, body: zMerge }),
  async (req, res) => {
    ok(
      res,
      await leads.mergeLeads({
        orgId: req.orgId,
        user: req.user,
        targetId: req.valid.params.id,
        sourceId: req.valid.body.sourceId,
        ctx: auditContext(req),
      }),
    );
  },
);

router.get(
  '/:id/activities',
  anyRead,
  validate({ ...byId, query: cursorQuery }),
  async (req, res) => {
    const { items, meta } = await followups.listActivities(
      req.orgId,
      req.user,
      req.valid.params.id,
      req.valid.query,
    );
    ok(res, items, { meta });
  },
);

router.post(
  '/:id/activities',
  authorize(P.LEADS_WRITE),
  validate({ ...byId, body: zActivityCreate }),
  async (req, res) => {
    created(
      res,
      await followups.logActivity({
        orgId: req.orgId,
        user: req.user,
        leadId: req.valid.params.id,
        input: req.valid.body,
      }),
    );
  },
);

router.get(
  '/:id/tasks',
  anyRead,
  validate({
    ...byId,
    query: { status: zTaskList.status, cursor: zTaskList.cursor, limit: zTaskList.limit },
  }),
  async (req, res) => {
    const { items, meta } = await followups.listTasks(req.orgId, req.user, {
      ...req.valid.query,
      scope: 'mine',
      due: 'all',
      leadId: req.valid.params.id,
    });
    ok(res, items, { meta });
  },
);

router.post(
  '/:id/tasks',
  authorize(P.LEADS_WRITE),
  validate({ ...byId, body: zTaskCreate }),
  async (req, res) => {
    created(
      res,
      await followups.createTask({
        orgId: req.orgId,
        user: req.user,
        leadId: req.valid.params.id,
        input: req.valid.body,
      }),
    );
  },
);

export default router;
