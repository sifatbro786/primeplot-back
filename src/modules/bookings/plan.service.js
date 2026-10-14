import mongoose from 'mongoose';
import { BadRequestError, ConflictError, NotFoundError } from '#shared/errors/AppError.js';
import { diffFields } from '#shared/utils/diff.js';
import { audit } from '#modules/audit/audit.service.js';
import { getProject } from '#modules/projects/project.service.js';
import { PaymentPlan } from './paymentPlan.model.js';

/** Payment plan templates (B4). Managed with plans:manage; any booking user can list them. */
const { ObjectId } = mongoose.Types;
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));

const staleVersion = () =>
  new ConflictError('This plan was changed by someone else. Reload and try again.', {
    code: 'STALE_VERSION',
  });

export function toPlan(p) {
  return {
    id: String(p._id),
    projectId: p.projectId ? String(p.projectId) : null,
    name: p.name,
    nameBn: p.nameBn ?? null,
    description: p.description ?? null,
    spec: p.spec,
    active: p.active,
    sortOrder: p.sortOrder ?? 0,
    version: p.__v ?? 0,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** Templates for a project: its own plus the company-wide ones. */
export async function listPlans(orgId, { projectId, active }) {
  const filter = { orgId };
  if (projectId) filter.projectId = { $in: [oid(projectId), null] };
  if (active !== undefined) filter.active = active === 'true';
  const rows = await PaymentPlan.find(filter).sort({ sortOrder: 1, name: 1 }).lean();
  return rows.map(toPlan);
}

export async function createPlan({ orgId, input, ctx }) {
  if (input.projectId) await getProject(orgId, input.projectId);
  const doc = await PaymentPlan.create({ ...input, orgId, createdBy: ctx.actor.id ?? null });
  await audit(ctx, 'payment_plan.create', {
    entity: { type: 'PaymentPlan', id: doc._id },
    meta: { name: doc.name },
  });
  return toPlan(doc.toObject());
}

const AUDITED = ['projectId', 'name', 'nameBn', 'description', 'spec', 'active', 'sortOrder'];

export async function updatePlan({ orgId, id, patch, ctx }) {
  const doc = await PaymentPlan.findOne({ orgId, _id: id });
  if (!doc) throw new NotFoundError('Payment plan not found');
  if (doc.__v !== patch.version) throw staleVersion();
  const { version: _v, ...input } = patch;
  if (input.projectId) await getProject(orgId, input.projectId);
  const before = doc.toObject();
  for (const [k, v] of Object.entries(input)) doc.set(k, v);
  if (input.spec) doc.markModified('spec');
  await doc.save();
  const diff = diffFields(before, doc.toObject(), AUDITED);
  if (diff)
    await audit(ctx, 'payment_plan.update', { entity: { type: 'PaymentPlan', id: doc._id }, diff });
  return toPlan(doc.toObject());
}

/** Soft delete. Bookings keep their copy of the plan. */
export async function deletePlan({ orgId, id, ctx }) {
  const doc = await PaymentPlan.findOne({ orgId, _id: id });
  if (!doc) throw new NotFoundError('Payment plan not found');
  await doc.softDelete(ctx.actor.id ?? null);
  await audit(ctx, 'payment_plan.delete', {
    entity: { type: 'PaymentPlan', id: doc._id },
    meta: { name: doc.name },
  });
}

/** An active plan usable for this project, or 422. */
export async function planForBooking(orgId, planId, projectId) {
  const p = await PaymentPlan.findOne({ orgId, _id: planId, active: true }).lean();
  if (!p || (p.projectId && String(p.projectId) !== String(projectId))) {
    throw new BadRequestError('This payment plan is not available for the project', {
      code: 'INVALID_PLAN',
      details: [{ path: 'planId', message: 'Not found, inactive or for another project' }],
    });
  }
  return p;
}
