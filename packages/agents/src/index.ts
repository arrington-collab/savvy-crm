import { examplePing } from "./functions/example";
import { leadIntake, leadBooked } from "./functions/lead-intake";

export { inngest } from "./client";
export { examplePing } from "./functions/example";
export { leadIntake, leadBooked } from "./functions/lead-intake";
export const functions = [examplePing, leadIntake, leadBooked];
