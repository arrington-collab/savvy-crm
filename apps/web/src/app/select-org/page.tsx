import { OrganizationList } from "@clerk/nextjs";

// Clerk interactive widget — render at request time (needs ClerkProvider + the
// publishable key), never statically prerendered at build.
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <OrganizationList
        afterCreateOrganizationUrl="/dashboard"
        afterSelectOrganizationUrl="/dashboard"
        hidePersonal
      />
    </div>
  );
}
