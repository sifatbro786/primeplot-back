import { offsetMeta } from '#shared/utils/pagination.js';
import { publicMediaMap } from '#modules/media/media.service.js';
import * as projects from '#modules/projects/project.service.js';
import * as units from '#modules/units/unit.service.js';
import * as floorplans from '#modules/floorplans/floorplan.service.js';
import { publicSeo } from '#modules/site/site.schema.js';
import { summariesFor } from '#modules/construction/construction.service.js';

/**
 * Website catalogue (B2): read-only, published projects only, blocked/cancelled units never
 * appear, no hold details, prices only where the project allows (publicPricing).
 */
function publicInventory(summary, project) {
  const by = summary?.byStatus ?? {};
  const sold = ['booked', 'allotted', 'registered', 'handed_over'].reduce(
    (n, s) => n + (by[s] ?? 0),
    0,
  );
  const available = by.available ?? 0;
  const held = by.held ?? 0;
  return {
    total: available + held + sold,
    available,
    held,
    sold,
    priceFrom: project.publicPricing ? (summary?.availableFrom ?? null) : null,
  };
}

function toPublicProject(p, { media, summary, full = false }) {
  const s = projects.toProject(p, { media });
  const card = {
    id: s.id,
    slug: s.slug,
    name: s.name,
    nameBn: s.nameBn,
    kind: s.kind,
    stage: s.stage,
    featured: s.featured,
    tagline: s.tagline,
    taglineBn: s.taglineBn,
    location: s.location,
    landArea: s.landArea,
    handoverAt: s.handoverAt,
    cover: s.media?.cover ?? null,
    inventory: publicInventory(summary, p),
  };
  if (!full) return card;
  return {
    ...card,
    description: s.description,
    descriptionBn: s.descriptionBn,
    highlights: s.highlights,
    amenities: s.amenities,
    approval: s.approval,
    gallery: s.media?.gallery ?? [],
    brochure: s.media?.brochure ?? null,
    publicPricing: p.publicPricing,
    seo: publicSeo(p.seo, media),
    updatedAt: s.updatedAt,
  };
}

export async function listPublicProjects(orgId, query) {
  const { page, limit } = query;
  const { rows, total } = await projects.findPublishedProjects(orgId, query);
  const [summaries, media] = await Promise.all([
    units.summarizeProjects(
      orgId,
      rows.map((r) => r._id),
    ),
    publicMediaMap(
      orgId,
      rows.map((r) => r.coverMediaId),
    ),
  ]);
  return {
    items: rows.map((p) => toPublicProject(p, { media, summary: summaries.get(String(p._id)) })),
    meta: offsetMeta({ page, limit }, total),
  };
}

export async function getPublicProject(orgId, slug) {
  const p = await projects.getPublishedProjectBySlug(orgId, slug);
  const [summaries, media, blocks, plans, progress] = await Promise.all([
    units.summarizeProjects(orgId, [p._id]),
    publicMediaMap(orgId, [
      p.coverMediaId,
      ...(p.galleryMediaIds ?? []),
      p.brochureMediaId,
      p.seo?.ogImageMediaId,
    ]),
    projects.listBlocksOf(orgId, p._id),
    floorplans.listFloorPlans(orgId, p._id, { publicOnly: true }),
    summariesFor(orgId, [p._id]),
  ]);
  return {
    ...toPublicProject(p, { media, summary: summaries.get(String(p._id)), full: true }),
    blocks: blocks.map((b) => {
      const { version: _v, ...rest } = projects.toBlock(b);
      return rest;
    }),
    floorPlans: plans.map(({ version: _v, hotspotCount: _h, ...rest }) => rest),
    construction: progress.get(String(p._id)) ?? null,
  };
}

export async function listPublicUnitsOf(orgId, slug, query) {
  const p = await projects.getPublishedProjectBySlug(orgId, slug);
  return units.listPublicUnits(orgId, p, query);
}

export async function getPublicUnitDetail(orgId, id) {
  const { unit, project } = await units.getPublicUnit(orgId, id);
  const media = await publicMediaMap(orgId, [unit.layoutMediaId]);
  return {
    ...units.toPublicUnit(unit, project),
    layout: media.get(String(unit.layoutMediaId)) ?? null,
    project: {
      id: String(project._id),
      slug: project.slug,
      name: project.name,
      nameBn: project.nameBn ?? null,
      kind: project.kind,
    },
  };
}

export const getPublicFloorPlan = floorplans.getPublicFloorPlan;
