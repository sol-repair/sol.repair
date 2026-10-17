import Link from "next/link";

/**
 * Homepage TOOLS section: the three read-only destinations, each a
 * titled link with an arrow and one honest line about what it does.
 * Replaces the old UnderstandSection (the other two tools lived only in
 * the footer or under the connect button). Read-only surfaces only:
 * nothing here signs, per the button doctrine in globals.css.
 */

const TOOLS = [
  {
    href: "/understand",
    title: "Understand a transaction",
    description:
      "Paste any signature and read what the transaction did, in plain language. Read-only.",
  },
  {
    href: "/report",
    title: "Wallet health report",
    description:
      "A read-only summary of everything the scan finds. Nothing to sign.",
  },
  {
    href: "/fees",
    title: "View the fee ledger",
    description: "Every fee recorded on-chain, straight from chain data.",
  },
];

export function ToolLinksSection() {
  return (
    <section className="mt-10">
      <h2 className="font-mono text-[11px] font-medium uppercase tracking-wider text-zinc-400">
        <span className="text-zinc-600">04</span>{" "}
        <span className="text-emerald-400">Tools</span>
      </h2>
      <div className="mt-3 space-y-4">
        {TOOLS.map((tool) => (
          <div key={tool.href}>
            <Link
              href={tool.href}
              className="flex items-baseline justify-between gap-3 text-sm text-zinc-200 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-white"
            >
              <span>{tool.title}</span>
              <span aria-hidden="true" className="text-zinc-500">
                →
              </span>
            </Link>
            <p className="mt-1 text-xs leading-relaxed text-zinc-400">
              {tool.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
