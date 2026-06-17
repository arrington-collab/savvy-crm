"use client";
import { toast } from "sonner";
import { PERSONAS, personaLine, type PersonaKey } from "@/lib/agents";
import { AgentAvatar } from "./AgentAvatar";

/** Bottom-center toast in an agent's voice (avatar in their color + a line). */
export function agentToast(personaKey: PersonaKey, message?: string) {
  const persona = PERSONAS[personaKey];
  toast.custom(
    () => (
      <div
        className="flex items-center gap-3 rounded-xl px-4 py-3"
        style={{
          background: "var(--popover)",
          border: "1px solid var(--border-panel)",
          boxShadow: "0 20px 50px rgba(0,0,0,0.5), var(--glow-accent)",
          color: "var(--text-body)",
          minWidth: 280,
        }}
      >
        <AgentAvatar persona={persona} />
        <div className="text-sm">
          <div className="eyebrow" style={{ color: persona.colorToken }}>
            {persona.name}
          </div>
          <div>{message ?? personaLine(persona)}</div>
        </div>
      </div>
    ),
    { duration: 2800 },
  );
}
