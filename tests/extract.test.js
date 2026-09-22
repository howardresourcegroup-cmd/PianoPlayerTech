const test = require('node:test');
const assert = require('node:assert');
const { extractBlock } = require('../tools/extract.js');

test('extractBlock returns the body of a named template literal', () => {
  const src = [
    'const OTHER = `nope`;',
    'const CSS = `',
    'body{color:red}',
    '`;',
    'const AFTER = 1;'
  ].join('\n');
  assert.strictEqual(extractBlock(src, 'CSS'), 'body{color:red}');
});

test('extractBlock unescapes doubled newline escapes', () => {
  const src = 'const JS = `\nvar a = "x\\\\ny";\n`;';
  assert.ok(extractBlock(src, 'JS').includes('\\n'));
  assert.ok(!extractBlock(src, 'JS').includes('\\\\n'));
});

test('extractBlock handles exported constants', () => {
  const src = 'export const CSS = `\nbody{color:red}\n`;';
  assert.strictEqual(extractBlock(src, 'CSS'), 'body{color:red}');
});

test('extractBlock throws when the constant is absent', () => {
  assert.throws(() => extractBlock('const A = 1;', 'CSS'), /CSS/);
});
