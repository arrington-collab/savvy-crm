import { z } from "./schemas";
import { measurementAreasSchema } from "./measurement";

/**
 * Extraction schema for an uploaded measurement report (Roofr PDF or similar).
 * Reuses the exact estimate-engine area fields + a 0-1 confidence, so a parsed
 * report drops straight into `measurement.areas`.
 */
export const measurementReportParseSchema = measurementAreasSchema.extend({
  confidence: z.number().min(0).max(1),
});
export type MeasurementReportParse = z.infer<typeof measurementReportParseSchema>;

/** Below this confidence, an upload is carded ("stored, unparsed") rather than trusted. */
export const MEASUREMENT_PARSE_MIN_CONFIDENCE = 0.8;
