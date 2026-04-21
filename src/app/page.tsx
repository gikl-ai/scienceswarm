import Link from "next/link";

const pipeline = [
  {
    step: "Literature",
    icon: "📄",
    skill: "Review",
    description: "Upload papers. AI reads them, extracts key findings, identifies gaps.",
    color: "from-violet-500/20 to-violet-500/5",
    border: "border-violet-500/40",
    text: "text-violet-400",
  },
  {
    step: "Hypothesis",
    icon: "🔬",
    skill: "Formulate",
    description: "Define research questions. AI helps identify gaps and form testable hypotheses.",
    color: "from-teal-500/20 to-teal-500/5",
    border: "border-teal-500/40",
    text: "text-teal-400",
  },
  {
    step: "Experiment",
    icon: "🧪",
    skill: "Run",
    description: "Write scripts, run experiments, track parameters and results.",
    color: "from-blue-500/20 to-blue-500/5",
    border: "border-blue-500/40",
    text: "text-blue-400",
  },
  {
    step: "Analyze",
    icon: "📊",
    skill: "Stats",
    description: "Auto-generate charts. Statistical analysis. Pattern detection in results.",
    color: "from-pink-500/20 to-pink-500/5",
    border: "border-pink-500/40",
    text: "text-pink-400",
  },
  {
    step: "Code",
    icon: "⚡",
    skill: "Build",
    description: "Write research code. AI reviews for correctness and reproducibility.",
    color: "from-amber-500/20 to-amber-500/5",
    border: "border-amber-500/40",
    text: "text-amber-400",
  },
  {
    step: "Write",
    icon: "✏️",
    skill: "Draft",
    description: "Draft papers, proofs, and sections. LaTeX-aware editing.",
    color: "from-cyan-500/20 to-cyan-500/5",
    border: "border-cyan-500/40",
    text: "text-cyan-400",
  },
  {
    step: "Review",
    icon: "📋",
    skill: "Check",
    description: "Peer review simulation. Check proofs, arguments, and presentation.",
    color: "from-green-500/20 to-green-500/5",
    border: "border-green-500/40",
    text: "text-green-400",
  },
  {
    step: "Submit",
    icon: "🚀",
    skill: "Publish",
    description: "Format for venues, generate cover letters, prepare supplementary materials.",
    color: "from-orange-500/20 to-orange-500/5",
    border: "border-orange-500/40",
    text: "text-orange-400",
  },
  {
    step: "Iterate",
    icon: "🔄",
    skill: "Revise",
    description: "Address reviewer comments. Track revisions. Resubmit.",
    color: "from-indigo-500/20 to-indigo-500/5",
    border: "border-indigo-500/40",
    text: "text-indigo-400",
  },
];

const features = [
  {
    title: "Full research lifecycle",
    description:
      "From literature review through publication. Every stage of research in one workspace, with AI that understands your domain.",
  },
  {
    title: "Papers that actually get read",
    description:
      "Upload PDFs and the AI extracts every theorem, equation, and result. It cross-references with your work and finds what matters.",
  },
  {
    title: "Experiments that reproduce",
    description:
      "Track every run, every parameter, every result. Auto-generate comparison charts. Never lose track of what worked.",
  },
];

