import { permanentRedirect } from "next/navigation";

// Operator Console: the Exceptions worklist is absorbed into the Today decision
// queue (same merge of operational vectors + scoreboard task exceptions).
export default function ExceptionsPage() {
  permanentRedirect("/today");
}
