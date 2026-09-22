// The dashboard's CSS and client script live inside template literals in
// functions/leads.js, where `node --check` cannot see them. This pulls them
// out so they can be syntax-checked and mounted in a test harness.
//
// A syntax error inside the client script used to reach production: the file
// parses fine, because to Node the script is just a string.

function extractBlock(source, constName) {
  const m = source.match(new RegExp(`(?:export\\s+)?const\\s+${constName}\\s*=\\s*\``));
  if (!m) throw new Error(`extractBlock: no const ${constName} template literal found`);
  const from = m.index + m[0].length;
  const end = source.indexOf('\n`;', from);
  if (end < 0) throw new Error(`extractBlock: unterminated template literal for ${constName}`);
  // Inside the literal a newline is written \\n; as standalone source it is \n.
  return source.slice(from, end).replace(/\\\\n/g, '\\n').replace(/^\n/, '');
}

module.exports = { extractBlock };
