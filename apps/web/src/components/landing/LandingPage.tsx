import Link from "next/link";

const VALUE_PROPS = [
  { title: "One pipeline, lead to paid", body: "Every job flows through inspect → estimate → produce → close → bill in one place." },
  { title: "AI agents that do real work", body: "Five agents handle comms, scheduling, finance, and ops — not just chat." },
  { title: "Get paid faster", body: "Built-in estimates, e-sign, and invoicing keep cash moving." },
];

export function LandingPage() {
  return (
    <main className="min-h-screen" style={{ background: "var(--surface-app)" }}>
      <header className="mx-auto flex max-w-5xl items-center justify-between p-6">
        <span className="text-lg font-bold" style={{ color: "var(--accent-gold)" }}>Savvy</span>
        <nav className="flex gap-4">
          <Link data-testid="landing-signin" href="/sign-in" className="underline">Sign in</Link>
          <Link data-testid="landing-signup-nav" href="/sign-up" className="rounded px-3 py-1 font-semibold" style={{ background: "var(--accent-gold)", color: "#1a1206" }}>Start free</Link>
        </nav>
      </header>
      <section className="mx-auto max-w-3xl px-6 py-20 text-center">
        <h1 className="text-4xl font-bold">The operations layer that runs your roofing company.</h1>
        <p className="mx-auto mt-4 max-w-xl text-lg" style={{ color: "var(--text-faint)" }}>
          Savvy is a multi-tenant ops platform with AI agents across the whole job lifecycle.
        </p>
        <Link data-testid="landing-signup" href="/sign-up" className="mt-8 inline-block rounded px-6 py-3 font-semibold" style={{ background: "var(--accent-gold)", color: "#1a1206" }}>
          Start free
        </Link>
      </section>
      <section className="mx-auto grid max-w-5xl gap-6 px-6 pb-20 md:grid-cols-3">
        {VALUE_PROPS.map((v) => (
          <div key={v.title} className="rounded-lg border p-5">
            <h3 className="font-semibold">{v.title}</h3>
            <p className="mt-2 text-sm" style={{ color: "var(--text-faint)" }}>{v.body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
