import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { provisionTenant, type TenantProvisionConfig, type ProvisionSecrets } from "../index";
import { adminPool } from "../admin-client";

// Cell 20 provisioning CLI. Loads a committable, SECRET-FREE tenant config from a
// JSON path; reads the only secret (Twilio auth token) from env — never the file.
// Dry-run by default (prints the plan, writes nothing); pass --commit to execute.
// On commit it writes a provisioning.complete artifact next to the config.
//
//   tsx src/scripts/provision-tenant.ts provisioning/alta.json            # dry run
//   PROVISION_TWILIO_ACCOUNT_SID=AC.. PROVISION_TWILIO_AUTH_TOKEN=.. \
//   INTEGRATION_SECRET_KEY=<base64-32> \
//   tsx src/scripts/provision-tenant.ts provisioning/alta.json --commit    # execute
//
// The auth token is sealed by the DB layer before it is stored; it is never
// logged or written to the artifact.

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes("--commit");
  const configPath = args.find((a) => !a.startsWith("--"));
  if (!configPath) {
    console.error("usage: provision-tenant <config.json> [--commit]");
    process.exit(2);
  }

  const config = JSON.parse(readFileSync(configPath, "utf8")) as TenantProvisionConfig;

  // Secrets from env ONLY. If both Twilio env vars are present, wire the connection;
  // otherwise the Twilio seam stays dormant (owner completes it at execution).
  const secrets: ProvisionSecrets = {};
  const sid = process.env.PROVISION_TWILIO_ACCOUNT_SID;
  const token = process.env.PROVISION_TWILIO_AUTH_TOKEN;
  if (sid && token) secrets.twilioSecret = { accountSid: sid, authToken: token };

  const startedAt = Date.now();
  console.log(`\n${commit ? "EXECUTING" : "DRY RUN"} — provisioning "${config.name}" (${config.clerkOrgId})`);
  const res = await provisionTenant(config, secrets, { dryRun: !commit });

  console.log("\nSteps:");
  for (const s of res.steps) console.log(`  [${s.action.padEnd(7)}] ${s.step} — ${s.detail}`);
  console.log("\nDormant seams:");
  for (const seam of res.dormantSeams) console.log(`  ${seam.active ? "ON " : "off"} ${seam.key.padEnd(11)} — ${seam.active ? seam.label : seam.activate}`);

  const elapsedMs = Date.now() - startedAt;
  console.log(`\nwall-clock: ${(elapsedMs / 1000).toFixed(1)}s`);

  if (commit) {
    const artifactPath = configPath.replace(/\.json$/, "") + ".complete.json";
    writeFileSync(artifactPath, JSON.stringify({ ...res.artifact, elapsedMs }, null, 2));
    console.log(`tenant #: ${res.tenantId} (${res.created ? "created" : "reused"})`);
    console.log(`artifact: ${basename(artifactPath)} written`);
  } else {
    console.log("(dry run — nothing written; re-run with --commit to execute)");
  }
}

main()
  .then(async () => { await adminPool.end(); process.exit(0); })
  .catch(async (e) => { console.error(e); await adminPool.end().catch(() => {}); process.exit(1); });
