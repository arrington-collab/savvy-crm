export const dynamic = "force-dynamic";

export default function CrewLayout({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto min-h-screen max-w-md p-4">{children}</div>;
}
