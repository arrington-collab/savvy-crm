import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.js";

const appUrl = process.env.DATABASE_URL ?? "postgres://savvy_app:savvy_app@localhost:5432/savvy";
export const pool = new Pool({ connectionString: appUrl });
export const db = drizzle(pool, { schema });
export { schema };
