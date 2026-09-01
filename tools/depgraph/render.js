// Markdown rendering of the dependency closure.
//
// WHO READS THIS. A human deciding whether the closure is right before four stages of test design
// are built on it, and the skill that consumes the closure to know which files to inventory. So the
// tables are marker-delimited the same way every other artifact in this package is, and the
// incompleteness section is never omitted - a reader must not be able to mistake a truncated walk
// for a complete one by skimming.

'use strict';

const NL = String.fromCharCode(10);

/** Escape a cell so a path or snippet containing a pipe cannot break the table. */
function cell(value) {
  if (value === undefined || value === null) return "";
  return String(value).split("|").join("&#124;").split(NL).join(" ");
}

function table(headers, rows) {
  const out = [];
  out.push("| " + headers.join(" | ") + " |");
  out.push("|" + headers.map(() => "---").join("|") + "|");
  for (const row of rows) out.push("| " + row.map(cell).join(" | ") + " |");
  return out.join(NL);
}

function code(value) {
  return "`" + cell(value) + "`";
}

/**
 * Render the closure report.
 *
 * Section order follows the questions a reviewer actually asks, in order: what did you look at,
 * what did it reach, where does control leave the code, who else is affected, and what do you not
 * know?
 */
function renderClosureMarkdown(report) {
  const L = [];
  const p = (s) => L.push(s === undefined ? "" : s);
  const s = report.scope;
  const r = report.reached;
  const b = report.boundarySummary || { total: 0, exercised: 0, minimumCases: 0, byRole: [] };

  p("# Dependency Closure");
  p("");
  p("**Repository:** " + code(report.root) + "  ");
  p("**Scope:** " + code(s.spec) + " (" + s.kind + ", " + s.seedCount + " seed file(s))  ");
  p("**Reached:** " + r.total + " file(s) - " + r.seeds + " seed + " + r.pulledIn
    + " pulled in by dependency, to depth " + report.limits.depthReached
    + " (limit " + report.limits.maxDepth + ")");
  p("");
  p("> A path scope is a **seed, not a boundary**. Every file below was reached by following an");
  p("> import from the scope, which means the part under test executes it: its rules and error");
  p("> paths belong to this suite. Only what could not be read became a boundary.");
  p("");

  if (!report.incomplete.isComplete) {
    p("## This closure is INCOMPLETE");
    p("");
    p("Everything below is a **floor** on what the scope reaches, never a ceiling.");
    p("");
    const rows = [];
    if (report.incomplete.truncatedAtDepth !== null) {
      rows.push(["Depth limit reached", "depth " + report.incomplete.truncatedAtDepth,
        report.incomplete.truncatedFrontier.length + " file(s) never explored"]);
    }
    if (report.incomplete.cappedAtFiles) {
      rows.push(["File cap reached", String(report.limits.maxFiles), "further files not followed"]);
    }
    if (report.unresolvedEdges.length) {
      rows.push(["Unresolved edges", String(report.unresolvedEdges.length),
        "an edge exists whose target source does not state"]);
    }
    if (report.incomplete.skippedFiles.length) {
      rows.push(["Files not read", String(report.incomplete.skippedFiles.length),
        "too large, unreadable, or an unsupported language"]);
    }
    p(table(["Reason", "Value", "Consequence"], rows));
    p("");
  }
  // ---- Reached files, by depth -------------------------------------------
  p("## Files in the closure");
  p("");
  p("Depth 0 is the scope itself. A file at depth N is N calls away from the part under test,");
  p("which is how directly a test can drive it.");
  p("");
  p("<!-- table:closure-files -->");
  p("");
  p(table(
    ["Depth", "Files", "Paths"],
    (r.byDepth || []).map((d) => [
      String(d.depth),
      String(d.count),
      d.files.map((f) => code(f)).join(", "),
    ])
  ));
  p("");

  // ---- Internal edges ----------------------------------------------------
  p("## Internal call graph");
  p("");
  p("One row per import that resolves inside the repository. **Call sites** are the lines where");
  p("control actually crosses - an edge with no call site is a dependency no walked path uses.");
  p("");
  p("<!-- table:closure-edges -->");
  p("");
  p(table(
    ["From", "To", "Specifier", "Resolved via", "Import Evidence", "Call Sites"],
    report.internalEdges.map((e) => [
      code(e.from),
      code(e.to),
      code(e.specifier),
      e.via || "",
      code(e.ref),
      e.callSites.length
        ? e.callSites.map((c) => code(c.symbol) + " @ " + code(c.ref)).join("; ")
        : "_none on any walked path_",
    ])
  ));
  p("");

  // ---- Boundaries --------------------------------------------------------
  p("## External boundaries");
  p("");
  p("These could not be read, so they are not more scope - they are **contracts**. Each is a");
  p("surface in its own right, and the caller behaviour on success AND on each failure mode is");
  p("what a test asserts. `Min Cases` is one success plus one per failure mode, per caller.");
  p("");
  p("Total: " + b.total + " boundar(ies), " + b.exercised + " exercised on a walked path, at least "
    + b.minimumCases + " boundary case(s) to cover or explicitly decline.");
  p("");
  p("<!-- table:closure-boundaries -->");
  p("");
  p(table(
    ["Boundary ID", "Specifier", "Role", "Exercised", "Callers", "Isolation", "Min Cases", "Failure Modes", "Evidence"],
    (report.boundaries || []).map((x) => [
      x.id,
      code(x.specifier),
      x.profileLabel + " (" + x.role + ")",
      x.exercised ? "Yes" : "No - imported, never called",
      x.callers.length ? x.callers.map((c) => code(c)).join(", ") : "_none_",
      code(x.isolation),
      String(x.minimumCases),
      x.failureOutcomes.map((o) => o.id).join(", "),
      x.evidence.map((e) => code(e)).join(", "),
    ])
  ));
  p("");

  // Per-boundary detail: the failure descriptions are what make a case executable.
  for (const x of (report.boundaries || [])) {
    if (!x.exercised) continue;
    p("### " + x.id + " - " + x.specifier);
    p("");
    p("**Role:** " + x.profileLabel + " · **Isolation:** " + code(x.isolation)
      + " · **Callers:** " + x.callers.map((c) => code(c)).join(", "));
    p("");
    p("Success: " + x.successOutcomes.join("; "));
    p("");
    p(table(
      ["Failure Mode", "What happens at the boundary", "Drive at"],
      x.failureOutcomes.map((o) => [
        code(o.id),
        o.description,
        x.callSites.map((c) => code(c.ref)).join(", "),
      ])
    ));
    p("");
  }
  // ---- Blast radius ------------------------------------------------------
  p("## Impacted by a change to this closure");
  p("");
  p("Files OUTSIDE the closure that call INTO it. A change to the part under test can break these,");
  p("and the scope never named them - so a suite that ignores this list reports green while the");
  p("regression ships. Their own dependencies are not followed: one hop is signal, two is noise.");
  p("");
  p("<!-- table:closure-impacted -->");
  p("");
  const impactRows = [];
  for (const i of (report.impactedByChange || [])) {
    for (const reach of i.reaches) {
      impactRows.push([
        code(i.file),
        code(reach.target),
        code(reach.specifier),
        code(reach.ref),
        reach.callSites.length ? reach.callSites.map((c) => code(c.symbol)).join(", ") : "_import only_",
      ]);
    }
  }
  p(impactRows.length
    ? table(["Impacted File", "Reaches", "Specifier", "Evidence", "Call Sites"], impactRows)
    : "_Nothing outside the closure imports it._");
  p("");

  // ---- Unresolved --------------------------------------------------------
  p("## Edges that could not be resolved");
  p("");
  p("Each row is a place where source proves an edge EXISTS but does not say where it goes: a"
    + " computed import, a reflective lookup, an injection token. Each is a gap for Stage 1 to"
    + " raise, and each is a piece of the execution path this closure does not contain.");
  p("");
  p("<!-- table:closure-unresolved -->");
  p("");
  p((report.unresolvedEdges || []).length
    ? table(
      ["From", "Specifier", "Why", "Evidence", "Source Line"],
      report.unresolvedEdges.map((u) => [
        code(u.from),
        u.specifier ? code(u.specifier) : "_not stated in source_",
        u.reason,
        code(u.ref),
        code(u.snippet),
      ])
    )
    : "_Every edge found was resolved to a file or classified as external._");
  p("");

  // ---- Handoff -----------------------------------------------------------
  p("## What Stage 1 must inventory");
  p("");
  p("The closure is the denominator for the surface inventory. Specifically:");
  p("");
  p("- Inventory surfaces in **all " + r.total + " file(s)** listed above, not only the "
    + r.seeds + " seed file(s). A rule enforced at depth 3 is a rule the part under test can"
    + " violate.");
  p("- Record each of the " + b.total + " boundar(ies) as an `EXT` surface with the failure modes"
    + " given, so Stage 3 covers the failure branch and not only the happy path.");
  p("- Treat the " + (report.impactedByChange || []).length + " impacted file(s) as regression"
    + " scope: they execute this code without being named by it.");
  if ((report.unresolvedEdges || []).length) {
    p("- Raise a gap for each of the " + report.unresolvedEdges.length + " unresolved edge(s)."
      + " The execution path beyond each is unknown, and a case that assumes it is a guess.");
  }
  p("");
  p("---");
  p("");
  p("_" + report.disclaimer + "_");
  p("");

  return L.join(NL) + NL;
}

module.exports = { renderClosureMarkdown, table, cell, code };
