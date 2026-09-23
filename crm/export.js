// Exporting what you are actually looking at.
//
// The tab already links to a server-side CSV of the whole view, which is the
// right thing for a backup. It is the wrong thing after you have spent a
// minute narrowing to eleven leads: the file that lands has five thousand.
// This exports the filtered list instead, from rows the browser already has.
//
// Nothing here imports page state: the escaping rules are the part worth
// testing, and a module that reads the DOM at import time cannot be loaded
// in a test runner. The caller passes in the name instead.

// RFC 4180: quote anything containing a comma, quote or newline, and double
// an embedded quote.
export function csvCell(v){
  var s = v == null ? '' : String(v);
  // A leading =, +, - or @ is read as a formula by Excel and Sheets. Prefix
  // it with a quote so a lead whose name starts with '=' is text, not code.
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(rows, cols){
  var out = [cols.map(csvCell).join(',')];
  rows.forEach(function(r){
    out.push(cols.map(function(c){ return csvCell(r[c]); }).join(','));
  });
  // A trailing newline, because a file without one annoys every other tool.
  return out.join('\r\n') + '\r\n';
}

export const EXPORT_COLUMNS = [
  'id', 'created_at', 'pipeline', 'status', 'name', 'phone', 'email',
  'address', 'city', 'system', 'service', 'message', 'notes', 'source',
  'referred_at', 'referral_status', 'referral_paid_at', 'referral_invoice_id',
  'archived_at'
];

export function download(rows, viewName, label){
  var csv = toCsv(rows, EXPORT_COLUMNS);
  var day = new Date().toISOString().slice(0, 10);
  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'ppt-' + viewName + (label ? '-' + label : '') + '-' + day + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(function(){ URL.revokeObjectURL(url); }, 30000);
}
