"use client";
import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";

export type ParsedAddress = {
  line1: string; city: string; state: string; zip: string; county: string;
  lat?: number; lng?: number; formatted: string;
};

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    google?: any;
    __savvyPlacesLoading?: Promise<void>;
  }
}

const KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

function loadPlaces(): Promise<void> {
  if (typeof window === "undefined" || !KEY) return Promise.reject(new Error("no key"));
  if (window.google?.maps?.places) return Promise.resolve();
  if (!window.__savvyPlacesLoading) {
    window.__savvyPlacesLoading = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${KEY}&libraries=places`;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("places load failed"));
      document.head.appendChild(s);
    });
  }
  return window.__savvyPlacesLoading;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(place: any): ParsedAddress {
  const get = (type: string, short = false) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = place.address_components?.find((x: any) => x.types.includes(type));
    return c ? (short ? c.short_name : c.long_name) : "";
  };
  const streetNo = get("street_number");
  const route = get("route");
  return {
    line1: [streetNo, route].filter(Boolean).join(" "),
    city: get("locality") || get("sublocality") || get("postal_town"),
    state: get("administrative_area_level_1", true),
    zip: get("postal_code"),
    county: get("administrative_area_level_2"),
    lat: place.geometry?.location?.lat?.(),
    lng: place.geometry?.location?.lng?.(),
    formatted: place.formatted_address ?? "",
  };
}

export function AddressAutocomplete({
  value, onChange, onPick, id = "address",
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (a: ParsedAddress) => void;
  id?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ac: any;
    loadPlaces()
      .then(() => {
        if (!ref.current || !window.google) return;
        ac = new window.google.maps.places.Autocomplete(ref.current, {
          types: ["address"], componentRestrictions: { country: "us" },
          fields: ["address_components", "geometry", "formatted_address"],
        });
        ac.addListener("place_changed", () => {
          const place = ac.getPlace();
          if (place?.address_components) onPick(parse(place));
        });
      })
      .catch(() => { /* no key / offline -> plain input, still works */ });
    return () => { if (ac && window.google) window.google.maps.event.clearInstanceListeners(ac); };
  }, [onPick]);

  return (
    <Input
      ref={ref}
      id={id}
      name={id}
      data-testid="address-autocomplete"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Start typing an address…"
      autoComplete="off"
      required
    />
  );
}
