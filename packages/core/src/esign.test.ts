import { test, expect } from "vitest";
import {
  parseEsignConfig, resolveEsignTemplate, buildEsignPrefill, ESIGN_DOC_TYPE,
} from "./esign";

test("ESIGN_DOC_TYPE has both doc types", () => {
  expect(ESIGN_DOC_TYPE).toEqual(["lien_waiver", "cert"]);
});

test("parseEsignConfig fills defaults from empty/undefined", () => {
  expect(parseEsignConfig(undefined).templates.lien_waiver).toBe("");
  expect(parseEsignConfig({}).templates.cert).toBe("");
});

test("parseEsignConfig keeps a tenant override", () => {
  const cfg = parseEsignConfig({ templates: { cert: "tpl_99" } });
  expect(cfg.templates.cert).toBe("tpl_99");
  expect(cfg.templates.lien_waiver).toBe("");
});

test("resolveEsignTemplate prefers the configured id, else the fallback", () => {
  const cfg = parseEsignConfig({ templates: { lien_waiver: "tpl_lw" } });
  expect(resolveEsignTemplate(cfg, "lien_waiver", "env_lw")).toBe("tpl_lw");
  expect(resolveEsignTemplate(cfg, "cert", "env_cert")).toBe("env_cert");
});

test("buildEsignPrefill: cert has name/address/date, NO amount", () => {
  const f = buildEsignPrefill("cert", { customerName: "Jane", propertyAddress: "1 Main", date: "2026-06-15" });
  expect(f).toEqual([
    { name: "customer_name", default_value: "Jane" },
    { name: "property_address", default_value: "1 Main" },
    { name: "date", default_value: "2026-06-15" },
  ]);
});

test("buildEsignPrefill: lien_waiver adds amount (empty when omitted)", () => {
  const withAmt = buildEsignPrefill("lien_waiver", { customerName: "J", propertyAddress: "1 Main", date: "2026-06-15", amount: "$1,200.00" });
  expect(withAmt.at(-1)).toEqual({ name: "amount", default_value: "$1,200.00" });
  const noAmt = buildEsignPrefill("lien_waiver", { customerName: "J", propertyAddress: "1 Main", date: "2026-06-15" });
  expect(noAmt.at(-1)).toEqual({ name: "amount", default_value: "" });
});
