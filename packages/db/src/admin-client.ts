import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index";

const adminUrl = process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/savvy";
export const adminPool = new Pool({ connectionString: adminUrl });
export const adminDb = drizzle(adminPool, { schema });
