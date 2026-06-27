import { z } from "./schemas";

const pipelineSchema = z.object({
  // win probability (0–100) per OPEN stage; terminal stages excluded
  stageWinProbability: z
    .object({
      lead: z.number().int().min(0).max(100).default(5),
      inspected: z.number().int().min(0).max(100).default(15),
      estimate: z.number().int().min(0).max(100).default(30),
      approved: z.number().int().min(0).max(100).default(70),
      production: z.number().int().min(0).max(100).default(90),
      closeout: z.number().int().min(0).max(100).default(95),
      billing: z.number().int().min(0).max(100).default(98),
    })
    .default({}),
});

export type PipelineConfig = z.infer<typeof pipelineSchema>;

export function parsePipelineConfig(raw: unknown): PipelineConfig {
  return pipelineSchema.parse(raw ?? {});
}
