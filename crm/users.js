// The Users tab: who may sign in to the CRM, and with which role.
//
// Owner only. The server refuses every one of these requests from anyone
// else (users.manage), and refuses any change that would leave nobody as an
// active owner; this screen just says so plainly when it happens.
//
// Every value here reaches the page through textContent or .value.

import { D, ME } from './state.js';
import { el, fmtWhen } from './dom.js';
import { post } from './api.js';

var users = D.users || [];
var log = D.userLog || [];

function roleName(r){ return r ? r.charAt(0).toUpperCase() + r.slice(1) : ''; }

function activeOwners(){
  return users.filter(function(u){ return u.role === 'owner' && u.active; }).length;
}

export function initUsers(){
  var box = document.getElementById('users');
  if (!box) return;
  paint(box);
}

function paint(box){
  box.textContent = '';
  box.className = 'users';

  if (D.usersError) {
    box.appendChild(el('p', {className:'warn', text:D.usersError}));
    return;
  }

  box.appendChild(el('p', {className:'note',
    text:'They also need to be allowed through Cloudflare Access (Zero Trust → Access → Applications → policy).'}));

  box.appendChild(addForm(box));
  box.appendChild(table(box));
  box.appendChild(roleHelp());
  if (log.length) box.appendChild(history());
}

function addForm(box){
  var wrap = el('div', {className:'card'});
  wrap.appendChild(el('h3', {text:'Add someone'}));
  var email = el('input', {type:'email', placeholder:'name@example.com', 'aria-label':'Email', autocomplete:'off'});
  var name = el('input', {type:'text', placeholder:'Name', 'aria-label':'Name', maxLength:120});
  var role = roleSelect('tech', 'Role for the new user');
  var btn = el('button', {className:'go', type:'button', text:'Add'});
  var msg = el('p', {className:'msgline'});

  btn.addEventListener('click', function(){
    if (!email.value.trim()) { say(msg, 'Type their email first.', true); email.focus(); return; }
    btn.disabled = true;
    say(msg, 'Adding…');
    post({action:'userCreate', email:email.value, name:name.value, role:role.value}).then(function(j){
      users = j.users; log = j.userLog || log;
      paint(box);
      flashMessage(box, 'Added ' + j.user.email + ' as ' + roleName(j.user.role) +
        '. Now allow them through Cloudflare Access too.');
    }, function(e){ btn.disabled = false; say(msg, e.message, true); });
  });

  wrap.appendChild(el('div', {className:'addform'}, [email, name, role, btn]));
  wrap.appendChild(msg);
  return wrap;
}

function table(box){
  var gw = el('div', {className:'gridwrap'});
  var t = el('table');
  var hr = el('tr');
  ['Email', 'Name', 'Role', 'Status', 'Last seen', ''].forEach(function(h){ hr.appendChild(el('th', {text:h})); });
  t.appendChild(el('thead', null, [hr]));
  var tb = el('tbody');
  var owners = activeOwners();

  users.forEach(function(u){
    var tr = el('tr', {className: u.active ? '' : 'off'});
    var mail = el('td', {text:u.email});
    if (ME && u.email === ME.email) mail.appendChild(el('span', {className:'tag', text:'you'}));
    if (u.bootstrap) mail.appendChild(el('span', {className:'tag', text:'ACCESS_EMAILS',
      title:'Always an owner while this address is in ACCESS_EMAILS'}));
    tr.appendChild(mail);
    tr.appendChild(el('td', {text:u.name || '—'}));

    var msg = el('span', {className:'msgline'});
    var roleTd = el('td');
    // The last active owner, and anyone ACCESS_EMAILS makes an owner, cannot
    // be demoted from here. The server refuses it either way.
    var locked = u.bootstrap || (u.role === 'owner' && u.active && owners <= 1);
    if (locked) {
      roleTd.appendChild(el('span', {text:roleName(u.role),
        title: u.bootstrap ? 'Set by ACCESS_EMAILS' : 'The last active owner'}));
    } else {
      var sel = roleSelect(u.role, 'Role for ' + u.email);
      sel.addEventListener('change', function(){
        var to = sel.value;
        sel.disabled = true;
        change(box, u, {role:to}, msg, function(){ sel.value = u.role; sel.disabled = false; });
      });
      roleTd.appendChild(sel);
    }
    tr.appendChild(roleTd);
    tr.appendChild(el('td', {text: u.active ? 'Active' : 'Deactivated'}));
    tr.appendChild(el('td', {text: u.lastSeenAt ? fmtWhen(u.lastSeenAt) : 'Never'}));

    var act = el('td');
    if (!locked && !u.bootstrap) {
      var b = el('button', {className:'ghost sm', type:'button', text: u.active ? 'Deactivate' : 'Reactivate'});
      b.addEventListener('click', function(){
        if (u.active && !confirm('Deactivate ' + u.email + '? They are refused on their next click.')) return;
        b.disabled = true;
        change(box, u, {active: !u.active}, msg, function(){ b.disabled = false; });
      });
      act.appendChild(b);
    }
    act.appendChild(msg);
    tr.appendChild(act);
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  gw.appendChild(t);
  return gw;
}

function change(box, u, patch, msg, undo){
  post(Object.assign({action:'userUpdate', email:u.email}, patch)).then(function(j){
    users = j.users; log = j.userLog || log;
    paint(box);
  }, function(e){ undo(); say(msg, e.message, true); });
}

function roleSelect(value, label){
  var s = el('select', {'aria-label':label});
  (D.roles || []).forEach(function(r){
    s.appendChild(el('option', {value:r, text:roleName(r), selected: r === value}));
  });
  s.value = value;
  return s;
}

function roleHelp(){
  var wrap = el('div', {className:'card'});
  wrap.appendChild(el('h3', {text:'What each role can do'}));
  var ul = el('ul', {className:'rolehelp'});
  (D.roles || []).forEach(function(r){
    ul.appendChild(el('li', null, [el('b', {text:roleName(r)}), document.createTextNode((D.roleLabels || {})[r] || '')]));
  });
  wrap.appendChild(ul);
  return wrap;
}

function history(){
  var wrap = el('div', {className:'card'});
  wrap.appendChild(el('h3', {text:'Recent changes'}));
  var ul = el('ul', {className:'log'});
  log.forEach(function(a){
    ul.appendChild(el('li', {text: fmtWhen(a.created_at) + ' · ' + (a.subject || '') + (a.actor ? ' · by ' + a.actor : '')}));
  });
  wrap.appendChild(ul);
  return wrap;
}

function say(node, text, bad){
  node.textContent = text || '';
  node.className = 'msgline' + (bad ? ' bad' : '');
}

function flashMessage(box, text){
  var p = el('p', {className:'msgline good', text:text});
  box.insertBefore(p, box.firstChild);
}