export default function Home() {
  return (
    <div className="flex flex-col min-h-full">
      {/* Nav */}
      <nav className="fixed top-0 w-full z-50 border-b-2 border-border bg-background/80 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xl">🔬</span>
            <span className="text-xl font-bold tracking-tight">ScienceSwarm</span>
            <span className="text-xs font-mono text-muted bg-surface px-2 py-0.5 rounded border border-border">
              beta
            </span>
          </div>
          <div className="flex items-center gap-6">
            <a
              href="#pipeline"
              className="text-sm text-muted hover:text-foreground transition-colors"
            >
              Pipeline
            </a>
            <a
              href="#why"
              className="text-sm text-muted hover:text-foreground transition-colors"
            >
              Why ScienceSwarm
            </a>
            <Link
              href="/dashboard"
              className="text-sm font-medium bg-accent text-white px-4 py-2 rounded-lg hover:bg-accent-hover transition-colors"
            >
              Open App
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-40 pb-20 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 text-sm font-mono text-accent bg-accent/10 px-4 py-1.5 rounded-full mb-8 border-2 border-accent/20">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
            </span>
            AI-powered research workspace
          </div>
          <h1 className="text-5xl sm:text-7xl font-bold tracking-tight leading-[1.1] mb-6">
            Research projects,
            <br />
            <span className="text-accent">end to end.</span>
          </h1>
          <p className="text-xl sm:text-2xl text-muted max-w-2xl mx-auto mb-12 leading-relaxed">
            Literature review to publication. One workspace for your entire research project.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/dashboard"
              className="w-full sm:w-auto text-center font-semibold bg-accent text-white px-8 py-4 rounded-xl hover:bg-accent-hover transition-colors text-lg"
            >
              Start Building
            </Link>
          </div>
        </div>
      </section>

      {/* Pipeline */}
      <section id="pipeline" className="py-24 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-5xl font-bold tracking-tight mb-4">
              The Research Pipeline
            </h2>
            <p className="text-muted text-lg max-w-xl mx-auto">
              Every great paper follows this path. ScienceSwarm accelerates each stage.
            </p>
          </div>

          {/* Pipeline visual */}
          <div className="relative">
            <div className="grid grid-cols-3 sm:grid-cols-3 lg:grid-cols-9 gap-3">
              {pipeline.map((stage, i) => (
                <div key={stage.step} className="flex flex-col items-center group">
                  {/* Node */}
                  <div
                    className={`relative w-full aspect-square max-w-[120px] rounded-2xl border-2 ${stage.border} bg-gradient-to-b ${stage.color} flex flex-col items-center justify-center gap-1 transition-all group-hover:scale-105 group-hover:shadow-lg group-hover:shadow-black/30`}
                  >
                    <span className="text-3xl">{stage.icon}</span>
                    <span className={`text-sm font-bold ${stage.text}`}>
                      {stage.step}
                    </span>
                    {i < pipeline.length - 1 && (
                      <span className="hidden lg:block absolute -right-3 top-1/2 -translate-y-1/2 text-muted text-lg font-bold">
                        ›
                      </span>
                    )}
                  </div>
                  {/* Detail */}
                  <div className="mt-3 text-center px-1">
                    <span className="text-xs font-mono text-muted block mb-1">
                      {stage.skill}
                    </span>
                    <p className="text-xs text-muted/70 leading-snug hidden sm:block">
                      {stage.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Why ScienceSwarm */}
      <section id="why" className="py-24 px-6 border-t-2 border-border">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-3xl sm:text-5xl font-bold tracking-tight text-center mb-16">
            Why ScienceSwarm
          </h2>
          <div className="space-y-6">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="border-2 border-border rounded-2xl p-8 hover:border-accent/30 transition-colors"
              >
                <h3 className="text-xl font-bold mb-3">{feature.title}</h3>
                <p className="text-lg text-muted leading-relaxed">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 px-6 border-t-2 border-border">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-3xl sm:text-5xl font-bold tracking-tight mb-6">
            Stop drowning in papers.
            <br />
            Start publishing.
          </h2>
          <p className="text-muted text-xl mb-10">
            Great research deserves great tools. ScienceSwarm handles the grind so you focus on the science.
          </p>
          <Link
            href="/dashboard"
            className="inline-flex font-semibold bg-accent text-white px-10 py-4 rounded-xl hover:bg-accent-hover transition-colors text-lg"
          >
            Start Building
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t-2 border-border py-8 px-6 mt-auto">
        <div className="max-w-6xl mx-auto flex items-center justify-between text-sm text-muted">
          <span className="font-mono font-bold">🔬 ScienceSwarm</span>
          <span>Science deserves better tools.</span>
        </div>
      </footer>
    </div>
  );
}
