import mongoose from 'mongoose';
import { AppError } from '#shared/errors/AppError.js';

/**
 * Base plugin — every business schema MUST use it:
 *
 *   const schema = new mongoose.Schema({...});
 *   schema.plugin(baseSchema);                       // tenant + soft delete + timestamps
 *   schema.plugin(baseSchema, { tenant: false });    // only for Organization itself
 *
 * What it adds
 *  - orgId (required, immutable, indexed) — single-tenant today, SaaS-ready tomorrow.
 *  - timestamps (createdAt / updatedAt).
 *  - soft delete: deletedAt / deletedBy; reads hide deleted docs unless `{ withDeleted: true }`.
 *  - tenant guard: any query/aggregate WITHOUT an orgId filter throws, unless `{ skipTenant: true }`
 *    is set explicitly (seed scripts, system jobs). This turns a forgotten org filter — the classic
 *    cross-tenant data leak — into a loud error during development.
 *
 * Query options:  Model.find({ orgId, ... }).setOptions({ withDeleted: true, skipTenant: true })
 * Aggregate:      Model.aggregate(pipeline).option({ withDeleted: true, skipTenant: true })
 */

const READ_OPS = ['find', 'findOne', 'countDocuments', 'distinct'];
const WRITE_OPS = [
  'findOneAndUpdate',
  'findOneAndReplace',
  'updateOne',
  'updateMany',
  'replaceOne',
];
const DELETE_OPS = ['findOneAndDelete', 'deleteOne', 'deleteMany'];

// Stages that must remain first in a pipeline.
const MUST_BE_FIRST = new Set(['$geoNear', '$search', '$searchMeta', '$vectorSearch']);

function filterHasKey(filter, key) {
  if (!filter || typeof filter !== 'object') return false;
  if (Object.hasOwn(filter, key)) return true;
  return Array.isArray(filter.$and) && filter.$and.some((f) => filterHasKey(f, key));
}

function tenantError(where) {
  return new AppError(
    `Tenant scope missing: ${where} ran without an orgId filter. ` +
      'Add orgId to the filter or set { skipTenant: true } for system-level access.',
    { statusCode: 500, code: 'TENANT_SCOPE_MISSING' },
  );
}

export function baseSchema(schema, { tenant = true, softDelete = true } = {}) {
  schema.set('timestamps', true);

  if (tenant) {
    schema.add({
      orgId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Organization',
        required: true,
        immutable: true,
        index: true,
      },
    });
  }

  if (softDelete) {
    schema.add({
      deletedAt: { type: Date, default: null },
      deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    });

    schema.method('softDelete', function softDeleteDoc(userId = null, { session } = {}) {
      this.deletedAt = new Date();
      this.deletedBy = userId;
      return this.save({ session });
    });

    schema.method('restore', function restoreDoc({ session } = {}) {
      this.deletedAt = null;
      this.deletedBy = null;
      return this.save({ session });
    });
  }

  // ── Query middleware (Mongoose 9: no `next`; throw to abort) ──────────────
  schema.pre([...READ_OPS, ...WRITE_OPS], function scopeQuery() {
    const opts = this.getOptions();
    const filter = this.getFilter();

    if (tenant && !opts.skipTenant && !filterHasKey(filter, 'orgId')) {
      throw tenantError(`${this.model.modelName}.${this.op}`);
    }
    // Hide soft-deleted docs unless the caller asks, or already filters on deletedAt.
    if (softDelete && !opts.withDeleted && !filterHasKey(filter, 'deletedAt')) {
      this.where({ deletedAt: null });
    }
  });

  // Hard deletes are allowed (e.g. purging drafts) but still tenant-scoped.
  schema.pre(DELETE_OPS, function scopeDelete() {
    if (tenant && !this.getOptions().skipTenant && !filterHasKey(this.getFilter(), 'orgId')) {
      throw tenantError(`${this.model.modelName}.${this.op}`);
    }
  });

  schema.pre('aggregate', function scopeAggregate() {
    const opts = this.options ?? {};
    const pipeline = this.pipeline();
    const first = pipeline[0] ?? {};
    const firstOp = Object.keys(first)[0];
    const insertAt = MUST_BE_FIRST.has(firstOp) ? 1 : 0;

    if (tenant && !opts.skipTenant) {
      const scoped =
        filterHasKey(first.$match, 'orgId') ||
        filterHasKey(first.$geoNear?.query, 'orgId') ||
        (insertAt === 1 && filterHasKey(pipeline[1]?.$match, 'orgId'));
      if (!scoped) throw tenantError(`${this._model?.modelName ?? 'Model'}.aggregate`);
    }

    if (softDelete && !opts.withDeleted) {
      pipeline.splice(insertAt, 0, { $match: { deletedAt: null } });
    }
  });
}
