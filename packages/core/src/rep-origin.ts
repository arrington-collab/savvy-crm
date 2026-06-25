export type LatLng = { lat: number; lng: number };
export type RepAppt = { startsAt: Date; endsAt: Date; lat: number; lng: number };

// Where to measure drive-time FROM, as of `reference`:
//   last same-day appointment ending before reference → rep base → tenant office → null.
export function resolveRepOrigin(args: {
  sameDayAppts: RepAppt[];
  reference: Date;
  repBase: LatLng | null;
  tenantOffice: LatLng | null;
}): LatLng | null {
  const { sameDayAppts, reference, repBase, tenantOffice } = args;
  const prior = sameDayAppts
    .filter((a) => a.endsAt.getTime() <= reference.getTime())
    .sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0];
  if (prior) return { lat: prior.lat, lng: prior.lng };
  if (repBase) return repBase;
  if (tenantOffice) return tenantOffice;
  return null;
}
