import { describe, it, expect } from "vitest";
import { parseAccuLynxContactsCsv } from "./acculynx";

const CSV = `Contact: First Name,Contact: Last Name,Contact: Types,Contact: LTV,Contact: Mailing Address,Contact: Phone,Contact: Email,Contact: Created Date,Contact: First Name Url,Contact: Last Name Url
Kayli,Elliott,Customer,0.00,"1240 Kennedy Drive,, Northglenn, CO 80234 US",(720) 791-5701,kelliott@guardianconst.com,2/2/26,https://my.acculynx.com/contacts/ef60badc-a300-f111-8af2-ea808804e890/overview,https://my.acculynx.com/contacts/ef60badc-a300-f111-8af2-ea808804e890/overview
Hella,Page,Customer,0.00,"477 whistler creek ct, Monument, CO 80132 US",(719) 358-8002,,1/26/26,https://my.acculynx.com/contacts/d570a4af-dbfa-f011-8af2-ea808804e890/overview,https://my.acculynx.com/contacts/d570a4af-dbfa-f011-8af2-ea808804e890/overview`;

describe("parseAccuLynxContactsCsv", () => {
  it("parses rows with quoted comma-bearing addresses and extracts the contact GUID from the URL", () => {
    const rows = parseAccuLynxContactsCsv(CSV);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      contactId: "ef60badc-a300-f111-8af2-ea808804e890",
      name: "Kayli Elliott",
      phone: "(720) 791-5701",
      email: "kelliott@guardianconst.com",
      address: "1240 Kennedy Drive,, Northglenn, CO 80234 US",
    });
  });

  it("treats an empty email as null", () => {
    expect(parseAccuLynxContactsCsv(CSV)[1]!.email).toBeNull();
  });

  it("skips rows whose URL has no GUID (no idempotency key)", () => {
    const bad = 'A,B,Customer,0.00,"x",1,e@x.com,1/1/26,not-a-url,not-a-url';
    const rows = parseAccuLynxContactsCsv(CSV + "\n" + bad);
    expect(rows).toHaveLength(2);
  });
});
