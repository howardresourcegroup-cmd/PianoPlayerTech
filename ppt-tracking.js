/* PianoPlayerTech — conversion and analytics tracking
 *
 * Two actions matter for this business: a lead form submission and a
 * tap-to-call. Both are reported to every platform that is configured --
 * Google Ads, GA4, and the Meta pixel -- from one place, so they cannot
 * drift apart and start disagreeing about how many leads there were.
 *
 * Every destination is optional. An unset or wrongly-shaped id makes that
 * platform a no-op rather than an error, so this file is safe to ship
 * before the accounts exist.
 *
 * SETUP:
 *   Google Ads  already live. Labels below, from Goals -> Conversions.
 *   GA4         live. The Measurement ID is in PPT_ANALYTICS.ga4, from
 *               analytics.google.com -> Admin -> Data Streams.
 *   Meta pixel  paste the Pixel ID into PPT_ANALYTICS.pixel.
 *               business.facebook.com -> Events Manager. 15-16 digits.
 *               Enabling this also needs connect.facebook.net added to
 *               script-src in _headers, which is already there.
 */
(function () {
  window.PPT_CONV = window.PPT_CONV || {
    lead: 'AW-18254090927/XVSRCPr89MQcEK-lnYBE', // "Submit lead form" conversion
    call: 'AW-18254090927/K0HlCPu8icUcEK-lnYBE'  // "Phone call clicks" conversion
  };

  window.PPT_ANALYTICS = window.PPT_ANALYTICS || {
    ga4: 'G-QX5JVYR96H',
    pixel: ''   // '123456789012345'
  };

  // Shape checks, not just emptiness. A half-typed id would otherwise
  // configure a destination that silently never reports, which looks
  // identical to having no traffic.
  var GA4 = /^G-[A-Z0-9]{6,}$/i.test(window.PPT_ANALYTICS.ga4 || '') ? window.PPT_ANALYTICS.ga4 : '';
  var PIXEL = /^\d{10,20}$/.test(String(window.PPT_ANALYTICS.pixel || '')) ? String(window.PPT_ANALYTICS.pixel) : '';

  // ---- GA4
  // gtag.js is already on the page for the Ads tag, and the library is the
  // same whichever id loads it -- so GA4 is one more destination, not a
  // second copy of the library.
  if (GA4 && typeof gtag === 'function') gtag('config', GA4);

  // ---- Meta pixel, loaded only when there is an id to load it for.
  //
  // The guard is around the loader alone, not around init: fbq may already
  // exist because something else put it there, and the pixel still has to be
  // told which id it reports to. Guarding both meant a pixel that loaded and
  // then tracked nothing -- which looks exactly like having no visitors.
  if (PIXEL) {
   if (!window.fbq) {
    (function (f, b, e, v, n, t, s) {
      n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = true; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
   }
   window.fbq('init', PIXEL);
   window.fbq('track', 'PageView');
  }

  // One call per action, fanned out to whatever is configured. Nothing here
  // throws: an analytics failure must never affect a lead reaching the CRM.
  function report(kind) {
    try {
      if (GA4 && typeof gtag === 'function') {
        gtag('event', kind === 'lead' ? 'generate_lead' : 'phone_call', {
          event_category: 'Contact',
          event_label: location.pathname || '/'
        });
      }
      if (PIXEL && typeof window.fbq === 'function') {
        window.fbq('track', kind === 'lead' ? 'Lead' : 'Contact');
      }
    } catch (err) { /* analytics is never worth breaking a page for */ }
  }

  function fire(sendTo) {
    if (typeof gtag !== 'function') return;
    if (!sendTo || /REPLACE_WITH/.test(sendTo)) return; // not configured yet
    gtag('event', 'conversion', { send_to: sendTo });
  }

  // Tap-to-call — any tel: link, anywhere on the page.
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="tel:"]');
    if (a) { fire(window.PPT_CONV.call); report('call'); }
  });

  // Lead capture -> Airtable (via the /api/lead Pages Function, which holds
  // the Airtable token server-side). Uses sendBeacon so the write survives
  // the page navigation that native (non-AJAX) form submits trigger. It is
  // fire-and-forget and wrapped in try/catch, so it can never block or break
  // the Formspree submission. Add data-no-airtable to a form to skip it.
  function toAirtable(form, force) {
    try {
      if (!form || form.hasAttribute('data-no-airtable')) return;
      // A form that posts to Formspree itself sends to the CRM once it knows
      // how Formspree answered (it calls pptAfterFormspree), so a submission
      // Formspree refuses as bad input -- a mistyped email -- and the
      // corrected resubmit do not become two leads.
      if (!force && form.hasAttribute('data-lead-after-ok')) return;
      var fields = {};
      var hp = false;
      new FormData(form).forEach(function (value, key) {
        // _gotcha is the honeypot: a box no person can see. Anything in it
        // means a bot, and the server is told so it stores nothing.
        if (key === '_gotcha') { if (String(value).trim() !== '') hp = true; return; }
        // Skip Formspree meta fields (_subject, _next…) and blanks.
        if (key && key.charAt(0) !== '_' && String(value).trim() !== '') {
          fields[key] = value;
        }
      });
      var payload = {
        source: (location.pathname || '/') + (form.id ? ' #' + form.id : ''),
        page: location.href,
        fields: fields
      };
      if (hp) payload.hp = 1;
      var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/lead', blob);
      } else {
        fetch('/api/lead', { method: 'POST', body: blob, keepalive: true }).catch(function () {});
      }
    } catch (err) { /* never let lead capture affect the form */ }
  }

  // For the data-lead-after-ok forms, once Formspree has answered. `status`
  // is the HTTP status, or 0 when the request never got an answer.
  //
  // The CRM copy is skipped only when Formspree refused the input itself
  // (400 or 422): the person is shown why and will send a corrected one.
  // Everything else -- success, an outage, a quota or rate limit (429), a
  // network failure -- still sends it. The CRM is the safety net for a
  // Formspree failure, and a lead must fail everywhere to be lost.
  //
  // Returns what happened, for the page's message:
  //   'ok'       Formspree took it
  //   'refused'  Formspree refused the input; nothing was sent to the CRM
  //   'saved'    Formspree failed, but the CRM copy was sent
  //   'offline'  no answer at all; the CRM copy was attempted
  window.pptAfterFormspree = function (form, status) {
    var refused = status === 400 || status === 422;
    if (!refused) toAirtable(form, true);
    if (status >= 200 && status < 300) return 'ok';
    if (refused) return 'refused';
    return status ? 'saved' : 'offline';
  };

  // The words for each outcome, so the seven forms say the same true thing.
  window.pptFormspreeMessage = function (how, detail) {
    if (how === 'refused') return (detail ? detail + ' \u2014 ' : '') + 'please check the form and send it again, or call (470) 758-9572.';
    if (how === 'saved') return 'Your details reached us, but our form service had a problem confirming it. We will be in touch \u2014 if you have not heard from us within the hour, please call (470) 758-9572.';
    return 'We could not confirm that went through. Please try again, or call (470) 758-9572.';
  };

  // Lead form submit — capture phase so it fires even when a handler
  // calls preventDefault() (e.g. the AJAX fetch forms).
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || f.tagName !== 'FORM') return;
    toAirtable(f);
    var trap = f.querySelector && f.querySelector('[name="_gotcha"]');
    if (trap && String(trap.value || '').trim() !== '') return; // a bot is not a conversion
    if (!f.hasAttribute('data-no-conversion')) {
      fire(window.PPT_CONV.lead);
      report('lead');
    }
  }, true);
})();
