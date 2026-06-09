import { serve } from "inngest/next";
import { inngest, functions } from "@savvy/agents";

// Serves all registered Inngest functions. The Inngest dev server (and prod)
// discovers them at this endpoint.
export const { GET, POST, PUT } = serve({ client: inngest, functions });
