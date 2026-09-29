/* PianoPlayerTech — shared page behaviour.
 *
 * Two jobs: open and close the menu on small screens, and mark which page
 * the visitor is on. Both are progressive: with this file missing the links
 * still work, the menu is simply always reachable by scrolling the header.
 */
(function () {
  var toggle = document.querySelector('.pp-nav-toggle');
  var nav = document.getElementById('pp-nav');

  function setOpen(open) {
    if (!toggle || !nav) return;
    nav.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });
    // A tap on a link inside the menu should not leave it covering the page
    // the link just scrolled to.
    nav.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('a')) setOpen(false);
    });
    document.addEventListener('click', function (e) {
      if (!nav.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { setOpen(false); toggle.focus(); }
    });
  }

  // On a phone the action bar repeats the hero's buttons. Keep it out of the
  // way until those have scrolled off, then bring it in.
  var bar = document.querySelector('.pp-actionbar');
  var heroActions = document.querySelector('.pp-hero__actions');
  if (bar && heroActions && window.IntersectionObserver) {
    new window.IntersectionObserver(function (entries) {
      bar.classList.toggle('is-hidden', entries[0].isIntersecting);
    }).observe(heroActions);
  }

  // Photo upload. The limits are checked here so the customer hears about an
  // oversized photo before waiting for it to upload; the server checks again.
  var photoForm = document.getElementById('photo-form');
  var photoStatus = document.getElementById('photo-status');
  var photoSubmit = document.getElementById('photo-submit');
  if (photoForm && photoStatus && photoSubmit && window.fetch && window.FormData) {
    var EMAIL_INSTEAD = ' Please email them to info@pianoplayertech.com instead.';
    var say = function (state, text) {
      photoStatus.setAttribute('data-state', state);
      photoStatus.textContent = text;
    };
    photoForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var files = photoForm.querySelector('input[type="file"]').files;
      if (!files.length) return say('error', 'Please choose at least one photo.');
      if (files.length > 5) return say('error', 'Please send up to 5 photos at a time.');
      for (var i = 0; i < files.length; i++) {
        if (files[i].size > 5 * 1024 * 1024) return say('error', 'Each photo must be under 5 MB.');
      }
      var label = photoSubmit.textContent;
      photoSubmit.disabled = true;
      photoSubmit.textContent = 'Sending\u2026';
      say('', '');
      fetch(photoForm.action, {
        method: 'POST',
        body: new window.FormData(photoForm),
        headers: { Accept: 'application/json' }
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (res.ok && data.ok) {
            photoForm.style.display = 'none';
            say('ok', data.message || 'Photos received.');
          } else {
            say('error', data.message || ('We could not send those photos.' + EMAIL_INSTEAD));
          }
        });
      }).catch(function () {
        say('error', 'Could not connect.' + EMAIL_INSTEAD);
      }).then(function () {
        photoSubmit.disabled = false;
        photoSubmit.textContent = label;
      });
    });
  }

  // Cloudflare serves /tuning and /tuning.html as the same page, so compare
  // with the extension and any trailing slash removed.
  function clean(p) {
    return (p || '/').replace(/\/index\.html$/, '/').replace(/\.html$/, '').replace(/\/$/, '') || '/';
  }
  var here = clean(location.pathname);
  var links = document.querySelectorAll('#pp-nav a[href]');
  for (var i = 0; i < links.length; i++) {
    var href = links[i].getAttribute('href');
    if (href.charAt(0) !== '/') continue;
    if (clean(href.split('#')[0]) === here) links[i].setAttribute('aria-current', 'page');
  }
})();
