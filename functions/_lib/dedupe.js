// Deciding when two leads are the same person.
//
// The bias here is deliberate and one-directional: leaving two records for one
// person is an annoyance, merging two people into one record loses data and is
// hard to undo. So this merges only on strong evidence and flags everything
// else for a human to look at.
//
// Strong evidence is either:
//   - the same phone AND compatible names, or
//   - the same email.
// Same phone with clearly different names -- a household sharing a landline --
// is flagged, never merged.

// Last ten digits. Anything shorter cannot identify a person, so it is
// treated as no phone at all rather than as a weak match.
export function normPhone(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

export function normEmail(v) {
  const e = String(v == null ? '' : v).trim().toLowerCase();
  return e.includes('@') && e.includes('.') ? e : '';
}

// Strip case, punctuation and extra spaces so "O'Brien, Pat" and "Pat OBrien"
// compare equal.
function tokens(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

export function namesCompatible(a, b) {
  const x = tokens(a);
  const y = tokens(b);
  // Nothing to contradict: a lead with no name could be anyone, including
  // the person we are about to merge it with.
  if (!x.length || !y.length) return true;

  const xs = [...x].sort().join(' ');
  const ys = [...y].sort().join(' ');
  if (xs === ys) return true;

  // One name is the start of the other: "Dana" and "Dana Whitfield".
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  return short.every((t, i) => long[i] === t);
}

// Union-find over leads, joined by phone and email.
function makeFinder() {
  const parent = new Map();
  const find = (k) => {
    if (!parent.has(k)) parent.set(k, k);
    while (parent.get(k) !== k) {
      parent.set(k, parent.get(parent.get(k)));
      k = parent.get(k);
    }
    return k;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  return { find, union };
}

// Prefer a longer, more complete value.
function best(rows, key) {
  let out = '';
  for (const r of rows) {
    const v = String(r[key] == null ? '' : r[key]).trim();
    if (v.length > out.length) out = v;
  }
  return out;
}

// A repeat submission often arrives as "Arthur Schiff 2". That trailing count
// is an artifact of the form, not part of anyone's name, and it must not end
// up on an invoice. Strip it -- but only when what remains is still a name,
// so a genuine "Henry 8th" or a house number is left alone.
export function stripDupSuffix(name) {
  const raw = String(name == null ? '' : name).trim();
  const m = raw.match(/^(.*?)\s+\d{1,2}$/);
  if (!m) return raw;
  const base = m[1].trim();
  return /[a-z]/i.test(base) && base.length >= 2 ? base : raw;
}

// The name shown everywhere: the fullest variant, with a duplicate-submission
// suffix removed. Preferring a suffix-free variant that already exists beats
// inventing one, so "Fisher Martin" wins over "Fisher Martin 2".
function bestName(rows) {
  const names = rows
    .map((r) => String(r.name == null ? '' : r.name).trim())
    .filter(Boolean);
  if (!names.length) return '';
  const cleaned = names.map(stripDupSuffix).filter(Boolean);
  let out = '';
  for (const n of cleaned) if (n.length > out.length) out = n;
  return out;
}

/**
 * Group leads into proposed contacts.
 *
 * @param {Array} leads rows with at least {id, name, phone, email}
 * @returns {{clusters: Array, flagged: Array}}
 *   clusters: [{leadIds, contact}] -- safe to merge
 *   flagged:  [{leadIds, reason}]  -- a person should decide
 */
export function clusterLeads(leads) {
  const rows = [...leads].sort((a, b) => a.id - b.id);
  const { find, union } = makeFinder();
  for (const r of rows) find(r.id);

  const byPhone = new Map();
  const byEmail = new Map();
  const flagged = [];

  for (const r of rows) {
    const p = normPhone(r.phone);
    const e = normEmail(r.email);

    if (e) {
      // An email address belongs to one person. This is the strongest signal
      // available and needs no name agreement.
      if (byEmail.has(e)) union(r.id, byEmail.get(e)); else byEmail.set(e, r.id);
    }

    if (p) {
      const seen = byPhone.get(p);
      if (seen === undefined) {
        byPhone.set(p, r.id);
      } else {
        const other = rows.find((x) => x.id === seen);
        if (namesCompatible(r.name, other.name)) {
          union(r.id, seen);
        } else if (find(r.id) !== find(seen)) {
          // A household sharing a line, most likely. Only worth reporting if
          // an email has not already proven them to be the same person.
          flagged.push({
            leadIds: [seen, r.id],
            reason: `Same phone ${p}, but the names differ: ` +
                    `"${other.name || '(none)'}" and "${r.name || '(none)'}"`
          });
        }
      }
    }
  }

  const groups = new Map();
  for (const r of rows) {
    const root = find(r.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  }

  const clusters = [...groups.values()].map((members) => {
    const byDate = [...members].sort((a, b) =>
      String(a.created_at || '').localeCompare(String(b.created_at || '')));
    // Later leads carry fresher contact details; the name is chosen by
    // completeness instead, so "Dana Whitfield" beats a later "Dana".
    const recent = (key) => {
      for (let i = byDate.length - 1; i >= 0; i--) {
        const v = String(byDate[i][key] == null ? '' : byDate[i][key]).trim();
        if (v) return v;
      }
      return '';
    };
    return {
      leadIds: members.map((m) => m.id).sort((a, b) => a - b),
      contact: {
        name: bestName(members),
        phone: recent('phone'),
        phone_norm: normPhone(recent('phone')),
        email: recent('email'),
        email_norm: normEmail(recent('email')),
        address: recent('address'),
        city: recent('city'),
        state: recent('state'),
        zip: recent('zip')
      }
    };
  });

  clusters.sort((a, b) => a.leadIds[0] - b.leadIds[0]);
  return { clusters, flagged };
}
