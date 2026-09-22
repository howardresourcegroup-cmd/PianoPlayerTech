// The one way this client talks to the server.
//
// Everything goes to POST /leads behind Cloudflare Access, with the action in
// the body. A failed request rejects with the server's own message, which is
// written for the person reading it -- "That lead is archived. Restore it
// first." -- so callers can show it verbatim.

export function post(payload){
  return fetch('/leads', {method:'POST', credentials:'same-origin',
    headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)})
  .then(function(res){
    return res.json().catch(function(){ return {}; }).then(function(j){
      if (!res.ok) throw new Error(j.error || ('Error ' + res.status));
      return j;
    });
  });
}
