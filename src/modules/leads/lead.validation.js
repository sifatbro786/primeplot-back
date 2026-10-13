import { z } from 'zod';
import { zemail, zid } from '#shared/middleware/validate.js';
import { cursorQuery } from '#shared/utils/pagination.js';
import { RANK_RE } from '#shared/utils/rank.js';
import { zLandAreaInput, zMoney, zText, zVersion } from '#modules/projects/project.validation.js';
import {
  LAND_OWNERSHIP,
  LEAD_SOURCES,
  LEAD_STATUSES,
  LEAD_TYPES,
  LOST_REASONS,
  MUTATION_STATUS,
} from './lead.model.js';
import { CALL_OUTCOMES, USER_ACTIVITY_TYPES } from './leadActivity.model.js';
import { STAGE_COLORS, STAGE_KINDS } from './leadStage.model.js';
import { TASK_STATUSES, TASK_TYPES } from './leadTask.model.js';

/** CRM request schemas (B3). Strict everywhere; phones are normalized in the service. */

const optText = (max) => zText(max).nullable().optional();
const zPhoneInput = z.string().trim().min(6).max(30);
const zTag = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,29}$/u, 'Letters, digits, spaces, - and _ (max 30)');

const zInterest = z
  .object({
    projectId: zid.nullable().optional(),
    unitId: zid.nullable().optional(),
    bedrooms: z.number().int().min(0).max(20).nullable().optional(),
    budgetMin: zMoney.nullable().optional(),
    budgetMax: zMoney.nullable().optional(),
  })
  .strict()
  .refine((i) => i.budgetMin == null || i.budgetMax == null || i.budgetMin <= i.budgetMax, {
    message: 'Budget from must not exceed budget to',
    path: ['budgetMax'],
  });

export const zLand = z
  .object({
    location: optText(300),
    area: zLandAreaInput.nullable().optional(),
    roadWidthFt: z.number().min(0).max(500).nullable().optional(),
    ownership: z.enum(LAND_OWNERSHIP).nullable().optional(),
    mutation: z.enum(MUTATION_STATUS).nullable().optional(),
    expectedShare: optText(60),
  })
  .strict();

const zSourceDetail = z
  .object({
    page: optText(300),
    campaign: optText(200),
    medium: optText(100),
    formName: optText(200),
    referrer: optText(200),
  })
  .strict();

/** Staff: manual lead. `assigneeId` omitted → automatic; null → unassigned (needs leads:assign). */
export const zLeadCreate = z
  .object({
    type: z.enum(LEAD_TYPES).default('buyer'),
    name: zText(120).min(2),
    phone: zPhoneInput,
    altPhone: zPhoneInput.nullable().optional(),
    email: zemail.nullable().optional(),
    source: z.enum(LEAD_SOURCES.filter((s) => s !== 'website')).default('manual'),
    sourceDetail: zSourceDetail.optional(),
    message: optText(2000),
    interest: zInterest.optional(),
    land: zLand.optional(),
    tags: z.array(zTag).max(20).optional(),
    assigneeId: zid.nullable().optional(),
  })
  .strict();

export const zLeadPatch = z
  .object({
    version: zVersion,
    name: zText(120).min(2).optional(),
    phone: zPhoneInput.optional(),
    altPhone: zPhoneInput.nullable().optional(),
    email: zemail.nullable().optional(),
    source: z.enum(LEAD_SOURCES).optional(),
    sourceDetail: zSourceDetail.optional(),
    interest: zInterest.optional(),
    land: zLand.optional(),
    tags: z.array(zTag).max(20).optional(),
  })
  .strict();

/** Kanban move: place the card in `stageId` after `afterId` (card above) / before `beforeId` (card below). */
export const zLeadMove = z
  .object({
    version: zVersion,
    stageId: zid,
    afterId: zid.nullable().optional(),
    beforeId: zid.nullable().optional(),
    lostReason: z.enum(LOST_REASONS).optional(),
    lostNote: optText(500),
  })
  .strict();

export const zAssign = z.object({ version: zVersion, assigneeId: zid.nullable() }).strict();
export const zBulkAssign = z
  .object({ ids: z.array(zid).min(1).max(200), assigneeId: zid.nullable() })
  .strict();
export const zMerge = z.object({ sourceId: zid }).strict();

const boolString = z.enum(['true', 'false']).transform((v) => v === 'true');

export const zLeadFilters = {
  type: z.enum(LEAD_TYPES).optional(),
  stageId: zid.optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  assignee: z.union([zid, z.enum(['me', 'unassigned'])]).optional(),
  projectId: zid.optional(),
  tag: zTag.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  followUp: z.enum(['overdue', 'today', 'upcoming', 'none']).optional(),
  slaBreached: boolString.optional(),
};

export const zLeadList = { ...zLeadFilters, ...cursorQuery };

