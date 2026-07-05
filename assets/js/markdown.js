// Minimal, dependency-free Markdown renderer.
// Supports the subset used by the content/*.md files: headings (#..######),
// paragraphs, unordered lists (- / *), blockquotes (>), and the inline forms
// **bold**, `code`, and [text](url). HTML in the source is escaped, so content
// authors can write plain Markdown without worrying about markup.
(function (global) {
  function escapeHtml(s) {
    return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }
  function inline(s) {
    s = escapeHtml(s);
    s = s.replace(/`([^`]+)`/g, (_, c) => "<code>" + c + "</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_, t, u) => '<a href="' + u + '" target="_blank" rel="noopener">' + t + "</a>");
    return s;
  }
  function render(md) {
    const lines = String(md).replace(/\r\n/g, "\n").split("\n");
    let html = "", i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { const l = h[1].length; html += `<h${l}>${inline(h[2].trim())}</h${l}>`; i++; continue; }

      if (/^\s*>/.test(line)) {                       // blockquote (recurses)
        const block = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { block.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        html += "<blockquote>" + render(block.join("\n")) + "</blockquote>";
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {                 // unordered list
        html += "<ul>";
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          html += "<li>" + inline(lines[i].replace(/^\s*[-*]\s+/, "")) + "</li>"; i++;
        }
        html += "</ul>";
        continue;
      }
      const para = [];                                // paragraph
      while (i < lines.length && !/^\s*$/.test(lines[i]) &&
             !/^(#{1,6})\s/.test(lines[i]) && !/^\s*>/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) {
        para.push(lines[i].trim()); i++;
      }
      html += "<p>" + inline(para.join(" ")) + "</p>";
    }
    return html;
  }

  const api = { render };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.markdown = api;
})(typeof window !== "undefined" ? window : globalThis);
