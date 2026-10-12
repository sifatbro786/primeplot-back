import mongoose from 'mongoose';
import { LAND_UNITS } from '#shared/utils/area.js';

/**
 * Stored land area: the entered (deed) figure + every derived unit, so the dashboard, site and
 * documents can show "৩.৩০ শতাংশ (১.৯৯৬৫ কাঠা)" without recomputing, and lists can filter/sort
 * on any unit. Always build it with `landArea(value, unit)` from #shared/utils/area.js.
 */
export const landAreaSchema = new mongoose.Schema(
  {
    value: { type: Number, required: true, min: 0 },
    unit: { type: String, enum: LAND_UNITS, required: true },
    katha: { type: Number, required: true },
    decimal: { type: Number, required: true },
    sqft: { type: Number, required: true },
    sqm: { type: Number, required: true },
  },
  { _id: false },
);