export const zBoardQuery = {
  type: z.enum(LEAD_TYPES).default('buyer'),
  assignee: zLeadFilters.assignee,
  projectId: zLeadFilters.projectId,
  source: zLeadFilters.source,
  tag: zLeadFilters.tag,
  q: zLeadFilters.q,
  perStage: z.coerce.number().int().min(1).max(100).default(50),
  closedDays: z.coerce.number().int().min(1).max(365).default(30),
};

export const zStageCards = {
  ...zBoardQuery,
  afterRank: z.string().regex(RANK_RE).optional(),
  afterId: zid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
};

// ── Activities & tasks ──────────────────────────────────────────────────────────

export const zActivityCreate = z
  .object({
    type: z.enum(USER_ACTIVITY_TYPES),
    body: optText(4000),
    outcome: z.enum(CALL_OUTCOMES).nullable().optional(),
    durationSec: z.number().int().min(0).max(86_400).nullable().optional(),
    at: z.coerce.date().optional(), // back-dating a call logged later
  })
  .strict()
  .refine((a) => a.type !== 'note' || (a.body && a.body.length > 0), {
    message: 'A note needs text',
    path: ['body'],
  });

const REMIND_BEFORE = [0, 15, 30, 60, 120, 1440];
const zRemind = z
  .number()
  .int()
  .refine((n) => REMIND_BEFORE.includes(n), `One of ${REMIND_BEFORE.join(', ')}`)
  .nullable(); // null = no reminder

export const zTaskCreate = z
  .object({
    title: zText(200).min(2),
    type: z.enum(TASK_TYPES).default('follow_up'),
    dueAt: z.coerce.date(),
    remindMinutesBefore: zRemind.default(15),
    assigneeId: zid.optional(),
  })
  .strict();

export const zTaskPatch = z
  .object({
    version: zVersion,
    title: zText(200).min(2).optional(),
    type: z.enum(TASK_TYPES).optional(),
    dueAt: z.coerce.date().optional(),
    remindMinutesBefore: zRemind.optional(),
    status: z.enum(TASK_STATUSES).optional(),
    assigneeId: zid.optional(),
  })
  .strict();

export const zTaskList = {
  scope: z.enum(['mine', 'all']).default('mine'),
  due: z.enum(['overdue', 'today', 'upcoming', 'all']).default('all'),
  status: z.enum(TASK_STATUSES).default('open'),
  leadId: zid.optional(),
  assigneeId: zid.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
};

// ── Pipeline & settings ─────────────────────────────────────────────────────────

export const zStagesReplace = z
  .object({
    pipeline: z.enum(LEAD_TYPES),
    stages: z
      .array(
        z
          .object({
            id: zid.optional(),
            name: zText(60).min(1),
            nameBn: optText(60),
            kind: z.enum(STAGE_KINDS),
            color: z.enum(STAGE_COLORS).default('neutral'),
          })
          .strict(),
      )
      .min(3)
      .max(15)
      .refine(
        (a) =>
          new Set(a.filter((s) => s.id).map((s) => s.id)).size === a.filter((s) => s.id).length,
        'Duplicate stage id',
      ),
  })
  .strict();

const zHhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM (24 h)');
export const zSettingsPatch = z
  .object({
    version: zVersion,
    assignment: z
      .object({
        mode: z.enum(['round_robin', 'manual']).optional(),
        projectPools: z
          .array(z.object({ projectId: zid, userIds: z.array(zid).min(1).max(50) }).strict())
          .max(100)
          .refine(
            (a) => new Set(a.map((p) => p.projectId)).size === a.length,
            'One team per project',
          )
          .optional(),
      })
      .strict()
      .optional(),
    sla: z
      .object({
        enabled: z.boolean().optional(),
        firstResponseMinutes: z.number().int().min(5).max(1440).optional(),
        officeStart: zHhmm.optional(),
        officeEnd: zHhmm.optional(),
        weekend: z.array(z.number().int().min(0).max(6)).max(6).optional(),
      })
      .strict()
      .optional(),
    autoReply: z
      .object({
        enabled: z.boolean().optional(),
        textBn: zText(480).min(5).optional(),
        textEn: zText(480).min(5).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// ── Website form (POST /public/leads) ───────────────────────────────────────────

export const zPublicLead = z
  .object({
    type: z.enum(LEAD_TYPES).default('buyer'),
    name: zText(120).min(2),
    phone: zPhoneInput,
    email: z.union([z.literal(''), zemail]).optional(),
    projectSlug: z
      .string()
      .trim()
      .toLowerCase()
      .max(80)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    unitId: zid.optional(),
    message: optText(1000),
    land: zLand.optional(),
    source: z.literal('website').default('website'),
    page: z.string().trim().max(300).optional(),
    utm: z
      .object({
        source: optText(100),
        medium: optText(100),
        campaign: optText(200),
      })
      .strict()
      .optional(),
    hp: z.string().max(200).optional(), // honeypot — must be empty
    elapsedMs: z.number().int().min(0).max(86_400_000).optional(),
  })
  .strict();
