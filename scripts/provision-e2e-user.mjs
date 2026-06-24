// Provision (idempotently) a Clerk test user + organization for E2E / prod smoke
// testing. Reads CLERK_SECRET_KEY from the environment. Safe to re-run.
//
// Usage:
//   CLERK_SECRET_KEY=sk_test_... node scripts/provision-e2e-user.mjs
//
// On a Clerk *development* instance, the "+clerk_test" email gets the magic
// email-verification code 424242 (no real email sent), and a password is also
// set so either sign-in factor works.

const API = "https://api.clerk.com/v1";
const SK = process.env.CLERK_SECRET_KEY;
if (!SK) {
  console.error("CLERK_SECRET_KEY is required");
  process.exit(1);
}

const EMAIL = process.env.E2E_EMAIL ?? "savvy.e2e+clerk_test@gmail.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "SavvyE2E!smoke-2026";
const ORG_NAME = process.env.E2E_ORG_NAME ?? "Savvy E2E Co";
// Clerk reserved test phone number (dev instance) -> magic SMS code 424242.
const PHONE = process.env.E2E_PHONE ?? "+12015550100";

async function clerk(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${SK}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function findUser() {
  const list = await clerk(`/users?email_address=${encodeURIComponent(EMAIL)}`);
  return Array.isArray(list) && list.length ? list[0] : null;
}

async function ensureUser() {
  const existing = await findUser();
  if (existing) {
    console.log(`user exists: ${existing.id}`);
    return existing;
  }
  const created = await clerk("/users", {
    method: "POST",
    body: JSON.stringify({
      email_address: [EMAIL],
      phone_number: [PHONE],
      password: PASSWORD,
      skip_password_checks: true,
      first_name: "Savvy",
      last_name: "Smoke",
    }),
  });
  console.log(`user created: ${created.id}`);
  return created;
}

async function ensureOrg(userId) {
  const memberships = await clerk(`/users/${userId}/organization_memberships`);
  const data = Array.isArray(memberships) ? memberships : memberships?.data ?? [];
  if (data.length) {
    const org = data[0].organization;
    console.log(`org exists: ${org.id} (${org.name})`);
    return org;
  }
  const org = await clerk("/organizations", {
    method: "POST",
    body: JSON.stringify({ name: ORG_NAME, created_by: userId }),
  });
  console.log(`org created: ${org.id} (${org.name})`);
  return org;
}

const user = await ensureUser();
const org = await ensureOrg(user.id);

console.log("\n=== E2E sign-in credentials ===");
console.log(`email:    ${EMAIL}`);
console.log(`phone:    ${PHONE}`);
console.log(`password: ${PASSWORD}`);
console.log(`userId:   ${user.id}`);
console.log(`orgId:    ${org.id}`);
console.log(`(dev-instance email code, if prompted: 424242)`);
