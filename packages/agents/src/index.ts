import { examplePing } from "./functions/example";
import { leadIntake, leadBooked } from "./functions/lead-intake";
import { jobStageChanged } from "./functions/job-stage";
import { dripRun } from "./functions/drip";

export { inngest } from "./client";
export { examplePing } from "./functions/example";
export { leadIntake, leadBooked } from "./functions/lead-intake";
export { jobStageChanged } from "./functions/job-stage";
export { dripRun } from "./functions/drip";
export const functions = [examplePing, leadIntake, leadBooked, jobStageChanged, dripRun];
