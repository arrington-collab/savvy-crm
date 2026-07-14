import { redirect } from "next/navigation";
import { getTransferOfferByToken, registerTransferByToken } from "@/lib/transfer-actions";

export const dynamic = "force-dynamic";

// Customer for Life slice 3, Play B: the new owner of a documented roof
// registers the workmanship-warranty transfer and inherits the Roof Record.
export default async function TransferPage({
  params, searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ registered?: string; error?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const res = await getTransferOfferByToken(token);
  if ("error" in res) {
    return (
      <main className="mx-auto max-w-md p-8 text-center" data-testid="transfer-invalid">
        <h1 className="text-xl font-semibold">Link unavailable</h1>
        <p className="mt-2 text-muted-foreground">This transfer link is invalid or expired. Please contact us.</p>
      </main>
    );
  }

  const installYear = res.lastRoofReplacementAt
    ? new Date(res.lastRoofReplacementAt).getUTCFullYear()
    : res.baselineAt ? new Date(res.baselineAt).getUTCFullYear() : null;
  const registered = res.status === "registered" || sp.registered === "1";

  async function register(formData: FormData) {
    "use server";
    const r = await registerTransferByToken(token, {
      name: String(formData.get("name") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      email: String(formData.get("email") ?? ""),
    });
    redirect("ok" in r ? `/transfer/${token}?registered=1` : `/transfer/${token}?error=${r.error}`);
  }

  return (
    <main className="mx-auto max-w-md p-6" data-testid="transfer-page">
      <p className="text-sm text-muted-foreground">{res.companyName}</p>
      <h1 className="text-2xl font-semibold">This roof comes with its papers.</h1>
      <p className="mt-2 text-muted-foreground">
        The roof at <span className="font-medium text-foreground">{res.address}</span> was installed
        {installYear ? ` in ${installYear}` : ""} by {res.companyName}. Its full Roof Record — inspections,
        photos, and the workmanship warranty — can transfer to you.
      </p>

      <div className="mt-4 rounded-md border p-3 text-sm text-muted-foreground" data-testid="transfer-terms">
        {res.terms}
        {res.feeCents > 0 && (
          <p className="mt-2">Transfer fee: ${(res.feeCents / 100).toFixed(2)}</p>
        )}
      </div>

      {registered ? (
        <div className="mt-6 rounded-md border p-4" data-testid="transfer-registered">
          <h2 className="font-medium">You&apos;re registered.</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The warranty and this home&apos;s Roof Record are now linked to you. We&apos;ll keep the same eyes on it.
          </p>
        </div>
      ) : (
        <form action={register} className="mt-6 space-y-3" data-testid="transfer-form">
          {sp.error && (
            <p className="text-sm text-red-600" data-testid="transfer-error">
              {sp.error === "already_registered" ? "This transfer was already registered." : "Something went wrong — please check your details."}
            </p>
          )}
          <label className="block text-sm">
            Your name
            <input name="name" required className="mt-1 w-full rounded-md border px-3 py-2" data-testid="transfer-name" />
          </label>
          <label className="block text-sm">
            Phone
            <input name="phone" type="tel" className="mt-1 w-full rounded-md border px-3 py-2" data-testid="transfer-phone" />
          </label>
          <label className="block text-sm">
            Email
            <input name="email" type="email" className="mt-1 w-full rounded-md border px-3 py-2" data-testid="transfer-email" />
          </label>
          <button type="submit" className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground" data-testid="transfer-submit">
            Register the transfer
          </button>
        </form>
      )}
    </main>
  );
}
