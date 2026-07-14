import { notFound } from "next/navigation";
import Script from "next/script";
import { adminDb, canvassRep, tenant, eq } from "@savvy/db";
import { ScanForm } from "./ScanForm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CanvassId {
  licenseNo?: string; insuranceCarrier?: string; insurancePolicy?: string;
  insurancePhone?: string; coiUrl?: string; metaPixelId?: string;
}

export default async function RepIdPage({ params }: { params: Promise<{ repId: string }> }) {
  const { repId } = await params;
  if (!UUID_RE.test(repId)) notFound();
  const [row] = await adminDb
    .select({ name: canvassRep.name, photoUrl: canvassRep.photoUrl, active: canvassRep.active,
      companyName: tenant.name, settings: tenant.settings })
    .from(canvassRep).innerJoin(tenant, eq(tenant.id, canvassRep.tenantId))
    .where(eq(canvassRep.id, repId));
  if (!row || row.active === false) notFound();
  const settings = (row.settings ?? {}) as { canvassLogo?: string; canvassId?: CanvassId };
  const info = settings.canvassId ?? {};
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  return (
    <main className="mx-auto max-w-md p-6 font-sans">
      {info.metaPixelId ? (
        <Script id="fbp" strategy="afterInteractive">{`
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init','${info.metaPixelId.replace(/[^0-9]/g, "")}');fbq('track','PageView');`}</Script>
      ) : null}
      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <div className="flex items-center gap-4">
          {row.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={row.photoUrl} alt={row.name} className="h-20 w-20 rounded-full object-cover" />
          ) : (
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gray-900 text-2xl font-bold text-white">{row.name.slice(0, 1)}</div>
          )}
          <div>
            <h1 className="text-xl font-bold">{row.name}</h1>
            <p className="text-sm text-gray-500">{row.companyName}</p>
            <p className="mt-1 inline-block rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800">✓ Verified active rep — {today}</p>
          </div>
        </div>
        <dl className="mt-6 space-y-2 text-sm">
          {info.licenseNo ? (<div className="flex justify-between"><dt className="text-gray-500">Contractor license</dt><dd className="font-semibold">{info.licenseNo}</dd></div>) : null}
          {info.insuranceCarrier ? (<div className="flex justify-between"><dt className="text-gray-500">Insured by</dt><dd className="font-semibold">{info.insuranceCarrier}</dd></div>) : null}
          {info.insurancePolicy ? (<div className="flex justify-between"><dt className="text-gray-500">Policy #</dt><dd className="font-semibold">{info.insurancePolicy}</dd></div>) : null}
          {info.insurancePhone ? (<div className="flex justify-between"><dt className="text-gray-500">Verify coverage</dt><dd className="font-semibold">{info.insurancePhone}</dd></div>) : null}
        </dl>
        {info.coiUrl?.startsWith("https://") ? (<a href={info.coiUrl} target="_blank" rel="noopener noreferrer" className="mt-3 block text-sm font-semibold text-blue-600 underline">View certificate of insurance</a>) : null}
        <p className="mt-4 text-xs text-gray-500">This page confirms the person at your door works with {row.companyName}, is licensed where required, and that the company carries active liability insurance for work on your property.</p>
      </div>
      <ScanForm repId={repId} company={row.companyName} repName={row.name} hasPixel={!!info.metaPixelId} />
    </main>
  );
}
