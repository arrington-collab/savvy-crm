// Onboard a new Knock Jockey company: creates the tenant row, its canvass
// config, and the first manager login — the parts that used to be hand-written
// SQL. Safe to re-run: it matches on the slug and updates instead of
// duplicating.
//
// Usage (from the repo root):
//   DATABASE_URL=postgres://... pnpm --filter @savvy/db exec node \
//     scripts/onboard-canvass-tenant.mjs \
//     --slug acme --name "Acme Pest" --manager "Jane Doe" --pin 481920
//
//   Optional:
//     --vertical pest|roofing      roofing keeps the storm/insurance surfaces
//     --label-noanswer "Not Home"  relabel the "No Answer" knock outcome
//     --label-goback  "Not Home"   relabel the sold-sign "Go Back" status
//     --dry                        print the plan, write nothing
//
// It deliberately needs NO app deploy and NO env change: the field app reads
// each company's config from GET /api/canvass/tenant?slug=<slug>, and CORS
// accepts any *.knockjockey.com subdomain.

import { randomBytes, scryptSync } from "node:crypto";

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const dry = args.includes("--dry");

const slug = (flag("slug") ?? "").toLowerCase();
const name = flag("name");
const manager = flag("manager");
const pin = flag("pin");
const vertical = flag("vertical", "pest");

if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) || !name || !manager || !/^\d{6}$/.test(pin ?? "")) {
  console.error(
    'Required: --slug <a-z0-9-> --name "<company>" --manager "<person>" --pin <6 digits>\n' +
      "Optional: --vertical pest|roofing  --label-noanswer <text>  --label-goback <text>  --dry",
  );
  process.exit(1);
}

// Same scheme the API verifies against (packages/core/src/crew-pin.ts).
// The plaintext PIN is never stored.
const hashPin = (p) => {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(p, salt, 32).toString("hex")}`;
};

const canvass = { storms: vertical === "roofing" };
const noanswer = flag("label-noanswer");
const goback = flag("label-goback");
if (noanswer) canvass.outcomeLabels = { noanswer };
if (goback) canvass.statusLabels = { goback };

console.log(`\n${dry ? "[DRY RUN] " : ""}Onboarding "${name}"`);
console.log(`  subdomain : ${slug}.knockjockey.com`);
console.log(`  vertical  : ${vertical}${canvass.storms ? "" : " (storm surfaces hidden)"}`);
console.log(`  manager   : ${manager}`);
console.log(`  config    : ${JSON.stringify(canvass)}`);

if (dry) {
  console.log("\nNothing written (--dry).\n");
  process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("\nDATABASE_URL is required to write (use the prod pooler URL for a real customer)");
  process.exit(1);
}

const { default: pg } = await import("pg");
const { uuidv7 } = await import("uuidv7");

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const key = `pk-${slug}-${randomBytes(20).toString("hex")}`;
  const settings = JSON.stringify({ canvassSlug: slug, canvass });

  const found = await client.query(
    "SELECT id, public_key FROM tenant WHERE settings->>'canvassSlug' = $1 LIMIT 1",
    [slug],
  );

  let tenantId, publicKey;
  if (found.rows.length) {
    tenantId = found.rows[0].id;
    publicKey = found.rows[0].public_key;
    await client.query("UPDATE tenant SET settings = settings || $1::jsonb WHERE id = $2", [settings, tenantId]);
    console.log(`\n\u21bb Existing company updated (${tenantId})`);
  } else {
    tenantId = uuidv7();
    publicKey = key;
    await client.query(
      "INSERT INTO tenant (id, name, public_key, settings) VALUES ($1, $2, $3, $4::jsonb)",
      [tenantId, name, publicKey, settings],
    );
    console.log(`\n\u2713 Company created (${tenantId})`);
  }

  const rep = await client.query(
    "SELECT id FROM canvass_rep WHERE tenant_id = $1 AND lower(name) = $2 LIMIT 1",
    [tenantId, manager.toLowerCase()],
  );
  if (rep.rows.length) {
    await client.query(
      "UPDATE canvass_rep SET pin_hash = $1, manager = true, active = true WHERE id = $2",
      [hashPin(pin), rep.rows[0].id],
    );
    console.log("\u2713 Manager login updated (PIN reset)");
  } else {
    await client.query(
      "INSERT INTO canvass_rep (id, tenant_id, name, pin_hash, manager, active) VALUES ($1,$2,$3,$4,true,true)",
      [uuidv7(), tenantId, manager, hashPin(pin)],
    );
    console.log("\u2713 Manager login created");
  }

  console.log(`\n  Company code (public): ${publicKey}`);
  console.log("\nRemaining steps (hosting only — no code change, no deploy):");
  console.log(`  1. Cloudflare Pages -> knockjockey project -> add domain ${slug}.knockjockey.com`);
  console.log(`  2. MapTiler -> allow https://${slug}.knockjockey.com on the map key`);
  console.log("  3. Load their metro's sold-home data");
  console.log(`\nThen ${manager} signs in at https://${slug}.knockjockey.com with PIN ${pin}\n`);
} finally {
  await client.end();
}
