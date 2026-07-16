// The installer's two faces behind one interface. Stage logic in install.mjs
// talks only to this adapter, so the full-screen TUI and the plain sequential
// flow (kept for dumb terminals, tiny windows, and --plain) stay behaviourally
// identical. Node builtins only.
import { createInterface } from "node:readline/promises";
import { red, dim, bold, ok as okc, bad, banner } from "./installer-lib.mjs";
import { makeScreen } from "./tui.mjs";

// interface:
//   step(n, total, title)
//   form(fields, {note}) -> {key: value}          fields as tui.mjs formInit
//   paste(label, {note, endWord}) -> string       cooked-mode multiline
//   confirm(question, dflt) -> bool
//   progress(title, fn(log)) -> result of fn      fn may throw; adapter rethrows
//   show(title, lines[])                          informational screen
//   finish(lines[]) / fail(message)               terminal states

export function chooseUI(argv = process.argv) {
  const plain = argv.includes("--plain")
    || !process.stdin.isTTY || !process.stdout.isTTY
    || process.env.TERM === "dumb"
    || (process.stdout.columns || 80) < 80 || (process.stdout.rows || 24) < 22;
  return plain ? sequentialUI() : tuiUI();
}

// ---- sequential (phase one) --------------------------------------------------
export function sequentialUI() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const say = (s = "") => process.stdout.write(s + "\n");
  let stepLabel = "";
  say("\n" + banner());
  async function askOne(f, all) {
    for (;;) {
      if (f.type === "toggle") {
        const v = (await rl.question(red(" ▸ ") + `${f.label} (${f.options.join("/")}) [${f.options[f.value ?? 0]}]: `)).trim();
        const chosen = v === "" ? f.options[f.value ?? 0] : f.options.find((o) => o.toLowerCase().startsWith(v.toLowerCase()));
        if (chosen) return chosen;
        say(bad("   ✗ choose one of: " + f.options.join(", ")));
        continue;
      }
      if (f.hint) say(dim("   " + f.hint));
      const v = (await rl.question(red(" ▸ ") + f.label + (f.value ? ` [${f.value}]` : "") + ": ")).trim() || String(f.value ?? "");
      const r = f.validate ? f.validate(v, all) : true;
      if (r === true) return v;
      say(bad("   ✗ " + (typeof r === "string" ? r : "invalid value")));
    }
  }
  return {
    async step(n, total, title) { stepLabel = `${n}/${total}`; say("\n" + red("── ") + bold(`${n}. ${title}`) + red(" " + "─".repeat(Math.max(2, 50 - title.length)))); },
    async form(fields, { note } = {}) {
      if (note) say(dim("   " + note.replace(/\n/g, "\n   ")));
      const out = {};
      for (const f of fields) out[f.key] = await askOne(f, out);
      return out;
    },
    async paste(label, { note, endWord = "END" } = {}) {
      if (note) say(dim("   " + note.replace(/\n/g, "\n   ")));
      say(red(" ▸ ") + label + dim(`  (paste, then a line with just ${endWord})`));
      const lines = [];
      for (;;) {
        const l = await rl.question("");
        if (l.trim() === endWord) return lines.join("\n");
        lines.push(l);
      }
    },
    async confirm(q, dflt = true) {
      const v = (await rl.question(red(" ▸ ") + q + (dflt ? " [Y/n]: " : " [y/N]: "))).trim().toLowerCase();
      return v === "" ? dflt : v.startsWith("y");
    },
    async progress(title, fn) {
      say(dim("   " + title + "…"));
      return fn((line) => say(dim("     " + line)));
    },
    async show(title, lines) { say(bold("   " + title)); for (const l of lines) say("   " + l); },
    async finish(lines) { say("\n" + okc(bold("Done.")) + "\n" + lines.map((l) => "   " + l).join("\n") + "\n"); rl.close(); },
    async fail(message) { say(bad("✗ " + message)); rl.close(); process.exit(1); },
    ok(s) { say(okc("   ✓ " + s)); },
    err(s) { say(bad("   ✗ " + s)); },
  };
}

// ---- full-screen (phase two) ---------------------------------------------------
export function tuiUI() {
  const screen = makeScreen();
  let stepLabel = "", stepTitle = "";
  let pendingNotes = [];                       // ok/err lines shown on the next screen
  const noteBlock = () => { const n = pendingNotes.join("\n"); pendingNotes = []; return n; };
  process.on("exit", () => screen.leave());
  return {
    async step(n, total, title) { stepLabel = `The Dojo Bay installer · step ${n} of ${total}`; stepTitle = title; },
    async form(fields, { note } = {}) {
      const merged = [noteBlock(), note].filter(Boolean).join("\n");
      return screen.runForm(fields, { stepLabel, title: stepTitle, note: merged });
    },
    async paste(label, { note, endWord = "END" } = {}) {
      // cooked-mode paste: raw-mode paste handling is unreliable across SSH clients
      return screen.suspend(async () => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        process.stdout.write("\n" + bold(stepTitle) + "\n");
        const merged = [noteBlock(), note].filter(Boolean).join("\n");
        if (merged) process.stdout.write(dim(merged.replace(/^/gm, "  ")) + "\n");
        process.stdout.write(red(" ▸ ") + label + dim(`  (paste, then a line with just ${endWord})`) + "\n");
        const lines = [];
        for (;;) {
          const l = await rl.question("");
          if (l.trim() === endWord) { rl.close(); return lines.join("\n"); }
          lines.push(l);
        }
      });
    },
    async confirm(q, dflt = true) {
      const v = await screen.runForm(
        [{ key: "a", label: q, type: "toggle", options: ["Yes", "No"], value: dflt ? 0 : 1 }],
        { stepLabel, title: stepTitle, note: noteBlock() });
      return v.a === "Yes";
    },
    async progress(title, fn) {
      return screen.runProgress({ stepLabel, title: `${stepTitle} — ${title}` }, fn);
    },
    async show(title, lines) {
      await screen.runForm([], { stepLabel, title, note: [noteBlock(), ...lines].filter(Boolean).join("\n") });
    },
    async finish(lines) {
      await screen.runForm([], { stepLabel: "The Dojo Bay installer · complete", title: "Done", note: lines.join("\n") });
      screen.leave();
    },
    async fail(message) { screen.leave(); console.error(bad("✗ " + message)); process.exit(1); },
    ok(s) { pendingNotes.push("✓ " + s); },
    err(s) { pendingNotes.push("✗ " + s); },
  };
}
